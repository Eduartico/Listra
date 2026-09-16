/**
 * IndexedDB backend: the fallback when the File System Access API is unavailable
 * (older Chromium, or a policy that blocks the picker) or when the user declines to
 * pick a folder.
 *
 * It mirrors the same virtual paths the folder backend writes to real disk
 * ("Nike_Air_Max_90/images/1.jpg"), so both backends present the same interface and
 * the orchestrator never branches on which one is live. Because an IndexedDB backup
 * is invisible outside the browser, this backend can also export the whole thing as
 * a ZIP — built here rather than pulled from a library, since the extension ships no
 * dependencies.
 */
(() => {
  const VB = (globalThis.VB ||= {});
  const SCOPE = 'storage-idb';
  const DB_NAME = 'vinted-backup';
  const DB_VERSION = 1;
  const FILES = 'files';
  const MANIFEST_PATH = 'backup_manifest.json';

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(FILES)) {
          db.createObjectStore(FILES, { keyPath: 'path' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Run one object-store operation and resolve with its result once the
   * transaction commits. Resolving on transaction completion rather than on
   * request success matters for writes: a request can succeed and the transaction
   * still abort, and a backup must not call that a successful write.
   *
   * @param {IDBDatabase} db
   * @param {IDBTransactionMode} mode
   * @param {(store: IDBObjectStore) => IDBRequest|void} fn
   */
  function tx(db, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(FILES, mode);
      let value;
      try {
        const req = fn(t.objectStore(FILES));
        if (req) {
          req.onsuccess = () => {
            value = req.result;
          };
        }
      } catch (err) {
        reject(err);
        return;
      }
      t.oncomplete = () => resolve(value);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  // --- ZIP writing -----------------------------------------------------------

  /** CRC-32, table built once. Required by the ZIP format even for stored entries. */
  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  /**
   * Store-only ZIP (compression method 0). No deflate: the payload is almost
   * entirely JPEG, which does not compress, and skipping it avoids shipping a
   * compression library into the extension.
   *
   * @param {Array<{path: string, bytes: Uint8Array}>} entries
   * @returns {Blob}
   */
  function buildZip(entries) {
    const encoder = new TextEncoder();
    const chunks = [];
    const central = [];
    let offset = 0;

    const u16 = (n) => [n & 0xff, (n >>> 8) & 0xff];
    const u32 = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

    for (const entry of entries) {
      const nameBytes = encoder.encode(entry.path);
      const crc = crc32(entry.bytes);
      const size = entry.bytes.length;

      const local = new Uint8Array([
        ...u32(0x04034b50),
        ...u16(20), // version needed
        ...u16(0x0800), // UTF-8 names
        ...u16(0), // stored
        ...u16(0), // mod time
        ...u16(0), // mod date
        ...u32(crc),
        ...u32(size),
        ...u32(size),
        ...u16(nameBytes.length),
        ...u16(0),
      ]);

      chunks.push(local, nameBytes, entry.bytes);

      central.push(
        new Uint8Array([
          ...u32(0x02014b50),
          ...u16(20),
          ...u16(20),
          ...u16(0x0800),
          ...u16(0),
          ...u16(0),
          ...u16(0),
          ...u32(crc),
          ...u32(size),
          ...u32(size),
          ...u16(nameBytes.length),
          ...u16(0),
          ...u16(0),
          ...u16(0),
          ...u16(0),
          ...u32(0),
          ...u32(offset),
        ]),
        nameBytes
      );

      offset += local.length + nameBytes.length + size;
    }

    const centralSize = central.reduce((sum, c) => sum + c.length, 0);
    const end = new Uint8Array([
      ...u32(0x06054b50),
      ...u16(0),
      ...u16(0),
      ...u16(entries.length),
      ...u16(entries.length),
      ...u32(centralSize),
      ...u32(offset),
      ...u16(0),
    ]);

    return new Blob([...chunks, ...central, end], { type: 'application/zip' });
  }

  class IdbBackend {
    constructor() {
      this.name = 'idb';
      this.db = null;
    }

    static get supported() {
      return typeof indexedDB !== 'undefined';
    }

    isReady() {
      return !!this.db;
    }

    label() {
      return this.db ? 'Browser storage (IndexedDB)' : null;
    }

    async restore() {
      this.db = await openDb();
      return 'ready';
    }

    /** Nothing to pick; the store is always there once opened. */
    async chooseTarget() {
      if (!this.db) this.db = await openDb();
      return VB.done(this.label());
    }

    async put(path, blob) {
      await tx(this.db, 'readwrite', (store) =>
        store.put({ path, blob, size: blob.size, updatedAt: Date.now() })
      );
    }

    async get(path) {
      return tx(this.db, 'readonly', (store) => store.get(path));
    }

    /**
     * Delete every stored row whose path starts with `prefix`. Used before
     * rewriting a listing's images: a re-run with fewer photos than last time
     * must not leave the previous run's extra rows behind, or verifyListing later
     * counts them and fails a listing that was actually stored correctly.
     */
    async deleteUnder(prefix) {
      const existing = await this.entriesUnder(prefix);
      if (!existing.length) return;
      await tx(this.db, 'readwrite', (store) => {
        for (const row of existing) store.delete(row.path);
      });
    }

    async writeListing(folder, payload) {
      if (!this.db) return VB.fail(VB.ERR.WRITE_FAILED, 'Storage not open');
      try {
        await this.put(
          folder + '/metadata.json',
          new Blob([JSON.stringify(payload.snapshot, null, 2)], { type: 'application/json' })
        );
        if (payload.raw !== undefined) {
          await this.put(
            folder + '/raw.json',
            new Blob([JSON.stringify(payload.raw, null, 2)], { type: 'application/json' })
          );
        }
        if (payload.html) {
          await this.put(
            folder + '/raw.html',
            new Blob([payload.html], { type: 'text/html' })
          );
        }
        await this.deleteUnder(folder + '/images/');
        for (const img of payload.images) {
          await this.put(folder + '/images/' + img.name, img.blob);
        }
        const check = await this.verifyListing(folder, payload.images.length);
        if (!check.ok) return check;
        return VB.done(true);
      } catch (err) {
        return VB.fail(VB.ERR.WRITE_FAILED, 'Storing ' + folder + ' failed: ' + String(err));
      }
    }

    async entriesUnder(prefix) {
      const all = await tx(this.db, 'readonly', (store) => store.getAll());
      return (all || []).filter((row) => row.path.startsWith(prefix));
    }

    async verifyListing(folder, expectedImageCount) {
      try {
        const rows = await this.entriesUnder(folder + '/');
        const meta = rows.find((r) => r.path === folder + '/metadata.json');
        if (!meta) return VB.fail(VB.ERR.VERIFY_FAILED, folder + '/metadata.json missing');
        const parsed = JSON.parse(await meta.blob.text());
        if (!parsed || !parsed.id) {
          return VB.fail(VB.ERR.VERIFY_FAILED, folder + '/metadata.json has no id');
        }
        const images = rows.filter((r) => r.path.startsWith(folder + '/images/'));
        const empty = images.find((r) => r.size === 0);
        if (empty) return VB.fail(VB.ERR.VERIFY_FAILED, empty.path + ' is empty');
        if (expectedImageCount != null && images.length !== expectedImageCount) {
          return VB.fail(
            VB.ERR.VERIFY_FAILED,
            folder + ' stored ' + images.length + ' images, expected ' + expectedImageCount
          );
        }
        return VB.done({ images: images.length });
      } catch (err) {
        return VB.fail(VB.ERR.VERIFY_FAILED, 'Verifying ' + folder + ': ' + String(err));
      }
    }

    async readMetadata(folder) {
      const row = await this.get(folder + '/metadata.json');
      if (!row) return VB.fail(VB.ERR.VERIFY_FAILED, folder + '/metadata.json missing');
      try {
        return VB.done(JSON.parse(await row.blob.text()));
      } catch (err) {
        return VB.fail(VB.ERR.VERIFY_FAILED, folder + '/metadata.json unreadable: ' + String(err));
      }
    }

    async readRaw(folder) {
      const row = await this.get(folder + '/raw.json');
      if (!row) return VB.done(null);
      try {
        return VB.done(JSON.parse(await row.blob.text()));
      } catch {
        return VB.done(null);
      }
    }

    async readImages(folder) {
      const rows = await this.entriesUnder(folder + '/images/');
      const out = rows.map((r) => ({ name: r.path.slice(r.path.lastIndexOf('/') + 1), blob: r.blob }));
      out.sort((a, b) => parseInt(a.name, 10) - parseInt(b.name, 10));
      return VB.done(out);
    }

    async writeManifest(manifest) {
      if (!this.db) return VB.fail(VB.ERR.WRITE_FAILED, 'Storage not open');
      try {
        await this.put(
          MANIFEST_PATH,
          new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' })
        );
        return VB.done(true);
      } catch (err) {
        return VB.fail(VB.ERR.WRITE_FAILED, 'Writing manifest failed: ' + String(err));
      }
    }

    async readManifest() {
      try {
        const rows = await this.entriesUnder(MANIFEST_PATH);
        const row = rows.find((r) => r.path === MANIFEST_PATH);
        if (!row) return VB.fail(VB.ERR.VERIFY_FAILED, 'No manifest stored yet');
        return VB.done(JSON.parse(await row.blob.text()));
      } catch (err) {
        return VB.fail(VB.ERR.VERIFY_FAILED, 'Manifest unreadable: ' + String(err));
      }
    }

    async scan() {
      try {
        const all = await this.entriesUnder('');
        /** @type {Map<string, any>} */
        const byFolder = new Map();
        for (const row of all) {
          if (!row.path.includes('/')) continue;
          const folder = row.path.slice(0, row.path.indexOf('/'));
          if (!byFolder.has(folder)) {
            byFolder.set(folder, {
              folder,
              images: 0,
              bytes: 0,
              metadata: null,
              problems: [],
            });
          }
          const entry = byFolder.get(folder);
          entry.bytes += row.size || 0;
          if (row.path.endsWith('/metadata.json')) {
            try {
              entry.metadata = JSON.parse(await row.blob.text());
            } catch {
              entry.problems.push('metadata.json unreadable');
            }
          } else if (row.path.includes('/images/')) {
            entry.images += 1;
            if (!row.size) entry.problems.push(row.path + ' is empty');
          }
        }
        for (const entry of byFolder.values()) {
          if (!entry.metadata) entry.problems.push('metadata.json missing');
        }
        return VB.done([...byFolder.values()]);
      } catch (err) {
        return VB.fail(VB.ERR.VERIFY_FAILED, 'Could not scan storage: ' + String(err));
      }
    }

    /**
     * Export everything as a single ZIP so an IndexedDB backup is still portable.
     * Reads the whole store into memory, which is the practical ceiling of this
     * backend — a very large backup belongs in a real folder.
     */
    async exportZip() {
      try {
        const rows = await this.entriesUnder('');
        if (!rows.length) return VB.fail(VB.ERR.VERIFY_FAILED, 'Nothing stored to export');
        const entries = [];
        for (const row of rows) {
          entries.push({
            path: 'VintedBackup/' + row.path,
            bytes: new Uint8Array(await row.blob.arrayBuffer()),
          });
        }
        const zip = buildZip(entries);
        VB.log.info(SCOPE, 'Built ZIP of ' + entries.length + ' files, ' + zip.size + ' bytes');
        return VB.done(zip);
      } catch (err) {
        return VB.fail(VB.ERR.WRITE_FAILED, 'ZIP export failed: ' + String(err));
      }
    }

    /** Remove every stored file. Used by the explicit "clear" action only. */
    async clear() {
      await tx(this.db, 'readwrite', (store) => store.clear());
      return VB.done(true);
    }
  }

  VB.IdbBackend = IdbBackend;
  VB.buildZip = buildZip;
  VB.crc32 = crc32;
})();
