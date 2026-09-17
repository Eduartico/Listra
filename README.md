# Listra

A Chrome/Brave extension (Manifest V3) that saves your own Vinted listings — every
field plus every photo at full resolution — to your own computer, shows them in a
Vinted-style grid, and relists any of them (sold ones included) in one click.

Nothing leaves your machine. There is no server, no account, and no third party: the
extension reads Vinted through your own already-signed-in browser session and writes
straight to disk.

## Install

No build step, no `npm install`: the repository folder *is* the extension.

1. Clone or download this folder somewhere it can stay, e.g. `E:\Repos\Listra`.
   Do not move or delete it afterwards; the browser loads it from there every start.
2. Open `brave://extensions` (`chrome://extensions` on Chrome) and turn on
   **Developer mode** (top right).
3. **Load unpacked** and select the folder that contains `manifest.json`.
4. Click the puzzle-piece icon in the toolbar and **pin** Listra, so the popup is
   one click away.

To update: pull the new version into the same folder, then press the reload arrow
on Listra's card in `brave://extensions`. Open Vinted tabs pick up the new content
script after a page reload.

An unpacked extension is loaded into one browser profile only. If you loaded it in
a test profile and do not see it in your everyday browser, load it there too — same
steps.

Things to know for daily use on Brave:

- Brave has no folder picker, so backups live in the extension's own browser
  storage. **Removing the extension deletes them.** After a backup run you care
  about, press **Save to Downloads folder** (real files under `Downloads/Listra`)
  or **Export as ZIP**.
- If Listra's pages come up light although Brave is dark, use the **System / Light
  / Dark** switch in the manager header or the popup. Brave does not always pass
  its colour setting on to extension pages.
- Some Brave versions show a "disable developer mode extensions" prompt on start.
  Dismiss it; nothing is wrong.

Icons are derived from `icons/Listra Logo.jfif` by `tools\icons-from-logo.ps1`
(Windows, uses the built-in .NET imaging). `node tools/make-icons.js` draws
placeholder icons in code on any platform.

## Use

Everything can be started from Vinted itself; the manager tab is where the backup
lives and where the full grid, log and settings are.

**On your own profile page** (`/member/<id>-<your-username>`) a **Listra ▾** pill
sits at the bottom right. Hover it for the last backup and anything running now;
click it for the menu:

- **Backup all listings** — opens the manager and, if a destination is already
  set, starts backing up. On Chrome, click **Choose backup folder** first; on
  Brave the backup goes into browser storage and starts right away.
- **Relist all active (N)** — after a confirmation, every live listing is backed
  up, deleted and recreated from the backup, one at a time (see *Relisting*).
  The manager does the work in a background tab; progress shows on the Vinted
  page.
- **Open Listra** — the manager tab.

**On one of your own item pages** a **Relist** button appears (next to Vinted's
own Edit/Bump actions when Listra finds them, floating at the bottom right
otherwise). Hover it for the backup date, whether the listing is live, and the
last relist result. Click it to relist that one listing; the manager stays in the
background and progress shows on the page. When it finishes, the panel shows the
new listing's id.

If Vinted asks for a human check mid-way, the on-page panel offers **Open check**
and, once you have done it, **Retry**. If the manager needs a decision from you
(no backup destination yet), it brings its tab to the front.

When a backup finishes, click **Validate backup** in the manager.

Theme: the pages follow your operating system by default; the **System / Light /
Dark** switch (manager header, popup) overrides that and is remembered.

### Where the backup is

**Chrome:** in the folder you picked, as ordinary files, written as the backup runs.

**Brave:** Brave disables the folder picker, so the backup is kept inside the
browser (IndexedDB), which is not a folder you can open. Two ways out, both on the
"Where the backup lives" panel:

- **Save to Downloads folder** copies every file into `Downloads/Listra/<profile>/…`
  with the same layout as below. Turn off "Ask where to save each file" in Brave's
  download settings first, or it asks once per file.
- **Export as ZIP** makes one archive of everything.

### The grid

Every backed-up listing is a card with its stored photos (arrows to flip through
them), price, title, category, condition, brand, size, colour and description
(click to expand). Badges mark **Sold**, Reserved, Hidden and Failed. Search, filter
(All / Active / Sold / Failed / Relisted) and sort (newest, title, price, photo
count) at the top. **Open on Vinted** goes to the live listing.

### Relisting

Sold listings are backed up too, and any listing can be put back on Vinted: press
**Relist** on a card, or tick several and press **Relist selected**. For each one,
Listra:

1. backs it up again first and checks it is on disk with its photos;
2. if the listing is still live, **deletes it** — this comes first because Vinted
   rejects a new listing whose photos match a live one, so creating before deleting
   gets both cancelled;
3. uploads the stored photos and creates the new listing from the backup — title,
   description, price, category, brand, condition, colours, package size;
4. backs up the new listing, so it appears in the grid.

Deleting first is why the backup has to be reliable: once the original is gone, the
backup is the only source. If the create then fails, the delete is remembered — the
card shows "Original deleted — press Relist to recreate from the backup", and Retry
finishes the job without deleting anything again.

A batch goes one listing at a time with a 20-second pause between them, because
creating listings is what Vinted's bot protection watches most closely. If Vinted
asks for a human check, Listra stops, shows an **Open Vinted's human check** button,
and continues from where it stopped when you press **Retry** after completing it.
If Vinted rate-limits, it stops the same way; wait a few minutes and retry.

Sold listings' backups lack the condition, colour and package-size ids that only the
seller's editable record carries, so those are looked up at relist time from the
labels ("Novo com etiquetas" → id 6, "Preto" → id 1); package size is assumed
small when unknown and the assumption is noted in the log.

Progress shows in the manager tab, on the Vinted page, and in the toolbar popup. You
can close the manager tab mid-run: reopening it and pressing Start continues from
where it stopped rather than starting over.

Choosing **Backup all listings** on the Vinted page again after a run has
already finished starts a fresh full backup rather than skipping what is already
there — there is no incremental "only fetch what changed" mode. Re-running overwrites
each listing's folder in place, so a completed backup is always safe to redo.

## What gets written

```
<folder you chose>/
├── backup_manifest.json
├── Nike_Air_Max_90/
│   ├── metadata.json      # the listing, normalized (see below)
│   ├── raw.json           # exactly what Vinted returned, unmodified
│   ├── raw.html           # only when the DOM fallback ran; the page as it was
│   └── images/
│       ├── 1.jpg
│       └── 2.jpg
└── ...
```

`raw.json` is kept deliberately. `metadata.json` is only as good as our understanding
of Vinted's field names, so the untouched response is stored next to it — if a field
turns out to matter later, it is already in the backup.

### metadata.json

```jsonc
{
  "schemaVersion": "1.0.0",
  "id": "123456789",
  "url": "https://www.vinted.fr/items/123456789",
  "title": "Nike Air Max 90",
  "description": "Worn twice, like new.",
  "price": 45,                  // number, or null if Vinted returned none
  "originalPrice": 90,          // number | null
  "currency": "EUR",            // string | null
  "category": ["Women", "Shoes"],
  "catalogId": 123,
  "brand": "Nike",              // string | null
  "brandId": 53,                // Vinted's brand id | null
  "condition": "Muito bom",     // Vinted's own localized label | null
  "conditionId": 50,            // Vinted's status id | null
  "size": "42",                 // string | null
  "sizeId": 506,                // Vinted's size id | null
  "color": "Black",             // string | null
  "material": null,             // string | null
  "shippingOptions": [{ "carrier": "Mondial Relay", "price": 3.99, "currency": "EUR" }],
  "seller": { "id": 99999, "username": "seller123", "rating": 4.9 },
  "favouriteCount": 12,
  "viewCount": 340,
  "listingState": { "draft": false, "closed": false, "reserved": false, "hidden": false },
  "uploadedText": "há um dia",  // Vinted's relative upload label; the only date shown
  "createdAt": null,            // ISO 8601 when Vinted exposes it, else null
  "updatedAt": null,
  "images": [
    {
      "index": 1,
      "originalUrl": "https://images1.vinted.net/...jpg",
      "localPath": "images/1.jpg",
      "width": 800,
      "height": 600
    }
  ],
  "rawSource": "api",           // "api" (wardrobe record) | "page" (listing page data) | "dom"
  "scrapedAt": "2026-09-15T21:04:00.000Z",
  "domain": "https://www.vinted.fr",
  "region": "fr"
}
```

Every optional field is `null` when absent, never missing and never `undefined`. The
`*Id` fields are recorded because they are what a future restore would need to send.

A listing is only marked `completed` once its metadata **and** all of its images are
written and read back non-empty. A listing that loses one photo is recorded as
`failed` rather than left looking complete, and the run continues.

### Where a backup can also go

If the folder picker is unavailable (older Chromium, or enterprise policy), the
extension falls back to IndexedDB inside the browser and offers **Export as ZIP**,
since browser storage is otherwise invisible from outside Chrome. The manager always
names the destination it is using.

## Regions

All twelve storefronts are supported and detected from the page you are on:
`vinted.fr`, `.es`, `.de`, `.it`, `.pt`, `.pl`, `.co.uk`, `.nl`, `.be`, `.lt`,
`.cz`, `.at`.

## How it is put together

```
Vinted tab (content script)      same-origin, has your session cookies
  ├── the on-page button and progress overlay
  └── every /api/v2 request the extension makes

Manager tab (extension page)     the orchestrator
  ├── owns the folder handle, the queue, retries, the manifest, validation
  └── downloads photos from the CDN directly

Service worker                   thin
  └── opens the manager tab and relays messages between the two
```

Three deliberate departures from the original brief, each for a concrete reason:

**The queue is not in the service worker.** A Manifest V3 service worker cannot call
`showDirectoryPicker` — it does not exist in worker scope — and it can be killed
between listings. Putting the orchestrator in a normal page removes that whole class
of problem, and with it the need for `chrome.alarms` keep-alive tricks, an offscreen
document, or a permission dance on every restart.

**No tabs are opened per listing.** Listings are fetched, not visited. That removes
the tab churn, the 800–2000 ms inter-tab delays, and most bot-protection exposure.
When a listing's page is needed, its HTML is fetched and parsed in place.

**API calls are made from the Vinted tab, not the manager.** A fetch from
`chrome-extension://…` carries an extension `Origin` and a cross-site
`Sec-Fetch-Site`, which Vinted's edge may reject. Photos are different — public CDN
bytes with no session — so those are fetched by the manager, keeping multi-megabyte
blobs out of `chrome.runtime` messages.

### Rate limiting

One token bucket guards every API request: 4 requests per second, at least 250 ms
apart, with jitter. The brief suggested a 200 ms floor, but 200 ms *is* 5 req/s,
which would have been looser than the 4 req/s ceiling it also asked for; 250 ms is
the gap that actually matches 4 req/s. Photos use a separate, slightly looser budget
because they are static assets; listing pages use a much stricter one (see above).

There is no fingerprint or anti-detection code, and none is needed: this runs in your
own browser, as you, below the request rate of Vinted's own pages.

## Code layout

```
manifest.json
src/common/      shared by all three contexts
  constants.js       regions, condition map, limits, storage keys
  messages.js        every cross-context message type and error code
  logger.js          ring buffer, mirrored to storage for the manager's log pane
  selectors.js       every DOM selector, in one file
  sanitize.js        filesystem-safe folder and file names
  rate-limiter.js    token bucket
  page-data.js       reads the page’s embedded Next.js payload (App Router RSC stream)
  normalize.js       raw Vinted item -> the schema above
  relist-body.js     the create-listing request body from a backup
  relist-plan.js     which wardrobe records are active; queue entries for a relist request
  theme.js           System / Light / Dark preference, applied as data-theme
src/content/     content script (proxy + backup overlay), page-actions.js (on-page buttons, menus, panels), DOM fallback, injected styles
src/background/  service worker
src/manager/     orchestrator page, grid, relist, both storage backends, images, validation, Downloads export
src/popup/       toolbar popup
tools/           icon generator
tests/           offline test harness and fixtures
```

Everything is a classic script attaching to one global namespace, `VB`. Content
scripts cannot use ES modules, so rather than maintain two module formats for the
same files, the whole extension uses one pattern: the service worker
`importScripts()` them, pages load them as ordered `<script>` tags, and the manifest
lists them for the content script.

When Vinted changes something, `selectors.js` and `normalize.js` are the two files
that should need editing.

## Where the data comes from

Verified against vinted.pt on 2026-09-16. The original brief described a different
Vinted; every item below replaced an assumption that turned out to be wrong.

| Need | Source | Status |
|---|---|---|
| The list of a user's listings (sold ones included), with price, brand, size, condition, counts and full-size photo URLs | `GET /api/v2/wardrobe/{userId}/items?page=N&per_page=96&order=newest_first` | verified, public |
| The seller's own editable record: description, `catalog_id`, `brand_id`, `size_id`, `color1_id`/`color2_id`, `package_size_id`, condition id (`item_attributes`), photos | `GET /api/v2/item_upload/items/{id}` | verified signed in; 403 for sold listings and for anyone else's |
| Category path for a catalog id | `GET /api/v2/item_upload/catalogs` (the whole tree, once per run) | verified |
| Colour names for colour ids | `GET /api/v2/item_upload/colors` (once per run) | verified |
| For listings `item_upload` refuses (sold): description, breadcrumbs, brand id | the listing page's Next.js **App Router** RSC payload (`self.__next_f.push` chunks), read by `page-data.js` | verified, public, **rate-limited hard** (HTTP 429 well under 1 page/s) |
| Who is signed in | `GET /api/v2/users/current` | verified |
| Page config: `x-csrf-token`, `x-anon-id` headers Vinted's frontend sends | `CSRF_TOKEN` and `anon_id` in the RSC payload / cookie | verified |

The listing page is fetched only when `item_upload` cannot answer. It is 2 MB and Vinted
throttles it aggressively; on a 429 the extension honours `Retry-After`, backs off, and
halves its page rate for the rest of the run. A full backup of 31 listings (25 live, 6
sold) took 42 s with no errors.

Attribute `id`s on the listing page are **not** entity ids for status and size (the same
id 50 appeared on two different condition labels — it is an FAQ id). Only the brand id
there is real. Condition, size and colour ids come from `item_upload` alone.

What the brief said that is **not** true of the live site: there is no `__NEXT_DATA__`
block (App Router, not Pages Router); `/api/v2/items/{id}` and
`/api/v2/users/{id}/items` both answer 404; `status_id` is not 1–3 (a real condition id
seen was 6, and page attribute ids are FAQ ids). The condition label therefore always
comes from Vinted's own localized string, with the real id from `item_upload` beside it.

### Browser differences

Brave disables the File System Access API, so on Brave the extension goes straight to
browser storage (IndexedDB) and offers **Export as ZIP**; on Chrome the folder picker is
available. Also on Brave: an unpacked extension that calls `chrome.runtime.reload()` is
left disabled until Developer mode is on — reload from `brave://extensions` instead.
Brave also hides extension-page URLs from `chrome.tabs.query` without the `tabs`
permission, so the manager tab is found by registration (it reports its tab id to the
worker on load) rather than by URL; a second manager tab closes itself in favour of
the first.

## Tests

```
node tests/run.js
```

236 assertions, no dependencies. It evaluates the shipped modules in-process and
covers region detection across all twelve domains, profile-URL detection, folder-name
safety (accents, length, Windows device names, collisions), price and timestamp
normalization, the RSC flight reader against a fixture built from a captured live
page (including reference resolution), a captured wardrobe record, tolerance of
renamed fields, the folder backend's overwrite behaviour against a small in-memory
fake of the File System Access API, the relist body builder and its condition,
colour and human-check parsers, theme resolution, item-page URL detection, the
active-listing filter and relist queue planning, the rate limiter's real timing,
and the ZIP writer's CRC.

Fixtures under `tests/fixtures/` that came from live captures are anonymized.

### Live testing

Vinted uses DataDome. A browser *launched* by Playwright is identified as automation
at the login step and blocked; this project does not try to get around that. What
worked: launch a plain Brave with `--remote-debugging-port` and the extension loaded,
sign in by hand in that window, then attach over CDP afterwards to observe traffic and
drive the extension's own pages. The driver for that lives in the git-ignored
`local/driver/` and is not part of the extension.

## Known limits

- **Verified against one storefront (vinted.pt), one real account, on Brave.**
  Several full 31-listing backups ran clean, signed in, including resuming after
  the manager tab was closed mid-run, cancelling mid-run, and a synthetic bad-id
  failure that isolated correctly while the rest of the run completed — all
  confirmed live, not just by design. Other storefronts share the same frontend
  but were not exercised; the Chrome folder-picker path was not exercised either
  (Brave has no picker), though its write/overwrite logic has an offline regression
  test against a fake File System Access directory. When the normalizer meets
  something unfamiliar it logs the keys it actually received and fails that
  listing loudly.
- **Shipping options and creation dates are not exposed.** The page loads shipping
  client-side and shows only a relative upload label ("há 6 semanas"), which is kept
  as `uploadedText`; `createdAt` is `null`.
- **Relisting goes through the same API Vinted's own form uses, not the form.** It
  worked for a recreated listing during development, but creating listings by API
  is exactly what DataDome scores hardest; expect a human check now and then. Two
  direct-API attempts in one session were challenged while the form itself was not,
  so the batch pacing is deliberately slow and stops at the first challenge.
- **Own-profile detection can be inconclusive.** If the extension cannot confirm the
  profile is yours, it says so and asks before proceeding rather than guessing.
- **Titles are flattened to ASCII for folder names**, per the spec's sanitization
  rule. A listing titled entirely in a non-Latin script gets a `listing` folder with
  a numeric suffix; its real title is intact inside `metadata.json`.
