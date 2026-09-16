/**
 * Storage facade.
 *
 * Picks a backend and exposes one interface, so the orchestrator never knows or
 * cares whether bytes are going to a real folder or to IndexedDB. Both backends
 * implement writeListing / writeManifest / readManifest / scan with the same virtual
 * paths.
 *
 * Choosing is deliberately not fully automatic on load: if the folder backend is
 * available, the user is asked for a folder rather than being quietly dropped into
 * browser storage they cannot find afterwards. Browser storage is used without
 * asking only when the picker does not exist at all.
 */
(() => {
  const VB = (globalThis.VB ||= {});
  const SCOPE = 'storage';

  class Storage {
    constructor() {
      /** @type {any} */
      this.backend = null;
      /** 'ready' | 'needs-permission' | 'needs-folder' | 'unavailable' */
      this.status = 'needs-folder';
      this.fsa = VB.FsaBackend.supported ? new VB.FsaBackend() : null;
      this.idb = VB.IdbBackend.supported ? new VB.IdbBackend() : null;
    }

    /** Resolve a backend without prompting. Safe to call on page load. */
    async init() {
      if (this.fsa) {
        const state = await this.fsa.restore();
        if (state === 'ready') {
          this.backend = this.fsa;
          this.status = 'ready';
          return this.describe();
        }
        this.status = state === 'needs-permission' ? 'needs-permission' : 'needs-folder';
        return this.describe();
      }

      if (this.idb) {
        await this.idb.restore();
        this.backend = this.idb;
        this.status = 'ready';
        VB.log.info(SCOPE, 'Folder picker unavailable; using browser storage');
        return this.describe();
      }

      this.status = 'unavailable';
      return this.describe();
    }

    describe() {
      return {
        status: this.status,
        backend: this.backend ? this.backend.name : null,
        label: this.backend ? this.backend.label() : null,
        canChooseFolder: !!this.fsa,
        canUseBrowserStorage: !!this.idb,
        rememberedFolder: this.fsa && this.fsa.pending ? this.fsa.pending.name : null,
      };
    }

    /** Show the folder picker. Must be called from a user gesture. */
    async chooseFolder() {
      if (!this.fsa) {
        return VB.fail(VB.ERR.WRITE_FAILED, 'This browser has no folder picker');
      }
      const res = await this.fsa.chooseTarget();
      if (!res.ok) return res;
      this.backend = this.fsa;
      this.status = 'ready';
      return res;
    }

    /** Re-grant permission on the folder used last session. Needs a gesture. */
    async reconnectFolder() {
      if (!this.fsa) return VB.fail(VB.ERR.WRITE_FAILED, 'No folder picker available');
      const res = await this.fsa.reconnect();
      if (!res.ok) return res;
      this.backend = this.fsa;
      this.status = 'ready';
      return res;
    }

    /** Switch to browser storage, explicitly. */
    async useBrowserStorage() {
      if (!this.idb) return VB.fail(VB.ERR.WRITE_FAILED, 'IndexedDB unavailable');
      if (!this.idb.isReady()) await this.idb.restore();
      this.backend = this.idb;
      this.status = 'ready';
      VB.log.info(SCOPE, 'Switched to browser storage');
      return VB.done(this.idb.label());
    }

    isReady() {
      return !!this.backend && this.backend.isReady();
    }

    #require() {
      if (!this.isReady()) {
        return VB.fail(VB.ERR.WRITE_FAILED, 'No backup destination selected yet');
      }
      return null;
    }

    async writeListing(folder, payload) {
      const missing = this.#require();
      if (missing) return missing;
      return this.backend.writeListing(folder, payload);
    }

    async writeManifest(manifest) {
      const missing = this.#require();
      if (missing) return missing;
      return this.backend.writeManifest(manifest);
    }

    async readManifest() {
      const missing = this.#require();
      if (missing) return missing;
      return this.backend.readManifest();
    }

    async readMetadata(folder) {
      const missing = this.#require();
      if (missing) return missing;
      return this.backend.readMetadata(folder);
    }

    async readRaw(folder) {
      const missing = this.#require();
      if (missing) return missing;
      return this.backend.readRaw(folder);
    }

    async readImages(folder) {
      const missing = this.#require();
      if (missing) return missing;
      return this.backend.readImages(folder);
    }

    async scan() {
      const missing = this.#require();
      if (missing) return missing;
      return this.backend.scan();
    }

    /** ZIP export exists only on the browser-storage backend. */
    async exportZip() {
      if (!this.backend || this.backend.name !== 'idb') {
        return VB.fail(
          VB.ERR.WRITE_FAILED,
          'ZIP export applies to browser storage only; a folder backup is already on disk'
        );
      }
      return this.backend.exportZip();
    }
  }

  VB.Storage = Storage;
})();
