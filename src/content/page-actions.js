/**
 * On-page actions: the buttons, menus and panels injected into Vinted so that
 * backing up and relisting never need the manager tab in front.
 *
 *   - own profile page: a "Listra" pill with a menu (Backup all, Relist all
 *     active, Open Listra) and a hover panel with the last backup and any run
 *     in progress
 *   - own item page: a "Relist" button, inline next to Vinted's owner actions
 *     when an anchor is found, floating otherwise, with a hover panel showing
 *     backup state, live/sold, and the last relist result
 *   - a relist progress overlay, driven by RELIST_PROGRESS messages from the
 *     manager through the service worker
 *
 * The work itself happens in the manager page (it owns the backup storage);
 * this file only asks for it and shows how it is going. Vinted is a single-page
 * app, so the URL is watched and the UI re-mounted on client-side navigation.
 *
 * Loaded after content-script.js, which exposes what it needs as VB.content.
 */
(() => {
  const VB = globalThis.VB;
  if (!VB || !VB.content) return;
  if (VB.__pageActionsLoaded) return;
  VB.__pageActionsLoaded = true;

  const { MSG, ERR } = VB;
  const { RELIST } = VB.constants;
  const C = VB.content;
  const SCOPE = 'page';

  // ---------------------------------------------------------------------------
  // Small DOM helpers. Every value from Vinted or a backup goes through
  // textContent; innerHTML only ever carries static markup written here.
  // ---------------------------------------------------------------------------

  function h(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function fmtWhen(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  function fmtDuration(ms) {
    const m = Math.round(ms / 60000);
    if (m < 1) return 'under a minute';
    if (m < 60) return 'about ' + m + ' min';
    return 'about ' + Math.round(m / 60) + ' h';
  }

  async function send(message) {
    try {
      const res = await chrome.runtime.sendMessage(message);
      return res || VB.fail(ERR.HTTP, 'No answer from the extension');
    } catch (err) {
      return VB.fail(ERR.HTTP, 'Could not reach the extension: ' + String(err));
    }
  }

  // ---------------------------------------------------------------------------
  // Confirm modal
  // ---------------------------------------------------------------------------

  /**
   * @param {string} title
   * @param {string[]} lines
   * @param {string} okLabel
   * @returns {Promise<boolean>}
   */
  function confirmModal(title, lines, okLabel) {
    return new Promise((resolve) => {
      const back = h('div', 'vb-modal');
      const box = h('div', 'vb-modal__box');
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      box.appendChild(h('h2', 'vb-modal__title', title));
      const body = h('div', 'vb-modal__body');
      for (const line of lines) body.appendChild(h('p', null, line));
      box.appendChild(body);
      const actions = h('div', 'vb-modal__actions');
      const ok = h('button', 'vb-btn vb-btn--primary', okLabel);
      ok.type = 'button';
      const cancel = h('button', 'vb-btn', 'Cancel');
      cancel.type = 'button';
      actions.append(ok, cancel);
      box.appendChild(actions);
      back.appendChild(box);

      const finish = (value) => {
        document.removeEventListener('keydown', onKey);
        back.remove();
        resolve(value);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') finish(false);
      };
      ok.addEventListener('click', () => finish(true));
      cancel.addEventListener('click', () => finish(false));
      back.addEventListener('click', (e) => {
        if (e.target === back) finish(false);
      });
      document.addEventListener('keydown', onKey);
      document.body.appendChild(back);
      ok.focus();
    });
  }

  // ---------------------------------------------------------------------------
  // Hover panel: one shared element, positioned under whichever control is
  // hovered or focused, filled by a per-control render function.
  // ---------------------------------------------------------------------------

  let panelEl = null;
  let panelOwner = null;
  let panelHide = null;

  function ensurePanel() {
    if (panelEl && document.body.contains(panelEl)) return panelEl;
    panelEl = h('div', 'vb-panel');
    panelEl.hidden = true;
    panelEl.addEventListener('mouseenter', () => clearTimeout(panelHide));
    panelEl.addEventListener('mouseleave', schedulePanelHide);
    document.body.appendChild(panelEl);
    return panelEl;
  }

  function schedulePanelHide() {
    clearTimeout(panelHide);
    panelHide = setTimeout(() => {
      if (panelEl) panelEl.hidden = true;
      panelOwner = null;
    }, 180);
  }

  function showPanel(anchor, rows) {
    const el = ensurePanel();
    clearTimeout(panelHide);
    panelOwner = anchor;
    el.replaceChildren();
    for (const row of rows) {
      if (!row) continue;
      const line = h('div', 'vb-panel__row' + (row.kind ? ' vb-panel__row--' + row.kind : ''));
      if (row.label) line.appendChild(h('span', 'vb-panel__label', row.label));
      line.appendChild(h('span', 'vb-panel__value', row.value));
      el.appendChild(line);
    }
    el.hidden = false;
    // Place under the anchor, kept inside the viewport.
    const r = anchor.getBoundingClientRect();
    const width = el.offsetWidth || 280;
    let left = r.left;
    if (left + width > window.innerWidth - 12) left = Math.max(12, window.innerWidth - width - 12);
    let top = r.bottom + 8;
    if (top + el.offsetHeight > window.innerHeight - 12) top = Math.max(12, r.top - el.offsetHeight - 8);
    el.style.left = left + 'px';
    el.style.top = top + 'px';
  }

  /** Attach a hover/focus panel to a control; `rows()` may be async. */
  function attachPanel(control, rows) {
    const open = async () => {
      if (control.getAttribute('aria-expanded') === 'true') return;
      const data = await rows();
      if (document.body.contains(control) && control.getAttribute('aria-expanded') !== 'true') showPanel(control, data);
    };
    control.addEventListener('mouseenter', open);
    control.addEventListener('focus', open);
    control.addEventListener('mouseleave', schedulePanelHide);
    control.addEventListener('blur', schedulePanelHide);
  }

  /** Refresh the panel if it is showing for this control. */
  async function refreshPanel(control, rows) {
    if (panelOwner !== control || !panelEl || panelEl.hidden) return;
    showPanel(control, await rows());
  }

  // ---------------------------------------------------------------------------
  // Status: what the manager knows about listings and the current relist
  // ---------------------------------------------------------------------------

  /** @type {object|null} last RELIST_PROGRESS payload */
  let relistProgress = null;

  async function itemStatus(ids) {
    const res = await send({ type: MSG.GET_ITEM_STATUS, ids });
    if (res.ok && res.value) {
      if (res.value.progress && (!relistProgress || res.value.progress.at > relistProgress.at)) {
        relistProgress = res.value.progress;
      }
      return res.value.items || {};
    }
    return {};
  }

  function relistRunning() {
    return !!(relistProgress && relistProgress.status === 'running');
  }

  function relistInvolves(id) {
    return !!(relistProgress && Array.isArray(relistProgress.ids) && relistProgress.ids.includes(String(id)));
  }

  function isBackedUp(info) {
    // Entries written before backedUpAt existed only carry the status.
    return !!(info && (info.backedUpAt || info.status === 'completed'));
  }

  function statusRows(id, info, liveState) {
    const rows = [];
    if (isBackedUp(info)) {
      const photos = info.imageCount != null ? info.imageCount + ' photo' + (info.imageCount === 1 ? '' : 's') : null;
      rows.push({
        label: 'Backup',
        value: [info.backedUpAt ? fmtWhen(info.backedUpAt) : 'Backed up', photos].filter(Boolean).join(' · '),
      });
    } else {
      rows.push({ label: 'Backup', value: 'Not backed up yet (done automatically before relisting)' });
    }
    if (liveState === true) rows.push({ label: 'State', value: 'Live' });
    else if (liveState === false) rows.push({ label: 'State', value: 'Sold or not active' });

    const r = info && info.relist;
    if (relistRunning() && relistInvolves(id)) {
      const p = relistProgress;
      const mine = String(p.currentId) === String(id);
      rows.push({
        label: 'Relist',
        kind: 'run',
        value: mine ? p.step || 'Working…' : 'Queued (' + p.completed + ' of ' + p.total + ' done)',
      });
    } else if (r && r.status === 'done') {
      rows.push({ label: 'Relist', kind: 'ok', value: 'Relisted ' + (fmtWhen(r.at) || '') + ' as #' + r.newId });
    } else if (r && r.status === 'failed') {
      rows.push({
        label: 'Relist',
        kind: 'err',
        value: r.oldDeleted ? 'Original deleted — press Relist to recreate from the backup' : r.error || 'Failed',
      });
    }
    return rows;
  }

  // ---------------------------------------------------------------------------
  // Relist progress overlay
  // ---------------------------------------------------------------------------

  let relistOverlay = null;
  let overlayHideTimer = null;

  function ensureRelistOverlay() {
    if (relistOverlay && document.body.contains(relistOverlay)) return relistOverlay;
    relistOverlay = h('div', 'vb-overlay vb-overlay--relist');
    relistOverlay.innerHTML =
      '<div class="vb-overlay__head">' +
      '<span class="vb-overlay__title" data-vb="title">Relisting</span>' +
      '<span class="vb-overlay__count" data-vb="count"></span>' +
      '</div>' +
      '<div class="vb-overlay__bar"><div class="vb-overlay__fill" data-vb="fill"></div></div>' +
      '<div class="vb-overlay__current" data-vb="current"></div>' +
      '<div class="vb-overlay__meta" data-vb="meta"></div>' +
      '<div class="vb-overlay__actions" data-vb="actions" hidden></div>';
    document.body.appendChild(relistOverlay);
    return relistOverlay;
  }

  function overlayButton(label, onClick, primary) {
    const b = h('button', 'vb-btn vb-btn--small' + (primary ? ' vb-btn--primary' : ''), label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function renderRelistOverlay(p) {
    clearTimeout(overlayHideTimer);
    if (!p || p.status === 'idle') {
      if (relistOverlay) relistOverlay.remove();
      relistOverlay = null;
      return;
    }
    const el = ensureRelistOverlay();
    const q = (k) => el.querySelector('[data-vb="' + k + '"]');
    const total = p.total || 0;
    const finished = (p.completed || 0) + (p.failed || 0);
    const pct = total ? Math.round((finished / total) * 100) : 0;

    q('count').textContent = total ? p.completed + ' / ' + total : '';
    q('fill').style.width = pct + '%';
    const actions = q('actions');
    actions.replaceChildren();
    actions.hidden = true;

    if (p.status === 'running') {
      q('title').textContent = 'Relisting';
      q('current').textContent = p.currentTitle || '';
      q('meta').textContent = p.step || '';
      return;
    }

    q('current').textContent = p.summary || '';
    if (p.status === 'done') {
      const newIds = Array.isArray(p.newIds) ? p.newIds : [];
      q('title').textContent = p.failed ? 'Relist finished with errors' : 'Relist done';
      q('meta').textContent = p.error
        ? p.error
        : newIds.length === 1
          ? 'Recreated as listing #' + newIds[0]
          : newIds.length > 1
            ? 'Recreated as ' + newIds.length + ' new listings'
            : '';
      if (newIds.length === 1) {
        actions.appendChild(overlayButton('Open new listing', () => { location.href = C.site.domain + '/items/' + newIds[0]; }, true));
      }
      if (p.failed) actions.appendChild(overlayButton('Open Listra', () => send({ type: MSG.OPEN_MANAGER })));
      actions.appendChild(overlayButton('Dismiss', () => renderRelistOverlay(null)));
      actions.hidden = false;
      if (!p.failed) overlayHideTimer = setTimeout(() => renderRelistOverlay(null), 30000);
    } else if (p.status === 'human-check') {
      q('title').textContent = 'Vinted wants a human check';
      q('meta').textContent = 'Complete it, then press Retry.';
      if (p.captchaUrl) {
        actions.appendChild(overlayButton('Open check', () => { location.href = p.captchaUrl; }, true));
      }
      actions.appendChild(overlayButton('Retry', () => send({ type: MSG.RELIST_RETRY })));
      actions.hidden = false;
    } else if (p.status === 'rate-limited') {
      q('title').textContent = 'Vinted rate-limited the relist';
      q('meta').textContent = 'Wait a few minutes, then press Retry.';
      actions.appendChild(overlayButton('Retry', () => send({ type: MSG.RELIST_RETRY })));
      actions.hidden = false;
    } else if (p.status === 'cancelled') {
      q('title').textContent = 'Relist stopped';
      q('meta').textContent = '';
      overlayHideTimer = setTimeout(() => renderRelistOverlay(null), 10000);
    } else {
      q('title').textContent = 'Relist failed';
      q('meta').textContent = p.error || '';
      actions.appendChild(overlayButton('Open Listra', () => send({ type: MSG.OPEN_MANAGER })));
      actions.hidden = false;
    }
  }

  /** Called by content-script.js when the manager reports progress. */
  const progressListeners = new Set();
  function onRelistProgress(p) {
    relistProgress = p || null;
    renderRelistOverlay(p);
    for (const fn of progressListeners) fn(p);
  }

  // ---------------------------------------------------------------------------
  // Asking for a relist
  // ---------------------------------------------------------------------------

  async function requestRelist(ids, context) {
    const res = await send({ type: MSG.RELIST_ITEMS, ids, context });
    if (!res.ok) {
      onRelistProgress({ status: 'failed', ids, total: ids.length, completed: 0, failed: 0, error: res.message, summary: '', at: Date.now() });
      return res;
    }
    if (res.value && res.value.held) {
      onRelistProgress({ status: 'failed', ids, total: ids.length, completed: 0, failed: 0, error: 'Listra needs a backup destination first — it has opened its tab for you to choose one. The relist starts right after.', summary: '', at: Date.now() });
      return res;
    }
    // Show something at once; the manager's first real report replaces it.
    onRelistProgress({ status: 'running', ids, total: ids.length, completed: 0, failed: 0, currentTitle: '', step: 'Starting…', at: Date.now() });
    return res;
  }

  // ---------------------------------------------------------------------------
  // Item page
  // ---------------------------------------------------------------------------

  function itemIdFromUrl() {
    const m = VB.SELECTORS.item.itemInUrl.exec(location.pathname);
    return m ? m[1] : null;
  }

  /**
   * Whether the page says its item is closed. The full item DTO in the flight
   * payload carries `is_closed`; null when it cannot be found, in which case the
   * manager decides from the backup and the wording hedges.
   */
  function pageSaysClosed(flight) {
    if (!flight) return null;
    const m = /"is_closed":(true|false)/.exec(flight);
    return m ? m[1] === 'true' : null;
  }

  /** The container holding Vinted's owner buttons, or null. */
  function findOwnerActionsAnchor() {
    for (const sel of VB.SELECTORS.item.ownerActionButtons) {
      const node = document.querySelector(sel);
      if (node && node.parentElement) return node.parentElement;
    }
    return null;
  }

  /**
   * A button that looks exactly like Vinted's own owner buttons: their classes
   * and inner markup are copied from one of them (icons dropped), so font,
   * weight, colour and radius match without guessing. Falls back to our own
   * `.vb-inline` styling when there is nothing to copy.
   *
   * @returns {{button: HTMLButtonElement, setLabel: (text: string) => void}}
   */
  function buildInlineButton(label) {
    const template = [VB.SELECTORS.item.ownerActionTemplate]
      .concat(VB.SELECTORS.item.ownerActionButtons)
      .map((sel) => document.querySelector(sel))
      .find((n) => n && n.tagName === 'BUTTON');
    const button = document.createElement('button');
    button.type = 'button';
    let labelEl = button;
    if (template) {
      button.className = template.className;
      for (const child of template.childNodes) button.appendChild(child.cloneNode(true));
      for (const n of button.querySelectorAll('svg, [data-testid]')) {
        if (n.tagName.toLowerCase() === 'svg') n.remove();
        else n.removeAttribute('data-testid');
      }
      // The deepest element that carried text is where the label goes.
      let cursor = button;
      for (;;) {
        const next = Array.from(cursor.children).find((c) => c.textContent.trim());
        if (!next) break;
        cursor = next;
      }
      labelEl = cursor;
      // Empty wrappers left behind by a removed icon add stray spacing.
      for (const n of Array.from(button.querySelectorAll('*'))) {
        if (n !== labelEl && !n.contains(labelEl) && !n.textContent.trim()) n.remove();
      }
    } else {
      button.className = 'vb-inline';
    }
    const setLabel = (text) => {
      labelEl.textContent = text;
    };
    setLabel(label);
    return { button, setLabel };
  }

  async function mountItemPage(itemId) {
    const context = await C.buildContext();
    if (!context.signedIn || context.viewerId == null) {
      VB.log.info(SCOPE, 'Item page: not signed in, no button');
      return;
    }
    const flight = VB.pageData.getFlightPayload();
    const sidebar = VB.pageData.getSidebarItem(flight);
    const sellerId = sidebar ? Number(sidebar.seller_id != null ? sidebar.seller_id : sidebar.user_id) : null;
    if (!sellerId) {
      VB.log.info(SCOPE, 'Item page: seller id not found, no button (fail closed)');
      return;
    }
    if (sellerId !== context.viewerId) {
      VB.log.info(SCOPE, 'Item page: someone else’s item, no button');
      return;
    }
    const closed = pageSaysClosed(flight);
    const title = sidebar && sidebar.title ? String(sidebar.title) : 'this listing';
    // The manager refills its wardrobe cache from `profileUserId`; on an item
    // page that is the signed-in seller.
    const ownerContext = { ...context, profileUserId: context.viewerId, isOwnProfile: true };

    // Inline next to Vinted's own actions when an anchor exists, floating otherwise.
    const anchor = await VB.domExtractor
      .waitForSelector(VB.SELECTORS.item.ownerActionButtons.join(', '), 4000)
      .then(() => findOwnerActionsAnchor())
      .catch(() => null);

    let button;
    let setLabel;
    if (anchor) {
      ({ button, setLabel } = buildInlineButton('Relist'));
    } else {
      button = h('button', 'vb-fab', 'Relist');
      button.type = 'button';
      setLabel = (text) => {
        button.textContent = text;
      };
    }
    button.dataset.vbMount = 'item';
    button.dataset.vbRelist = itemId;
    button.title = 'Back up this listing, then put it back on Vinted as a new listing';

    const rows = async () => {
      const info = (await itemStatus([itemId]))[itemId];
      return statusRows(itemId, info, closed == null ? null : !closed);
    };
    attachPanel(button, rows);

    const reflect = () => {
      const busy = relistRunning();
      button.disabled = busy;
      setLabel(busy ? (relistInvolves(itemId) ? 'Relisting…' : 'Busy') : 'Relist');
      refreshPanel(button, rows);
    };
    progressListeners.add(reflect);

    button.addEventListener('click', async () => {
      const lines = [
        closed === false
          ? 'The current listing is deleted first, then recreated from the backup with the same photos.'
          : closed === true
            ? 'Recreated as a new listing from the backup (nothing to delete).'
            : 'If it is still live it is deleted first, then recreated from the backup with the same photos.',
        'It is backed up first; the backup is the only copy once the original is gone.',
      ];
      const go = await confirmModal('Relist “' + title + '”?', lines, 'Relist');
      if (!go) return;
      button.disabled = true;
      setLabel('Relisting…');
      const res = await requestRelist([itemId], ownerContext);
      if (!res.ok) reflect();
    });

    if (anchor) anchor.appendChild(button);
    else document.body.appendChild(button);
    reflect();
    VB.log.info(SCOPE, 'Item page: Relist button ' + (anchor ? 'inline' : 'floating'));

    // Vinted hydrates after first paint and rebuilds the sidebar, which drops
    // anything appended to the server-rendered markup (observed). Put the button
    // back whenever it goes missing, for as long as this page is mounted.
    if (anchor) {
      const mountKey = mountedFor;
      const keep = setInterval(() => {
        if (mountedFor !== mountKey) {
          clearInterval(keep);
          return;
        }
        if (document.body.contains(button)) return;
        const again = findOwnerActionsAnchor();
        if (again) again.appendChild(button);
        else {
          button.className = 'vb-fab';
          document.body.appendChild(button);
        }
      }, 500);
    }
  }

  // ---------------------------------------------------------------------------
  // Profile page
  // ---------------------------------------------------------------------------

  async function mountProfilePage() {
    await VB.domExtractor.waitForSelector(VB.SELECTORS.profile.listingCards, 5000).catch(() => {});
    C.dismissCookieBanner();
    const context = await C.buildContext();
    VB.log.info(SCOPE, 'Profile page context', context);
    if (!context.signedIn) return;
    if (context.isOwnProfile === false) {
      VB.log.info(SCOPE, 'Someone else’s profile, no menu');
      return;
    }

    const wrap = h('div', 'vb-menu');
    wrap.dataset.vbMount = 'profile';
    const pill = h('button', 'vb-fab vb-fab--menu', 'Listra ▾');
    pill.type = 'button';
    pill.setAttribute('aria-haspopup', 'menu');
    pill.setAttribute('aria-expanded', 'false');
    const list = h('div', 'vb-menu__list');
    list.setAttribute('role', 'menu');
    list.hidden = true;

    const item = (label) => {
      const b = h('button', 'vb-menu__item', label);
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      list.appendChild(b);
      return b;
    };
    const backupAll = item('Backup all listings');
    const relistAll = item('Relist all active (…)');
    relistAll.disabled = true;
    const openManager = item('Open Listra');
    wrap.append(pill, list);
    document.body.appendChild(wrap);

    const setOpen = (open) => {
      list.hidden = !open;
      pill.setAttribute('aria-expanded', String(open));
      // The menu opens where the panel sits; one at a time.
      if (open && panelEl) {
        panelEl.hidden = true;
        panelOwner = null;
      }
    };
    pill.addEventListener('click', () => setOpen(list.hidden));
    document.addEventListener('click', (e) => {
      if (!wrap.contains(e.target)) setOpen(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') setOpen(false);
    });

    /** @type {string[]|null} */
    let active = null;
    let lastBackup = null;

    async function loadCounts() {
      if (context.profileUserId == null) return;
      const res = await C.fetchWardrobeRecords(context.profileUserId, null);
      if (res.ok) {
        active = VB.relistPlan.activeIds(res.value);
        relistAll.textContent = 'Relist all active (' + active.length + ')';
        relistAll.disabled = active.length === 0 || relistRunning();
        const infos = await itemStatus(active.slice(0, 200));
        const backed = Object.values(infos).filter(isBackedUp);
        const times = backed.map((i) => i.backedUpAt).filter(Boolean).sort();
        lastBackup = backed.length ? { at: times.length ? times[times.length - 1] : null, count: backed.length } : null;
      } else {
        relistAll.textContent = 'Relist all active (unavailable)';
      }
    }

    const rows = async () => {
      const out = [];
      out.push({
        label: 'Listings',
        value: active ? active.length + ' active' : 'Counting…',
      });
      out.push({
        label: 'Backup',
        value: lastBackup
          ? (lastBackup.at ? 'Last ' + fmtWhen(lastBackup.at) + ' · ' : '') + lastBackup.count + ' of ' + (active ? active.length : '?') + ' active backed up'
          : 'No backup of these yet',
      });
      const state = await send({ type: MSG.GET_STATE });
      const p = state.ok && state.value ? state.value.progress : null;
      if (p && p.status === 'running') {
        out.push({ label: 'Now', kind: 'run', value: 'Backing up ' + (p.completed || 0) + ' / ' + (p.total || 0) + (p.currentTitle ? ' · ' + p.currentTitle : '') });
      } else if (relistRunning()) {
        const r = relistProgress;
        out.push({ label: 'Now', kind: 'run', value: 'Relisting ' + r.completed + ' / ' + r.total + (r.currentTitle ? ' · ' + r.currentTitle : '') });
      }
      return out;
    };
    attachPanel(pill, rows);
    progressListeners.add(() => {
      relistAll.disabled = !active || active.length === 0 || relistRunning();
      refreshPanel(pill, rows);
    });

    backupAll.addEventListener('click', async () => {
      setOpen(false);
      if (context.isOwnProfile === null) {
        const go = await confirmModal(
          'Is this your profile?',
          ['This extension could not confirm that this is your own profile.', 'Continue and back up the listings shown here?'],
          'Continue'
        );
        if (!go) return;
      }
      pill.disabled = true;
      pill.textContent = 'Opening manager…';
      const fresh = await C.buildContext();
      await send({ type: MSG.START_BACKUP, context: fresh });
      pill.disabled = false;
      pill.textContent = 'Listra ▾';
    });

    relistAll.addEventListener('click', async () => {
      setOpen(false);
      if (!active || !active.length) return;
      const n = active.length;
      const lines = [
        'Each of the ' + n + ' active listing' + (n === 1 ? '' : 's') + ' is backed up, then deleted, then recreated from the backup with the same photos.',
        'One at a time, ' + Math.round(RELIST.gapMs / 1000) + ' s apart: ' + fmtDuration(n * (RELIST.gapMs + 30000)) + '.',
        'Vinted may ask for a human check part-way; the run then waits for you here.',
      ];
      const go = await confirmModal('Relist all ' + n + ' active listing' + (n === 1 ? '' : 's') + '?', lines, 'Relist all');
      if (!go) return;
      relistAll.disabled = true;
      await requestRelist(active.slice(), context);
    });

    openManager.addEventListener('click', () => {
      setOpen(false);
      send({ type: MSG.OPEN_MANAGER });
    });

    loadCounts();
  }

  // ---------------------------------------------------------------------------
  // Mount / unmount on navigation
  // ---------------------------------------------------------------------------

  let mountedFor = null;

  function unmount() {
    for (const node of document.querySelectorAll('[data-vb-mount]')) node.remove();
    progressListeners.clear();
    if (panelEl) panelEl.hidden = true;
  }

  async function mount() {
    const key = location.pathname;
    if (mountedFor === key) return;
    mountedFor = key;
    unmount();
    C.dismissCookieBanner();
    const itemId = itemIdFromUrl();
    try {
      if (itemId) await mountItemPage(itemId);
      else if (C.onProfilePage()) await mountProfilePage();
    } catch (err) {
      VB.log.warn(SCOPE, 'Could not mount page actions', String(err));
    }
    // A stale mount from a navigation that raced this one is removed by the
    // next mount(); the last navigation wins.
  }

  function watchNavigation() {
    let last = location.href;
    const check = () => {
      if (location.href !== last) {
        last = location.href;
        mountedFor = null;
        mount();
      }
    };
    window.addEventListener('popstate', check);
    setInterval(check, 1000);
  }

  VB.pageActions = { onRelistProgress, mount };

  (async function boot() {
    // Redraw a relist that is still going, or stopped waiting for a Retry, if
    // this tab is the one it was asked from.
    const status = await send({ type: MSG.GET_ITEM_STATUS, ids: [] });
    const p = status.ok && status.value ? status.value.progress : null;
    if (p && p.status !== 'idle' && p.status !== 'done' && p.status !== 'cancelled' && Date.now() - (p.at || 0) < 6 * 3600 * 1000) {
      onRelistProgress(p);
    }
    await mount();
    watchNavigation();
  })();
})();
