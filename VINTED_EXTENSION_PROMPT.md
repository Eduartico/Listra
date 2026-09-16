# Vinted Listing Backup & Restore — Chrome Extension (Manifest V3)

## Agent Instruction

You are an expert Chrome Extension (Manifest V3) engineer and browser automation architect. Your task is to design and implement a full Chrome/Brave extension that automates the backup and recreation of marketplace listings on **Vinted**. The extension must NOT rely on external servers — everything runs locally in the browser extension.

You have been given deep domain knowledge about Vinted's architecture, API patterns, DOM structure, Cloudflare bypass techniques, and data model — use ALL of it.

---

## VINTED DOMAIN KNOWLEDGE (READ FIRST)

### 1. Regional Domains

Vinted operates per-country. The extension MUST detect the current domain automatically:

| Region | Domain               |
|--------|----------------------|
| fr     | https://www.vinted.fr     |
| es     | https://www.vinted.es     |
| de     | https://www.vinted.de     |
| it     | https://www.vinted.it     |
| pt     | https://www.vinted.pt     |
| pl     | https://www.vinted.pl     |
| uk     | https://www.vinted.co.uk  |
| nl     | https://www.vinted.nl     |
| be     | https://www.vinted.be     |
| lt     | https://www.vinted.lt     |
| cz     | https://www.vinted.cz     |
| at     | https://www.vinted.at     |

**Implementation**: Derive from `window.location.origin` when the content script loads. Use a regex.

### 2. Vinted Tech Stack & Page Architecture

- **Framework**: Next.js (React SSR/CSR hybrid)
- **Rendering**: Client-side React hydration after initial server HTML
- **Embedded data**: `<script id="__NEXT_DATA__" type="application/json">` contains serialized props with item data, user info, and catalog IDs. **This is the primary data source — deterministic and immune to CSS changes.**
- **DOM classes/selectors**: Vinted uses CSS Modules with hashed class names. **Do NOT rely on class names.** Prefer:
  - `data-testid` attributes (e.g., `[data-testid="item-title"]`)
  - Semantic HTML (`h1`, `img[alt]`, `a[href*="/items/"]`)
  - `__NEXT_DATA__` JSON extraction (deterministic)

### 3. User Profile / "My Listings" Page

**URL pattern**: `{domain}/member/{username}`

The content script detects this URL pattern to know it's on the profile page. Listings are a **grid of cards**. **Infinite scroll** loads listings lazily via XHR/fetch to the internal API. Each card links to `{domain}/items/{item_id}-{slug}`.

**Key insight**: Extract item IDs from `__NEXT_DATA__` — the grid items come from the internal API and are embedded in Next.js page props. This avoids DOM parsing of cards entirely.

**Fallback DOM extraction** (if `__NEXT_DATA__` unavailable):
- Each card is an `<a>` with `href` matching `/items/\d+-`
- Extract href, title (from `img[alt]`), price (text with €/$/£), and thumbnail
- Scroll 600px at a time with 400ms pauses to trigger infinite scroll
- Stop when no new listings appear for 3 consecutive scrolls

### 4. Listing Detail Page

**URL pattern**: `{domain}/items/{item_id}-{slug}`

All data from `__NEXT_DATA__`. Key fields:

```json
{
  "props": {"pageProps": {"item": {
    "id": 123456789,
    "title": "Nike Air Max 90",
    "description": "Worn twice, like new...",
    "price": { "amount": "45.00", "currency_code": "EUR" },
    "original_price_numeric": "90.00",
    "brand_title": "Nike",
    "size_title": "42",
    "status_id": "3",
    "catalog_id": 123,
    "catalog_breadcrumbs": [
      { "id": 1, "title": "Women", "code": "women" },
      { "id": 123, "title": "Shoes", "code": "shoes" }
    ],
    "photos": [
      { "id": 111, "url": "https://...jpg", "full_size_url": "https://...jpg", "width": 800, "height": 600 }
    ],
    "user": { "id": 99999, "login": "seller123", "feedback_reputation": 4.9 },
    "created_at_ts": 1700000000,
    "updated_at_ts": 1700100000,
    "favourite_count": 12, "view_count": 340,
    "service_fee": "3.50", "city": "Paris", "country_title": "France",
    "color1": "Black", "material_id": 5
  }}}
}
```

**Condition mapping** (status_id → human-readable):
| status_id | Condition          |
|-----------|--------------------|
| 1         | New with tags      |
| 2         | New without tags   |
| 3         | Very good          |

### 5. Vinted Internal API Endpoints

The extension runs in the user's authenticated browser session, inheriting all cookies. Call from content scripts or via `chrome.tabs` + injected fetch:

| Endpoint | Purpose |
|----------|---------|
| `{domain}/api/v2/catalog/items?search_text=...&page=1&per_page=96&order=newest_first` | Search/catalog listing |
| `{domain}/api/v2/users/{user_id}/items?page=1&per_page=96&order=newest_first` | User's own listings |
| `{domain}/api/v2/items/{item_id}` | Single item full detail |

**API parameters**: `per_page` (max 96), `page` (1-based), `order` (newest_first, oldest_first, price_low_to_high, price_high_to_low, relevance), `currency`, `price_from`, `price_to`, `catalog_ids`, `time={unix_ts}` (cache-buster).

**Rate limit**: ~5 req/s. Implement a **token-bucket rate limiter**: max 4 req/s, 200ms min inter-request delay, ±50ms jitter. Never exceed 4 req/s.

### 6. Cloudflare / Anti-Bot Considerations

Vinted uses Cloudflare. The extension runs in the user's already-authenticated browser so most protections are bypassed. However:

- Never expose `navigator.webdriver` (hidden by default in extensions, but verify).
- Do NOT open tabs < 500ms apart — triggers rate limiting.
- Use randomized delays: 800ms–2000ms between tab openings.
- If a tab hits Cloudflare challenge (`document.title` contains "Just a moment..." or `#challenge-running`), close tab, wait 5-10s, retry.
- `fetch()` from content scripts inherits cookies and looks like legitimate XHR — prefer over opening tabs.
- Set `X-Requested-With: XMLHttpRequest` header on API calls to match Vinted's frontend.

### 7. Image CDN & Download Strategy

- Vinted hosts images on a CDN (media.vinted.com or similar).
- `full_size_url` from the API is highest resolution. Use this.
- Images are cross-origin (CDN). Download via `fetch(imageUrl)` from content script, convert to Blob.
- Fallback: `chrome.downloads` API.
- Naming: `{index}.jpg` (1.jpg, 2.jpg, ...). Preserve original extension if known.

### 8. Shipping / Delivery Settings

Present in `__NEXT_DATA__` under `item.delivery_options`:
```json
[
  { "carrier": "Mondial Relay", "price": { "amount": "3.99", "currency_code": "EUR" } }
]
```

---

## PROJECT OVERVIEW

The extension runs on Vinted (user is logged in).

### Core Workflow

1. User navigates to their Vinted profile page (`{domain}/member/{username}`).
2. Extension injects a floating UI button: **"Backup Listings"** (bottom-right, z-index: 99999).
3. When clicked:
   - **Option A (API-first, preferred)**: Extract user ID from `__NEXT_DATA__` or URL, call `{domain}/api/v2/users/{user_id}/items?page=1&per_page=96` iteratively to collect ALL active listing IDs. Then for each listing, call `{domain}/api/v2/items/{item_id}` to extract full data.
   - **Option B (DOM crawl, fallback)**: Extract listing URLs from profile page DOM, scroll-load more, repeat until no new listings for 3 consecutive scrolls.
   - Then for each listing: extract full structured data, download all images.
4. Store each listing as a structured `ListingSnapshot` object in a local backup directory.

---

## DATA MODEL — ListingSnapshot Schema

```typescript
interface ListingSnapshot {
  // Core identity
  id: string;                    // Vinted item ID
  url: string;                   // Full URL to listing detail page
  title: string;
  description: string;

  // Pricing
  price: number;
  originalPrice: number | null;
  currency: string;              // EUR, USD, GBP

  // Category hierarchy
  category: string[];            // Breadcrumb: ["Women","Shoes","Sneakers"]
  catalogId: number | null;

  // Item attributes
  brand: string | null;
  condition: string | null;      // "New with tags", "Very good", etc.
  size: string | null;
  color: string | null;
  material: string | null;

  // Shipping
  shippingOptions: Array<{
    carrier: string;
    price: number;
    currency: string;
  }>;

  // Seller info
  seller: {
    id: number;
    username: string;
    rating: number | null;
  };

  // Engagement
  favouriteCount: number;
  viewCount: number;

  // Timestamps
  createdAt: string;             // ISO 8601
  updatedAt: string;

  // Images
  images: Array<{
    index: number;               // 1-based
    originalUrl: string;         // full_size_url
    localPath: string;           // "images/1.jpg"
    width: number | null;
    height: number | null;
  }>;

  // Metadata
  rawSource: string;             // "api" | "dom"
  scrapedAt: string;             // ISO timestamp
  domain: string;                // e.g. "https://www.vinted.fr"
  region: string;                // e.g. "fr"
}
```

If absent, extract from DOM near "Shipping"/"Delivery" labels.



---

## DATA STORAGE REQUIREMENTS

Use the **File System Access API** (Chrome 86+) as primary storage. Provide **IndexedDB** as seamless fallback.

**Directory structure per backup:**

```
/VintedBackup/
├── backup_manifest.json         # Top-level manifest of all listings
├── Listing_Title_Sanitized_1/
│   ├── metadata.json            # Full ListingSnapshot as JSON
│   ├── images/
│   │   ├── 1.jpg
│   │   └── ...
│   └── raw.html                 # Saved DOM (debugging)
└── Listing_Title_Sanitized_2/
    └── ...
```

**backup_manifest.json schema:**
```json
{
  "version": "1.0.0",
  "createdAt": "2026-01-15T10:30:00.000Z",
  "domain": "https://www.vinted.fr",
  "region": "fr",
  "totalListings": 42,
  "completedListings": 42,
  "failedListings": 0,
  "listings": [
    {
      "id": "123456789",
      "title": "Nike Air Max 90",
      "folder": "Nike_Air_Max_90",
      "price": 45.00,
      "currency": "EUR",
      "imageCount": 5,
      "status": "completed"
    }
  ]
}
```

**Folder name sanitization**: Replace `[^a-zA-Z0-9_\\- ]` with `_`, trim to 64 chars.

---

## ARCHITECTURE — MANIFEST V3

### Permission Model

```json
{
  "manifest_version": 3,
  "name": "Vinted Listing Backup",
  "version": "1.0.0",
  "description": "Backup and restore your Vinted marketplace listings locally.",
  "permissions": ["storage", "tabs", "scripting", "downloads", "notifications"],


### Component Architecture

```
vinted-backup-extension/
├── manifest.json
├── background.js              # Service worker orchestrator
├── content_script.js          # Profile page injection + UI
├── content_styles.css         # Injected button & progress styles
├── listing_extractor.js       # Detail page data extraction
├── storage.js                 # File System Access API + IndexedDB
├── rate_limiter.js            # Token-bucket rate limiter
├── selectors.js               # ALL DOM/CSS selectors in one config
├── next_data_parser.js        # __NEXT_DATA__ extraction & parsing
├── popup.html                 # Extension popup
├── popup.js                   # Popup logic
├── popup.css                  # Popup styles
└── icons/                     # Extension icons (16, 48, 128)
```

### `background.js` — Service Worker (Orchestrator)

The service worker is the **central state machine**:

1. **Scraping queue states**: `pending` → `fetching_detail` → `extracting_data` → `downloading_images` → `saving` → `completed` (terminal: `failed`)
2. **Persist ALL state to `chrome.storage.local`** after every transition.
3. **Use `chrome.alarms`** every 20 seconds to keep alive.
4. **Tab lifecycle**: Create 1 detail tab at a time, wait for extraction, then close.
5. **Retry**: 3 attempts with exponential backoff (2s, 4s, 8s).
6. **Message protocol** — strict message types:

```
// content_script → background
{ type: 'START_BACKUP', listingUrls: string[] }
{ type: 'GET_STATE' }, { type: 'CANCEL_BACKUP' }

// listing_extractor → background (from detail tab)
{ type: 'LISTING_EXTRACTED', snapshot: ListingSnapshot }
{ type: 'EXTRACTION_FAILED', listingId: string, error: string }
```



### `content_script.js` — Profile Page Injection

Runs on `{domain}/member/*` pages. Responsibilities:

1. Detect user is viewing their OWN profile (compare `__NEXT_DATA__` user ID).
2. Inject a floating action button (FAB) at bottom-right, z-index: 99999.
3. Show progress overlay during backup: progress bar, current listing title, X of Y, elapsed time, ETA.
4. Collect listing URLs:
   - Primary: Extract from `__NEXT_DATA__` — `nextData.props.pageProps?.items`.
   - Fallback: Infinite scroll — 600px increments, 400ms pauses, collect `<a href="/items/\d+">`, stop after 3 empty scrolls. Deduplicate by ID.
5. Send `START_BACKUP` message to service worker with all URLs.

### `listing_extractor.js` — Detail Page Extraction

Injected into detail tabs via `chrome.scripting.executeScript()`. Returns `ListingSnapshot`.

**Priority:**
1. Parse `__NEXT_DATA__` (deterministic). Handle `price` as both object and plain value. Map all fields.
2. DOM fallback if `__NEXT_DATA__` missing: title (h1), price (€/$/£ element), description, size, brand, condition, category breadcrumbs, images.
3. Handle lazy-loaded content with `MutationObserver`, max 8s wait.
4. Image carousel: Click "next" arrows, collect all `img[src]`. Check `data-src` attributes.

### `selectors.js` — Centralized Selector Config

```javascript
const SELECTORS = {
  profile: {
    listingCards: 'a[href*="/items/"]',
    listingGrid: '[data-testid="profile-items-grid"]',
    usernameInUrl: /\/member\/([^/?]+)/,
  },
  nextData: {
    scriptId: '__NEXT_DATA__',
    itemPath: 'props.pageProps.item',
    itemsListPath: 'props.pageProps.items',
  },
  detail: {
    title: 'h1, [data-testid="item-title"]',
    price: '[data-testid="item-price"], [class*="price"]',
    description: '[data-testid="item-description"], [itemprop="description"]',
    brand: '[data-testid="item-attribute-brand"]',
    size: '[data-testid="item-attribute-size"]',
    condition: '[data-testid="item-attribute-status"]',
    categoryBreadcrumb: 'nav[aria-label="Breadcrumb"] a, [data-testid="breadcrumb-item"]',
    photoGallery: '[data-testid="item-photo-carousel"]',
    photoImages: 'img[src*="media.vinted"], img[src*="vinted"]',
    carouselNext: 'button[aria-label="Next"], [data-testid="carousel-next"]',
    shippingSection: '[data-testid="item-shipping"]',
    cloudflareChallenge: '#challenge-running',
  },
  cookie: {
    acceptButton: '[data-testid="cookie-consent-accept-button"], #onetrust-accept-btn-handler',
  },
};
```

### `next_data_parser.js` — Deterministic Extraction



---

## UI REQUIREMENTS

Popup (300x400px):
1. **Status**: idle / backing up / complete.
2. **"Select Backup Folder"** — directory picker (needs user gesture).
3. **"Backup All Listings"** — triggers collection then service worker. Disabled if no folder.
4. **Progress**: bar, count, current title, elapsed, ETA.
5. **"Validate Backup"** — checks manifest, metadata, images. Shows summary.
6. **Summary**: total listings, images, disk size, failures.
7. **"Cancel" button** during backup.

Communication: Popup → Background via `chrome.runtime.sendMessage()`. Popup listens on `chrome.runtime.onMessage`.

---

## RESILIENCY & ERROR HANDLING

1. **Checkpoint every listing** to `chrome.storage.local`. Resume on restart.
2. **Retry**: Extraction 3x (2s/4s/8s). Images 2x.
3. **Partial failure**: Log and continue. Manifest tracks completed + failed.
4. **Cloudflare**: Check `document.title` for "Just a moment..." or `#challenge-running`. Close tab, wait 10s, retry.
5. **Timeout**: 30s per listing. Exceeded → mark failed.
6. **Cancellation**: Stop queue, close tabs, persist partial progress.

---

## CRITICAL IMPLEMENTATION NOTES

### DO:
- `__NEXT_DATA__` as primary source — deterministic, always present.
- `chrome.storage.local` for ALL persistent state.
- All selectors in `selectors.js` only.
- Token-bucket rate limiter before every tab/API call.
- `chrome.alarms` to keep service worker alive.
- Sanitize folder names.
- Randomize delays: 800ms-2000ms between tabs.
- Handle `price` as both object `{amount, currency_code}` and plain string/number.

### DO NOT:


---

## OUTPUT REQUIREMENTS

Generate ALL files with complete, production-quality code (JSDoc for non-obvious decisions):

1. **`manifest.json`** — V3 with all 12 regional URL patterns
2. **`background.js`** — Full orchestrator: queue, retry, persistence
3. **`content_script.js`** — FAB button, URL collection, progress overlay
4. **`listing_extractor.js`** — `__NEXT_DATA__` parsing + DOM fallback
5. **`selectors.js`** — Centralized selectors
6. **`next_data_parser.js`** — Extraction logic
7. **`storage.js`** — File System Access + IndexedDB
8. **`rate_limiter.js`** — Token bucket
9. **`popup.html`** — Popup UI
10. **`popup.js`** — Popup logic
11. **`popup.css`** — Popup styles
12. **`content_styles.css`** — Injected styles
13. **`icons/`** — Placeholder icons (16, 48, 128)

---

## DESIGN GOAL

This is not a simple scraper. It is a **transactional backup system** for marketplace listings.

Each listing extraction is an **atomic operation**:
1. Start scrape → 2. Extract data (verify required fields) → 3. Download all images (verify each) → 4. Persist snapshot → 5. Update manifest → 6. Mark completed

No listing is complete unless ALL images AND metadata are successfully stored and validated.
