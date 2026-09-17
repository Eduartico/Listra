/**
 * Theme: light, dark, or follow the operating system.
 *
 * The stylesheets already follow prefers-color-scheme, but that signal does not
 * reach extension pages in every browser (observed: Brave with "Brave colours"
 * set to Dark still reports light). So the preference is explicit, stored in
 * chrome.storage.local under `vb_theme`, and applied as `data-theme` on <html>.
 *
 * Loaded first in <head> of the manager and the popup, as a classic script (MV3
 * forbids inline ones). chrome.storage is asynchronous, so the last known value
 * is mirrored into localStorage and applied synchronously on load to avoid a
 * light flash before the real value arrives.
 */
(() => {
  const VB = (globalThis.VB ||= {});

  const KEY = 'vb_theme';
  const VALUES = ['system', 'light', 'dark'];

  /**
   * Which palette to show. Pure, so it is testable.
   *
   * @param {string|undefined} stored 'system' | 'light' | 'dark' | anything else
   * @param {boolean} systemPrefersDark
   * @returns {'light'|'dark'}
   */
  function resolve(stored, systemPrefersDark) {
    if (stored === 'light' || stored === 'dark') return stored;
    return systemPrefersDark ? 'dark' : 'light';
  }

  function normalize(value) {
    return VALUES.includes(value) ? value : 'system';
  }

  /** Set data-theme on <html>; 'system' removes it so the media query decides. */
  function apply(value) {
    if (typeof document === 'undefined' || !document.documentElement) return;
    const v = normalize(value);
    if (v === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = v;
    try {
      localStorage.setItem(KEY, v);
    } catch {
      /* private window or blocked storage; the stored value still wins on load */
    }
  }

  async function get() {
    try {
      const got = await chrome.storage.local.get(KEY);
      return normalize(got[KEY]);
    } catch {
      return 'system';
    }
  }

  async function set(value) {
    const v = normalize(value);
    apply(v);
    try {
      await chrome.storage.local.set({ [KEY]: v });
    } catch {
      /* the page already shows the right theme; persistence is best effort */
    }
  }

  /**
   * Wire a System / Light / Dark control: a container with one button per
   * value carrying `data-theme-opt`. Reflects the stored value and follows
   * changes made in the other page.
   */
  function bindControl(container) {
    if (!container) return;
    const buttons = Array.from(container.querySelectorAll('[data-theme-opt]'));
    const reflect = (value) => {
      const v = normalize(value);
      for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.themeOpt === v));
    };
    for (const b of buttons) b.addEventListener('click', () => set(b.dataset.themeOpt));
    get().then(reflect);
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[KEY]) reflect(changes[KEY].newValue);
    });
  }

  VB.theme = { KEY, VALUES, resolve, apply, get, set, bindControl };

  // Boot: only in a document with chrome.storage (manager, popup), never in the
  // test harness or a content script.
  if (typeof document !== 'undefined' && typeof chrome !== 'undefined' && chrome.storage) {
    let cached = null;
    try {
      cached = localStorage.getItem(KEY);
    } catch {
      /* ignore */
    }
    if (cached) apply(cached);
    get().then(apply);
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[KEY]) apply(changes[KEY].newValue);
    });
  }
})();
