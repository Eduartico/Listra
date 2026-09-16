/**
 * File System Access backend: writes the backup into a real folder the user picks.
 *
 * This is why the orchestrator lives in a tab. showDirectoryPicker() exists only on
 * a document, needs a user gesture, and the handle it returns is meaningless in
 * another context. The handle is structured-cloneable though, so it is stashed in
 * IndexedDB and the same folder can be reused across sessions — subject to the user
 * re-granting permission, which also needs a gesture, hence the reconnect button in
 * the UI.
 *
 * Layout written (per spec):
 *   backup_manifest.json
 *   <Sanitized_Title>/metadata.json
 *   <Sanitized_Title>/raw.json
 *   <Sanitized_Title>/images/1.jpg ...
 */
(() => {
  const VB = (globalThis.VB ||= {});
  const SCOPE = 'storage-fsa';
  const MANIFEST_NAME = 'backup_manifest.json';

  const HANDLE_DB = 'vinted-backup-handles';
  const HANDLE_STORE = 'handles';
  const HANDLE_KEY = 'root';

  function openHandleDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(HANDLE_DB, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(HANDLE_STORE)) {
          req.result.createObjectStore(HANDLE_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function idbPut(db, store, key, value) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function idbGet(db, store, key) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  class FsaBackend {
    constructor() {
      this.name = 'fsa';
      /** @type {FileSystemDirectoryHandle|null} */
      this.root = null;
    }

    static get supported() {
      return typeof globalThis.showDirectoryPicker === 'function';
    }

    isReady() {
      return !!this.root;
    }

    label() {
      return this.root ? this.root.name : null;
    }

    /**
     * Re-attach to the folder chosen in an earlier session, if Chrome still
     * considers the grant live. Never prompts: a prompt needs a user gesture and
     * this runs on page load.
     *
     * @returns {Promise<'ready'|'needs-permission'|'none'>}
     */
    async restore() {
      let db;
      try {
        db = await openHandleDb();
      } catch (err) {
        VB.log.warn(SCOPE, 'Handle database unavailable', String(err));
        return 'none';
      }
      const handle = await idbGet(db, HANDLE_STORE, HANDLE_KEY).catch(() => null);
      if (!handle) return 'none';

      const state = await handle.queryPermission({ mode: 'readwrite' });
      if (state === 'granted') {
        this.root = handle;
        VB.log.info(SCOPE, 'Reconnected to folder ' + handle.name);
        return 'ready';
      }
      // Kept on the instance so the reconnect button can request permission
      // without making the user pick the folder again.
      this.pending = handle;
      return 'needs-permission';
    }

    /** Request permission on the folder remembered from last time. Needs a gesture. */
    async reconnect() {
      if (!this.pending) return VB.fail(VB.ERR.WRITE_FAILED, 'No remembered folder');
      const state = await this.pending.requestPermission({ mode: 'readwrite' });
      if (state !== 'granted') {
        return VB.fail(VB.ERR.WRITE_FAILED, 'Folder permission was not granted');
      }
      this.root = this.pending;
      this.pending = null;
      return VB.done(this.root.name);
    }

    /** Show the directory picker. Must be called from a click handler. */
    async chooseTarget() {
      try {
        const handle = await globalThis.showDirectoryPicker({
          id: 'vinted-backup',
          mode: 'readwrite',
          startIn: 'documents',
        });
        this.root = handle;
        const db = await openHandleDb();
        await idbPut(db, HANDLE_STORE, HANDLE_KEY, handle);
        VB.log.info(SCOPE, 'Backup folder set to ' + handle.name);
        return VB.done(handle.name);
      } catch (err) {
        // AbortError means the user closed the picker; that is not a failure worth
        // shouting about.
        if (err && err.name === 'AbortError') {
          return VB.fail(VB.ERR.CANCELLED, 'Folder selection cancelled');
        }
        return VB.fail(VB.ERR.WRITE_FAILED, 'Could not open folder: ' + String(err));
      }
    }

    async dir(parent, name, create) {
      return parent.getDirectoryHandle(name, { create: !!create });
    }

    async writeFile(dirHandle, name, data) {
      const fileHandle = await dirHandle.getFileHandle(name, { create: true });
      const writable = await fileHandle.createWritable();
      try {
        await writable.write(data);
      } finally {
        // Closing is what actually commits; a thrown write must still close or the
        // file is left locked.
        await writable.close();
      }
    }

    /**
     * Delete every file directly inside `dirHandle`. Used before rewriting a
     * listing's images/ folder: a re-run whose photo count went down must not
     * leave the previous run's extra files behind, or verifyListing later counts
     * them and fails a listing that was actually written correctly.
     */
    async clearFiles(dirHandle) {
      for await (const [name, handle] of dirHandle.entries()) {
        if (handle.kind === 'file') await dirHandle.removeEntry(name).catch(() => {});
      }
    }

    /**
     * Write one listing's folder, then read it back.
     *
     * The read-back is the point: a snapshot only counts as backed up once the
     * bytes are on disk and non-empty, and createWritable can succeed while the
     * commit later fails on a full or disconnected volume.
     *
     * @param {string} folder sanitized folder name
     * @param {{snapshot: object, images: Array<{name: string, blob: Blob}>, raw: any, html?: string}} payload
     */
    async writeListing(folder, payload) {
      if (!this.root) return VB.fail(VB.ERR.WRITE_FAILED, 'No backup folder selected');
      try {
        const listingDir = await this.dir(this.root, folder, true);
        await this.writeFile(
          listingDir,
          'metadata.json',
          JSON.stringify(payload.snapshot, null, 2)
        );
        if (payload.raw !== undefined) {
          // Everything Vinted returned, kept verbatim. If a field turns out to
          // matter later, it is already in the backup rather than lost to our
          // schema.
          await this.writeFile(listingDir, 'raw.json', JSON.stringify(payload.raw, null, 2));
        }
        if (payload.html) {
          // Only present when the DOM fallback ran. Saved so a selector that broke
          // can be diagnosed against the markup as it actually was.
          await this.writeFile(listingDir, 'raw.html', payload.html);
        }

        const imagesDir = await this.dir(listingDir, 'images', true);
        // Clear before writing: a re-run with fewer photos than last time must not
        // leave the old extras behind (they would otherwise inflate the count
        // verifyListing sees and fail a listing that actually wrote correctly).
        await this.clearFiles(imagesDir);
        for (const img of payload.images) {
          await this.writeFile(imagesDir, img.name, img.blob);
        }

        const check = await this.verifyListing(folder, payload.images.length);
        if (!check.ok) return check;
        return VB.done(true);
      } catch (err) {
        return VB.fail(VB.ERR.WRITE_FAILED, 'Writing ' + folder + ' failed: ' + String(err));
      }
    }

    /** Confirm metadata parses and every image is present and non-empty. */
    async verifyListing(folder, expectedImageCount) {
      try {
        const listingDir = await this.dir(this.root, folder, false);
        const metaFile = await (await listingDir.getFileHandle('metadata.json')).getFile();
        const text = await metaFile.text();
        const parsed = JSON.parse(text);
        if (!parsed || !parsed.id) {
          return VB.fail(VB.ERR.VERIFY_FAILED, folder + '/metadata.json has no id');
        }

        const imagesDir = await this.dir(listingDir, 'images', false);
        let count = 0;
        for await (const [name, handle] of imagesDir.entries()) {
          if (handle.kind !== 'file') continue;
          const file = await handle.getFile();
          if (file.size === 0) {
            return VB.fail(VB.ERR.VERIFY_FAILED, folder + '/images/' + name + ' is empty');
          }
          count += 1;
        }
        if (expectedImageCount != null && count !== expectedImageCount) {
          return VB.fail(
            VB.ERR.VERIFY_FAILED,
            folder + ' has ' + count + ' images on disk, expected ' + expectedImageCount
          );
        }
        return VB.done({ images: count });
      } catch (err) {
        return VB.fail(VB.ERR.VERIFY_FAILED, 'Verifying ' + folder + ': ' + String(err));
      }
    }

    /** metadata.json of one listing folder. */
    async readMetadata(folder) {
      if (!this.root) return VB.fail(VB.ERR.WRITE_FAILED, 'No backup folder selected');
      try {
        const dir = await this.dir(this.root, folder, false);
        const file = await (await dir.getFileHandle('metadata.json')).getFile();
        return VB.done(JSON.parse(await file.text()));
      } catch (err) {
        return VB.fail(VB.ERR.VERIFY_FAILED, folder + '/metadata.json unreadable: ' + String(err));
      }
    }

    /** raw.json of one listing folder, or null when absent. */
    async readRaw(folder) {
      if (!this.root) return VB.fail(VB.ERR.WRITE_FAILED, 'No backup folder selected');
      try {
        const dir = await this.dir(this.root, folder, false);
        const file = await (await dir.getFileHandle('raw.json')).getFile();
        return VB.done(JSON.parse(await file.text()));
      } catch {
        return VB.done(null);
      }
    }

    /** The image files of one listing, as blobs, in index order. */
    async readImages(folder) {
      if (!this.root) return VB.fail(VB.ERR.WRITE_FAILED, 'No backup folder selected');
      try {
        const dir = await this.dir(this.root, folder, false);
        const imagesDir = await this.dir(dir, 'images', false);
        const out = [];
        for await (const [name, handle] of imagesDir.entries()) {
          if (handle.kind !== 'file') continue;
          out.push({ name, blob: await handle.getFile() });
        }
        out.sort((a, b) => parseInt(a.name, 10) - parseInt(b.name, 10));
        return VB.done(out);
      } catch (err) {
        return VB.fail(VB.ERR.VERIFY_FAILED, folder + '/images unreadable: ' + String(err));
      }
    }

    async writeManifest(manifest) {
      if (!this.root) return VB.fail(VB.ERR.WRITE_FAILED, 'No backup folder selected');
      try {
        await this.writeFile(this.root, MANIFEST_NAME, JSON.stringify(manifest, null, 2));
        return VB.done(true);
      } catch (err) {
        return VB.fail(VB.ERR.WRITE_FAILED, 'Writing manifest failed: ' + String(err));
      }
    }

    async readManifest() {
      if (!this.root) return VB.fail(VB.ERR.WRITE_FAILED, 'No backup folder selected');
      try {
        const file = await (await this.root.getFileHandle(MANIFEST_NAME)).getFile();
        return VB.done(JSON.parse(await file.text()));
      } catch (err) {
        return VB.fail(VB.ERR.VERIFY_FAILED, 'No readable manifest: ' + String(err));
      }
    }

    /** Listing folders present on disk, with their file counts and total bytes. */
    async scan() {
      if (!this.root) return VB.fail(VB.ERR.WRITE_FAILED, 'No backup folder selected');
      const folders = [];
      try {
        for await (const [name, handle] of this.root.entries()) {
          if (handle.kind !== 'directory') continue;
          const entry = { folder: name, images: 0, bytes: 0, metadata: null, problems: [] };

          try {
            const metaFile = await (await handle.getFileHandle('metadata.json')).getFile();
            entry.bytes += metaFile.size;
            entry.metadata = JSON.parse(await metaFile.text());
          } catch {
            entry.problems.push('metadata.json missing or unreadable');
          }

          try {
            const imagesDir = await handle.getDirectoryHandle('images');
            for await (const [imgName, imgHandle] of imagesDir.entries()) {
              if (imgHandle.kind !== 'file') continue;
              const file = await imgHandle.getFile();
              if (file.size === 0) entry.problems.push(imgName + ' is empty');
              entry.images += 1;
              entry.bytes += file.size;
            }
          } catch {
            entry.problems.push('images/ missing');
          }

          folders.push(entry);
        }
        return VB.done(folders);
      } catch (err) {
        return VB.fail(VB.ERR.VERIFY_FAILED, 'Could not scan backup folder: ' + String(err));
      }
    }
  }

  VB.FsaBackend = FsaBackend;
})();
