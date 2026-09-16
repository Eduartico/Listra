/**
 * Popup: status readout and a way into the manager tab.
 *
 * Intentionally does no work of its own. A popup is destroyed the moment it loses
 * focus, which makes it the wrong place to hold a queue or a directory handle, so
 * the buttons here only send commands and the display is read from the checkpoint
 * the manager page keeps.
 */
(() => {
  const VB = globalThis.VB;
  const { MSG } = VB;

  const el = {};
  for (const node of document.querySelectorAll('[data-el]')) el[node.dataset.el] = node;

  let pollTimer = null;

  function renderIdle() {
    el.status.textContent = 'idle';
    el.count.textContent = '';
    el.fill.style.width = '0%';
    el.current.textContent = '';
    el.timing.textContent = 'No backup running.';
    el.cancel.disabled = true;
  }

  function render(state) {
    if (!state || !state.progress) {
      renderIdle();
      return;
    }
    const p = state.progress;
    const pct = p.total ? Math.round(((p.completed + p.failed) / p.total) * 100) : 0;

    el.status.textContent = p.status || 'idle';
    el.count.textContent = p.total ? p.completed + ' / ' + p.total : '';
    el.fill.style.width = pct + '%';
    el.current.textContent = p.currentTitle || '';

    const bits = [];
    if (p.elapsedText) bits.push(p.elapsedText + ' elapsed');
    if (p.etaText) bits.push('about ' + p.etaText + ' left');
    if (p.failed) bits.push(p.failed + ' failed');
    el.timing.textContent = bits.join(' · ') || '';

    el.cancel.disabled = p.status !== 'running';
  }

  async function refresh() {
    try {
      const res = await chrome.runtime.sendMessage({ type: MSG.GET_STATE });
      render(res && res.ok ? res.value : null);
    } catch {
      renderIdle();
    }
  }

  el.open.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: MSG.OPEN_MANAGER });
    window.close();
  });

  el.cancel.addEventListener('click', async () => {
    el.cancel.disabled = true;
    await chrome.runtime.sendMessage({ type: MSG.CANCEL_BACKUP });
    refresh();
  });

  refresh();
  // Cheap poll while the popup is open; it is torn down on close so this stops
  // itself without any cleanup.
  pollTimer = setInterval(refresh, 1000);
  window.addEventListener('unload', () => clearInterval(pollTimer));
})();
