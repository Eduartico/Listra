# In-page actions, theme switch, daily install — design

Date: 2026-09-17
Status: approved

## Goals

1. Dark mode works in the user's Brave browser, where `prefers-color-scheme`
   does not reach extension pages even with Brave colours set to Dark.
2. Relist from inside Vinted, without opening the manager page:
   - on one of the user's own item pages, a **Relist** button;
   - on the user's own profile page, **Relist all active listings**, next to the
     existing backup action;
   - a hover panel on each button showing status (backup, live/sold, last relist,
     progress while running).
3. Clear instructions for loading the extension into the user's everyday Brave
   profile, and the small things that make it safe to use daily.

Out of scope: moving relist orchestration out of the manager page (offscreen
document), packaging a `.crx`/`.zip`, Chrome Web Store.

## Constraints that shape the design

- Relist orchestration and backup storage live in the manager page
  (`src/manager/*`). The folder backend needs a user gesture in that page; the
  IndexedDB backend (what Brave uses) does not. Content scripts cannot reach the
  extension's IndexedDB, and Vinted API calls must be made from a Vinted tab.
  So the in-page buttons trigger the manager, they do not do the work.
- Extension pages cannot run inline scripts (MV3 CSP). The theme must be applied
  by an external script loaded before first paint.
- Vinted's class names are hashed. Any inline anchor for the item-page button
  must be a `data-testid` candidate list with a floating fallback.

## Architecture

Approach chosen: **manager as headless worker**. The content script asks the
service worker to run a relist; the worker opens or reuses the manager tab in the
background; the manager runs the existing `relist.js` batch; per-step progress is
relayed back to the Vinted tab that asked. The manager is brought to the front
only when it needs the user (destination not ready, human check).

```
Vinted tab (content script)          service worker              manager tab
  click Relist → confirm modal
  RELIST_ITEMS {ids, context} ───────▶ open/reuse manager (inactive)
                                       RELIST_ITEMS ─────────────▶ create entries, runBatch
  overlay ◀────────── RELIST_PROGRESS ◀─────────────────────────── per step / done
  GET_ITEM_STATUS ──────────────────▶ answer from chrome.storage.local run state
                                       focus manager ◀──────────── NEED_ATTENTION
```

## 1. Theme switch

**Files:** `src/common/theme.js` (new), `manager.html`, `manager.css`,
`manager.js`, `popup.html`, `popup.css`, `popup.js`.

- Stored value `vb_theme` in `chrome.storage.local`: `'system' | 'light' | 'dark'`.
  Missing or unknown → `system`.
- `theme.js` is a classic script loaded first in `<head>` of both pages. It reads
  the value and sets `document.documentElement.dataset.theme`. Because
  `chrome.storage` is async, the script also mirrors the last value into
  `localStorage` (`vb_theme`) and applies that synchronously first, so there is
  no flash on load. It exposes `VB.theme = { get, set, apply, resolve }` where
  `resolve(stored, systemPrefersDark)` is the pure function under test.
- It also listens on `chrome.storage.onChanged` so the popup and the manager stay
  in step.
- CSS token structure in both stylesheets:

  ```css
  :root { /* light tokens */ }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { /* dark tokens */ } }
  :root[data-theme="dark"] { /* dark tokens */ }
  ```

  The dark token block is written once and shared by both selectors via a
  selector list. `color-scheme` is set per theme so form controls and scrollbars
  follow.
- Control: a three-segment control (System / Light / Dark) in the manager header
  and in the popup footer. Plain `<button>`s with `aria-pressed`, no library.

## 2. Item page button

**Files:** `content-script.js`, `content-styles.css`, `selectors.js`,
`page-data.js` (if the sidebar item lookup needs a helper).

- Detection: `location.pathname` matches `SELECTORS.item.itemInUrl`
  (`/^\/items\/(\d+)(?:-[^/?#]*)?\/?$/`).
- Ownership: the item page's flight payload carries the sidebar item object
  (`seller_id` / `user_id`). Compare with the signed-in user id from
  `buildContext()`. Not signed in, or not the seller → nothing injected. If the
  seller id cannot be read, inject nothing and log (fail closed).
- Placement: `SELECTORS.item.ownerActions` is an ordered list of candidate
  selectors for Vinted's owner action row (Edit / Bump / Mark as sold). First
  match wins and the button is appended there with `.vb-inline` styling. No
  match within 5 s → floating pill (`.vb-fab`, bottom-right, "Relist this
  item"). The candidate list is filled from real markup pasted by the user
  during implementation; until then it is empty and the fallback is used.
- Button label: **Relist**. Disabled with label **Relisting…** while a run
  involving this id is in progress; **Busy** when Listra is doing something
  else.
- Hover panel (`.vb-panel`), shown on hover/focus, anchored to the button:
  - Backup: "Backed up 16 Sep, 20:35 · 2 photos" or "Not backed up yet
    (done automatically before relisting)".
  - State: "Live" or "Sold / not active" (from the page's own item object).
  - Last relist: "Relisted 16 Sep as #10027122729" or the last error.
  - While running: step text and a progress bar.
  - Data comes from `GET_ITEM_STATUS`.
- Click: in-page confirm modal (`.vb-modal`), same wording as the manager's
  dialog: for a live item "The current listing is deleted first, then recreated
  from the backup with the same photos"; for a sold one "Recreated as a new
  listing". Confirm → `RELIST_ITEMS { ids: [id], context }`.

## 3. Profile page

**Files:** `content-script.js`, `content-styles.css`.

- The single **Backup Listings** pill becomes **Listra ▾**. Click opens a menu:
  - **Backup all listings** — existing behaviour (`START_BACKUP`).
  - **Relist all active (N)** — N filled after the wardrobe list loads; shows
    "…" until then.
  - **Open Listra** — `OPEN_MANAGER`.
- Hover on the pill shows the status panel: last backup (time, count), and the
  current run's progress if any (backup or relist).
- **Relist all active**: `collectViaWardrobe` already fetches the wardrobe;
  keep the records and filter `is_closed === false`. Confirm modal states the
  count, that each is deleted then recreated one at a time, and a rough
  duration (`N × RELIST.gapMs` plus ~30 s each). Confirm → `RELIST_ITEMS`.
- The ownership rules stay as they are (`isOwnProfile === false` → nothing;
  `null` → ask).

## 4. Messages, service worker, manager

**Files:** `messages.js`, `service-worker.js`, `manager.js`, `relist.js`,
`constants.js` (storage key for the last relist origin tab, if needed).

New message types:

| Type | Direction | Payload | Reply |
|---|---|---|---|
| `RELIST_ITEMS` | content → worker → manager | `{ ids: string[], context }` | `done(true)` or `fail(BUSY)` |
| `GET_ITEM_STATUS` | content → worker | `{ ids: string[] }` | `{ [id]: { backedUpAt, imageCount, relist } }` from persisted run state |
| `RELIST_PROGRESS` | manager → worker → origin tab | `{ status, ids, currentId, currentTitle, step, completed, failed, total, captchaUrl, summary }` | — |
| `RELIST_RETRY` | content → worker → manager | — | `done(true)` |
| `NEED_ATTENTION` | manager → worker | `{ reason }` | focuses the manager tab |

Service worker:

- `openManagerTab({ active })` gains the `active` option. `RELIST_ITEMS` opens
  it inactive, remembers `sender.tab.id` as both proxy tab and progress target,
  stores `vb_pending_relist = { ids, context }` for a freshly opened manager
  (same handover pattern as `vb_pending_context`), and forwards the message to
  an already-open manager.
- `RELIST_PROGRESS` is relayed to the remembered tab with `chrome.tabs.sendMessage`,
  best effort, like `OVERLAY_UPDATE`.
- `GET_ITEM_STATUS` reads `STORAGE_KEYS.runState` and picks the requested ids
  out of `queue`.
- `NEED_ATTENTION` calls the existing focus path of `openManagerTab`.

Manager:

- `RELIST_ITEMS` handler (and the boot-time `vb_pending_relist` handover): if a
  backup run or a relist batch is in progress reply `fail(ERR.BUSY, …)`. If
  storage is not ready, send `NEED_ATTENTION { reason: 'storage' }` and show the
  existing "choose a destination" notice; the request is kept and started when
  storage becomes ready (the `ready` transition already exists in `renderStorage`
  flow). Otherwise create pending queue entries for ids not in the queue (same
  shape `backupNewId` uses) and call `runBatch(ids)` directly, skipping the
  manager's confirm dialog because the page already confirmed.
- `relist.js`: `runBatch` publishes `RELIST_PROGRESS` at each `setStep`, on each
  item's completion and at the end (summary: relisted, failed, stopped reason,
  `captchaUrl` on a human check). On a human check it also sends
  `NEED_ATTENTION { reason: 'human-check' }` only if the origin tab did not
  acknowledge the progress message (tab closed). `RELIST_RETRY` maps to the
  existing Retry button behaviour.
- Persisted entries gain `backedUpAt` (ISO string, set when a backup completes)
  and `relist.lastResult = { at, newId, error }`, so `GET_ITEM_STATUS` has what
  the hover panel shows.
- New error code `ERR.BUSY`.

## 5. On-page overlay

- `.vb-overlay` is reused with a `mode` ('backup' | 'relist'). Relist mode shows
  "Relisting", `completed / total`, the current title and step.
- Done: "3 relisted, 0 failed" and auto-hide after 10 s. The item button's hover
  panel is refreshed.
- Failure: message plus an **Open Listra** button (`OPEN_MANAGER`).
- Human check: "Vinted wants a human check" with **Open check** (navigates the
  current tab to `captchaUrl`) and **Retry** (`RELIST_RETRY`). Because the
  overlay state is driven by messages, a re-injected content script asks
  `GET_STATE`-style for the last relist progress on boot (stored under
  `STORAGE_KEYS.relistProgress` by the manager) so the overlay survives a reload.

## 6. Install for daily use (README)

Rewrite the Install section:

- Load unpacked from the repository folder itself (`E:\Repos\Listra`), so an
  update is `git pull` and **Reload** on `brave://extensions`. Do not move or
  delete the folder while loaded.
- Pin the Listra icon in the toolbar.
- Brave specifics: no folder picker, so backups live in the extension's browser
  storage; **removing the extension deletes them**. Use **Save to Downloads
  folder** or **Export as ZIP** after each backup run you care about. Brave
  colours "Dark" does not reach extension pages; use the theme switch.
- Developer-mode extensions may show a warning on start in some versions;
  harmless.

## 7. Tests (`tests/run.js`)

- `VB.theme.resolve`: `('system', true) → 'dark'`, `('system', false) → 'light'`,
  `('dark', false) → 'dark'`, `('light', true) → 'light'`, `(undefined, true) → 'dark'`.
- `SELECTORS.item.itemInUrl` accepts `/items/123-slug`, `/items/123`, `/items/123/`,
  rejects `/items/`, `/items/abc`, `/member/123`.
- Active-id filter over wardrobe records: `is_closed === false` only; missing
  `is_closed` excluded.
- Pure helper `VB.relistPlan.entriesFor(queue, ids)` (in `common`) returns the
  existing entries plus new pending entries for unknown ids, in request order,
  with the same field set as `backupNewId`.

## Error handling summary

- No Vinted tab / proxy failure: existing `NO_PROXY_TAB` path; the overlay shows
  the message and **Open Listra**.
- Manager busy: `ERR.BUSY`; the button shows **Busy** and the panel says what is
  running.
- Storage not ready (Chrome folder permission): manager focused with the existing
  notice; the request is held and runs once the destination is ready.
- Human check / rate limit: batch stops as today; overlay shows check/retry.
- Delete succeeded, create failed: existing `oldDeleted` flow; the panel shows
  "Original deleted — press Relist to recreate from backup" and Relist sends the
  same id again, which the manager treats as a retry.
