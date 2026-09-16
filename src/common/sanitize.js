/**
 * Filesystem-safe name construction.
 *
 * Backups land on the user's real disk, usually NTFS, so this has to survive more
 * than the spec's character class: Windows also rejects a set of reserved device
 * names outright and silently drops trailing dots and spaces.
 */
(() => {
  const VB = (globalThis.VB ||= {});
  const { maxFolderNameLength } = VB.constants.LIMITS;

  /**
   * Device names Windows refuses as a file or folder name at any extension.
   * Creating "CON" fails with a permission error that reads like a bug in us.
   */
  const RESERVED = new Set([
    'CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
  ]);

  /**
   * Turn a listing title into a folder name.
   *
   * Per spec: everything outside [a-zA-Z0-9_- ] becomes "_", trimmed to 64 chars.
   * That intentionally flattens accents and non-Latin scripts, so a title that is
   * entirely non-Latin collapses to underscores; an empty or all-underscore result
   * falls back to "listing".
   *
   * @param {string} title
   * @returns {string} a name safe on NTFS, ext4 and APFS
   */
  function folderName(title) {
    let name = String(title == null ? '' : title)
      .replace(/[^a-zA-Z0-9_\- ]/g, '_')
      .replace(/_{2,}/g, '_')
      .trim()
      .slice(0, maxFolderNameLength)
      // Truncation can leave a trailing space, which Windows silently drops when
      // creating the folder; that would desync the manifest from what is on disk.
      .replace(/[. ]+$/, '');

    if (!name || /^_+$/.test(name)) name = 'listing';
    if (RESERVED.has(name.toUpperCase())) name = name + '_';
    return name;
  }

  /**
   * Folder name that does not collide with one already used in this backup.
   * Two listings can legitimately share a title and the second must not overwrite
   * the first.
   *
   * @param {string} title
   * @param {Set<string>} taken names already allocated; the winner is added to it
   * @returns {string}
   */
  function uniqueFolderName(title, taken) {
    const base = folderName(title);
    if (!taken.has(base)) {
      taken.add(base);
      return base;
    }
    for (let i = 2; i < 10000; i += 1) {
      const suffix = '_' + i;
      const candidate = base.slice(0, maxFolderNameLength - suffix.length) + suffix;
      if (!taken.has(candidate)) {
        taken.add(candidate);
        return candidate;
      }
    }
    // Practically unreachable; keeps the function total rather than returning
    // undefined and writing a folder literally called "undefined".
    const fallback = 'listing_' + Date.now();
    taken.add(fallback);
    return fallback;
  }

  /**
   * Image file name for a 1-based index, keeping the CDN extension when it is one
   * we recognise. Vinted serves JPEG almost exclusively but has WebP variants.
   *
   * @param {number} index 1-based
   * @param {string} url source URL, used only for its extension
   */
  function imageFileName(index, url) {
    let ext = 'jpg';
    const m = /\.(jpe?g|png|webp|gif|avif)(?:[?#]|$)/i.exec(String(url || ''));
    if (m) {
      const found = m[1].toLowerCase();
      ext = found === 'jpeg' ? 'jpg' : found;
    }
    return index + '.' + ext;
  }

  VB.sanitize = { folderName, uniqueFolderName, imageFileName, RESERVED };
})();
