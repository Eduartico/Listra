/**
 * "Save to Downloads folder": copy a browser-storage backup out as real files.
 *
 * Brave has no folder picker, so on Brave the backup lives in IndexedDB, which a
 * person cannot open. chrome.downloads can still write into the Downloads folder
 * with subfolders, so every stored file is handed to it under
 * Downloads/Listra/<profile>/<listing>/... — the same layout the folder backend
 * writes — and the result is a folder the person can browse.
 *
 * Downloads are started one after another; Chrome shows them in its download
 * list. If the browser is set to "ask where to save each file", it will ask once
 * per file, which is worth turning off first for a 160-file backup.
 */
(() => {
  const VB = globalThis.VB;
  const M = VB.manager;
  const { el } = M;
  const SCOPE = 'downloads';

  let busy = false;

  function safeSegment(s) {
    return VB.sanitize.folderName(s || 'backup');
  }

  async function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    try {
      await chrome.downloads.download({ url, filename, conflictAction: 'overwrite', saveAs: false });
    } finally {
      // The download reads the URL asynchronously; revoke well after it started.
      setTimeout(() => URL.revokeObjectURL(url), 120000);
    }
  }

  async function saveToDownloads() {
    if (busy) return;
    busy = true;
    el.saveDownloads.disabled = true;
    try {
      const scan = await M.storage.scan();
      if (!scan.ok) {
        M.setNotice(scan.message, 'error');
        return;
      }
      const ctx = M.getState().context || {};
      const root = 'Listra/' + safeSegment(ctx.username || ctx.profileUserId || 'backup');
      const folders = scan.value;
      let files = 0;
      const total = folders.reduce((n, f) => n + 2 + f.images, 0) + 1;
      const progress = (label) => {
        el.downloadsProgress.textContent = 'Saving ' + files + ' of ~' + total + ' files to Downloads/' + root + (label ? ' — ' + label : '');
      };

      const manifest = await M.storage.readManifest();
      if (manifest.ok) {
        await downloadBlob(new Blob([JSON.stringify(manifest.value, null, 2)], { type: 'application/json' }), root + '/backup_manifest.json');
        files += 1;
      }

      for (const folder of folders) {
        progress(folder.folder);
        const base = root + '/' + folder.folder;
        const meta = await M.storage.readMetadata(folder.folder);
        if (meta.ok) {
          await downloadBlob(new Blob([JSON.stringify(meta.value, null, 2)], { type: 'application/json' }), base + '/metadata.json');
          files += 1;
        }
        const raw = await M.storage.readRaw(folder.folder);
        if (raw.ok && raw.value) {
          await downloadBlob(new Blob([JSON.stringify(raw.value, null, 2)], { type: 'application/json' }), base + '/raw.json');
          files += 1;
        }
        const images = await M.storage.readImages(folder.folder);
        if (images.ok) {
          for (const img of images.value) {
            await downloadBlob(img.blob, base + '/images/' + img.name);
            files += 1;
          }
        }
      }
      el.downloadsProgress.textContent = 'Saved ' + files + ' files to Downloads/' + root + '.';
      M.setNotice('Backup copied to Downloads/' + root + '. Open your Downloads folder to browse it.', 'ok');
      VB.log.info(SCOPE, 'Saved ' + files + ' files to Downloads/' + root);
    } catch (err) {
      M.setNotice('Saving to Downloads stopped: ' + String(err), 'error');
      VB.log.error(SCOPE, 'Save to Downloads failed', String(err));
    } finally {
      busy = false;
      el.saveDownloads.disabled = false;
    }
  }

  el.saveDownloads.addEventListener('click', saveToDownloads);
  VB.exportDownloads = { saveToDownloads };
})();
