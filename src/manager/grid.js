/**
 * The listings grid: one card per backed-up listing, Vinted-style, with a photo
 * carousel fed from the backup itself (not from Vinted's CDN), so what is shown is
 * exactly what was saved.
 *
 * Cards are keyed by listing id and updated in place on re-render, so the frequent
 * progress renders during a run do not re-create DOM or reload photos.
 */
(() => {
  const VB = globalThis.VB;
  const M = VB.manager;
  const { el } = M;

  /** folder -> metadata.json */
  const metaByFolder = new Map();
  /** folder -> object URLs for the stored images, in index order */
  const imagesByFolder = new Map();
  /** folders whose loads are in flight, to avoid duplicate reads */
  const loading = new Set();
  /** listing id -> card element */
  const cards = new Map();
  /** selected listing ids */
  const selected = new Set();

  let renderQueued = false;

  // ---------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------

  async function ensureLoaded(entry) {
    const folder = entry.folder;
    if (!folder || loading.has(folder)) return;
    if (metaByFolder.has(folder) && imagesByFolder.has(folder)) return;
    loading.add(folder);
    try {
      // A failed read is cached as empty too, or every render would retry it.
      const meta = await M.storage.readMetadata(folder);
      metaByFolder.set(folder, meta.ok ? meta.value : null);
      const images = await M.storage.readImages(folder);
      for (const url of imagesByFolder.get(folder) || []) URL.revokeObjectURL(url);
      imagesByFolder.set(folder, images.ok ? images.value.map((f) => URL.createObjectURL(f.blob)) : []);
    } finally {
      loading.delete(folder);
    }
    scheduleRender();
  }

  /** Forget cached data for a folder, e.g. after it was re-backed-up. */
  function invalidate(folder) {
    metaByFolder.delete(folder);
    for (const url of imagesByFolder.get(folder) || []) URL.revokeObjectURL(url);
    imagesByFolder.delete(folder);
  }

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      render();
    });
  }

  // ---------------------------------------------------------------------------
  // Filtering and ordering
  // ---------------------------------------------------------------------------

  function isSold(meta) {
    return !!(meta && meta.listingState && meta.listingState.closed);
  }

  function matches(entry, meta, filter, query) {
    if (filter === 'failed' && entry.status !== 'failed') return false;
    if (filter === 'sold' && !isSold(meta)) return false;
    if (filter === 'active' && (isSold(meta) || entry.status === 'failed')) return false;
    if (filter === 'relisted' && !(entry.relist && entry.relist.status === 'done')) return false;
    if (query) {
      const hay = [
        entry.id,
        entry.title,
        meta && meta.brand,
        meta && meta.category && meta.category.join(' '),
        meta && meta.description,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  }

  function sorter(sort) {
    const price = (e, m) => (m && m.price != null ? m.price : e.price != null ? e.price : -Infinity);
    switch (sort) {
      case 'title':
        return (a, b) => String(a.meta && a.meta.title || a.entry.title || '').localeCompare(String(b.meta && b.meta.title || b.entry.title || ''));
      case 'price-asc':
        return (a, b) => price(a.entry, a.meta) - price(b.entry, b.meta);
      case 'price-desc':
        return (a, b) => price(b.entry, b.meta) - price(a.entry, a.meta);
      case 'photos':
        return (a, b) => (b.images ? b.images.length : 0) - (a.images ? a.images.length : 0);
      default:
        return null; // queue order, which is Vinted's newest-first
    }
  }

  // ---------------------------------------------------------------------------
  // Cards
  // ---------------------------------------------------------------------------

  function formatPrice(meta, entry) {
    const amount = meta && meta.price != null ? meta.price : entry.price;
    const currency = (meta && meta.currency) || entry.currency;
    if (amount == null) return '—';
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'EUR' }).format(amount);
    } catch {
      return amount + (currency ? ' ' + currency : '');
    }
  }

  function h(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function buildCard(entry) {
    const card = h('article', 'item');
    card.dataset.id = entry.id;

    const select = h('input', 'item__select');
    select.type = 'checkbox';
    select.title = 'Select for relisting';
    select.addEventListener('change', () => {
      if (select.checked) selected.add(entry.id);
      else selected.delete(entry.id);
      card.classList.toggle('item--selected', select.checked);
      renderSelectionControls();
    });
    card.appendChild(select);

    card.appendChild(h('div', 'item__badges'));

    const carousel = h('div', 'carousel');
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    carousel.appendChild(img);
    const prev = h('button', 'carousel__nav carousel__nav--prev', '‹');
    const next = h('button', 'carousel__nav carousel__nav--next', '›');
    prev.type = 'button';
    next.type = 'button';
    carousel.appendChild(prev);
    carousel.appendChild(next);
    carousel.appendChild(h('div', 'carousel__dots'));
    carousel.appendChild(h('div', 'carousel__empty', 'No photos stored'));
    card.appendChild(carousel);
    card._index = 0;
    prev.addEventListener('click', () => step(card, -1));
    next.addEventListener('click', () => step(card, 1));

    const body = h('div', 'item__body');
    body.appendChild(h('div', 'item__price'));
    body.appendChild(h('div', 'item__title'));
    body.appendChild(h('div', 'item__meta item__meta--cat'));
    body.appendChild(h('div', 'item__meta item__meta--attrs'));
    const desc = h('div', 'item__desc');
    desc.addEventListener('click', () => desc.classList.toggle('open'));
    body.appendChild(desc);

    const foot = h('div', 'item__foot');
    const link = h('a', 'item__link', 'Open on Vinted');
    link.target = '_blank';
    link.rel = 'noopener';
    foot.appendChild(link);
    const relist = h('button', 'btn btn--small', 'Relist');
    relist.type = 'button';
    relist.addEventListener('click', () => VB.relist && VB.relist.relistMany([entry.id]));
    foot.appendChild(relist);
    body.appendChild(foot);
    body.appendChild(h('div', 'item__status'));
    card.appendChild(body);
    return card;
  }

  function step(card, delta) {
    const urls = card._images || [];
    if (urls.length < 2) return;
    card._index = (card._index + delta + urls.length) % urls.length;
    paintCarousel(card);
  }

  function paintCarousel(card) {
    const urls = card._images || [];
    const img = card.querySelector('.carousel img');
    const dots = card.querySelector('.carousel__dots');
    const empty = card.querySelector('.carousel__empty');
    const nav = card.querySelectorAll('.carousel__nav');
    if (!urls.length) {
      img.hidden = true;
      empty.hidden = false;
      dots.replaceChildren();
      nav.forEach((n) => (n.hidden = true));
      return;
    }
    img.hidden = false;
    empty.hidden = true;
    const src = urls[card._index] || urls[0];
    if (img.src !== src) img.src = src;
    nav.forEach((n) => (n.hidden = urls.length < 2));
    dots.replaceChildren(
      ...urls.map((_, i) => {
        const d = document.createElement('i');
        if (i === card._index) d.className = 'on';
        return d;
      })
    );
  }

  function updateCard(card, entry, meta, images) {
    // Every value here is remote data; textContent only, never innerHTML.
    const badges = card.querySelector('.item__badges');
    badges.replaceChildren();
    if (entry.status === 'failed') badges.appendChild(h('span', 'badge badge--failed', 'Failed'));
    if (isSold(meta)) badges.appendChild(h('span', 'badge badge--sold', 'Sold'));
    if (meta && meta.listingState) {
      if (meta.listingState.reserved) badges.appendChild(h('span', 'badge badge--state', 'Reserved'));
      if (meta.listingState.hidden) badges.appendChild(h('span', 'badge badge--state', 'Hidden'));
      if (meta.listingState.draft) badges.appendChild(h('span', 'badge badge--state', 'Draft'));
    }
    if (entry.relist && entry.relist.status === 'done') badges.appendChild(h('span', 'badge badge--relisted', 'Relisted'));
    card.classList.toggle('item--failed', entry.status === 'failed');

    card.querySelector('.item__price').textContent = formatPrice(meta, entry);
    card.querySelector('.item__title').textContent = (meta && meta.title) || entry.title || 'Listing ' + entry.id;

    const cat = meta && Array.isArray(meta.category) ? meta.category.slice(-2).join(' › ') : '';
    card.querySelector('.item__meta--cat').textContent = cat;
    const attrs = meta
      ? [meta.condition, meta.brand, meta.size ? 'Size ' + meta.size : null, meta.color]
          .filter(Boolean)
          .join(' · ')
      : '';
    card.querySelector('.item__meta--attrs').textContent = attrs;
    card.querySelector('.item__desc').textContent = (meta && meta.description) || '';

    const link = card.querySelector('.item__link');
    const url = (meta && meta.url) || (M.getState().context ? M.getState().context.domain + '/items/' + entry.id : '#');
    link.href = url;

    const status = card.querySelector('.item__status');
    status.className = 'item__status';
    if (entry.relist) {
      const r = entry.relist;
      if (r.status === 'running') status.textContent = r.step || 'Relisting…';
      else if (r.status === 'done') {
        status.textContent = 'Relisted as ' + r.newId + (r.deletedOld ? ' · old listing removed' : '');
        status.classList.add('item__status--ok');
      } else if (r.status === 'failed') {
        // oldDeleted means the original is gone and only the recreate is left;
        // the backup still holds everything, so Retry finishes the job.
        status.textContent = r.oldDeleted
          ? 'Original deleted — press Relist to recreate from the backup'
          : 'Relist failed: ' + (r.error || 'unknown');
        status.classList.add(r.oldDeleted ? 'item__status--warn' : 'item__status--error');
      } else if (r.status === 'queued') status.textContent = 'Queued for relisting';
    } else if (entry.status === 'failed') {
      status.textContent = entry.error || 'Backup failed';
      status.classList.add('item__status--error');
    } else if (entry.status !== 'completed') {
      status.textContent = entry.status.replace(/_/g, ' ') + '…';
    } else status.textContent = '';

    const relistBtn = card.querySelector('.item__foot .btn');
    relistBtn.disabled = entry.status !== 'completed' || (VB.relist && VB.relist.isBusy());

    const select = card.querySelector('.item__select');
    select.checked = selected.has(entry.id);
    card.classList.toggle('item--selected', select.checked);

    if (card._images !== images) {
      card._images = images || [];
      card._index = Math.min(card._index || 0, Math.max(0, card._images.length - 1));
      paintCarousel(card);
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  function renderSelectionControls() {
    const n = selected.size;
    el.relistSelected.textContent = n ? 'Relist selected (' + n + ')' : 'Relist selected';
    el.relistSelected.disabled = !n || (VB.relist && VB.relist.isBusy());
  }

  function render() {
    const state = M.getState();
    const queue = state.queue.filter((e) => e.folder || e.status !== 'pending');
    const filter = el.filter.value;
    const sort = el.sort.value;
    const query = el.search.value.trim().toLowerCase();

    // Drop selections that no longer exist.
    const ids = new Set(state.queue.map((e) => e.id));
    for (const id of [...selected]) if (!ids.has(id)) selected.delete(id);

    const rows = [];
    for (const entry of queue) {
      if (entry.folder) ensureLoaded(entry);
      const meta = entry.folder ? metaByFolder.get(entry.folder) || null : null;
      const images = entry.folder ? imagesByFolder.get(entry.folder) || null : null;
      if (!matches(entry, meta, filter, query)) continue;
      rows.push({ entry, meta, images });
    }
    const s = sorter(sort);
    if (s) rows.sort(s);

    el.queueEmpty.hidden = rows.length > 0 || state.queue.length > 0;
    el.gridCount.textContent = rows.length ? '· ' + rows.length + (rows.length !== queue.length ? ' of ' + queue.length : '') : '';

    // Remove cards for entries that are gone.
    for (const [id, card] of cards) {
      if (!ids.has(id)) {
        card.remove();
        cards.delete(id);
      }
    }
    const shown = new Set(rows.map((r) => r.entry.id));
    for (const [id, card] of cards) card.hidden = !shown.has(id);

    const fragment = document.createDocumentFragment();
    for (const row of rows) {
      let card = cards.get(row.entry.id);
      if (!card) {
        card = buildCard(row.entry);
        cards.set(row.entry.id, card);
      }
      card.hidden = false;
      updateCard(card, row.entry, row.meta, row.images);
      fragment.appendChild(card); // appending moves an existing node; no reload
    }
    el.cards.appendChild(fragment);
    renderSelectionControls();
  }

  // ---------------------------------------------------------------------------

  el.filter.addEventListener('change', render);
  el.sort.addEventListener('change', render);
  el.search.addEventListener('input', scheduleRender);
  el.selectAll.addEventListener('click', () => {
    for (const [id, card] of cards) if (!card.hidden) selected.add(id);
    render();
  });
  el.selectNone.addEventListener('click', () => {
    selected.clear();
    render();
  });

  /** Forget everything cached; used after a full backup run rewrote the folders. */
  function invalidateAll() {
    for (const folder of [...imagesByFolder.keys()]) invalidate(folder);
    metaByFolder.clear();
  }

  VB.grid = {
    render,
    scheduleRender,
    invalidate,
    invalidateAll,
    selectedIds: () => [...selected],
    clearSelection: () => selected.clear(),
    metaFor: (folder) => metaByFolder.get(folder) || null,
  };

  render();
})();
