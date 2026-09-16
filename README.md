# Vinted Listing Backup

A Chrome/Brave extension (Manifest V3) that saves your own Vinted listings — every
field plus every photo at full resolution — into a folder on your computer.

Nothing leaves your machine. There is no server, no account, and no third party: the
extension reads Vinted through your own already-signed-in browser session and writes
straight to disk.

## Install

1. Clone or download this folder.
2. Open `chrome://extensions`, turn on **Developer mode**.
3. **Load unpacked**, and select this folder (the one containing `manifest.json`).

No build step, no `npm install`. The extension ships the files it runs.

Icons are derived from `icons/Listra Logo.jfif` by `tools\icons-from-logo.ps1`
(Windows, uses the built-in .NET imaging). `node tools/make-icons.js` draws
placeholder icons in code on any platform.

## Use

1. Sign in to Vinted and open your own profile (`/member/<id>-<your-username>`).
2. Click the **Backup Listings** button at the bottom right of the page.
   The backup manager opens in its own tab.
3. In the manager, click **Choose backup folder** and pick where the backup should go.
4. Click **Back up all listings**.
   To try it first, put `2` in the "First … listings only" box.
5. When it finishes, click **Validate backup**.

Progress shows in the manager tab, on the Vinted page, and in the toolbar popup. You
can close the manager tab mid-run: reopening it and pressing Start continues from
where it stopped rather than starting over.

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
src/content/     content script, DOM fallback, injected styles
src/background/  service worker
src/manager/     orchestrator page, both storage backends, images, validation
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

## Tests

```
node tests/run.js
```

164 assertions, no dependencies. It evaluates the shipped modules in-process and
covers region detection across all twelve domains, profile-URL detection, folder-name
safety (accents, length, Windows device names, collisions), price and timestamp
normalization, the RSC flight reader against a fixture built from a captured live
page (including reference resolution), a captured wardrobe record, tolerance of
renamed fields, the rate limiter's real timing, and the ZIP writer's CRC.

Fixtures under `tests/fixtures/` that came from live captures are anonymized.

### Live testing

Vinted uses DataDome. A browser *launched* by Playwright is identified as automation
at the login step and blocked; this project does not try to get around that. What
worked: launch a plain Brave with `--remote-debugging-port` and the extension loaded,
sign in by hand in that window, then attach over CDP afterwards to observe traffic and
drive the extension's own pages. The driver for that lives in the git-ignored
`local/driver/` and is not part of the extension.

## Known limits

- **Verified against one storefront (vinted.pt), one real account, on Brave.** A
  full 31-listing backup ran clean, signed in. Other storefronts share the same
  frontend but were not exercised; the Chrome folder-picker path was not exercised
  either (Brave has no picker). When the normalizer meets something unfamiliar it
  logs the keys it actually received and fails that listing loudly.
- **Shipping options and creation dates are not exposed.** The page loads shipping
  client-side and shows only a relative upload label ("há 6 semanas"), which is kept
  as `uploadedText`; `createdAt` is `null`.
- **Backup only.** Re-listing from a backup is not implemented. It means driving
  Vinted's upload form, which is a separate piece of work with its own failure modes.
- **Own-profile detection can be inconclusive.** If the extension cannot confirm the
  profile is yours, it says so and asks before proceeding rather than guessing.
- **Titles are flattened to ASCII for folder names**, per the spec's sanitization
  rule. A listing titled entirely in a non-Latin script gets a `listing` folder with
  a numeric suffix; its real title is intact inside `metadata.json`.
