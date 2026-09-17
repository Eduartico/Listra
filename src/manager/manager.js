/**
 * Manager page: the orchestrator.
 *
 * Everything stateful about a backup run lives here — the queue, retries, the
 * manifest, the directory handle — because this is a document in a tab, so it has
 * the File System Access API, a user gesture when one is needed, and a lifetime
 * that outlasts a service worker. Requests that must look like Vinted's own go out
 * through the content script via the service worker; photos are fetched here.
 *
 * The queue is checkpointed to chrome.storage.local after every state transition,
 * so closing this tab mid-run and reopening it resumes instead of starting over.
 */
(() => {
  const VB = globalThis.VB;
  const { MSG, ERR } = VB;
  const { LIMITS, STORAGE_KEYS, SCHEMA_VERSION } = VB.constants;
  const SCOPE = 'manager';

  const storage = new VB.Storage();

  /**
   * @typedef {object} QueueEntry
   * @property {string} id
   * @property {'pending'|'fetching_detail'|'extracting_data'|'downloading_images'|'saving'|'completed'|'failed'} status
   * @property {string|null} title
   * @property {string|null} folder
   * @property {number} attempts
   * @property {string|null} error
   * @property {number|null} imageCount
   * @property {number|null} bytes
   * @property {number|null} price
   * @property {string|null} currency
   * @property {string} [backedUpAt] ISO time of the last successful backup
   * @property {object} [relist] relist.js's per-entry state
   */

  /** @type {{status: string, context: object|null, queue: QueueEntry[], startedAt: number|null, finishedAt: number|null, durations: number[], limit: number|null}} */
  let state = emptyState();
  let cancelRequested = false;
  let running = false;

  function emptyState() {
    return {
      status: 'idle',
      context: null,
      queue: [],
      startedAt: null,
      finishedAt: null,
      durations: [],
      limit: null,
    };
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  async function persist() {
    const payload = { ...state, progress: progressSnapshot() };
    await chrome.storage.local.set({ [STORAGE_KEYS.runState]: payload }).catch((err) => {
      VB.log.warn(SCOPE, 'Could not checkpoint run state', String(err));
    });
    render();
    // Best effort: drives the on-page overlay in the Vinted tab.
    chrome.runtime.sendMessage({ type: MSG.STATE_CHANGED, progress: payload.progress }).catch(
      () => {}
    );
  }

  async function loadCheckpoint() {
    try {
      const got = await chrome.storage.local.get(STORAGE_KEYS.runState);
      const saved = got[STORAGE_KEYS.runState];
      if (!saved || !Array.isArray(saved.queue)) return;
      state = {
        status: saved.status === 'running' ? 'paused' : saved.status,
        context: saved.context || null,
        queue: saved.queue,
        startedAt: saved.startedAt || null,
        finishedAt: saved.finishedAt || null,
        durations: Array.isArray(saved.durations) ? saved.durations : [],
        limit: saved.limit || null,
      };
      // A run that was in flight when the tab closed is left mid-queue: entries
      // stuck in a working state go back to pending so resume retries them.
      for (const entry of state.queue) {
        if (!['completed', 'failed', 'pending'].includes(entry.status)) {
          entry.status = 'pending';
        }
      }
      VB.log.info(SCOPE, 'Loaded checkpoint with ' + state.queue.length + ' listings');
    } catch (err) {
      VB.log.warn(SCOPE, 'No usable checkpoint', String(err));
    }
  }

  // ---------------------------------------------------------------------------
  // Progress
  // ---------------------------------------------------------------------------

  function counts() {
    let completed = 0;
    let failed = 0;
    for (const e of state.queue) {
      if (e.status === 'completed') completed += 1;
      else if (e.status === 'failed') failed += 1;
    }
    return { completed, failed, total: state.queue.length };
  }

  function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return null;
    const totalSeconds = Math.round(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes === 0) return seconds + 's';
    return minutes + 'm ' + String(seconds).padStart(2, '0') + 's';
  }

  /**
   * ETA from the mean of the last few listings rather than the whole run, so it
   * tracks the current pace instead of being dragged by a slow start.
   */
  function etaMs() {
    const done = state.durations.slice(-5);
    if (!done.length) return null;
    const mean = done.reduce((a, b) => a + b, 0) / done.length;
    const { completed, failed, total } = counts();
    const remaining = total - completed - failed;
    return remaining > 0 ? mean * remaining : 0;
  }

  function currentEntry() {
    return state.queue.find((e) => !['completed', 'failed', 'pending'].includes(e.status));
  }

  function progressSnapshot() {
    const { completed, failed, total } = counts();
    const current = currentEntry();
    const elapsed = state.startedAt ? Date.now() - state.startedAt : null;
    const eta = state.status === 'running' ? etaMs() : null;
    return {
      status: state.status,
      total,
      completed,
      failed,
      currentTitle: current ? current.title || 'Listing ' + current.id : null,
      currentStage: current ? current.status : null,
      elapsedText: elapsed == null ? null : formatDuration(elapsed),
      etaText: eta == null ? null : formatDuration(eta),
    };
  }

  // ---------------------------------------------------------------------------
  // Vinted access, proxied through the content script
  // ---------------------------------------------------------------------------

  async function proxy(message) {
    const domain = state.context ? state.context.domain : undefined;
    try {
      const res = await chrome.runtime.sendMessage({ ...message, domain });
      if (!res) return VB.fail(ERR.NO_PROXY_TAB, 'No response from the Vinted tab');
      return res;
    } catch (err) {
      return VB.fail(ERR.NO_PROXY_TAB, 'Could not reach the Vinted tab: ' + String(err));
    }
  }

  /** Reject with a typed failure if `promise` outlives `ms`. */
  function withTimeout(promise, ms, message) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(VB.fail(ERR.TIMEOUT, message)), ms);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          resolve(VB.fail(ERR.TIMEOUT, message + ' (' + String(err) + ')'));
        }
      );
    });
  }

  // ---------------------------------------------------------------------------
  // The manifest
  // ---------------------------------------------------------------------------

  function buildManifest() {
    const { completed, failed, total } = counts();
    const ctx = state.context || {};
    return {
      version: SCHEMA_VERSION,
      createdAt: new Date(state.startedAt || Date.now()).toISOString(),
      updatedAt: new Date().toISOString(),
      domain: ctx.domain || null,
      region: ctx.region || null,
      profileUsername: ctx.username || null,
      totalListings: total,
      completedListings: completed,
      failedListings: failed,
      listings: state.queue.map((e) => ({
        id: e.id,
        title: e.title,
        folder: e.folder,
        price: e.price,
        currency: e.currency,
        imageCount: e.imageCount,
        status: e.status,
        error: e.error || undefined,
      })),
    };
  }

  async function flushManifest() {
    const res = await storage.writeManifest(buildManifest());
    if (!res.ok) VB.log.warn(SCOPE, 'Manifest write failed', res.message);
    return res;
  }

  // ---------------------------------------------------------------------------
  // One listing, start to finish
  // ---------------------------------------------------------------------------

  /** Folder names already allocated in this run, so titles that repeat do not collide. */
  function allocatedFolders() {
    const taken = new Set();
    for (const e of state.queue) if (e.folder) taken.add(e.folder);
    return taken;
  }

  /**
   * Extract, download, write and verify one listing.
   *
   * API first; on anything other than a clean JSON item, the DOM fallback fetches
   * the listing HTML and reads it — still without opening a tab.
   *
   * @param {QueueEntry} entry
   */
  async function processListing(entry) {
    const ctx = state.context;

    entry.status = 'fetching_detail';
    await persist();

    // One call assembles the listing from every source the content script has:
    // the wardrobe record, the listing page, and (own items only) item_upload.
    const fetched = await proxy({
      type: MSG.PROXY_FETCH_ITEM,
      itemId: entry.id,
      userId: ctx.profileUserId,
    });
    if (!fetched.ok) return fetched;
    const raw = fetched.value;
    const source = fetched.via === 'api' ? 'api' : fetched.via === 'dom' ? 'dom' : 'page';
    const html = fetched.html;

    entry.status = 'extracting_data';
    await persist();

    const normalized = VB.normalize.normalizeItem(raw, {
      domain: ctx.domain,
      region: ctx.region,
      source,
    });
    if (!normalized.ok) {
      // Log the shape we actually got; this is the signal that Vinted renamed
      // something and normalize.js needs an update.
      VB.log.error(SCOPE, 'Could not normalize item ' + entry.id, normalized);
      return normalized;
    }

    const snapshot = normalized.value;
    const valid = VB.normalize.validateSnapshot(snapshot);
    if (!valid.ok) return valid;

    entry.title = snapshot.title;
    entry.price = snapshot.price;
    entry.currency = snapshot.currency;
    if (!entry.folder) {
      entry.folder = VB.sanitize.uniqueFolderName(snapshot.title, allocatedFolders());
    }
    entry.status = 'downloading_images';
    await persist();

    const images = await VB.imageFetcher.fetchAll(snapshot.images);
    if (!images.ok) return images;

    entry.status = 'saving';
    await persist();

    const written = await storage.writeListing(entry.folder, {
      snapshot,
      images: images.value.files,
      raw,
      html,
    });
    if (!written.ok) return written;

    entry.imageCount = images.value.files.length;
    entry.bytes = images.value.totalBytes;
    return VB.done(true);
  }

  /**
   * Run one listing with retries and a hard timeout.
   *
   * The timeout covers the whole pipeline for that listing, per spec: a listing that
   * takes more than 30 seconds is treated as stuck rather than allowed to hold up
   * the queue.
   */
  async function processWithRetries(entry) {
    const delays = LIMITS.extractionRetryDelaysMs;
    for (let attempt = 0; attempt < delays.length; attempt += 1) {
      if (cancelRequested) return VB.fail(ERR.CANCELLED, 'Cancelled');
      if (attempt > 0) {
        VB.log.warn(
          SCOPE,
          'Retrying listing ' + entry.id + ' in ' + delays[attempt - 1] + 'ms'
        );
        await new Promise((r) => setTimeout(r, delays[attempt - 1]));
      }
      entry.attempts = attempt + 1;

      const started = Date.now();
      const res = await withTimeout(
        processListing(entry),
        LIMITS.listingTimeoutMs,
        'Listing ' + entry.id + ' exceeded ' + LIMITS.listingTimeoutMs + 'ms'
      );

      if (res.ok) {
        state.durations.push(Date.now() - started);
        // Shown by the in-page hover panels ("Backed up 16 Sep, 20:35").
        entry.backedUpAt = new Date().toISOString();
        return res;
      }

      entry.error = res.message;

      // A Cloudflare interstitial means backing off rather than hammering: wait
      // before the next attempt on top of the normal backoff.
      if (res.code === ERR.CHALLENGE) {
        VB.log.warn(SCOPE, 'Cloudflare challenge; pausing 10s');
        await new Promise((r) => setTimeout(r, 10000));
      }
      // A shape failure will not fix itself on a retry.
      if (res.code === ERR.SHAPE) return res;
    }
    return VB.fail(ERR.TIMEOUT, entry.error || 'All attempts failed');
  }

  // ---------------------------------------------------------------------------
  // The run
  // ---------------------------------------------------------------------------

  /**
   * Bounded even though the happy path is normally quick: pagination through a
   * very large wardrobe, or a slow tab-open-and-wait when no Vinted tab exists
   * yet, can legitimately take tens of seconds. Unlike each listing's own
   * pipeline (wrapped by processWithRetries), nothing else here bounds this call,
   * so it gets its own generous but finite ceiling rather than none at all.
   */
  const COLLECT_TIMEOUT_MS = 90000;

  async function collectIds(context, limit) {
    state.status = 'collecting';
    await persist();
    const res = await withTimeout(
      proxy({ type: MSG.PROXY_COLLECT_IDS, options: { userId: context.profileUserId, limit } }),
      COLLECT_TIMEOUT_MS,
      'Listing your profile took too long'
    );
    if (!res.ok) return res;
    return VB.done(res.value);
  }

  /**
   * Start or resume a run.
   *
   * Resuming is the same code path: pending entries are processed and completed
   * ones are skipped, so a partially finished queue just continues.
   */
  async function startRun(options) {
    if (running) {
      VB.log.warn(SCOPE, 'A run is already in progress');
      return;
    }
    if (!storage.isReady()) {
      setNotice('Choose where the backup should go first.', 'warn');
      return;
    }
    if (VB.relist && VB.relist.isBusy()) {
      setNotice('Wait for the relist to finish before starting a backup.', 'warn');
      return;
    }

    const o = options || {};
    running = true;
    cancelRequested = false;

    try {
      if (o.context) state.context = o.context;
      if (!state.context) {
        // No context yet: ask whichever Vinted tab we can reach. Bounded like
        // collectIds() below — this is the one round trip in the whole run that
        // otherwise had no timeout at all, and an indefinite hang here means
        // `running` never resets and the UI is stuck disabled until the manager
        // tab is reloaded.
        const ctxRes = await withTimeout(
          proxy({ type: MSG.PROXY_CONTEXT }),
          COLLECT_TIMEOUT_MS,
          'Could not reach a Vinted tab in time'
        );
        if (!ctxRes.ok) {
          setNotice(
            'Open your Vinted profile in another tab, then start the backup again.',
            'error'
          );
          return;
        }
        state.context = ctxRes.value;
      }

      const pending = state.queue.filter((e) => e.status === 'pending');
      if (!pending.length) {
        const ids = await collectIds(state.context, o.limit || null);
        if (!ids.ok) {
          setNotice('Could not list your listings: ' + ids.message, 'error');
          state.status = 'idle';
          await persist();
          return;
        }
        if (!ids.value.length) {
          setNotice('No listings found on this profile.', 'warn');
          state.status = 'idle';
          await persist();
          return;
        }
        state.queue = ids.value.map((id) => ({
          id: String(id),
          status: 'pending',
          title: null,
          folder: null,
          attempts: 0,
          error: null,
          imageCount: null,
          bytes: null,
          price: null,
          currency: null,
        }));
        state.durations = [];
        state.limit = o.limit || null;
        // A fresh queue is a fresh run; the previous run's clock must not carry over.
        state.startedAt = null;
        state.finishedAt = null;
        VB.log.info(SCOPE, 'Queued ' + state.queue.length + ' listings');
      }

      state.status = 'running';
      state.startedAt = state.startedAt || Date.now();
      state.finishedAt = null;
      await persist();
      await flushManifest();

      for (const entry of state.queue) {
        if (cancelRequested) break;
        if (entry.status === 'completed') continue;

        const res = await processWithRetries(entry);
        if (res.ok) {
          entry.status = 'completed';
          entry.error = null;
        } else if (res.code === ERR.CANCELLED) {
          entry.status = 'pending';
          break;
        } else {
          entry.status = 'failed';
          entry.error = res.message;
          VB.log.error(SCOPE, 'Listing ' + entry.id + ' failed', res.message);
        }

        // The manifest is rewritten per listing: it is cheap, and it doubles as the
        // resume index if this tab goes away.
        await persist();
        await flushManifest();
      }

      state.status = cancelRequested ? 'cancelled' : 'done';
      state.finishedAt = Date.now();
      // Folders were rewritten; the grid's cached photos and metadata are stale.
      if (VB.grid) VB.grid.invalidateAll();
      await persist();
      await flushManifest();

      const { completed, failed, total } = counts();
      const summary = cancelRequested
        ? 'Cancelled after ' + completed + ' of ' + total + ' listings.'
        : 'Finished: ' + completed + ' of ' + total + ' saved' +
            (failed ? ', ' + failed + ' failed' : '') + '.';
      setNotice(summary, failed ? 'warn' : 'ok');
      notify(summary);
    } finally {
      // The last render() before this point ran from inside persist(), while
      // running was still true — every button disabled state computed from
      // `running` was baked into the DOM at that moment and nothing else
      // re-renders afterward. Without this call the Start button stays visibly
      // (but not actually) disabled forever after any run ends, recoverable only
      // by reloading the tab, which a user has no reason to know to do.
      running = false;
      render();
    }
  }

  /**
   * Desktop notification when a run ends. A long backup is usually left running in
   * a background tab, so this is how the user finds out it is done.
   */
  function notify(message) {
    if (!chrome.notifications) return;
    chrome.notifications
      .create({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: 'Listra',
        message,
      })
      .catch(() => {});
  }

  function cancelRun() {
    if (!running) return;
    cancelRequested = true;
    setNotice('Cancelling after the current listing…', 'warn');
  }

  async function resetRun() {
    if (running) return;
    state = emptyState();
    await chrome.storage.local.remove(STORAGE_KEYS.runState).catch(() => {});
    setNotice('Cleared the saved queue.', 'ok');
    await persist();
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------

  const el = {};
  let noticeTimer = null;

  function bind() {
    for (const node of document.querySelectorAll('[data-el]')) {
      el[node.dataset.el] = node;
    }

    VB.theme.bindControl(el.theme);

    el.chooseFolder.addEventListener('click', async () => {
      const res = await storage.chooseFolder();
      if (!res.ok && res.code !== ERR.CANCELLED) setNotice(res.message, 'error');
      renderStorage();
      startHeldRelist();
    });

    el.reconnectFolder.addEventListener('click', async () => {
      const res = await storage.reconnectFolder();
      if (!res.ok) setNotice(res.message, 'error');
      renderStorage();
      startHeldRelist();
    });

    el.useBrowserStorage.addEventListener('click', async () => {
      const res = await storage.useBrowserStorage();
      if (!res.ok) setNotice(res.message, 'error');
      renderStorage();
      startHeldRelist();
    });

    el.start.addEventListener('click', () => {
      const limitValue = Number(el.limit.value);
      startRun({ limit: Number.isFinite(limitValue) && limitValue > 0 ? limitValue : null });
    });

    el.cancel.addEventListener('click', cancelRun);
    el.reset.addEventListener('click', resetRun);

    el.validate.addEventListener('click', async () => {
      el.validate.disabled = true;
      const res = await VB.validator.validate(storage);
      el.validate.disabled = false;
      if (!res.ok) {
        setNotice(res.message, 'error');
        return;
      }
      renderValidation(res.value);
    });

    el.exportZip.addEventListener('click', async () => {
      const res = await storage.exportZip();
      if (!res.ok) {
        setNotice(res.message, 'error');
        return;
      }
      const url = URL.createObjectURL(res.value);
      await chrome.downloads.download({
        url,
        filename: 'VintedBackup-' + new Date().toISOString().slice(0, 10) + '.zip',
        saveAs: true,
      });
      // Revoked late: the download reads from the URL asynchronously.
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    });

    el.clearLog.addEventListener('click', async () => {
      await VB.log.clear();
      renderLog();
    });
  }

  /**
   * In-page confirmation. Not window.confirm: a native dialog is auto-dismissed
   * when the page is attached to a debugger, and looks out of place regardless.
   *
   * @param {string} title
   * @param {string} body may contain newlines
   * @param {string} [okLabel]
   * @returns {Promise<boolean>}
   */
  function confirmDialog(title, body, okLabel) {
    return new Promise((resolve) => {
      el.modalTitle.textContent = title;
      el.modalBody.textContent = body;
      el.modalOk.textContent = okLabel || 'Continue';
      el.modal.hidden = false;
      const done = (value) => {
        el.modal.hidden = true;
        el.modalOk.removeEventListener('click', onOk);
        el.modalCancel.removeEventListener('click', onCancel);
        document.removeEventListener('keydown', onKey);
        resolve(value);
      };
      const onOk = () => done(true);
      const onCancel = () => done(false);
      const onKey = (e) => {
        if (e.key === 'Escape') done(false);
      };
      el.modalOk.addEventListener('click', onOk);
      el.modalCancel.addEventListener('click', onCancel);
      document.addEventListener('keydown', onKey);
      el.modalOk.focus();
    });
  }

  function setNotice(message, kind) {
    el.notice.textContent = message;
    el.notice.className = 'notice notice--' + (kind || 'ok');
    el.notice.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      el.notice.hidden = true;
    }, 12000);
  }

  function renderStorage() {
    const info = storage.describe();
    el.backendName.textContent =
      info.status === 'ready'
        ? info.label || info.backend
        : info.status === 'needs-permission'
          ? 'Folder "' + info.rememberedFolder + '" needs permission again'
          : 'No destination chosen';
    el.reconnectFolder.hidden = info.status !== 'needs-permission';
    el.chooseFolder.hidden = !info.canChooseFolder;
    el.useBrowserStorage.hidden = !info.canUseBrowserStorage || info.backend === 'idb';
    el.exportZip.hidden = info.backend !== 'idb';
    el.saveDownloads.hidden = info.backend !== 'idb';
    // Browser storage is invisible from outside the browser, which is the single
    // most confusing thing about it, so say so and point at the way out.
    el.destinationHint.textContent =
      info.backend === 'idb'
        ? (info.canChooseFolder
            ? 'This is inside the browser, not a folder you can open. Pick a folder above to write to disk directly, or use "Save to Downloads folder" to copy everything into Downloads/Listra.'
            : 'This browser has no folder picker (Brave switches it off), so the backup is kept inside the browser and is not a folder you can open. "Save to Downloads folder" copies everything into Downloads/Listra as real files; "Export as ZIP" makes one archive.')
        : info.status === 'ready'
          ? 'Files are written straight into this folder as the backup runs.'
          : 'Pick a folder on your computer; the backup is written there as ordinary files.';
    el.start.disabled = info.status !== 'ready' || running || !!(VB.relist && VB.relist.isBusy());
  }

  /** The listings grid lives in grid.js; it is loaded after this file. */
  function renderQueue() {
    if (VB.grid) VB.grid.render();
  }

  function renderProgress() {
    const p = progressSnapshot();
    const pct = p.total ? Math.round(((p.completed + p.failed) / p.total) * 100) : 0;
    el.progressFill.style.width = pct + '%';
    el.progressCount.textContent = p.total ? p.completed + ' / ' + p.total : '—';
    el.status.textContent = p.status;
    el.current.textContent = p.currentTitle
      ? p.currentTitle + ' · ' + String(p.currentStage || '').replace(/_/g, ' ')
      : '';
    const bits = [];
    if (p.elapsedText) bits.push(p.elapsedText + ' elapsed');
    if (p.etaText) bits.push('about ' + p.etaText + ' left');
    if (p.failed) bits.push(p.failed + ' failed');
    el.timing.textContent = bits.join(' · ');
    el.cancel.disabled = !running;
    el.reset.disabled = running || !state.queue.length;
  }

  function renderValidation(result) {
    const s = result.summary;
    el.validationSummary.replaceChildren();
    const lines = [
      ['Destination', s.destination || '—'],
      ['Listings in manifest', String(s.manifestListings)],
      ['Folders stored', String(s.foldersOnDisk)],
      ['Images', String(s.totalImages)],
      ['Size on disk', s.totalBytesHuman],
      ['Listings with problems', String(s.listingsWithIssues)],
    ];
    for (const [label, value] of lines) {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value;
      el.validationSummary.append(dt, dd);
    }

    el.validationProblems.replaceChildren();
    if (!result.problems.length) {
      const li = document.createElement('li');
      li.textContent = 'No problems found.';
      el.validationProblems.appendChild(li);
    } else {
      for (const p of result.problems) {
        const li = document.createElement('li');
        li.textContent = p.scope + ': ' + p.message;
        el.validationProblems.appendChild(li);
      }
    }
    el.validationPanel.hidden = false;
  }

  function renderLog() {
    const entries = VB.log.entries().slice(-120).reverse();
    el.log.replaceChildren();
    for (const entry of entries) {
      const li = document.createElement('li');
      li.className = 'log__line log__line--' + entry.level;
      li.textContent =
        entry.t.slice(11, 19) + ' [' + entry.scope + '] ' + entry.msg +
        (entry.data ? ' — ' + entry.data : '');
      el.log.appendChild(li);
    }
  }

  function renderContext() {
    const ctx = state.context;
    if (!ctx) {
      el.context.textContent = 'No Vinted profile connected yet.';
      return;
    }
    const who = ctx.username ? '@' + ctx.username : 'unknown profile';
    const own =
      ctx.isOwnProfile === true
        ? 'your own profile'
        : ctx.isOwnProfile === false
          ? 'someone else’s profile'
          : 'ownership unconfirmed';
    el.context.textContent = who + ' on vinted.' + ctx.region + ' · ' + own;
  }

  function render() {
    if (!el.status) return;
    renderContext();
    renderStorage();
    renderProgress();
    renderQueue();
    renderLog();
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  /**
   * A relist asked for from a Vinted page while no destination was ready. Kept
   * until the person picks one here (that needs a gesture on this page), then
   * started without asking again.
   * @type {{ids: string[], context: object}|null}
   */
  let heldRelist = null;

  function startHeldRelist() {
    if (!heldRelist || !storage.isReady() || running) return;
    const req = heldRelist;
    heldRelist = null;
    acceptRelist(req.ids, req.context);
  }

  /**
   * Handle a RELIST_ITEMS request from a Vinted page. The page already asked
   * for confirmation, so none is repeated here. Returns a result object the
   * page can show.
   */
  function acceptRelist(ids, context) {
    if (!VB.relist) return VB.fail(ERR.HTTP, 'Relisting is not loaded');
    if (running) return VB.fail(ERR.BUSY, 'A backup is running; try again when it finishes.');
    if (VB.relist.isBusy()) return VB.fail(ERR.BUSY, 'A relist is already running.');
    // The page's context fills in when none is set (fresh tab); an existing
    // one is kept, since it may carry the username the manifest records.
    if (context && context.domain && !(state.context && state.context.domain)) state.context = context;
    if (!storage.isReady()) {
      heldRelist = { ids, context };
      setNotice('Choose where the backup should go; the relist starts right after.', 'warn');
      chrome.runtime.sendMessage({ type: MSG.NEED_ATTENTION, reason: 'storage' }).catch(() => {});
      render();
      return VB.done({ held: true });
    }
    const { entries, added } = VB.relistPlan.entriesFor(state.queue, ids);
    if (!entries.length) return VB.fail(ERR.SHAPE, 'No listing ids to relist');
    if (added.length) state.queue.unshift(...added);
    render();
    VB.relist.relistFromPage(entries.map((e) => e.id));
    return VB.done({ started: entries.length, added: added.length });
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return false;
    // chrome.runtime.sendMessage from a content script reaches every extension
    // page as well as the service worker. Relist commands are acted on only when
    // the worker forwards them (no sender.tab), otherwise a request would run
    // once per open manager tab plus once more via the worker — observed live as
    // two parallel relists of the same listing, one of them failing on the
    // delete the other had just done.
    const fromWorker = !(sender && sender.tab);
    if (message.type === MSG.MANAGER_PING) {
      sendResponse(VB.done(true));
      return false;
    }
    if (message.type === MSG.RELIST_ITEMS) {
      if (!fromWorker) return false;
      sendResponse(acceptRelist(Array.isArray(message.ids) ? message.ids : [], message.context));
      return false;
    }
    if (message.type === MSG.RELIST_RETRY) {
      if (!fromWorker) return false;
      sendResponse(VB.relist ? VB.relist.retry() : VB.fail(ERR.HTTP, 'Relisting is not loaded'));
      return false;
    }
    if (message.type === MSG.START_BACKUP) {
      // Sent when the on-page button is used. Only auto-starts when a destination
      // is already set; otherwise the user still has to pick one here, since the
      // picker needs a gesture on this page.
      state.context = message.context || state.context;
      render();
      if (storage.isReady() && !running) startRun({ context: message.context });
      else setNotice('Choose where the backup should go, then press Start.', 'warn');
      sendResponse(VB.done(true));
      return false;
    }
    if (message.type === MSG.CANCEL_BACKUP) {
      cancelRun();
      sendResponse(VB.done(true));
      return false;
    }
    return false;
  });

  /**
   * What the sibling modules (grid.js, relist.js, export-downloads.js) need from
   * the orchestrator. They are separate files only to keep this one readable; they
   * run in the same page and share this state.
   */
  VB.manager = {
    el,
    storage,
    proxy,
    withTimeout,
    setNotice,
    confirmDialog,
    persist,
    render,
    getState: () => state,
    isRunning: () => running,
    /** Back up one queue entry now (fetch, download, write, verify). */
    backupEntry: (entry) => processWithRetries(entry),
    /** Add a listing id to the queue and back it up; returns the entry. */
    async backupNewId(id) {
      let entry = state.queue.find((e) => e.id === String(id));
      if (!entry) {
        entry = {
          id: String(id), status: 'pending', title: null, folder: null, attempts: 0,
          error: null, imageCount: null, bytes: null, price: null, currency: null,
        };
        state.queue.unshift(entry);
      }
      const res = await processWithRetries(entry);
      entry.status = res.ok ? 'completed' : 'failed';
      entry.error = res.ok ? null : res.message;
      await persist();
      await flushManifest();
      return entry;
    },
    async flushManifest() {
      return flushManifest();
    },
  };

  /**
   * One manager tab at a time. Two of them would both act on forwarded
   * commands and both run queues against the same storage. The worker keeps
   * the id of the live manager; if that is not this tab, hand over and close.
   */
  async function yieldToExistingManager() {
    try {
      const me = await chrome.tabs.getCurrent();
      if (!me) return false;
      const res = await chrome.runtime.sendMessage({ type: MSG.MANAGER_HELLO, tabId: me.id });
      const existing = res && res.ok && res.value ? res.value.existing : null;
      if (existing == null) return false;
      if (me.active) await chrome.tabs.update(existing, { active: true }).catch(() => {});
      await chrome.tabs.remove(me.id);
      return true;
    } catch {
      return false;
    }
  }

  (async function boot() {
    // bind() must run synchronously: grid.js, relist.js and export-downloads.js
    // are evaluated right after this file and wire their buttons through `el`.
    bind();
    if (await yieldToExistingManager()) return;
    await VB.log.hydrate();
    await loadCheckpoint();

    // A context handed over by the button click, if this tab was just opened.
    const pending = await chrome.storage.local.get('vb_pending_context').catch(() => ({}));
    let handedOver = false;
    if (pending && pending.vb_pending_context) {
      state.context = pending.vb_pending_context;
      handedOver = true;
      await chrome.storage.local.remove('vb_pending_context').catch(() => {});
    }

    await storage.init();
    render();

    // The on-page button just handed over a context and a destination is already
    // set (browser storage, or a folder still granted from last time): start. An
    // interrupted run resumes; a finished one is replaced by a fresh run, since a
    // second press of the button means "back up again". Without a destination the
    // user picks one here, since that needs a gesture.
    if (handedOver && storage.isReady() && !running) {
      const interrupted = state.queue.some((e) => e.status === 'pending');
      if (!interrupted) {
        const context = state.context;
        state = emptyState();
        state.context = context;
      }
      startRun({ context: state.context });
    }

    if (state.queue.some((e) => e.status === 'pending') && state.queue.some((e) => e.status === 'completed')) {
      setNotice(
        'A previous run was interrupted. Press Start to continue where it stopped.',
        'warn'
      );
    }

    // A relist request handed over by a Vinted page that opened this tab.
    const pendingRelist = await chrome.storage.local.get(STORAGE_KEYS.pendingRelist).catch(() => ({}));
    const req = pendingRelist && pendingRelist[STORAGE_KEYS.pendingRelist];
    if (req && Array.isArray(req.ids) && req.ids.length) {
      await chrome.storage.local.remove(STORAGE_KEYS.pendingRelist).catch(() => {});
      const res = acceptRelist(req.ids.map(String), req.context);
      if (!res.ok) {
        setNotice(res.message, 'warn');
        VB.relist.publishProgress({ status: 'failed', error: res.message, ids: req.ids.map(String) });
      }
    }
  })();
})();
