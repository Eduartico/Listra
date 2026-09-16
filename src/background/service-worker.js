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
  const PROXIED = new Set([
    MSG.PROXY_CONTEXT,
    MSG.PROXY_COLLECT_IDS,
    MSG.PROXY_FETCH_ITEM,
    MSG.PROXY_FETCH_HTML,
  ]);

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

  /** Open the manager tab, or focus it if it is already open. */
  async function openManagerTab() {
    const existing = await chrome.tabs.query({ url: MANAGER_URL });
    if (existing.length) {
      await chrome.tabs.update(existing[0].id, { active: true });
      await chrome.windows.update(existing[0].windowId, { focused: true }).catch(() => {});
      return existing[0].id;
    }
    const tab = await chrome.tabs.create({ url: MANAGER_URL, active: true });
    return tab.id;
  }

  async function sendToManager(message) {
    const tabs = await chrome.tabs.query({ url: MANAGER_URL });
    await Promise.all(
      tabs.map((t) => chrome.tabs.sendMessage(t.id, message).catch(() => {}))
    );
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

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return false;

    if (PROXIED.has(message.type)) {
      proxyToVintedTab(message).then(sendResponse);
      return true;
    }

    switch (message.type) {
      case MSG.OPEN_MANAGER:
        openManagerTab().then((id) => sendResponse(VB.done(id)));
        return true;

      case MSG.START_BACKUP: {
        // Sent by the on-page button. Remember which tab it came from so the
        // manager proxies through the tab the user was actually looking at.
        const context = message.context || {};
        (async () => {
          if (sender.tab && sender.tab.id != null) await rememberProxyTab(sender.tab.id);
          await chrome.storage.local.set({ vb_pending_context: context });
          const tabId = await openManagerTab();
          // The manager may already be open and idle; nudge it either way.
          await sendToManager({ type: MSG.START_BACKUP, context });
          sendResponse(VB.done(tabId));
        })();
        return true;
      }

      case MSG.CANCEL_BACKUP:
        sendToManager({ type: MSG.CANCEL_BACKUP }).then(() => sendResponse(VB.done(true)));
        return true;

      case MSG.GET_STATE:
        readRunState().then(sendResponse);
        return true;

      case MSG.STATE_CHANGED:
        // Mirror progress onto the Vinted page overlay, best effort.
        (async () => {
          const tabId = await storedProxyTabId();
          if (tabId != null) {
            chrome.tabs
              .sendMessage(tabId, {
                type: MSG.OVERLAY_UPDATE,
                progress: message.progress,
              })
              .catch(() => {});
          }
          sendResponse(VB.done(true));
        })();
        return true;

      default:
        return false;
    }
  });

  chrome.tabs.onRemoved.addListener(async (tabId) => {
    const remembered = await storedProxyTabId();
    if (remembered === tabId) {
      await chrome.storage.session.remove(STORAGE_KEYS.proxyTabId).catch(() => {});
      VB.log.info(SCOPE, 'Proxy tab closed; will re-resolve on next request');
    }
  });

  chrome.runtime.onInstalled.addListener(() => {
    VB.log.info(SCOPE, 'Installed, version ' + chrome.runtime.getManifest().version);
  });
})();
