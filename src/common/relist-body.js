/**
 * Pure helpers for relisting: turning a backed-up listing back into the request
 * body Vinted's own upload form sends, and reading the responses that come back.
 *
 * Everything here is data in, data out — no fetch, no DOM — so it is exercised by
 * the offline test harness. The network side lives in the content script.
 *
 * The create body shape was captured live from Vinted's frontend on 2026-09-16
 * (docs/vinted-api-notes.md) and used successfully to recreate a listing.
 */
(() => {
  const VB = (globalThis.VB ||= {});

  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  /** Case- and accent-insensitive label comparison for localized option titles. */
  function fold(s) {
    return String(s || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .trim()
      .toLowerCase();
  }

  /**
   * Find the condition id whose title matches a localized label, in the form that
   * `POST /api/v2/item_upload/attributes` returns for a category.
   *
   * Observed shape: attributes[].code === 'condition' → configuration.options[]
   * are groups, each with options[] of { id, title }.
   *
   * @param {object} form the parsed attributes response
   * @param {string} label e.g. "Novo com etiquetas"
   * @returns {number|null}
   */
  function conditionIdFromForm(form, label) {
    if (!form || !Array.isArray(form.attributes) || !label) return null;
    const attr = form.attributes.find((a) => a && a.code === 'condition');
    const groups = attr && attr.configuration && Array.isArray(attr.configuration.options)
      ? attr.configuration.options
      : [];
    const want = fold(label);
    for (const group of groups) {
      const options = Array.isArray(group.options) ? group.options : [group];
      for (const opt of options) {
        if (opt && opt.id != null && fold(opt.title) === want) return num(opt.id);
      }
    }
    return null;
  }

  /**
   * Colour ids for a "Preto, Verde-escuro" style label, from the colours list.
   * @param {Array<{id:number,title:string}>} colors
   * @param {string|null} label
   */
  function colorIdsFromLabel(colors, label) {
    if (!Array.isArray(colors) || !label) return [];
    const wanted = String(label).split(',').map(fold).filter(Boolean);
    const out = [];
    for (const w of wanted) {
      const hit = colors.find((c) => c && fold(c.title) === w);
      if (hit && hit.id != null) out.push(num(hit.id));
    }
    return out.slice(0, 2);
  }

  /**
   * The item_attributes array to send. The seller's own item_upload record carries
   * the full set with real ids (material, size, condition, ...) — the create
   * validates against the category's required attributes, so a Star Wars toy that
   * needs a size fails without it. When the record is present its attributes are
   * used as the base, with the condition id overridden by the resolved value; when
   * it is not (a sold listing), only condition is sent.
   *
   * @param {object|null} own raw._raw.upload.item
   * @param {number} conditionId
   */
  function itemAttributes(own, conditionId) {
    const base = own && Array.isArray(own.item_attributes) ? own.item_attributes : null;
    if (!base) return [{ code: 'condition', ids: [conditionId] }];
    const out = [];
    let sawCondition = false;
    for (const a of base) {
      if (!a || !a.code || !Array.isArray(a.ids)) continue;
      if (a.code === 'condition') {
        out.push({ code: 'condition', ids: [conditionId] });
        sawCondition = true;
      } else if (a.ids.length) {
        out.push({ code: a.code, ids: a.ids.slice() });
      }
    }
    if (!sawCondition) out.push({ code: 'condition', ids: [conditionId] });
    return out;
  }

  /**
   * Build the `POST /api/v2/item_upload/items` body for a backed-up listing.
   *
   * @param {object} args
   * @param {object} args.snapshot metadata.json
   * @param {object|null} args.raw raw.json (its `_raw.upload.item` is used when present)
   * @param {number[]} args.photoIds temporary photo ids from POST /api/v2/photos, in order
   * @param {string} args.sessionId upload session uuid, same one given to the photo uploads
   * @param {{conditionId?: number|null, colorIds?: number[]|null, packageSizeId?: number|null}} [args.resolved]
   *   ids looked up at relist time for listings whose backup lacks them (sold ones)
   * @returns {{ok: true, value: object, missing: string[]} | {ok: false, code: string, message: string}}
   */
  function buildCreateBody(args) {
    const s = args.snapshot;
    if (!s || !s.title) return VB.fail(VB.ERR.SHAPE, 'Backup has no title');
    if (!Array.isArray(args.photoIds) || !args.photoIds.length) {
      return VB.fail(VB.ERR.NO_IMAGES, 'No uploaded photos to attach');
    }
    const own = args.raw && args.raw._raw && args.raw._raw.upload && args.raw._raw.upload.item
      ? args.raw._raw.upload.item
      : null;
    const r = args.resolved || {};

    const catalogId = num(s.catalogId) ?? num(own && own.catalog_id);
    const brandId = num(s.brandId) ?? num(own && own.brand_id);
    const conditionId = num(r.conditionId) ?? num(s.conditionId);
    const colorIds = (Array.isArray(r.colorIds) && r.colorIds.length ? r.colorIds : null)
      || (Array.isArray(s.colorIds) && s.colorIds.length ? s.colorIds : [])
      .map(num).filter((v) => v !== null);
    const packageSizeId = num(r.packageSizeId) ?? num(s.packageSizeId) ?? num(own && own.package_size_id) ?? 1;
    const price = num(s.price);

    const missing = [];
    if (catalogId === null) missing.push('catalog id');
    if (conditionId === null) missing.push('condition id');
    if (price === null) missing.push('price');
    if (catalogId === null || conditionId === null || price === null) {
      return VB.fail(VB.ERR.SHAPE, 'Cannot relist without ' + missing.join(', '));
    }
    // Package size defaults to the smallest when the backup does not say; recorded
    // in `missing` so the UI can show it was assumed rather than known.
    if (num(r.packageSizeId) === null && num(s.packageSizeId) === null && !(own && own.package_size_id != null)) {
      missing.push('package size (assumed small)');
    }

    const body = {
      item: {
        id: null,
        currency: s.currency || (own && own.currency) || 'EUR',
        temp_uuid: args.sessionId,
        title: s.title,
        description: s.description || '',
        brand_id: brandId,
        brand: s.brand || (own && own.brand_dto && own.brand_dto.title) || null,
        catalog_id: catalogId,
        isbn: own ? own.isbn ?? null : null,
        is_unisex: own ? !!own.is_unisex : false,
        ai_photo: false,
        price,
        package_size_id: packageSizeId,
        shipment_prices: { domestic: null, international: null },
        color_ids: colorIds,
        assigned_photos: args.photoIds.map((id) => ({
          id,
          orientation: 0,
          ai_detected: false,
          digital_source_type: [],
          c2pa_read_error: 'other',
        })),
        measurement_length: own ? own.measurement_length ?? null : null,
        measurement_width: own ? own.measurement_width ?? null : null,
        item_attributes: itemAttributes(own, conditionId),
        manufacturer: null,
        manufacturer_labelling: null,
      },
      push_up: false,
      // Observed on the form's own successful create: the session id is repeated at
      // the top level and `parcel` is present (null when shipping is left default).
      // A create without `upload_session_id` answered 500 {"code":105}.
      parcel: null,
      upload_session_id: args.sessionId,
    };
    const sizeId = num(s.sizeId) ?? num(own && own.size_id);
    if (sizeId !== null) body.item.size_id = sizeId;

    return { ok: true, value: body, missing };
  }

  /**
   * Recognise a DataDome human-check response and extract a URL a person can open
   * to complete it. Two shapes were observed on vinted.pt:
   *   - JSON: {"url": "https://geo.captcha-delivery.com/captcha/?..."}
   *   - HTML: <script>var dd={'rt':'c','cid':'…','hsh':'…','t':'bv','s':…,'e':'…'}</script>
   *
   * @param {string} bodyText
   * @param {{referer?: string, datadomeCookie?: string|null}} [ctx]
   * @returns {{url: string|null}|null} null when the body is not a challenge
   */
  function parseChallenge(bodyText, ctx) {
    const text = String(bodyText || '');
    if (!text) return null;
    if (/^\s*\{/.test(text)) {
      try {
        const j = JSON.parse(text);
        if (j && typeof j.url === 'string' && /captcha-delivery\.com/.test(j.url)) return { url: j.url };
      } catch {
        /* not JSON */
      }
    }
    if (!/captcha-delivery\.com|var dd=/.test(text)) return null;
    const m = /var dd=(\{[^}]*\})/.exec(text);
    if (!m) return { url: null };
    const dd = {};
    for (const pair of m[1].slice(1, -1).split(',')) {
      const kv = /^\s*'([^']+)'\s*:\s*'?([^']*)'?\s*$/.exec(pair);
      if (kv) dd[kv[1]] = kv[2];
    }
    const c = ctx || {};
    const params = new URLSearchParams();
    if (dd.cid) params.set('initialCid', dd.cid);
    if (dd.hsh) params.set('hash', dd.hsh);
    if (c.datadomeCookie) params.set('cid', c.datadomeCookie);
    if (dd.t) params.set('t', dd.t);
    if (c.referer) params.set('referer', c.referer);
    if (dd.s) params.set('s', dd.s);
    if (dd.e) params.set('e', dd.e);
    const host = dd.host || 'geo.captcha-delivery.com';
    return { url: 'https://' + host + '/captcha/?' + params.toString() };
  }

  VB.relistBody = { buildCreateBody, conditionIdFromForm, colorIdsFromLabel, parseChallenge, _internals: { fold, itemAttributes } };
})();
