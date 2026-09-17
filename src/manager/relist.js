/**
 * Relisting: put a backed-up listing back on Vinted as a new listing.
 *
 * For each listing, in order:
 *   1. back it up again now and verify it is on disk with its photos
 *   2. if the listing is still live, DELETE it first — Vinted refuses a new listing
 *      whose photos match a live one, so creating before deleting cancels both
 *   3. upload its stored photos and create the new listing from the backup
 *   4. back up the new listing so the grid shows it
 *
 * Deleting before creating is the reason the backup must be reliable: once the
 * original is gone the backup is the only source. If the create then fails, the
 * delete is remembered so Retry recreates without deleting again.
 *
 * Creating listings is the action Vinted's bot protection watches most closely,
 * so a batch runs strictly one at a time with a pause between listings, and it
 * stops at the first human check or rate limit instead of pushing on. A human
 * check is surfaced as a button that opens Vinted's own check page; the person
 * completes it and presses Retry.
 */
(() => {
  const VB = globalThis.VB;
  const M = VB.manager;
  const { el } = M;
  const { MSG, ERR } = VB;
  const { RELIST, STORAGE_KEYS } = VB.constants;
  const SCOPE = 'relist';

  let busy = false;
  let cancelRequested = false;
  /** ids still to do after a stop, for Retry */
  let remaining = [];
  let lastCaptchaUrl = null;

  /** The batch in flight, for progress reports: ids, counts, current entry. */
  let batch = null;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * Tell the Vinted tab that asked (via the service worker) how the relist is
   * going, and keep the last report so a reloaded tab can redraw it. Best
   * effort: the tab may be gone.
   */
  function publishProgress(extra) {
    const p = {
      status: 'idle',
      ids: batch ? batch.ids : [],
      total: batch ? batch.ids.length : 0,
      completed: batch ? batch.done : 0,
      failed: batch ? batch.failed : 0,
      currentId: batch && batch.current ? batch.current.id : null,
      currentTitle: batch && batch.current ? batch.current.title || batch.current.id : null,
      step: batch && batch.current && batch.current.relist ? batch.current.relist.step || null : null,
      captchaUrl: null,
      error: null,
      at: Date.now(),
      ...(extra || {}),
    };
    chrome.storage.local.set({ [STORAGE_KEYS.relistProgress]: p }).catch(() => {});
    chrome.runtime.sendMessage({ type: MSG.RELIST_PROGRESS, progress: p }).catch(() => {});
    return p;
  }

  async function blobToBase64(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  function setStep(entry, step) {
    entry.relist = { ...(entry.relist || {}), status: 'running', step };
    M.render();
    publishProgress({ status: 'running' });
  }

  function setStatus(text) {
    el.relistStatus.textContent = text || '';
  }

  /** Look up ids a sold listing's backup could not carry. */
  async function resolveIds(meta) {
    const resolved = { conditionId: meta.conditionId ?? null, colorIds: meta.colorIds || [], packageSizeId: meta.packageSizeId ?? null };
    const notes = [];

    if (resolved.conditionId == null && meta.condition && meta.catalogId != null) {
      const form = await M.proxy({ type: MSG.PROXY_ATTRIBUTE_FORM, catalogId: meta.catalogId });
      if (!form.ok) return form;
      resolved.conditionId = VB.relistBody.conditionIdFromForm(form.value, meta.condition);
      if (resolved.conditionId == null) {
        return VB.fail(ERR.SHAPE, 'Could not match condition "' + meta.condition + '" to one of Vinted\'s options');
      }
      notes.push('condition id looked up from "' + meta.condition + '"');
    }
    if ((!resolved.colorIds || !resolved.colorIds.length) && meta.color) {
      const colors = await M.proxy({ type: MSG.PROXY_COLORS });
      if (colors.ok) {
        resolved.colorIds = VB.relistBody.colorIdsFromLabel(colors.value.colors, meta.color);
        if (resolved.colorIds.length) notes.push('colour ids looked up from "' + meta.color + '"');
      }
    }
    if (resolved.packageSizeId == null) {
      resolved.packageSizeId = RELIST.defaultPackageSizeId;
      notes.push('package size assumed small');
    }
    return VB.done({ resolved, notes });
  }

  /**
   * Relist one listing. Returns {ok, value: {newId, deletedOld}} or a failure whose
   * code says whether the batch should stop (HUMAN_CHECK, RATE_LIMITED).
   *
   * Order matters and is the whole point of the backup: for a listing that is still
   * live, the old one is DELETED BEFORE the new one is created. Vinted refuses a new
   * listing whose photos match a live listing — creating first makes both get
   * cancelled. So: back up (and verify), delete the original, then recreate from the
   * verified backup. If the create then fails, the original is gone but the backup is
   * intact and the create is retryable; that is the trade the backup exists to cover.
   */
  async function relistOne(entry) {
    const already = entry.relist && entry.relist.oldDeleted ? entry.relist : null;

    // 1. Back up the listing and verify it is on disk with its photos. This is the
    //    safety net before anything destructive happens. On a retry after the old
    //    one was already deleted, the listing no longer exists to fetch, so the
    //    existing backup is reused instead of re-fetched.
    let meta;
    let rawRes;
    let images;
    if (already) {
      const metaRes = await M.storage.readMetadata(entry.folder);
      if (!metaRes.ok) return VB.fail(metaRes.code, 'Backup unreadable on retry: ' + metaRes.message);
      meta = metaRes.value;
      rawRes = await M.storage.readRaw(entry.folder);
      images = await M.storage.readImages(entry.folder);
    } else {
      setStep(entry, 'Backing up first…');
      const backup = await M.backupEntry(entry);
      if (!backup.ok) return VB.fail(backup.code, 'Backup before relisting failed: ' + backup.message);
      entry.status = 'completed';
      entry.error = null;
      VB.grid.invalidate(entry.folder);
      await M.persist();

      const metaRes = await M.storage.readMetadata(entry.folder);
      if (!metaRes.ok) return metaRes;
      meta = metaRes.value;
      rawRes = await M.storage.readRaw(entry.folder);
      images = await M.storage.readImages(entry.folder);
    }
    if (!images.ok) return images;
    if (!images.value.length) return VB.fail(ERR.NO_IMAGES, 'No stored photos to upload; nothing deleted');

    // 2. Resolve any ids the backup could not carry (sold listings) BEFORE deleting,
    //    so a lookup failure aborts while the original is still safe.
    setStep(entry, 'Checking ids…');
    const ids = await resolveIds(meta);
    if (!ids.ok) return ids;

    // 3. Delete the original — only if it is still live and not already deleted on a
    //    previous attempt. If the delete fails, ABORT: creating now would duplicate
    //    the photos and get both listings cancelled.
    const wasActive = !!(meta.listingState && meta.listingState.closed === false);
    let deletedOld = already ? true : false;
    if (wasActive && !deletedOld) {
      if (cancelRequested) return VB.fail(ERR.CANCELLED, 'Stopped before deleting anything');
      setStep(entry, 'Removing the original listing…');
      const del = await M.proxy({ type: MSG.PROXY_DELETE_ITEM, itemId: entry.id });
      if (!del.ok) {
        return VB.fail(
          del.code,
          'Could not delete the original, so nothing was recreated (avoids a duplicate): ' + del.message,
          { captchaUrl: del.captchaUrl }
        );
      }
      deletedOld = true;
      // Record the delete immediately: if the create below fails or the tab
      // crashes, a retry must skip straight to creating, never delete again.
      entry.relist = {
        status: 'running',
        step: 'Original deleted; creating the new listing…',
        oldDeleted: true,
        wasActive: true,
      };
      await M.persist();
      VB.log.info(SCOPE, 'Deleted original ' + entry.id + ' before recreating');
      // Give Vinted a moment to release the photos the deleted listing held.
      await sleep(2000);
    }

    // 4. Upload the photos and create the new listing from the backup.
    const sessionId = crypto.randomUUID();
    const photoIds = [];
    for (let i = 0; i < images.value.length; i += 1) {
      if (cancelRequested) return failAfterDelete(entry, deletedOld, VB.fail(ERR.CANCELLED, 'Stopped'));
      const file = images.value[i];
      setStep(entry, 'Uploading photo ' + (i + 1) + ' of ' + images.value.length + '…');
      const up = await M.proxy({
        type: MSG.PROXY_UPLOAD_PHOTO,
        bytesBase64: await blobToBase64(file.blob),
        mimeType: file.blob.type || 'image/jpeg',
        fileName: file.name,
        sessionId,
      });
      if (!up.ok) return failAfterDelete(entry, deletedOld, VB.fail(up.code, 'Photo ' + (i + 1) + ': ' + up.message, { captchaUrl: up.captchaUrl }));
      photoIds.push(up.value.id);
      if (i < images.value.length - 1) await sleep(RELIST.photoGapMs);
    }

    const body = VB.relistBody.buildCreateBody({
      snapshot: meta,
      raw: rawRes.ok ? rawRes.value : null,
      photoIds,
      sessionId,
      resolved: ids.value.resolved,
    });
    if (!body.ok) return failAfterDelete(entry, deletedOld, body);

    if (cancelRequested) return failAfterDelete(entry, deletedOld, VB.fail(ERR.CANCELLED, 'Stopped'));
    setStep(entry, 'Creating the new listing…');
    const created = await M.proxy({ type: MSG.PROXY_CREATE_ITEM, body: body.value, excludeId: entry.id });
    if (!created.ok) return failAfterDelete(entry, deletedOld, VB.fail(created.code, 'Create: ' + created.message, { captchaUrl: created.captchaUrl }));
    const newId = created.value.id;
    if (String(newId) === String(entry.id)) return failAfterDelete(entry, deletedOld, VB.fail(ERR.SHAPE, 'Create did not produce a new listing'));
    VB.log.info(SCOPE, 'Relisted ' + entry.id + ' as ' + newId, { notes: ids.value.notes, assumed: body.missing });

    entry.relist = {
      status: 'done',
      newId,
      deletedOld,
      wasActive,
      at: new Date().toISOString(),
      notes: ids.value.notes.concat(body.missing || []),
    };
    await M.persist();

    setStatus('Backing up the new listing ' + newId + '…');
    // The wardrobe can lag a moment behind a create; give it a beat so the new
    // listing's backup finds it rather than failing on a 404.
    await sleep(3000);
    await M.backupNewId(newId);
    return VB.done({ newId, deletedOld });
  }

  /**
   * Attach the "original already deleted" flag to a failure so the UI and a Retry
   * both know the old listing is gone and the create is what still needs doing.
   */
  function failAfterDelete(entry, deletedOld, failure) {
    if (deletedOld) {
      failure.oldDeleted = true;
      failure.message = 'The original was already deleted; only the new listing is missing. ' + failure.message;
    }
    return failure;
  }

  async function runBatch(ids) {
    busy = true;
    cancelRequested = false;
    lastCaptchaUrl = null;
    el.humanCheckRow.hidden = true;
    el.relistCancel.disabled = false;
    remaining = ids.slice();
    batch = { ids: ids.slice(), done: 0, failed: 0, current: null };
    M.render();
    publishProgress({ status: 'running' });

    const state = M.getState();
    let done = 0;
    let stopCode = null;
    try {
      while (remaining.length) {
        if (cancelRequested) break;
        const id = remaining[0];
        const entry = state.queue.find((e) => e.id === id);
        if (!entry) {
          remaining.shift();
          continue;
        }
        batch.current = entry;
        setStatus('Relisting ' + (entry.title || id) + ' (' + (done + 1) + ' of ' + ids.length + ')');
        const res = await relistOne(entry);
        if (res.ok) {
          done += 1;
          batch.done = done;
          remaining.shift();
          publishProgress({ status: 'running' });
        } else {
          batch.failed += 1;
          entry.relist = {
            ...(entry.relist || {}),
            status: 'failed',
            error: res.message,
            captchaUrl: res.captchaUrl || null,
            // If the original was already deleted, keep that flag: the card shows
            // it and a Retry skips straight to recreating rather than deleting.
            oldDeleted: !!(res.oldDeleted || (entry.relist && entry.relist.oldDeleted)),
          };
          await M.persist();
          if (res.oldDeleted) {
            M.setNotice('The original was deleted but the new listing was not created. Your backup is safe — press Retry.', 'warn');
          }
          if (res.code === ERR.HUMAN_CHECK || res.code === ERR.RATE_LIMITED || res.code === ERR.CANCELLED) {
            lastCaptchaUrl = res.captchaUrl || null;
            stopCode = res.code;
            if (res.code === ERR.HUMAN_CHECK) {
              M.setNotice('Vinted asked for a human check. Open it, complete it, then press Retry.', 'warn');
              el.humanCheckRow.hidden = false;
              el.openHumanCheck.hidden = !lastCaptchaUrl;
            } else if (res.code === ERR.RATE_LIMITED) {
              M.setNotice('Vinted rate-limited the relist. Wait a few minutes, then press Retry.', 'warn');
              el.humanCheckRow.hidden = false;
              el.openHumanCheck.hidden = true;
            }
            break; // keep `remaining` for Retry
          }
          remaining.shift(); // an ordinary failure: move on to the next one
        }
        if (remaining.length && !cancelRequested) {
          setStatus('Pausing ' + Math.round(RELIST.gapMs / 1000) + 's before the next one…');
          await sleep(RELIST.gapMs);
        }
      }
    } finally {
      busy = false;
      el.relistCancel.disabled = true;
      const summary = cancelRequested
        ? 'Stopped after ' + done + ' of ' + ids.length + '.'
        : remaining.length
          ? done + ' of ' + ids.length + ' relisted; ' + remaining.length + ' waiting for Retry.'
          : done + ' of ' + ids.length + ' relisted.';
      setStatus(summary);
      // The page overlay: done, or stopped and waiting for a Retry from there.
      const lastError = batch.current && batch.current.relist && batch.current.relist.status === 'failed'
        ? batch.current.relist.error
        : null;
      const delivered = publishProgress({
        status: stopCode === ERR.HUMAN_CHECK ? 'human-check'
          : stopCode === ERR.RATE_LIMITED ? 'rate-limited'
          : cancelRequested ? 'cancelled'
          : 'done',
        step: null,
        captchaUrl: lastCaptchaUrl,
        error: lastError,
        summary,
      });
      void delivered;
      batch = null;
      M.render();
    }
  }

  /**
   * Relist a set of listing ids, after confirming. Active listings are replaced
   * (new copy created, old removed); sold ones are recreated.
   */
  async function relistMany(ids) {
    if (busy) return;
    if (M.isRunning()) {
      M.setNotice('Wait for the backup to finish before relisting.', 'warn');
      return;
    }
    const state = M.getState();
    const entries = ids.map((id) => state.queue.find((e) => e.id === id)).filter(Boolean);
    if (!entries.length) return;
    let active = 0;
    for (const e of entries) {
      let meta = VB.grid.metaFor(e.folder);
      if (!meta && e.folder) {
        const read = await M.storage.readMetadata(e.folder);
        if (read.ok) meta = read.value;
      }
      if (meta && meta.listingState && meta.listingState.closed === false) active += 1;
    }
    const sold = entries.length - active;
    const lines = [];
    if (active) lines.push('• ' + active + ' active: the current listing is deleted first, then recreated from the backup with the same photos.');
    if (sold) lines.push('• ' + sold + ' sold or not active: recreated as new listings (nothing to delete).');
    lines.push('', 'Each one is backed up first. One at a time, ' + Math.round(RELIST.gapMs / 1000) + 's apart.');
    VB.log.info(SCOPE, 'Relist requested for ' + entries.length + ' listing(s)', entries.map((e) => e.id));
    const go = await M.confirmDialog(
      'Relist ' + entries.length + ' listing' + (entries.length === 1 ? '' : 's') + '?',
      lines.join('\n'),
      'Relist'
    );
    if (!go) {
      VB.log.info(SCOPE, 'Relist cancelled at the confirmation');
      M.render();
      return;
    }
    await runBatch(entries.map((e) => e.id));
  }

  el.relistSelected.addEventListener('click', () => relistMany(VB.grid.selectedIds()));
  el.relistCancel.addEventListener('click', () => {
    cancelRequested = true;
    setStatus('Stopping after the current step…');
  });
  el.openHumanCheck.addEventListener('click', () => {
    if (lastCaptchaUrl) window.open(lastCaptchaUrl, '_blank', 'noopener');
  });
  function retry() {
    if (busy) return VB.fail(ERR.BUSY, 'A relist is already running.');
    if (!remaining.length) return VB.fail(ERR.SHAPE, 'Nothing is waiting for a retry.');
    el.humanCheckRow.hidden = true;
    runBatch(remaining.slice());
    return VB.done(true);
  }

  el.relistRetry.addEventListener('click', retry);

  /**
   * Relist ids on behalf of a Vinted page that already confirmed. Same batch as
   * the grid's Relist, without the manager's own dialog. Ids already in the
   * batch or that are the pending retry set are simply run again.
   */
  function relistFromPage(ids) {
    if (busy) return VB.fail(ERR.BUSY, 'A relist is already running.');
    if (M.isRunning()) return VB.fail(ERR.BUSY, 'A backup is running.');
    VB.log.info(SCOPE, 'Relist requested from a Vinted page for ' + ids.length + ' listing(s)', ids);
    runBatch(ids.slice());
    return VB.done(true);
  }

  VB.relist = { relistMany, relistFromPage, retry, publishProgress, isBusy: () => busy };
})();
