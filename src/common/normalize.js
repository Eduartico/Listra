/**
 * Raw Vinted item -> ListingSnapshot.
 *
 * This module is the single place that knows Vinted field names. The field names
 * it reads were verified against vinted.pt on 2026-09-16 (wardrobe API records and
 * listing-page data); variants from the original brief are still accepted so a
 * storefront on an older layout keeps working. When it meets something it does not
 * recognise it records the actual keys instead of silently writing a half-empty
 * snapshot. If Vinted renames something, this file and selectors.js are the only
 * two that need editing.
 *
 * Every extraction path (wardrobe record, listing page, DOM fallback) produces an
 * object using these same field names, so there is one normalizer rather than
 * three.
 *
 * @typedef {object} ListingSnapshot see README for the full documented schema
 */
(() => {
  const VB = (globalThis.VB ||= {});
  const { SCHEMA_VERSION } = VB.constants;

  /** Coerce to a finite number, else null. Accepts "45.00" and 45. */
  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }

  /** Coerce to a non-empty trimmed string, else null. */
  function str(v) {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    return s ? s : null;
  }

  /**
   * Vinted returns money in at least three shapes across endpoints and page props:
   * an object, a bare numeric string, and a separate *_numeric field. All three
   * appear in the wild, so all three are handled rather than assumed away.
   *
   * @param {any} value the price-ish field
   * @param {any} [fallbackNumeric] e.g. item.price_numeric
   * @returns {{amount: number|null, currency: string|null}}
   */
  function money(value, fallbackNumeric) {
    if (value && typeof value === 'object') {
      return {
        amount: num(value.amount != null ? value.amount : value.value),
        currency: str(value.currency_code || value.currency),
      };
    }
    const direct = num(value);
    return {
      amount: direct !== null ? direct : num(fallbackNumeric),
      currency: null,
    };
  }

  /**
   * Timestamp -> ISO 8601.
   * Accepts unix seconds (Vinted's *_ts fields), unix milliseconds, and an
   * already-formatted date string.
   */
  function isoDate(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number' || /^\d+$/.test(String(v))) {
      const n = Number(v);
      // Anything below this threshold is far too small to be milliseconds for a
      // real listing, so it is seconds.
      const ms = n < 1e11 ? n * 1000 : n;
      const d = new Date(ms);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    const d = new Date(String(v));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  /** Breadcrumb array -> ["Women", "Shoes", "Sneakers"] */
  function categoryPath(raw) {
    const crumbs = raw.catalog_breadcrumbs;
    if (Array.isArray(crumbs)) {
      return crumbs.map((c) => str(c && (c.title || c.name))).filter(Boolean);
    }
    if (Array.isArray(raw.category)) return raw.category.map(str).filter(Boolean);
    return [];
  }

  /**
   * Condition label: Vinted's own localized `status` string ("Muito bom", "Very
   * good"). Never derived from status_id — see constants.js for why.
   */
  function condition(raw) {
    return str(raw.status) || str(raw.condition);
  }

  /** A brand arrives as a string (wardrobe), an object (page), or brand_title. */
  function brandName(raw) {
    if (typeof raw.brand === 'string') return str(raw.brand);
    if (raw.brand && typeof raw.brand === 'object') return str(raw.brand.title || raw.brand.name);
    return str(raw.brand_title);
  }

  /** delivery_options -> shippingOptions, tolerating carrier/title naming. */
  function shipping(raw, fallbackCurrency) {
    const opts = Array.isArray(raw.delivery_options) ? raw.delivery_options : [];
    return opts
      .map((o) => {
        if (!o || typeof o !== 'object') return null;
        const m = money(o.price, o.price_numeric);
        const carrier = str(o.carrier || o.title || o.name || o.code);
        if (!carrier) return null;
        return {
          carrier,
          price: m.amount === null ? 0 : m.amount,
          currency: m.currency || fallbackCurrency || null,
        };
      })
      .filter(Boolean);
  }

  /**
   * photos -> images. full_size_url is the highest resolution Vinted exposes; the
   * thumbnail `url` is the fallback so a listing with an unusual photo record is
   * still backed up at whatever resolution is available.
   */
  function images(raw) {
    const photos = Array.isArray(raw.photos) ? raw.photos : [];
    const out = [];
    const seen = new Set();
    for (const p of photos) {
      if (!p) continue;
      const url = str(
        typeof p === 'string'
          ? p
          : p.full_size_url || p.url || (p.high_resolution && p.high_resolution.url)
      );
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const index = out.length + 1;
      out.push({
        index,
        originalUrl: url,
        localPath: 'images/' + VB.sanitize.imageFileName(index, url),
        width: num(p.width),
        height: num(p.height),
      });
    }
    return out;
  }

  /** Seller block, tolerating both a nested user object and flattened fields. */
  function seller(raw) {
    const u = raw.user && typeof raw.user === 'object' ? raw.user : {};
    return {
      id: num(u.id != null ? u.id : raw.user_id),
      username: str(u.login || u.username || raw.user_login),
      rating: num(u.feedback_reputation != null ? u.feedback_reputation : u.rating),
    };
  }

  /** Canonical listing URL. Prefers what Vinted itself reports. */
  function listingUrl(raw, id, domain) {
    const given = str(raw.url);
    if (given && /^https?:\/\//i.test(given)) return given;
    if (given) return domain + (given.startsWith('/') ? given : '/' + given);
    const path = str(raw.path);
    if (path) return domain + (path.startsWith('/') ? path : '/' + path);
    return domain + '/items/' + id;
  }

  /**
   * Normalize a raw item into a ListingSnapshot.
   *
   * @param {any} raw a wardrobe record merged with listing-page data, or the
   *   same-shaped object produced by a fallback path
   * @param {{domain: string, region: string, source: 'api'|'page'|'dom'}} ctx
   * @returns {{ok: true, value: ListingSnapshot} | {ok: false, code: string, message: string, keys?: string[]}}
   */
  function normalizeItem(raw, ctx) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return VB.fail(VB.ERR.SHAPE, 'Item payload was not an object', {
        got: typeof raw,
      });
    }

    const id = str(raw.id != null ? raw.id : raw.item_id);
    const title = str(raw.title);

    // A payload missing both of these is not an item we recognise. Report the keys
    // we actually got, so a Vinted-side rename is diagnosable from the log rather
    // than showing up as a folder full of nulls.
    if (!id || !title) {
      return VB.fail(VB.ERR.SHAPE, 'Item payload had no usable id/title pair', {
        keys: Object.keys(raw).slice(0, 40),
      });
    }

    const price = money(raw.price, raw.price_numeric);
    const original = money(raw.original_price_numeric, raw.original_price);
    const currency = price.currency || str(raw.currency) || str(raw.currency_code);

    const colorParts = [str(raw.color1), str(raw.color2)].filter(Boolean);

    /** @type {ListingSnapshot} */
    const snapshot = {
      schemaVersion: SCHEMA_VERSION,

      id,
      url: listingUrl(raw, id, ctx.domain),
      title,
      description: str(raw.description) || '',

      price: price.amount,
      originalPrice: original.amount,
      currency,

      category: categoryPath(raw),
      catalogId: num(raw.catalog_id),

      brand: brandName(raw),
      brandId: num(raw.brand_id),
      condition: condition(raw),
      conditionId: num(raw.status_id),
      size: str(raw.size_title) || str(raw.size),
      sizeId: num(raw.size_id),
      color: colorParts.length ? colorParts.join(', ') : null,
      colorIds: [num(raw.color1_id), num(raw.color2_id)].filter((v) => v !== null),
      packageSizeId: num(raw.package_size_id),
      // Vinted exposes material_id (a number) but not reliably a material name. An
      // id is not a label, so a name is recorded only when one is actually present
      // rather than inventing one from the id.
      material: str(raw.material_title) || str(raw.material),

      shippingOptions: shipping(raw, currency),
      seller: seller(raw),

      favouriteCount: num(raw.favourite_count) || 0,
      viewCount: num(raw.view_count) || 0,

      /** Listing state flags from the wardrobe record; null when not reported. */
      listingState: {
        draft: raw.is_draft == null ? null : !!raw.is_draft,
        closed: raw.is_closed == null ? null : !!raw.is_closed,
        reserved: raw.is_reserved == null ? null : !!raw.is_reserved,
        hidden: raw.is_hidden == null ? null : !!raw.is_hidden,
      },
      /** Vinted's relative upload label ("há um dia"); the only date the page shows. */
      uploadedText: str(raw.upload_date_text),

      createdAt: isoDate(raw.created_at_ts != null ? raw.created_at_ts : raw.created_at),
      updatedAt: isoDate(raw.updated_at_ts != null ? raw.updated_at_ts : raw.updated_at),

      images: images(raw),

      rawSource: ctx.source,
      scrapedAt: new Date().toISOString(),
      domain: ctx.domain,
      region: ctx.region,
    };

    return VB.done(snapshot);
  }

  /**
   * A snapshot worth writing to disk. This is the atomicity gate from the design
   * goal: no listing counts as backed up without an id, a title and at least one
   * image, so a partially-extracted item fails loudly instead of leaving behind a
   * folder that looks complete.
   *
   * @returns {{ok: true} | {ok: false, code: string, message: string}}
   */
  function validateSnapshot(s) {
    if (!s || typeof s !== 'object') return VB.fail(VB.ERR.SHAPE, 'Snapshot missing');
    if (!s.id) return VB.fail(VB.ERR.SHAPE, 'Snapshot has no id');
    if (!s.title) return VB.fail(VB.ERR.SHAPE, 'Snapshot has no title');
    if (!Array.isArray(s.images) || s.images.length === 0) {
      return VB.fail(VB.ERR.NO_IMAGES, 'Listing ' + s.id + ' produced no image URLs');
    }
    return { ok: true };
  }

  VB.normalize = {
    normalizeItem,
    validateSnapshot,
    /** Exposed for the offline test harness in tests/run.js. */
    _internals: { num, str, money, isoDate, categoryPath, condition, brandName, images, shipping },
  };
})();
