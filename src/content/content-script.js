/**
 * Content script: the extension's only same-origin foothold on Vinted.
 *
 * Two jobs.
 *
 * 1. The progress overlay the manager page drives while a run is going, and the
 *    Vinted-side helpers (page context, wardrobe listing) that page-actions.js
 *    builds the on-page buttons and menus on.
 *
 * 2. Request proxy. The manager page orchestrates the backup but lives on a
 *    chrome-extension:// origin, so its fetches would carry an extension `Origin`
 *    and a cross-site `Sec-Fetch-Site`. Requests issued from here ride the real
 *    session cookies and carry the same headers Vinted's own frontend sends, so
 *    every /api/v2 call in the extension is made here and relayed back.
 *
 * Injected on every Vinted storefront page, not just profiles, so that any open
 * Vinted tab can serve as the proxy even after the user navigates away from their
 * profile.
 *
 * Data sources, verified live on vinted.pt (2026-09-16):
 *   - /api/v2/wardrobe/{userId}/items  — the listing list, 96 per page, with full
 *     photo records (full_size_url), price, brand, size, status, counts.
 *   - the listing page's RSC payload    — description, breadcrumbs/catalog id, and
 *     attribute ids (brand, size, status, colour).
 *   - /api/v2/item_upload/items/{id}    — exists, owner-only; fetched opportunistically
 *     and kept raw for a future restore.
 * The brief's /api/v2/items/{id} and /api/v2/users/{id}/items both 404 live.
 */
(() => {
  const VB = (globalThis.VB ||= {});

  // The same tab can be re-injected (SPA navigations, extension reload). Without
  // this guard a second message listener would answer every request twice.
  if (VB.__contentScriptLoaded) return;
  VB.__contentScriptLoaded = true;

  const { MSG, ERR } = VB;
  const { LIMITS } = VB.constants;
  const API = VB.SELECTORS.api;
  const SCOPE = 'content';

  const site = VB.constants.detectRegion(location.origin);
  if (!site) {
    VB.log.warn(SCOPE, 'Not a known Vinted storefront, standing down', location.origin);
    return;
  }

  const limiter = new VB.RateLimiter();
  const pageLimiter = new VB.RateLimiter(VB.constants.PAGE_RATE_LIMIT);
  let cookieBannerHandled = false;

  /** Page config read once from the flight payload: CSRF token and anon id. */
  let pageConfig = null;

  /**
   * Wardrobe records by item id, filled during collection. Lets a later
   * PROXY_FETCH_ITEM reuse the list response instead of re-fetching it.
   * @type {Map<string, object>}
   */
  const wardrobeCache = new Map();

  // ---------------------------------------------------------------------------
  // Vinted API access
  // ---------------------------------------------------------------------------

  function readCookie(name) {
    const m = new RegExp('(?:^|; )' + name + '=([^;]*)').exec(document.cookie);
    return m ? decodeURIComponent(m[1]) : null;
  }

  async function getPageConfig() {
    if (pageConfig && pageConfig.csrfToken) return pageConfig;
    const cfg = VB.pageData.getPageConfig(VB.pageData.getFlightPayload());
    if (!cfg.csrfToken) {
      // After a client-side navigation the flight scripts are no longer in the
      // DOM. A fresh copy of the current page still carries the token, escaped
      // inside script text, so it is matched by marker plus UUID shape rather than
      // by exact quoting.
      try {
        const html = await (await fetch(location.href, { credentials: 'same-origin' })).text();
        const m = /CSRF_TOKEN.{0,6}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(html);
        if (m) cfg.csrfToken = m[1];
      } catch {
        /* leave it null; GETs work without it */
      }
    }
    // The anon id is also a plain cookie; the cookie wins when both exist because
    // it is what the browser will actually send alongside the request.
    cfg.anonId = readCookie('anon_id') || cfg.anonId;
    pageConfig = cfg;
    return cfg;
  }

  /**
   * Same-origin GET against Vinted's internal API.
   *
   * Headers mirror what Vinted's own frontend was observed sending: `x-csrf-token`
   * and `x-anon-id`. GETs were observed to succeed on cookies alone, but matching
   * the real client costs nothing. `credentials: 'same-origin'` carries the session
   * cookie. Every call goes through the shared limiter.
   *
   * @param {string} path absolute path beginning with "/"
   * @returns {Promise<{ok: true, value: any} | {ok: false, code: string, message: string}>}
   */
  async function apiGet(path) {
    await limiter.acquire();
    const cfg = await getPageConfig();
    const headers = { Accept: 'application/json, text/plain, */*' };
    if (cfg.csrfToken) headers['x-csrf-token'] = cfg.csrfToken;
    if (cfg.anonId) headers['x-anon-id'] = cfg.anonId;

    let res;
    try {
      res = await fetch(site.domain + path, { method: 'GET', credentials: 'same-origin', headers });
    } catch (err) {
      return VB.fail(ERR.HTTP, 'Network error on ' + path + ': ' + String(err));
    }

    const contentType = res.headers.get('content-type') || '';
    const body = await res.text();

    // Observed: an unknown API path answers 404 with an HTML page, and a
    // bot-protection block answers with HTML too. Neither is JSON to retry.
    if (!contentType.includes('json')) {
      const looksLikeChallenge =
        /just a moment|challenge-running|captcha-delivery|temporariamente restrit|temporarily restricted/i.test(
          body.slice(0, 3000)
        );
      return VB.fail(
        looksLikeChallenge ? ERR.CHALLENGE : ERR.NOT_JSON,
        'Expected JSON from ' + path + ' but got HTTP ' + res.status + ' ' + (contentType || 'no content-type'),
        { status: res.status }
      );
    }

    let json;
    try {
      json = JSON.parse(body);
    } catch (err) {
      return VB.fail(ERR.NOT_JSON, 'Malformed JSON from ' + path + ': ' + String(err));
    }

    if (!res.ok) {
      // Observed error envelope: {"code":106,"message":"...","message_code":"access_denied"}
      return VB.fail(ERR.HTTP, 'HTTP ' + res.status + ' on ' + path + ': ' + (json.message_code || json.message || ''), {
        status: res.status,
        apiCode: json.code,
        messageCode: json.message_code,
      });
    }
    return VB.done(json);
  }

  /**
   * Classify a non-JSON or error response from Vinted so the caller can act on it.
   * A DataDome human check comes back as a 403 whose body is either JSON with a
   * captcha URL or an HTML stub with a `dd` config; both are turned into a
   * HUMAN_CHECK failure that carries a URL a person can open.
   */
  function classifyFailure(path, status, contentType, body) {
    const challenge = VB.relistBody.parseChallenge(body, {
      referer: location.href,
      datadomeCookie: readCookie('datadome'),
    });
    if (challenge) {
      return VB.fail(ERR.HUMAN_CHECK, 'Vinted asked for a human check on ' + path, {
        status,
        captchaUrl: challenge.url,
      });
    }
    if (status === 429) {
      return VB.fail(ERR.RATE_LIMITED, 'Vinted rate-limited ' + path, { status });
    }
    if (!contentType.includes('json')) {
      return VB.fail(ERR.NOT_JSON, 'Expected JSON from ' + path + ' but got HTTP ' + status + ' ' + (contentType || 'no content-type'), { status });
    }
    let json = null;
    try {
      json = JSON.parse(body);
    } catch {
      return VB.fail(ERR.NOT_JSON, 'Malformed JSON from ' + path, { status });
    }
    return VB.fail(ERR.HTTP, 'HTTP ' + status + ' on ' + path + ': ' + (json.message_code || json.message || ''), {
      status,
      apiCode: json.code,
      messageCode: json.message_code,
      details: json.errors || json.details || null,
    });
  }

  /**
   * Same-origin POST against Vinted's internal API, with the same headers the
   * frontend sends. `body` is either a plain object (sent as JSON) or a FormData
   * (sent as multipart, for photo uploads).
   *
   * @param {string} path
   * @param {object|FormData} body
   */
  async function apiPost(path, body) {
    await limiter.acquire();
    const cfg = await getPageConfig();
    const headers = { Accept: 'application/json, text/plain, */*' };
    if (cfg.csrfToken) headers['x-csrf-token'] = cfg.csrfToken;
    if (cfg.anonId) headers['x-anon-id'] = cfg.anonId;
    const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
    const isEmpty = body === null || body === undefined;
    if (!isForm && !isEmpty) headers['content-type'] = 'application/json';
    if (path.startsWith('/api/v2/item_upload') || path.startsWith('/api/v2/photos')) {
      // Observed on the form's own requests. The dynamic-attribute flags are what
      // make the server accept `item_attributes: [{code: 'condition', ...}]`; a
      // create without them answered 500 {"code":105} with an otherwise identical
      // body.
      headers['x-upload-form'] = 'true';
      headers['x-enable-dynamic-attribute-condition'] = 'true';
      headers['x-enable-dynamic-attribute-size'] = 'true';
      headers['x-enable-dynamic-attribute-video-game-rating'] = 'true';
      const locale = readCookie('user-iso-locale') || readCookie('anonymous-iso-locale');
      if (locale) headers.locale = locale;
    }

    let res;
    try {
      res = await fetch(site.domain + path, {
        method: 'POST',
        credentials: 'same-origin',
        headers,
        body: isForm ? body : isEmpty ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      return VB.fail(ERR.HTTP, 'Network error on ' + path + ': ' + String(err));
    }
    const contentType = res.headers.get('content-type') || '';
    const text = await res.text();
    // The create endpoint was observed answering 200 with nothing to parse. That is
    // still a success; the caller resolves what it needs another way.
    if (res.ok && !text.trim()) return VB.done(null);
    if (!res.ok || !contentType.includes('json')) return classifyFailure(path, res.status, contentType, text);
    try {
      return VB.done(JSON.parse(text));
    } catch (err) {
      return VB.fail(ERR.NOT_JSON, 'Malformed JSON from ' + path + ': ' + String(err));
    }
  }

  // ---------------------------------------------------------------------------
  // Relisting: the write side of the API
  // ---------------------------------------------------------------------------

  /**
   * Upload one photo for a new listing.
   *
   * Field names match what Vinted's own form sends (verified live when the
   * recreated listing was published): photo[file], photo[type]=item, and the
   * upload session's temp_uuid so the create call can claim the photo.
   *
   * @param {{bytesBase64: string, mimeType: string, fileName: string, sessionId: string}} msg
   */
  async function uploadPhoto(msg) {
    const bin = atob(msg.bytesBase64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const form = new FormData();
    form.append('photo[file]', new Blob([bytes], { type: msg.mimeType || 'image/jpeg' }), msg.fileName || 'photo.jpg');
    form.append('photo[temp_uuid]', msg.sessionId);
    form.append('photo[type]', 'item');
    const res = await apiPost('/api/v2/photos', form);
    if (!res.ok) return res;
    // Observed: { id, temp_uuid, url, thumbnails, ... }
    if (res.value == null || res.value.id == null) {
      return VB.fail(ERR.SHAPE, 'Photo upload answered without an id', { keys: Object.keys(res.value || {}) });
    }
    return VB.done({ id: res.value.id, tempUuid: res.value.temp_uuid || msg.sessionId });
  }

  /** The attribute form for a category: condition options with their real ids. */
  function attributeForm(catalogId) {
    return apiPost('/api/v2/item_upload/attributes', {
      attributes: [{ code: 'category', value: [Number(catalogId)] }],
    });
  }

  async function createItem(body, excludeId) {
    const res = await apiPost('/api/v2/item_upload/items', body);
    if (!res.ok) return res;
    // Observed: the created item comes back under `item`; some deploys answer bare.
    const item = res.value && res.value.item ? res.value.item : res.value;
    if (item && item.id != null) {
      return VB.done({ id: String(item.id), title: item.title || null, url: item.url || item.path || null });
    }
    // The response body was observed empty on one deploy. The new id is then found
    // in the wardrobe, which lists newest first.
    // Excluding the old listing's id matters: if the create silently failed, the
    // old one would otherwise match by title and be mistaken for the new one.
    const found = await findNewest(body.item.title, excludeId);
    if (found) return VB.done({ id: found.id, title: found.title, url: found.url, resolvedFromWardrobe: true });
    return VB.fail(ERR.SHAPE, 'Create answered without an item id and the wardrobe does not show it yet', {
      keys: Object.keys(res.value || {}),
    });
  }

  /**
   * The newest wardrobe item with a given title, excluding one id. Used when the
   * create response carried no id. A few short retries cover indexing lag.
   */
  async function findNewest(title, excludeId) {
    const ctx = await buildContext();
    const userId = ctx.viewerId;
    if (!userId) return null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (attempt) await new Promise((r) => setTimeout(r, 2500));
      const res = await apiGet(API.wardrobeItems(userId) + '?page=1&per_page=20&order=newest_first');
      if (!res.ok) continue;
      const hit = (res.value.items || []).find(
        (it) => it && String(it.title) === String(title) && String(it.id) !== String(excludeId)
      );
      if (hit) {
        wardrobeCache.set(String(hit.id), hit);
        return { id: String(hit.id), title: hit.title, url: hit.url || null };
      }
    }
    return null;
  }

  function deleteItem(itemId) {
    // No body: the form's own successful delete sent an empty POST. The same call
    // with `{}` and a JSON content-type answered 403 access_denied.
    return apiPost('/api/v2/items/' + encodeURIComponent(itemId) + '/delete', null);
  }

  /** Fetch and parse a listing page. No navigation involved. */
  async function fetchItemPage(itemId) {
    await pageLimiter.acquire();
    let res;
    try {
      res = await fetch(site.domain + '/items/' + itemId, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'text/html' },
      });
    } catch (err) {
      return VB.fail(ERR.HTTP, 'Network error fetching item page: ' + String(err));
    }
    if (!res.ok) {
      return VB.fail(ERR.HTTP, 'HTTP ' + res.status + ' fetching item page', {
        status: res.status,
        retryAfter: Number(res.headers.get('retry-after')) || null,
      });
    }
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const extracted = VB.domExtractor.extractFromDocument(doc, String(itemId));
    if (!extracted.ok) {
      VB.log.warn(SCOPE, 'Item page ' + itemId + ' not extractable', {
        code: extracted.code,
        status: res.status,
        finalUrl: res.url,
        bytes: html.length,
        title: (html.match(/<title>([^<]*)/) || [])[1] || null,
      });
    }
    // The markup is worth keeping only when the selectors were actually used: that
    // is the case where someone will need to see what the page looked like.
    if (extracted.ok && extracted.via === 'dom') extracted.html = html;
    return extracted;
  }

  // ---------------------------------------------------------------------------
  // Page context
  // ---------------------------------------------------------------------------

  /** `{ id, login }` from a /member/{id}-{login} URL, or null off a profile page. */
  function profileFromUrl() {
    const m = VB.SELECTORS.profile.profileInUrl.exec(location.pathname);
    if (!m) return null;
    return { id: Number(m[1]), login: m[2] ? decodeURIComponent(m[2]) : null };
  }

  function onProfilePage() {
    return profileFromUrl() !== null;
  }

  function signedIn() {
    return !document.querySelector(VB.SELECTORS.auth.headerLoginButton);
  }

  /**
   * Who is signed in, and whose profile is this.
   *
   *   1. profile id from the URL (observed: /member/{id}-{login})
   *   2. viewer id from /api/v2/users/current (observed: 403 when signed out)
   *   3. legacy __NEXT_DATA__ paths, should a storefront still serve them
   *
   * `isOwnProfile: null` is reported honestly rather than guessed, and the UI asks
   * the user to confirm in that case.
   */
  async function buildContext() {
    const fromUrl = profileFromUrl();
    const legacy = VB.pageData.getNextData();
    const P = VB.SELECTORS.pageData;

    const profileId =
      fromUrl && fromUrl.id ? fromUrl.id : VB.pageData.firstPath(legacy, P.legacyProfileUserPaths);

    let viewerId = VB.pageData.firstPath(legacy, P.legacyViewerPaths);
    let viewerLogin = null;
    if (viewerId == null && signedIn()) {
      const current = await apiGet(API.currentUser);
      if (current.ok) {
        const u = current.value.user || current.value;
        viewerId = u && u.id != null ? u.id : null;
        viewerLogin = u && u.login ? u.login : null;
      } else {
        VB.log.info(SCOPE, 'Could not resolve signed-in user id', current.code);
      }
    }

    const numericViewer = viewerId == null ? null : Number(viewerId);
    const numericProfile = profileId == null ? null : Number(profileId);
    const isOwnProfile =
      numericViewer && numericProfile ? numericViewer === numericProfile : null;

    return {
      region: site.region,
      domain: site.domain,
      href: location.href,
      onProfilePage: onProfilePage(),
      signedIn: signedIn(),
      // Observed: own-profile links are often /member/{id} with no slug, so the
      // signed-in login fills in when the URL has none and the profile is ours.
      username:
        (fromUrl && fromUrl.login) ||
        (isOwnProfile !== false ? viewerLogin : null),
      viewerId: numericViewer,
      profileUserId: numericProfile,
      isOwnProfile,
    };
  }

  /** Dismiss the cookie consent dialog once, if it is up; it can swallow clicks. */
  function dismissCookieBanner() {
    if (cookieBannerHandled) return;
    const btn = document.querySelector(VB.SELECTORS.cookie.acceptButton);
    if (btn) {
      cookieBannerHandled = true;
      btn.click();
      VB.log.info(SCOPE, 'Dismissed cookie consent dialog');
    }
  }

  // ---------------------------------------------------------------------------
  // Listing collection
  // ---------------------------------------------------------------------------

  /**
   * Every listing in a user's wardrobe, via the API. Fills wardrobeCache.
   *
   * @param {number|string} userId
   * @param {number} [limit] stop early; used by the manager's "first N" test run
   * @returns {Promise<{ok: true, value: string[]} | {ok: false, code: string, message: string}>}
   */
  /**
   * Every wardrobe record for a user, newest first, across all pages. Records
   * are also kept in wardrobeCache so a later PROXY_FETCH_ITEM can reuse them.
   *
   * @param {number|string} userId
   * @param {number|null} [limit] stop once this many records are in hand
   * @returns {Promise<{ok: true, value: object[]} | {ok: false, code: string, message: string}>}
   */
  async function fetchWardrobeRecords(userId, limit) {
    const records = [];
    const seen = new Set();
    let page = 1;
    let totalPages = null;

    for (;;) {
      const qs = '?page=' + page + '&per_page=' + LIMITS.perPage + '&order=newest_first';
      const res = await apiGet(API.wardrobeItems(userId) + qs);
      if (!res.ok) {
        // Failing on page 1 means the endpoint is unusable and the caller should
        // fall back. Failing later means most of the list is in hand; keep it and
        // report the gap.
        if (page === 1) return res;
        VB.log.warn(SCOPE, 'Wardrobe listing stopped early at page ' + page, res.code);
        break;
      }

      const items = Array.isArray(res.value.items) ? res.value.items : [];
      for (const it of items) {
        if (!it || it.id == null) continue;
        const key = String(it.id);
        // Deduped within this listing only; the cache may hold an earlier run's
        // records and must not hide ids from a later one.
        if (seen.has(key)) continue;
        seen.add(key);
        records.push(it);
        wardrobeCache.set(key, it);
      }

      if (totalPages === null) {
        totalPages = Number(VB.pageData.deepGet(res.value, 'pagination.total_pages')) || null;
      }
      if (limit && records.length >= limit) break;
      if (totalPages ? page >= totalPages : items.length < LIMITS.perPage) break;
      page += 1;
      if (page > 200) {
        VB.log.warn(SCOPE, 'Stopped paginating at page 200');
        break;
      }
    }

    VB.log.info(SCOPE, 'Wardrobe listed ' + records.length + ' items over ' + page + ' page(s)');
    return VB.done(limit ? records.slice(0, limit) : records);
  }

  async function collectViaWardrobe(userId, limit) {
    const res = await fetchWardrobeRecords(userId, limit);
    if (!res.ok) return res;
    return VB.done(res.value.map((it) => String(it.id)));
  }

  /** Fallback collection by crawling the rendered grid with scroll steps. */
  async function collectViaScroll(limit) {
    const re = VB.SELECTORS.profile.itemIdInHref;
    const ids = [];
    const seen = new Set();
    let emptyRounds = 0;

    const harvest = () => {
      let added = 0;
      for (const a of document.querySelectorAll(VB.SELECTORS.profile.listingCards)) {
        const m = re.exec(a.getAttribute('href') || '');
        if (!m || seen.has(m[1])) continue;
        seen.add(m[1]);
        ids.push(m[1]);
        added += 1;
      }
      return added;
    };

    harvest();
    while (emptyRounds < LIMITS.scrollEmptyRoundsBeforeStop) {
      if (limit && ids.length >= limit) break;
      window.scrollBy(0, LIMITS.scrollStepPx);
      await new Promise((r) => setTimeout(r, LIMITS.scrollPauseMs));
      emptyRounds = harvest() > 0 ? 0 : emptyRounds + 1;
    }
    window.scrollTo(0, 0);
    VB.log.info(SCOPE, 'Scroll crawl collected ' + ids.length + ' listing ids');
    return VB.done(limit ? ids.slice(0, limit) : ids);
  }

  async function collectItemIds(opts) {
    const o = opts || {};
    if (o.userId) {
      const viaApi = await collectViaWardrobe(o.userId, o.limit);
      if (viaApi.ok && viaApi.value.length) return viaApi;
      VB.log.warn(SCOPE, 'Wardrobe API unusable, falling back to scroll crawl', viaApi.ok ? 'empty' : viaApi.code);
    }
    if (!onProfilePage()) {
      return VB.fail(ERR.NOT_VINTED, 'Cannot crawl listings: this tab is not on a profile page');
    }
    return collectViaScroll(o.limit);
  }

  // ---------------------------------------------------------------------------
  // Reference data: catalog tree and colours, fetched once per tab
  // ---------------------------------------------------------------------------

  /** catalog id -> ["Mulher", "Roupa", ...]; built from /item_upload/catalogs. */
  let catalogPaths = null;
  /** colour id -> localized title; from /item_upload/colors. */
  let colorTitles = null;

  async function ensureCatalogPaths() {
    if (catalogPaths) return catalogPaths;
    catalogPaths = new Map();
    const res = await apiGet(API.catalogs);
    if (!res.ok) {
      VB.log.warn(SCOPE, 'Catalog tree unavailable; category paths will come from pages only', res.code);
      return catalogPaths;
    }
    // Observed shape: { catalogs: [ { id, title, catalogs: [ ... ] } ] }
    const walk = (nodes, trail) => {
      for (const node of nodes || []) {
        if (!node || node.id == null) continue;
        const path = trail.concat(node.title || '');
        catalogPaths.set(String(node.id), path);
        walk(node.catalogs, path);
      }
    };
    walk(res.value.catalogs, []);
    VB.log.info(SCOPE, 'Catalog tree loaded: ' + catalogPaths.size + ' categories');
    return catalogPaths;
  }

  async function ensureColorTitles() {
    if (colorTitles) return colorTitles;
    colorTitles = new Map();
    const res = await apiGet(API.colors);
    if (!res.ok) return colorTitles;
    // Observed shape: { colors: [ { id, title, hex, code } ] }
    for (const c of res.value.colors || []) if (c && c.id != null) colorTitles.set(String(c.id), c.title);
    return colorTitles;
  }

  // ---------------------------------------------------------------------------
  // One listing, assembled from its sources
  // ---------------------------------------------------------------------------

  /**
   * Fetch a listing page with 429 awareness.
   *
   * Observed live: Vinted rate-limits item-page HTML far more tightly than the
   * JSON API (429s appeared at under one page per second). Each 429 honours
   * Retry-After, backs off, and slows the page limiter for the rest of the tab's
   * life so the run settles below the threshold instead of hammering it.
   */
  async function fetchItemPageWithBackoff(id) {
    let page = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      page = await fetchItemPage(id);
      if (page.ok) return page;
      let wait = 3000;
      if (page.status === 429) {
        pageLimiter.minIntervalMs = Math.min(15000, pageLimiter.minIntervalMs * 2);
        wait = Math.max((page.retryAfter || 0) * 1000, 15000 * (attempt + 1));
        VB.log.warn(SCOPE, 'Item page ' + id + ' rate limited; waiting ' + wait + 'ms, page spacing now ' + pageLimiter.minIntervalMs + 'ms');
      } else if (page.code === ERR.CHALLENGE) {
        wait = 10000;
      }
      await new Promise((r) => setTimeout(r, wait));
    }
    return page;
  }

  /**
   * Assemble a raw item for one listing.
   *
   * Sources, most authoritative first for each field:
   *   wardrobe record  — title, price, photos with full_size_url, counts, flags
   *   item_upload      — the seller's own editable record: description and every id
   *   listing page     — description, breadcrumbs, brand id for listings the
   *                      seller cannot edit (sold ones), and the upload-date label
   *
   * The page is fetched only when item_upload did not answer: it is 2 MB and
   * tightly rate-limited, while for the seller's own live listings everything it
   * would add is already available from item_upload plus the catalog tree.
   *
   * @param {string} itemId
   * @param {number|string} [userId] lets a cold cache be refilled from the wardrobe
   */
  async function fetchItem(itemId, userId) {
    const id = String(itemId);

    if (!wardrobeCache.has(id) && userId) {
      // A resumed run in a fresh tab has an empty cache; one listing pass refills it.
      await collectViaWardrobe(userId, null);
    }
    const wardrobe = wardrobeCache.get(id) || null;

    // Owner-only endpoint; 403 for someone else's or a sold item is expected.
    const up = await apiGet(API.itemUpload(id));
    const upload = up.ok ? up.value : null;
    // Observed shape: { item: { catalog_id, brand_id, color1_id, color2_id, size_id,
    // package_size_id, description, item_attributes: [{code:'condition', ids:[n]}] } }
    const own = upload && upload.item && typeof upload.item === 'object' ? upload.item : null;
    const condition = own && Array.isArray(own.item_attributes)
      ? own.item_attributes.find((a) => a && a.code === 'condition')
      : null;

    let page = { ok: false, code: 'SKIPPED', message: 'not needed: item_upload answered' };
    if (!own || !own.catalog_id) page = await fetchItemPageWithBackoff(id);
    if (!wardrobe && !own && !page.ok) return page;
    const pageItem = page.ok ? page.value : null;

    const paths = own && own.catalog_id ? await ensureCatalogPaths() : null;
    const colors = own && (own.color1_id != null || own.color2_id != null) ? await ensureColorTitles() : null;

    const catalogId = (own && own.catalog_id) || (pageItem && pageItem.catalog_id) || null;
    const pageCrumbs = pageItem && Array.isArray(pageItem.catalog_breadcrumbs) ? pageItem.catalog_breadcrumbs : [];
    const treeCrumbs = paths && catalogId && paths.has(String(catalogId))
      ? paths.get(String(catalogId)).map((title) => ({ title }))
      : [];

    const merged = {
      ...(pageItem || {}),
      ...(wardrobe || {}),
      id,
      catalog_id: catalogId,
      catalog_breadcrumbs: pageCrumbs.length ? pageCrumbs : treeCrumbs,
      brand_id: (own && own.brand_id) || (pageItem && pageItem.brand_id) || null,
      size_id: own ? own.size_id : null,
      status_id: condition && Array.isArray(condition.ids) && condition.ids.length ? condition.ids[0] : null,
      color1_id: own ? own.color1_id : null,
      color2_id: own ? own.color2_id : null,
      package_size_id: own ? own.package_size_id : null,
      is_unisex: own ? own.is_unisex : null,
      isbn: own ? own.isbn : null,
      measurement_length: own ? own.measurement_length : null,
      measurement_width: own ? own.measurement_width : null,
      description:
        (own && own.description) || (pageItem && pageItem.description) || (wardrobe && wardrobe.description) || null,
      color1:
        (pageItem && pageItem.color1) ||
        (colors && own.color1_id != null && colors.get(String(own.color1_id))) ||
        (wardrobe && wardrobe.color1) || null,
      color2: (colors && own && own.color2_id != null && colors.get(String(own.color2_id))) || null,
      material: (pageItem && pageItem.material) || (wardrobe && wardrobe.material) || null,
      upload_date_text: pageItem ? pageItem.upload_date_text : null,
      // The page knows the seller's rating; the wardrobe record only the id/login.
      user: { ...((pageItem && pageItem.user) || {}), ...((wardrobe && wardrobe.user) || {}) },
      // Wardrobe photos carry full_size_url; page photos are the f800 render.
      photos:
        wardrobe && Array.isArray(wardrobe.photos) && wardrobe.photos.length
          ? wardrobe.photos
          : (own && Array.isArray(own.photos) && own.photos.length ? own.photos : (pageItem && pageItem.photos) || []),
      _sources: {
        wardrobe: !!wardrobe,
        upload: !!own,
        uploadError: up.ok ? null : up.code + ': ' + up.message,
        page: page.ok ? page.via : null,
        pageError: page.ok ? null : page.code + ': ' + page.message,
        categoryFrom: pageCrumbs.length ? 'page' : treeCrumbs.length ? 'catalog-tree' : null,
      },
      _raw: {
        wardrobe,
        upload,
        page: pageItem ? pageItem._plugins || pageItem._jsonld || null : null,
      },
    };
    delete merged._plugins;
    delete merged._jsonld;

    return {
      ok: true,
      value: merged,
      via: wardrobe || own ? 'api' : page.via,
      html: page.ok ? page.html : undefined,
    };
  }

  // ---------------------------------------------------------------------------
  // Injected UI: the backup progress overlay. The buttons and menus live in
  // page-actions.js, which is loaded after this file.
  // ---------------------------------------------------------------------------

  let overlayEl = null;

  function ensureOverlay() {
    if (overlayEl && document.body.contains(overlayEl)) return overlayEl;
    overlayEl = document.createElement('div');
    overlayEl.className = 'vb-overlay';
    // Static markup only — every value that comes from a listing is written
    // through textContent in renderOverlay, never interpolated into HTML.
    overlayEl.innerHTML =
      '<div class="vb-overlay__head">' +
      '<span class="vb-overlay__title">Backing up listings</span>' +
      '<span class="vb-overlay__count" data-vb="count"></span>' +
      '</div>' +
      '<div class="vb-overlay__bar"><div class="vb-overlay__fill" data-vb="fill"></div></div>' +
      '<div class="vb-overlay__current" data-vb="current"></div>' +
      '<div class="vb-overlay__meta" data-vb="meta"></div>';
    document.body.appendChild(overlayEl);
    return overlayEl;
  }

  /** Render a progress payload sent by the manager page. */
  function renderOverlay(progress) {
    if (!progress || progress.status === 'idle') {
      if (overlayEl) overlayEl.remove();
      overlayEl = null;
      return;
    }
    const el = ensureOverlay();
    const total = progress.total || 0;
    const done = progress.completed || 0;
    const failed = progress.failed || 0;
    const pct = total ? Math.round(((done + failed) / total) * 100) : 0;

    el.querySelector('[data-vb="count"]').textContent = done + ' / ' + total;
    el.querySelector('[data-vb="fill"]').style.width = pct + '%';
    el.querySelector('[data-vb="current"]').textContent = progress.currentTitle || '';
    const bits = [];
    if (progress.elapsedText) bits.push(progress.elapsedText + ' elapsed');
    if (progress.etaText) bits.push('about ' + progress.etaText + ' left');
    if (failed) bits.push(failed + ' failed');
    if (progress.status === 'cancelled') bits.push('cancelled');
    el.querySelector('[data-vb="meta"]').textContent = bits.join(' · ');
  }

  // ---------------------------------------------------------------------------
  // Message handling
  // ---------------------------------------------------------------------------

  /**
   * Run a handler and always call sendResponse, even if it throws.
   *
   * Without this, an unexpected exception (e.g. res.text() failing mid-stream on
   * a dropped connection) leaves sendResponse uncalled and the manager's message
   * port open with nothing ever arriving on it. The manager's own per-listing
   * timeout eventually recovers from that, but only after wasting up to 30s per
   * attempt across all 3 retries; failing fast here means a real error is
   * reported immediately instead of masquerading as a hang.
   *
   * @param {() => Promise<any>} fn
   * @param {(value: any) => void} sendResponse
   */
  function guarded(fn, sendResponse) {
    Promise.resolve()
      .then(fn)
      .then(sendResponse, (err) => {
        VB.log.error(SCOPE, 'Message handler threw', String((err && err.stack) || err));
        sendResponse(VB.fail(ERR.HTTP, 'Unexpected error: ' + String(err)));
      });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return false;

    switch (message.type) {
      case MSG.PING:
        sendResponse(VB.done(true));
        return false;

      case MSG.PROXY_CONTEXT:
        guarded(async () => VB.done(await buildContext()), sendResponse);
        return true;

      case MSG.PROXY_COLLECT_IDS:
        guarded(() => collectItemIds(message.options || {}), sendResponse);
        return true;

      case MSG.PROXY_FETCH_ITEM:
        guarded(() => fetchItem(message.itemId, message.userId), sendResponse);
        return true;

      case MSG.PROXY_FETCH_HTML:
        guarded(() => fetchItemPage(message.itemId), sendResponse);
        return true;

      case MSG.PROXY_UPLOAD_PHOTO:
        guarded(() => uploadPhoto(message), sendResponse);
        return true;

      case MSG.PROXY_ATTRIBUTE_FORM:
        guarded(() => attributeForm(message.catalogId), sendResponse);
        return true;

      case MSG.PROXY_COLORS:
        guarded(() => apiGet(API.colors), sendResponse);
        return true;

      case MSG.PROXY_CREATE_ITEM:
        guarded(() => createItem(message.body, message.excludeId), sendResponse);
        return true;

      case MSG.PROXY_DELETE_ITEM:
        guarded(() => deleteItem(message.itemId), sendResponse);
        return true;

      case MSG.OVERLAY_UPDATE:
        renderOverlay(message.progress);
        sendResponse({ ok: true });
        return false;

      case MSG.RELIST_PROGRESS:
        if (VB.pageActions) VB.pageActions.onRelistProgress(message.progress);
        sendResponse({ ok: true });
        return false;

      default:
        return false;
    }
  });

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  /** What page-actions.js needs from this file. */
  VB.content = {
    site,
    apiGet,
    buildContext,
    fetchWardrobeRecords,
    profileFromUrl,
    onProfilePage,
    signedIn,
    dismissCookieBanner,
    renderOverlay,
  };

  (async function boot() {
    dismissCookieBanner();
    VB.log.info(SCOPE, 'Loaded on ' + site.region + ' ' + location.pathname);

    // Restore the backup overlay if a run is already in flight and the user came
    // back to this tab.
    const state = await chrome.runtime.sendMessage({ type: MSG.GET_STATE }).catch(() => null);
    if (state && state.ok && state.value && state.value.status === 'running') {
      renderOverlay(state.value.progress);
    }
  })();
})();
