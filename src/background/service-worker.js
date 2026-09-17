/**
 * Service worker: tab bookkeeping and message routing. Deliberately thin.
 *
 * The spec put the backup queue here, but a Manifest V3 service worker cannot hold
 * a FileSystemDirectoryHandle (showDirectoryPicker does not exist in worker scope)
 * and can be killed between listings. The queue therefore lives in the manager
 * page, which is a normal document in a tab, and this worker only does the two
 * things a page cannot:
 *
 *   - open and track the manager tab
 *   - relay messages between the manager page and a Vinted tab's content script,
 *     since extension pages cannot message a content script directly
 *
 * No chrome.alarms keep-alive is needed as a result: nothing long-running lives
 * here to keep alive.
 *
 * This file calls chrome.tabs.query/create/update/sendMessage freely without the
 * "tabs" permission, which is deliberate, not an oversight: querying or matching by
 * `url` only needs the "tabs" permission for hosts the extension does NOT already
 * have host_permissions for, and an extension can always see and message its own
 * pages (the manager tab) regardless of permissions. Every tab this worker touches
 * is either a Vinted origin (covered by host_permissions) or the extension's own
 * manager page, so "tabs" would add nothing but a scarier install-time permission
 * prompt. Confirmed live: the full backup flow works end-to-end without it.
 */
importScripts(
  '../common/constants.js',
  '../common/messages.js',
  '../common/logger.js',
  '../common/selectors.js',
  '../common/sanitize.js',
  '../common/rate-limiter.js',
  '../common/page-data.js',
  '../common/normalize.js'
);

(() => {
  const VB = globalThis.VB;
  const { MSG, ERR } = VB;
  const { STORAGE_KEYS, REGIONS } = VB.constants;
  const SCOPE = 'worker';

  const MANAGER_URL = chrome.runtime.getURL('src/manager/manager.html');
  const VINTED_URL_PATTERNS = REGIONS.map((r) => r.domain + '/*');

  /** Message types the manager page asks us to forward to a Vinted tab. */
  const PROXIED = new Set(
    // Every PROXY_* type is relayed; deriving the set from MSG means a type added
    // in messages.js cannot be forgotten here again.
    Object.values(MSG).filter((t) => t.startsWith('PROXY_'))
  );

  // ---------------------------------------------------------------------------
  // Tab tracking
  // ---------------------------------------------------------------------------

  async function rememberProxyTab(tabId) {
    await chrome.storage.session
      .set({ [STORAGE_KEYS.proxyTabId]: tabId })
      .catch(() => {});
  }

  async function storedProxyTabId() {
    try {
      const got = await chrome.storage.session.get(STORAGE_KEYS.proxyTabId);
      return got[STORAGE_KEYS.proxyTabId] || null;
    } catch {
      return null;
    }
  }

  function isVintedUrl(url) {
    return !!VB.constants.detectRegion(new URL(url).origin);
  }

  /**
   * A Vinted tab we can issue same-origin requests through.
   *
   * Preference order: the tab the run started from, then any open Vinted tab
   * (profile pages first, since those can also serve the scroll-crawl fallback),
   * then a freshly opened background tab on the requested storefront.
   *
   * @param {string} [preferredDomain]
   * @returns {Promise<{ok: true, value: number} | {ok: false, code: string, message: string}>}
   */
  async function ensureProxyTab(preferredDomain) {
    const remembered = await storedProxyTabId();
    if (remembered) {
      try {
        const tab = await chrome.tabs.get(remembered);
        if (tab && tab.url && isVintedUrl(tab.url)) return VB.done(tab.id);
      } catch {
        /* tab is gone; fall through */
      }
    }

    const tabs = await chrome.tabs.query({ url: VINTED_URL_PATTERNS });
    const scored = tabs
      .filter((t) => t.url)
      .sort((a, b) => {
        const rank = (t) =>
          (preferredDomain && t.url.startsWith(preferredDomain) ? 2 : 0) +
          (/\/member\//.test(t.url) ? 1 : 0);
        return rank(b) - rank(a);
      });

    if (scored.length) {
      await rememberProxyTab(scored[0].id);
      return VB.done(scored[0].id);
    }

    if (!preferredDomain) {
      return VB.fail(
        ERR.NO_PROXY_TAB,
        'No Vinted tab is open and no storefront was specified'
      );
    }

    // Opened inactive so a long backup does not steal focus from the manager tab.
    const created = await chrome.tabs.create({ url: preferredDomain, active: false });
    const ready = await waitForContentScript(created.id);
    if (!ready) {
      return VB.fail(
        ERR.NO_PROXY_TAB,
        'Opened a Vinted tab but its content script never answered'
      );
    }
    await rememberProxyTab(created.id);
    return VB.done(created.id);
  }

  /**
   * Poll a tab until its content script answers. A newly created tab needs the
   * page to load and the script to run, and there is no event that tells us both
   * have happened.
   */
  async function waitForContentScript(tabId, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await chrome.tabs.sendMessage(tabId, { type: MSG.PING });
        if (res) return true;
      } catch {
        /* not listening yet */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // The manager tab
  //
  // Observed on Brave: tabs.query({url}) does not match extension pages without
  // the "tabs" permission (their url is reported as null), so a URL lookup finds
  // nothing and every request would open one more manager. The manager instead
  // registers its tab id on load (MANAGER_HELLO) and is pinged before reuse.
  // ---------------------------------------------------------------------------

  async function storedManagerTabId() {
    try {
      const got = await chrome.storage.session.get(STORAGE_KEYS.managerTabId);
      return got[STORAGE_KEYS.managerTabId] || null;
    } catch {
      return null;
    }
  }

  async function rememberManagerTab(tabId) {
    await chrome.storage.session.set({ [STORAGE_KEYS.managerTabId]: tabId }).catch(() => {});
  }

  /** Whether this tab still holds a manager page that answers. */
  async function isManagerAlive(tabId) {
    if (tabId == null) return false;
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: MSG.MANAGER_PING });
      return !!(res && res.ok);
    } catch {
      return false;
    }
  }

  /** The live manager tab id, or null. */
  async function findManagerTab() {
    const remembered = await storedManagerTabId();
    if (await isManagerAlive(remembered)) return remembered;
    // Where the browser does expose extension-page urls, this still works.
    const byUrl = await chrome.tabs.query({ url: MANAGER_URL }).catch(() => []);
    for (const t of byUrl) {
      if (await isManagerAlive(t.id)) {
        await rememberManagerTab(t.id);
        return t.id;
      }
    }
    return null;
  }

  async function focusTab(tabId) {
    try {
      const tab = await chrome.tabs.update(tabId, { active: true });
      if (tab) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    } catch {
      /* gone */
    }
  }

  /**
   * Open the manager tab, or reuse the live one.
   *
   * `active: true` (the default) brings it to the front, which is what a click on
   * the toolbar or the Backup button wants. The in-page Relist actions pass
   * `active: false` so the work happens in a background tab and the person stays
   * on Vinted; the manager asks to be focused (NEED_ATTENTION) only when it needs
   * a decision.
   *
   * @param {{active?: boolean}} [opts]
   * @returns {Promise<{tabId: number, created: boolean}>}
   */
  async function openManagerTab(opts) {
    const active = !opts || opts.active !== false;
    const existing = await findManagerTab();
    if (existing != null) {
      if (active) await focusTab(existing);
      return { tabId: existing, created: false };
    }
    const tab = await chrome.tabs.create({ url: MANAGER_URL, active });
    await rememberManagerTab(tab.id);
    return { tabId: tab.id, created: true };
  }

  /** Read one storage.local key, null when missing or unreadable. */
  async function readLocal(key) {
    try {
      const got = await chrome.storage.local.get(key);
      return got[key] == null ? null : got[key];
    } catch {
      return null;
    }
  }

  /**
   * The backup and relist facts the hover panels show, per id, picked out of
   * the manager's persisted queue. Ids the manager has never seen map to null.
   */
  async function itemStatus(ids) {
    const state = await readLocal(STORAGE_KEYS.runState);
    const queue = (state && state.queue) || [];
    const progress = await readLocal(STORAGE_KEYS.relistProgress);
    const out = {};
    for (const raw of ids || []) {
      const id = String(raw);
      const e = queue.find((q) => q && q.id === id);
      out[id] = e
        ? {
            status: e.status,
            title: e.title,
            backedUpAt: e.backedUpAt || null,
            imageCount: e.imageCount,
            relist: e.relist || null,
          }
        : null;
    }
    return { items: out, progress: progress || null };
  }

  /** Forward relist progress to the Vinted tab that asked; best effort. */
  async function relayRelistProgress(progress) {
    const tabId = await readLocal(STORAGE_KEYS.relistOriginTabId);
    if (tabId == null) return false;
    try {
      await chrome.tabs.sendMessage(tabId, { type: MSG.RELIST_PROGRESS, progress });
      return true;
    } catch {
      return false;
    }
  }

  async function sendToManager(message) {
    const tabId = await findManagerTab();
    if (tabId == null) return;
    await chrome.tabs.sendMessage(tabId, message).catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // Routing
  // ---------------------------------------------------------------------------

  /**
   * Forward a manager request into a Vinted tab.
   *
   * A stale remembered tab id is the common failure here (the user closed the tab),
   * so one retry is made after clearing the memo before reporting failure.
   */
  async function proxyToVintedTab(message) {
    const first = await ensureProxyTab(message.domain);
    if (!first.ok) return first;

    try {
      const res = await chrome.tabs.sendMessage(first.value, message);
      if (res) return res;
    } catch (err) {
      VB.log.warn(SCOPE, 'Proxy tab did not answer, re-resolving', String(err));
    }

    await chrome.storage.session.remove(STORAGE_KEYS.proxyTabId).catch(() => {});
    const second = await ensureProxyTab(message.domain);
    if (!second.ok) return second;
    try {
      const res = await chrome.tabs.sendMessage(second.value, message);
      if (res) return res;
      return VB.fail(ERR.NO_PROXY_TAB, 'Vinted tab returned an empty response');
    } catch (err) {
      return VB.fail(ERR.NO_PROXY_TAB, 'Could not reach a Vinted tab: ' + String(err));
    }
  }

  async function readRunState() {
    try {
      const got = await chrome.storage.local.get(STORAGE_KEYS.runState);
      return VB.done(got[STORAGE_KEYS.runState] || null);
    } catch (err) {
      return VB.fail(ERR.HTTP, 'Could not read run state: ' + String(err));
    }
  }

  /**
   * Run a handler and always call sendResponse, even if it throws.
   *
   * ensureProxyTab and friends call chrome.tabs.query/create without a wrapping
   * try/catch, on the assumption that well-formed calls with granted permissions
   * essentially never reject — but "essentially never" is not "never", and the
   * manager's collectIds() awaits this round trip with no timeout of its own. An
   * unhandled rejection here would otherwise leave sendResponse uncalled and the
   * caller waiting indefinitely; this guarantees a fast, typed failure instead.
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

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return false;

    if (PROXIED.has(message.type)) {
      guarded(() => proxyToVintedTab(message), sendResponse);
      return true;
    }

    switch (message.type) {
      case MSG.OPEN_MANAGER:
        guarded(async () => VB.done((await openManagerTab()).tabId), sendResponse);
        return true;

      case MSG.RELIST_ITEMS: {
        // Sent by the in-page Relist button or profile menu. The manager does the
        // work in a background tab; progress comes back to the tab that asked.
        const ids = Array.isArray(message.ids) ? message.ids.map(String) : [];
        const context = message.context || {};
        guarded(async () => {
          if (!ids.length) return VB.fail(ERR.SHAPE, 'No listing ids to relist');
          if (sender.tab && sender.tab.id != null) {
            await rememberProxyTab(sender.tab.id);
            await chrome.storage.local.set({ [STORAGE_KEYS.relistOriginTabId]: sender.tab.id }).catch(() => {});
          }
          const { tabId, created } = await openManagerTab({ active: false });
          if (created) {
            // A fresh manager boots asynchronously and picks this up itself.
            await chrome.storage.local.set({ [STORAGE_KEYS.pendingRelist]: { ids, context } });
            return VB.done({ tabId, queued: true });
          }
          try {
            const res = await chrome.tabs.sendMessage(tabId, { type: MSG.RELIST_ITEMS, ids, context });
            return res || VB.fail(ERR.HTTP, 'The manager did not answer');
          } catch (err) {
            return VB.fail(ERR.HTTP, 'Could not reach the manager: ' + String(err));
          }
        }, sendResponse);
        return true;
      }

      case MSG.RELIST_RETRY:
        guarded(async () => {
          const { tabId } = await openManagerTab({ active: false });
          try {
            const res = await chrome.tabs.sendMessage(tabId, { type: MSG.RELIST_RETRY });
            return res || VB.fail(ERR.HTTP, 'The manager did not answer');
          } catch (err) {
            return VB.fail(ERR.HTTP, 'Could not reach the manager: ' + String(err));
          }
        }, sendResponse);
        return true;

      case MSG.GET_ITEM_STATUS:
        guarded(async () => VB.done(await itemStatus(message.ids)), sendResponse);
        return true;

      case MSG.NEED_ATTENTION:
        guarded(async () => {
          VB.log.info(SCOPE, 'Manager asks for attention: ' + (message.reason || 'unspecified'));
          await openManagerTab({ active: true });
          return VB.done(true);
        }, sendResponse);
        return true;

      case MSG.MANAGER_HELLO: {
        // A manager page just loaded. If another one is already alive, tell the
        // new one so it can hand over and close; otherwise it becomes the one.
        const tabId = message.tabId;
        guarded(async () => {
          const current = await storedManagerTabId();
          if (current != null && current !== tabId && (await isManagerAlive(current))) {
            return VB.done({ existing: current });
          }
          if (tabId != null) await rememberManagerTab(tabId);
          return VB.done({ existing: null });
        }, sendResponse);
        return true;
      }

      case MSG.RELIST_PROGRESS:
        guarded(async () => VB.done(await relayRelistProgress(message.progress)), sendResponse);
        return true;

      case MSG.START_BACKUP: {
        // Sent by the on-page button. Remember which tab it came from so the
        // manager proxies through the tab the user was actually looking at.
        const context = message.context || {};
        guarded(async () => {
          if (sender.tab && sender.tab.id != null) await rememberProxyTab(sender.tab.id);
          await chrome.storage.local.set({ vb_pending_context: context });
          const { tabId } = await openManagerTab();
          // The manager may already be open and idle; nudge it either way.
          await sendToManager({ type: MSG.START_BACKUP, context });
          return VB.done(tabId);
        }, sendResponse);
        return true;
      }

      case MSG.CANCEL_BACKUP:
        guarded(async () => {
          await sendToManager({ type: MSG.CANCEL_BACKUP });
          return VB.done(true);
        }, sendResponse);
        return true;

      case MSG.GET_STATE:
        guarded(readRunState, sendResponse);
        return true;

      case MSG.STATE_CHANGED:
        // Mirror progress onto the Vinted page overlay, best effort.
        guarded(async () => {
          const tabId = await storedProxyTabId();
          if (tabId != null) {
            await chrome.tabs
              .sendMessage(tabId, {
                type: MSG.OVERLAY_UPDATE,
                progress: message.progress,
              })
              .catch(() => {});
          }
          return VB.done(true);
        }, sendResponse);
        return true;

      default:
        // Answer, rather than stay silent: a silent unknown type shows up at the
        // sender as "No response from the Vinted tab", which points the wrong way.
        sendResponse(VB.fail(ERR.HTTP, 'The service worker does not handle "' + message.type + '"'));
        return false;
    }
  });

  chrome.tabs.onRemoved.addListener(async (tabId) => {
    const remembered = await storedProxyTabId();
    if (remembered === tabId) {
      await chrome.storage.session.remove(STORAGE_KEYS.proxyTabId).catch(() => {});
      VB.log.info(SCOPE, 'Proxy tab closed; will re-resolve on next request');
    }
    if ((await storedManagerTabId()) === tabId) {
      await chrome.storage.session.remove(STORAGE_KEYS.managerTabId).catch(() => {});
    }
  });

  chrome.runtime.onInstalled.addListener(() => {
    VB.log.info(SCOPE, 'Installed, version ' + chrome.runtime.getManifest().version);
  });
})();
