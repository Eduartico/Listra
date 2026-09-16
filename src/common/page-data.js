/**
 * Reading the data Vinted embeds in its pages.
 *
 * Verified live on 2026-09-16 against vinted.pt: Vinted runs the Next.js App
 * Router. Pages carry their server data as a React Server Components "flight"
 * stream, split across many `self.__next_f.push([1, "..."])` script tags. There is
 * no `<script id="__NEXT_DATA__">` at all — the Pages Router block the original brief
 * assumed. The legacy reader is kept in case a storefront still serves it, but the
 * flight reader is the one that does the work.
 *
 * The flight text is a sequence of `id:payload` lines whose payloads are JSON. Two
 * things in it matter to us:
 *
 *   - page config, including CSRF_TOKEN and the anon_id cookie value
 *   - on a listing page, the "plugin" blocks the item page is assembled from:
 *     `{"data":{...},"name":"breadcrumbs","section":"content","type":"breadcrumbs"}`
 *     and likewise for `attributes`, `description`, `gallery`, `summary`, ...
 *
 * Rather than parse the whole RSC graph, the reader locates those blocks by their
 * `"name"` key and parses the enclosing balanced object, so the key order Vinted
 * happens to serialize (it differs between anonymous and signed-in renders) does
 * not matter. It is a targeted read of a format we do not control, so everything
 * here is defensive: nothing throws, absence is null.
 */
(() => {
  const VB = (globalThis.VB ||= {});
  const S = VB.SELECTORS.pageData;

  // ---------------------------------------------------------------------------
  // Legacy: Pages Router __NEXT_DATA__
  // ---------------------------------------------------------------------------

  /**
   * @param {Document} [doc]
   * @returns {object|null} null when the block is absent — the normal case now
   */
  function getNextData(doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d) return null;
    const el = d.getElementById(S.nextDataScriptId);
    if (!el || !el.textContent) return null;
    try {
      return JSON.parse(el.textContent);
    } catch (err) {
      VB.log.warn('page-data', '__NEXT_DATA__ present but did not parse', String(err));
      return null;
    }
  }

  /** Read a dotted path without throwing on a missing link in the chain. */
  function deepGet(obj, path) {
    if (!obj || typeof path !== 'string') return undefined;
    let cur = obj;
    for (const key of path.split('.')) {
      if (cur == null || typeof cur !== 'object') return undefined;
      cur = cur[key];
    }
    return cur;
  }

  /** First defined value among several candidate paths. */
  function firstPath(obj, paths) {
    for (const p of paths || []) {
      const v = deepGet(obj, p);
      if (v !== undefined && v !== null) return v;
    }
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // App Router: the flight stream
  // ---------------------------------------------------------------------------

  /**
   * Concatenate every `self.__next_f.push([1, "..."])` payload in document order.
   * Only type-1 chunks carry data; others are bootstrap markers.
   *
   * @param {Document} [doc]
   * @returns {string} the flight text, "" when the page has none
   */
  function getFlightPayload(doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d) return '';
    let out = '';
    for (const script of d.querySelectorAll('script')) {
      out += flightFromScriptText(script.textContent || '');
    }
    return out;
  }

  /**
   * The flight payload carried by one script tag's text. A tag can hold several
   * pushes; each is `self.__next_f.push([...])`. The array is found by a
   * bracket-aware scan rather than a regex, because the payload string routinely
   * contains "])" sequences that would end a lazy match early.
   *
   * @param {string} text
   * @returns {string}
   */
  function flightFromScriptText(text) {
    if (!text || !text.includes(S.flightMarker)) return '';
    let out = '';
    let from = 0;
    for (;;) {
      const at = text.indexOf(S.flightMarker + '(', from);
      if (at === -1) break;
      const start = at + S.flightMarker.length + 1;
      const raw = arrayStartingAt(text, start);
      if (!raw) break;
      from = start + raw.length;
      try {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr[0] === 1 && typeof arr[1] === 'string') out += arr[1];
      } catch {
        /* a push we could not parse; skip it rather than lose the rest */
      }
    }
    return out;
  }

  /** Given the index of an opening bracket, return the balanced array starting there. */
  function arrayStartingAt(text, start) {
    if (text[start] !== '[') return null;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i += 1) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '[') depth += 1;
      else if (c === ']') {
        depth -= 1;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    return null;
  }

  /**
   * Given the index of a closing brace, return the balanced object ending there.
   * Walks backwards, skipping string contents. Used to lift a plugin block out of
   * the flight text once its signature has been located.
   */
  function objectEndingAt(text, endExclusive) {
    let depth = 0;
    let inStr = false;
    for (let i = endExclusive - 1; i >= 0; i -= 1) {
      const c = text[i];
      if (inStr) {
        if (c === '"' && text[i - 1] !== '\\') inStr = false;
        continue;
      }
      if (c === '"') {
        inStr = true;
        continue;
      }
      if (c === '}') depth += 1;
      else if (c === '{') {
        depth -= 1;
        if (depth === 0) return text.slice(i, endExclusive);
      }
    }
    return null;
  }

  /** Given the index of an opening brace, return the balanced object starting there. */
  function objectStartingAt(text, start) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i += 1) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    return null;
  }

  /**
   * Resolve an RSC reference such as "$ea:props:value:price".
   *
   * Flight lines are `id:json`; a value that is a string beginning with "$" and a
   * hex id points at another line, with the rest of the string as a colon-separated
   * path into that line's JSON. Observed on the sidebar item, whose `price` and
   * `photos` are references to the props of the component that rendered them.
   *
   * @param {string} flight
   * @param {any} value returned unchanged when it is not a reference
   * @param {number} [depth] guards against reference cycles
   */
  function resolveRef(flight, value, depth) {
    if (typeof value !== 'string' || value[0] !== '$') return value;
    const m = /^\$([0-9a-f]+)(?::(.*))?$/i.exec(value);
    if (!m) return value;
    if ((depth || 0) > 4) return null;

    const marker = '\n' + m[1] + ':';
    let at = flight.startsWith(m[1] + ':') ? 0 : flight.indexOf(marker);
    if (at === -1) return null;
    if (at > 0) at += 1;
    const lineStart = at + m[1].length + 1;
    let lineEnd = flight.indexOf('\n', lineStart);
    if (lineEnd === -1) lineEnd = flight.length;

    let parsed;
    try {
      parsed = JSON.parse(flight.slice(lineStart, lineEnd));
    } catch {
      return null;
    }
    let cur = parsed;
    for (const key of m[2] ? m[2].split(':') : []) {
      if (cur == null || typeof cur !== 'object') return null;
      // A React element is serialized as ["$", type, key, props]; "props" in a
      // reference path means the fourth slot of that tuple.
      if (key === 'props' && Array.isArray(cur) && cur[0] === '$') cur = cur[3];
      else cur = cur[key];
    }
    return resolveRef(flight, cur, (depth || 0) + 1);
  }

  /**
   * Page-level config from the flight text: the CSRF token Vinted's own frontend
   * sends as `x-csrf-token`, and the anon id it sends as `x-anon-id`.
   *
   * @param {string} flight
   * @returns {{csrfToken: string|null, anonId: string|null}}
   */
  function getPageConfig(flight) {
    const out = { csrfToken: null, anonId: null };
    if (!flight) return out;
    const csrf = new RegExp(S.csrfTokenPattern).exec(flight);
    if (csrf) out.csrfToken = csrf[1];
    const anon = new RegExp(S.anonIdPattern).exec(flight);
    if (anon) out.anonId = anon[1];
    return out;
  }

  /**
   * The item-page plugin blocks, keyed by plugin name (`breadcrumbs`, `attributes`,
   * `description`, `gallery`, `summary`, `user_info_header`, ...). Each value is the
   * block's `data` object. First occurrence wins; the page repeats some blocks for
   * mobile and desktop layouts with identical data.
   *
   * @param {string} flight
   * @returns {Map<string, object>}
   */
  function getItemPlugins(flight) {
    const plugins = new Map();
    if (!flight) return plugins;
    const re = new RegExp(S.pluginNamePattern, 'g');
    let m;
    while ((m = re.exec(flight))) {
      const name = m[1];
      if (plugins.has(name)) continue;
      const raw = enclosingObject(flight, m.index);
      if (!raw) continue;
      try {
        const obj = JSON.parse(raw);
        // A plugin block has data plus a type or section; a <meta name=...> tag
        // serialized into the stream has neither and is skipped here.
        if (obj && obj.data && typeof obj.data === 'object' && (obj.type || obj.section)) {
          plugins.set(name, obj.data);
        }
      } catch {
        /* a block whose JSON we could not lift; the others still count */
      }
    }
    return plugins;
  }

  /**
   * The smallest JSON object that contains position `idx`. Walks backwards to the
   * unmatched opening brace, then forwards over the balanced object.
   */
  function enclosingObject(text, idx) {
    let depth = 0;
    let inStr = false;
    let start = -1;
    for (let i = idx - 1; i >= 0; i -= 1) {
      const c = text[i];
      if (inStr) {
        if (c === '"' && text[i - 1] !== '\\') inStr = false;
        continue;
      }
      if (c === '"') {
        inStr = true;
        continue;
      }
      if (c === '}') depth += 1;
      else if (c === '{') {
        if (depth === 0) {
          start = i;
          break;
        }
        depth -= 1;
      }
    }
    if (start === -1) return null;
    return objectStartingAt(text, start);
  }

  /**
   * The sidebar's compact item object — id, title, price, currency, catalog_id,
   * brand_dto, seller_id. It is the one place on the page with the price as a
   * proper `{amount, currency_code}` object.
   *
   * @param {string} flight
   * @returns {object|null}
   */
  function getSidebarItem(flight) {
    if (!flight) return null;
    let at = -1;
    let best = null;
    while ((at = flight.indexOf(S.sidebarItemKey, at + 1)) !== -1) {
      const raw = objectStartingAt(flight, at + S.sidebarItemKey.length - 1);
      if (!raw) continue;
      try {
        const obj = JSON.parse(raw);
        if (obj && obj.id != null && obj.title && (!best || Object.keys(obj).length > Object.keys(best).length)) {
          best = obj;
        }
      } catch {
        /* not a complete object at this position */
      }
    }
    return best;
  }

  /**
   * The schema.org Product block Vinted emits for search engines. Cheap, stable,
   * and carries description, price, brand, colour and category text.
   *
   * @param {Document} doc
   * @returns {object|null}
   */
  function getJsonLdProduct(doc) {
    if (!doc) return null;
    for (const script of doc.querySelectorAll(S.jsonLdSelector)) {
      try {
        const parsed = JSON.parse(script.textContent || '');
        const list = Array.isArray(parsed) ? parsed : [parsed];
        const product = list.find((x) => x && x['@type'] === 'Product');
        if (product) return product;
      } catch {
        /* malformed block */
      }
    }
    return null;
  }

  /**
   * Whether a document is a bot-protection interstitial rather than a Vinted page.
   * Vinted uses DataDome (observed) and Cloudflare (per the brief); both are checked.
   */
  function isChallengeDocument(doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d) return false;
    if (d.querySelector(VB.SELECTORS.detail.challengeContainer)) return true;
    const title = String(d.title || '').toLowerCase();
    return VB.SELECTORS.challengeTitles.some((frag) => title.includes(frag));
  }

  VB.pageData = {
    // legacy
    getNextData,
    deepGet,
    firstPath,
    // app router
    getFlightPayload,
    flightFromScriptText,
    getPageConfig,
    getItemPlugins,
    getSidebarItem,
    resolveRef,
    getJsonLdProduct,
    isChallengeDocument,
    _internals: { objectEndingAt, objectStartingAt, arrayStartingAt, enclosingObject },
  };
})();
