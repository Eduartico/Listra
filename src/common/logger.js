/**
 * Ring-buffer logger shared by all contexts.
 *
 * Entries are kept in memory and mirrored into chrome.storage.local on a debounce
 * so the manager page's debug pane can show what happened in a Vinted tab, and so
 * a log survives a service-worker restart. The buffer is capped: a 300-listing run
 * must not be able to fill the storage quota.
 */
(() => {
  const VB = (globalThis.VB ||= {});
  const MAX_ENTRIES = 500;

  /**
   * Which of the three contexts this is. Each persists under its own key: the
   * content script and the manager page both flushing to one key overwrote each
   * other, which hid the content script's warnings from the manager's log pane.
   */
  const CONTEXT =
    typeof document === 'undefined'
      ? 'worker'
      : location.protocol === 'chrome-extension:'
        ? 'page'
        : 'content';
  const KEY = VB.constants.STORAGE_KEYS.log + ':' + CONTEXT;

  /** @type {Array<{t: string, level: string, scope: string, msg: string, data?: any}>} */
  let buffer = [];
  let flushTimer = null;
  let loaded = false;

  const hasStorage = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;

  function scheduleFlush() {
    if (!hasStorage || flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      chrome.storage.local.set({ [KEY]: buffer }).catch(() => {
        /* storage full or context torn down; the in-memory log still works */
      });
    }, 1000);
  }

  /**
   * `data` is truncated before storage: a raw API item is ~4KB and 500 of them
   * would blow past the quota, so we keep a short JSON preview only.
   */
  function preview(data) {
    if (data === undefined) return undefined;
    try {
      const s = typeof data === 'string' ? data : JSON.stringify(data);
      return s.length > 600 ? `${s.slice(0, 600)}…(${s.length} chars)` : s;
    } catch {
      return String(data);
    }
  }

  function write(level, scope, msg, data) {
    const entry = { t: new Date().toISOString(), level, scope, msg };
    const p = preview(data);
    if (p !== undefined) entry.data = p;
    buffer.push(entry);
    if (buffer.length > MAX_ENTRIES) buffer = buffer.slice(-MAX_ENTRIES);
    const line = `[VB:${scope}] ${msg}`;
    if (level === 'error') console.error(line, data ?? '');
    else if (level === 'warn') console.warn(line, data ?? '');
    else console.log(line, data ?? '');
    scheduleFlush();
  }

  VB.log = {
    /** @param {string} scope short module name, e.g. "manager" */
    info: (scope, msg, data) => write('info', scope, msg, data),
    warn: (scope, msg, data) => write('warn', scope, msg, data),
    error: (scope, msg, data) => write('error', scope, msg, data),

    /** Current entries, oldest first. */
    entries: () => buffer.slice(),

    /**
     * Merge every context's persisted log in, once, so the manager's pane shows
     * what the content script and the worker did too. Entries are ordered by time.
     */
    async hydrate() {
      if (loaded || !hasStorage) return;
      loaded = true;
      try {
        const all = await chrome.storage.local.get(null);
        const prefix = VB.constants.STORAGE_KEYS.log + ':';
        let merged = [];
        for (const [k, v] of Object.entries(all)) {
          if (k.startsWith(prefix) && Array.isArray(v)) merged = merged.concat(v);
        }
        merged = merged.concat(buffer);
        merged.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
        buffer = merged.slice(-MAX_ENTRIES);
      } catch {
        /* nothing persisted yet */
      }
    },

    async clear() {
      buffer = [];
      if (!hasStorage) return;
      try {
        const all = await chrome.storage.local.get(null);
        const prefix = VB.constants.STORAGE_KEYS.log + ':';
        await chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith(prefix)));
      } catch {
        /* nothing to clear */
      }
    },
  };
})();
