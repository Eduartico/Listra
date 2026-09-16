/**
 * Listing-page extraction: turns a fetched item page into an API-shaped raw item.
 *
 * Works on a detached Document (DOMParser output) as well as the live one, which is
 * what lets the extension read a listing without opening a tab. Three tiers, each
 * verified or best-effort as marked:
 *
 *   1. The RSC flight payload's plugin blocks (observed live). Deterministic and
 *      carries ids: catalog_id, brand id, size id, status id.
 *   2. The schema.org Product JSON-LD block (observed live). Stable, fewer fields.
 *   3. DOM selectors (best-effort, from the brief). Last resort.
 *
 * The output uses the same field names the wardrobe API uses, so normalize.js
 * remains the single normalizer regardless of where a field came from.
 */
(() => {
  const VB = (globalThis.VB ||= {});
  const S = VB.SELECTORS.detail;
  const CODES = VB.SELECTORS.attributeCodes;
  const PD = VB.pageData;

  /** Symbol -> ISO currency code, for prices that only exist as rendered text. */
  const CURRENCY_BY_SYMBOL = [
    ['€', 'EUR'],
    ['£', 'GBP'],
    ['$', 'USD'],
    ['zł', 'PLN'],
    ['Kč', 'CZK'],
  ];

  function text(root, selector) {
    const el = root.querySelector(selector);
    if (!el) return null;
    const t = (el.textContent || '').trim();
    return t || null;
  }

  /** Pull an amount and a currency out of rendered price text such as "45,00 €". */
  function parsePriceText(raw) {
    if (!raw) return { amount: null, currency: null };
    let currency = null;
    for (const [symbol, code] of CURRENCY_BY_SYMBOL) {
      if (raw.includes(symbol)) {
        currency = code;
        break;
      }
    }
    const m = /(\d[\d\s.,]*)/.exec(raw);
    let amount = null;
    if (m) {
      const cleaned = m[1]
        .replace(/\s/g, '')
        .replace(/\.(?=\d{3}\b)/g, '')
        .replace(',', '.');
      const n = Number(cleaned);
      amount = Number.isFinite(n) ? n : null;
    }
    return { amount, currency };
  }

  /** Largest candidate in a srcset. */
  function largestFromSrcset(srcset) {
    if (!srcset) return null;
    let best = null;
    let bestWidth = -1;
    for (const part of srcset.split(',')) {
      const bits = part.trim().split(/\s+/);
      if (!bits[0]) continue;
      const w = bits[1] && /^(\d+)w$/.test(bits[1]) ? Number(bits[1].slice(0, -1)) : 0;
      if (w >= bestWidth) {
        bestWidth = w;
        best = bits[0];
      }
    }
    return best;
  }

  // ---------------------------------------------------------------------------
  // Tier 1: flight plugins
  // ---------------------------------------------------------------------------

  /**
   * Observed shape of the `attributes` plugin:
   *   { attributes: [ { code: 'brand'|'size'|'status'|'color'|..., data: { id?, title, value } } ] }
   * Returns a map of code -> { id, value, title }.
   *
   * Only the brand id is an entity id (it comes with a /brand/{id}-{slug} URL). The
   * `id` on status and size entries is an FAQ id: observed as 50 for two different
   * condition labels. Those ids are therefore not surfaced; the real condition and
   * size ids come from item_upload for the seller's own items.
   */
  function attributeMap(plugins) {
    const block = plugins.get('attributes');
    const out = new Map();
    if (!block || !Array.isArray(block.attributes)) return out;
    for (const attr of block.attributes) {
      if (!attr || !attr.code || !attr.data) continue;
      out.set(attr.code, {
        id: attr.data.id != null ? attr.data.id : null,
        value: attr.data.value != null ? String(attr.data.value) : null,
        title: attr.data.title || null,
      });
    }
    return out;
  }

  /**
   * Photos from the gallery plugin. The page only exposes `url` (an f800 render)
   * and thumbnails; the wardrobe API is where `full_size_url` lives, so these are
   * the fallback when that record is unavailable.
   */
  function galleryPhotos(plugins) {
    const gallery = plugins.get('gallery') || plugins.get('make_offer');
    if (!gallery || !Array.isArray(gallery.photos)) return [];
    return gallery.photos
      .map((p) => {
        if (!p || !p.url) return null;
        return {
          id: p.id != null ? p.id : null,
          url: p.url,
          full_size_url: p.full_size_url || null,
          width: p.width != null ? p.width : null,
          height: p.height != null ? p.height : null,
          is_main: !!p.is_main,
        };
      })
      .filter(Boolean);
  }

  /**
   * Build an API-shaped item from the flight payload.
   *
   * @param {string} flight
   * @param {string} itemId
   * @returns {object|null} null when the page carries no recognizable item data
   */
  function fromFlight(flight, itemId) {
    const plugins = PD.getItemPlugins(flight);
    if (!plugins.size) return null;

    const attrs = attributeMap(plugins);
    const sidebar = PD.getSidebarItem(flight);
    if (sidebar) {
      // The sidebar's price and photos are RSC references into other flight lines.
      sidebar.price = PD.resolveRef(flight, sidebar.price);
      sidebar.photos = PD.resolveRef(flight, sidebar.photos);
    }
    const breadcrumbs = plugins.get('breadcrumbs');
    const description = plugins.get('description');
    const seller = plugins.get('user_info_header');
    const summary = plugins.get('summary');

    let title = sidebar && sidebar.title ? sidebar.title : null;
    if (!title && summary && Array.isArray(summary.lines)) {
      const first = summary.lines[0] && summary.lines[0].elements && summary.lines[0].elements[0];
      if (first && first.value) title = first.value;
    }

    const brand = attrs.get(CODES.brand);
    const size = attrs.get(CODES.size);
    const status = attrs.get(CODES.status);
    const color = attrs.get(CODES.color);
    const material = attrs.get(CODES.material);
    const upload = attrs.get(CODES.uploadDate);

    const hasSomething =
      title || (breadcrumbs && breadcrumbs.catalog_id) || (description && description.description);
    if (!hasSomething) return null;

    return {
      id: itemId,
      title,
      description: description ? description.description || null : null,
      price: sidebar && sidebar.price ? sidebar.price : null,
      currency: sidebar && sidebar.currency ? sidebar.currency : null,
      catalog_id: breadcrumbs && breadcrumbs.catalog_id != null ? breadcrumbs.catalog_id : sidebar ? sidebar.catalog_id : null,
      catalog_breadcrumbs: breadcrumbs && Array.isArray(breadcrumbs.breadcrumbs) ? breadcrumbs.breadcrumbs : [],
      brand: brand ? brand.value : sidebar && sidebar.brand_dto ? sidebar.brand_dto.title : null,
      brand_id: brand && brand.id != null ? brand.id : breadcrumbs ? breadcrumbs.brand_id : null,
      size: size ? size.value : null,
      status: status ? status.value : null,
      color1: color ? color.value : null,
      material: material ? material.value : null,
      upload_date_text: upload ? upload.value : null,
      photos: galleryPhotos(plugins),
      user: seller
        ? {
            id: sidebar && sidebar.seller_id != null ? sidebar.seller_id : null,
            login: seller.name || null,
            feedback_reputation: seller.feedback_reputation != null ? seller.feedback_reputation : null,
            feedback_count: seller.feedback_count != null ? seller.feedback_count : null,
          }
        : sidebar && sidebar.seller_id != null
          ? { id: sidebar.seller_id }
          : null,
      /** Every plugin block, verbatim, for raw.json. */
      _plugins: Object.fromEntries(plugins),
    };
  }

  // ---------------------------------------------------------------------------
  // Tier 2: JSON-LD
  // ---------------------------------------------------------------------------

  function fromJsonLd(doc, itemId) {
    const product = PD.getJsonLdProduct(doc);
    if (!product || !product.name) return null;
    const offer = product.offers && typeof product.offers === 'object' ? product.offers : {};
    return {
      id: itemId,
      title: product.name,
      description: product.description || null,
      price: offer.price != null ? { amount: offer.price, currency_code: offer.priceCurrency || null } : null,
      currency: offer.priceCurrency || null,
      brand: product.brand && product.brand.name ? product.brand.name : null,
      color1: product.color || null,
      catalog_breadcrumbs: product.category
        ? String(product.category).split(/\s{2,}|\s>\s/).map((title) => ({ title }))
        : [],
      photos: product.image ? [{ url: product.image }] : [],
      url: offer.url || null,
      _jsonld: product,
    };
  }

  // ---------------------------------------------------------------------------
  // Tier 3: selectors
  // ---------------------------------------------------------------------------

  function photosFromDom(doc) {
    const gallery = doc.querySelector(S.photoGallery);
    const scope = gallery || doc;
    const urls = [];
    const seen = new Set();
    for (const img of scope.querySelectorAll(S.photoImages)) {
      const url =
        largestFromSrcset(img.getAttribute('srcset')) ||
        img.getAttribute('src') ||
        img.getAttribute('data-src');
      if (!url || seen.has(url)) continue;
      // Thumbnails carry a size token in the path; skipping the tiny ones keeps a
      // 70px avatar from being backed up as a product photo.
      if (/\/(?:thumb|50x50|70x70|100x100|70x100|150x150|150x210)\//.test(url)) continue;
      seen.add(url);
      urls.push({
        url,
        width: Number(img.getAttribute('width')) || null,
        height: Number(img.getAttribute('height')) || null,
      });
    }
    return urls;
  }

  function fromDom(doc, itemId) {
    const title = text(doc, S.title);
    const price = parsePriceText(text(doc, S.price));
    const photos = photosFromDom(doc);
    if (!title && photos.length === 0) return null;
    return {
      id: itemId,
      title,
      description: text(doc, S.description),
      price: price.amount === null ? null : { amount: price.amount, currency_code: price.currency },
      brand: text(doc, S.brand),
      size: text(doc, S.size),
      status: text(doc, S.condition),
      color1: text(doc, S.color),
      material: text(doc, S.material),
      catalog_breadcrumbs: Array.from(doc.querySelectorAll(S.categoryBreadcrumb))
        .map((n) => (n.textContent || '').trim())
        .filter((t) => t && t.length < 60)
        .map((title) => ({ title })),
      photos,
    };
  }

  // ---------------------------------------------------------------------------

  /**
   * Extract a raw item from a listing document.
   *
   * @param {Document} doc
   * @param {string} itemId
   * @returns {{ok: true, value: object, via: 'flight'|'jsonld'|'dom'} | {ok: false, code: string, message: string}}
   */
  function extractFromDocument(doc, itemId) {
    if (PD.isChallengeDocument(doc)) {
      return VB.fail(VB.ERR.CHALLENGE, 'Listing page returned a bot-protection challenge');
    }

    const flight = PD.getFlightPayload(doc);
    const viaFlight = fromFlight(flight, itemId);
    if (viaFlight) return { ok: true, value: viaFlight, via: 'flight' };

    // Legacy Pages Router payload, should any storefront still serve it.
    const legacy = PD.deepGet(PD.getNextData(doc), VB.SELECTORS.pageData.legacyItemPath);
    if (legacy && typeof legacy === 'object' && (legacy.id != null || legacy.title)) {
      return { ok: true, value: legacy, via: 'flight' };
    }

    const viaJsonLd = fromJsonLd(doc, itemId);
    if (viaJsonLd) return { ok: true, value: viaJsonLd, via: 'jsonld' };

    const viaDom = fromDom(doc, itemId);
    if (viaDom) return { ok: true, value: viaDom, via: 'dom' };

    return VB.fail(
      VB.ERR.SHAPE,
      'Listing page had no flight data, no JSON-LD and no recognizable markup'
    );
  }

  /**
   * Wait for a selector to appear in the live document, capped by
   * LIMITS.lazyContentTimeoutMs.
   */
  function waitForSelector(selector, timeoutMs) {
    const limit = timeoutMs || VB.constants.LIMITS.lazyContentTimeoutMs;
    const existing = document.querySelector(selector);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearTimeout(timer);
        resolve(value);
      };
      const observer = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) finish(el);
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      const timer = setTimeout(() => finish(null), limit);
    });
  }

  VB.domExtractor = {
    extractFromDocument,
    waitForSelector,
    _internals: { parsePriceText, largestFromSrcset, fromFlight, fromJsonLd, attributeMap },
  };
})();
