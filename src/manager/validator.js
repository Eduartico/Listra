/**
 * Backup validation.
 *
 * Re-reads what is actually stored and compares it against the manifest, rather
 * than trusting the counters the run kept in memory. That distinction is the whole
 * point: an in-memory counter says what the extension believed it wrote, and this
 * says what is there now.
 *
 * Reports, per listing: metadata present and parseable, required fields intact,
 * image count matching the manifest, no empty files. Plus totals for the summary.
 */
(() => {
  const VB = (globalThis.VB ||= {});
  const SCOPE = 'validator';

  function humanBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i += 1;
    }
    return (i === 0 ? value : value.toFixed(1)) + ' ' + units[i];
  }

  /**
   * @param {VB.Storage} storage
   * @returns {Promise<{ok: true, value: object} | {ok: false, code: string, message: string}>}
   */
  async function validate(storage) {
    const manifestRes = await storage.readManifest();
    const scanRes = await storage.scan();

    if (!scanRes.ok) return scanRes;

    const manifest = manifestRes.ok ? manifestRes.value : null;
    const folders = scanRes.value;
    const byFolder = new Map(folders.map((f) => [f.folder, f]));

    const problems = [];
    if (!manifestRes.ok) {
      problems.push({
        scope: 'manifest',
        message: 'backup_manifest.json is missing or unreadable',
      });
    }

    const rows = [];
    let totalImages = 0;
    let totalBytes = 0;

    // Manifest-driven pass: everything the manifest claims should exist.
    const claimed = manifest && Array.isArray(manifest.listings) ? manifest.listings : [];
    for (const entry of claimed) {
      const found = byFolder.get(entry.folder);
      const row = {
        id: entry.id,
        title: entry.title,
        folder: entry.folder,
        status: entry.status,
        expectedImages: entry.imageCount == null ? null : Number(entry.imageCount),
        actualImages: found ? found.images : 0,
        bytes: found ? found.bytes : 0,
        issues: [],
      };

      if (!found) {
        row.issues.push('folder missing on disk');
      } else {
        totalImages += found.images;
        totalBytes += found.bytes;
        for (const p of found.problems) row.issues.push(p);

        const meta = found.metadata;
        if (meta) {
          const check = VB.normalize.validateSnapshot(meta);
          if (!check.ok) row.issues.push(check.message);
          if (meta.id && entry.id && String(meta.id) !== String(entry.id)) {
            row.issues.push('metadata id does not match the manifest entry');
          }
        }
        if (row.expectedImages != null && row.actualImages !== row.expectedImages) {
          row.issues.push(
            'manifest says ' + row.expectedImages + ' images, found ' + row.actualImages
          );
        }
      }

      if (row.issues.length) {
        problems.push({ scope: row.folder, message: row.issues.join('; ') });
      }
      rows.push(row);
    }

    // Disk-driven pass: folders present that the manifest does not mention. Usually
    // a run that was interrupted before the manifest was rewritten.
    const claimedFolders = new Set(claimed.map((c) => c.folder));
    for (const folder of folders) {
      if (claimedFolders.has(folder.folder)) continue;
      totalImages += folder.images;
      totalBytes += folder.bytes;
      const issues = ['not listed in the manifest'].concat(folder.problems);
      rows.push({
        id: folder.metadata ? folder.metadata.id : null,
        title: folder.metadata ? folder.metadata.title : null,
        folder: folder.folder,
        status: 'orphan',
        expectedImages: null,
        actualImages: folder.images,
        bytes: folder.bytes,
        issues,
      });
      problems.push({ scope: folder.folder, message: issues.join('; ') });
    }

    const summary = {
      backend: storage.backend ? storage.backend.name : null,
      destination: storage.backend ? storage.backend.label() : null,
      manifestListings: claimed.length,
      foldersOnDisk: folders.length,
      totalImages,
      totalBytes,
      totalBytesHuman: humanBytes(totalBytes),
      failuresInManifest: claimed.filter((c) => c.status === 'failed').length,
      listingsWithIssues: rows.filter((r) => r.issues.length).length,
      ok: problems.length === 0,
    };

    VB.log.info(SCOPE, 'Validation finished', summary);
    return VB.done({ summary, rows, problems });
  }

  VB.validator = { validate, humanBytes };
})();
