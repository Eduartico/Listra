/**
 * Every message type that crosses a context boundary.
 *
 * Message flow: the manager page is the orchestrator but has no Vinted cookies,
 * so any call that must look like Vinted's own XHR is sent to the service worker,
 * which forwards it to a Vinted tab's content script and relays the reply back.
 *
 *   popup/content  --> service worker   (commands)
 *   manager        --> service worker   --> content script (PROXY_*)
 *   manager        --> popup/content    (STATE_CHANGED broadcast)
 */
(() => {
  const VB = (globalThis.VB ||= {});

  VB.MSG = {
    // --- commands, handled by the service worker -----------------------------
    /** Open (or focus) the manager tab. */
    OPEN_MANAGER: 'OPEN_MANAGER',
    /** FAB or popup asking for a backup run; carries the originating tab. */
    START_BACKUP: 'START_BACKUP',
    /** Stop the queue at the next safe point. */
    CANCEL_BACKUP: 'CANCEL_BACKUP',
    /** Read the persisted run state. Answered from chrome.storage.local. */
    GET_STATE: 'GET_STATE',
    /**
     * In-page Relist button or menu asking the manager to relist these ids. The
     * worker opens the manager in the background and forwards this to it.
     */
    RELIST_ITEMS: 'RELIST_ITEMS',
    /** Retry the stopped relist batch (after a human check done on the page). */
    RELIST_RETRY: 'RELIST_RETRY',
    /** Per-id backup and relist facts for hover panels; answered from storage. */
    GET_ITEM_STATUS: 'GET_ITEM_STATUS',
    /** Manager asking to be brought to the front because it needs the person. */
    NEED_ATTENTION: 'NEED_ATTENTION',
    /**
     * A manager page announcing its tab id on load. The worker cannot find
     * manager tabs by URL (Brave hides extension-page URLs from tabs.query
     * without the "tabs" permission), so the manager registers itself instead.
     * Answered with `{ existing: tabId|null }` when another manager is alive.
     */
    MANAGER_HELLO: 'MANAGER_HELLO',
    /** Worker -> manager tab: are you still a manager page? */
    MANAGER_PING: 'MANAGER_PING',

    // --- proxied to a Vinted tab's content script ----------------------------
    /** Readiness probe: is a content script listening in this tab yet? */
    PING: 'PING',
    /** Report region, domain, signed-in user id and profile user id. */
    PROXY_CONTEXT: 'PROXY_CONTEXT',
    /** Paginate the wardrobe endpoint; returns an array of item ids. */
    PROXY_COLLECT_IDS: 'PROXY_COLLECT_IDS',
    /** Assemble one listing from the wardrobe record and its page; returns raw. */
    PROXY_FETCH_ITEM: 'PROXY_FETCH_ITEM',
    /** Fetch and parse only the listing page; returns extracted fields. */
    PROXY_FETCH_HTML: 'PROXY_FETCH_HTML',

    // --- relisting, also proxied to a Vinted tab --------------------------------
    /** POST /api/v2/photos with one image (base64 in the message); returns the temp photo. */
    PROXY_UPLOAD_PHOTO: 'PROXY_UPLOAD_PHOTO',
    /** POST /api/v2/item_upload/attributes for a category; returns the attribute form. */
    PROXY_ATTRIBUTE_FORM: 'PROXY_ATTRIBUTE_FORM',
    /** GET /api/v2/item_upload/colors; returns the colour list. */
    PROXY_COLORS: 'PROXY_COLORS',
    /** POST /api/v2/item_upload/items with a prepared body; returns the created item. */
    PROXY_CREATE_ITEM: 'PROXY_CREATE_ITEM',
    /** POST /api/v2/items/{id}/delete. */
    PROXY_DELETE_ITEM: 'PROXY_DELETE_ITEM',

    // --- broadcasts ----------------------------------------------------------
    /** Run state changed; payload is the full run state object. */
    STATE_CHANGED: 'STATE_CHANGED',
    /** Drive the on-page progress overlay in the Vinted tab. */
    OVERLAY_UPDATE: 'OVERLAY_UPDATE',
    /** Relist batch progress, manager -> worker -> the Vinted tab that asked. */
    RELIST_PROGRESS: 'RELIST_PROGRESS',
  };

  /** Error codes we branch on, rather than matching error message text. */
  VB.ERR = {
    NO_PROXY_TAB: 'NO_PROXY_TAB',
    NOT_VINTED: 'NOT_VINTED',
    HTTP: 'HTTP',
    NOT_JSON: 'NOT_JSON',
    CHALLENGE: 'CHALLENGE',
    TIMEOUT: 'TIMEOUT',
    SHAPE: 'SHAPE',
    CANCELLED: 'CANCELLED',
    NO_IMAGES: 'NO_IMAGES',
    WRITE_FAILED: 'WRITE_FAILED',
    VERIFY_FAILED: 'VERIFY_FAILED',
    /** Vinted asked for a human check (DataDome); `captchaUrl` carries where to do it. */
    HUMAN_CHECK: 'HUMAN_CHECK',
    /** HTTP 429 from Vinted. */
    RATE_LIMITED: 'RATE_LIMITED',
    /** The manager is already backing up or relisting. */
    BUSY: 'BUSY',
  };

  /**
   * Build a rejected-result object. We return these instead of throwing across
   * message boundaries, because an Error does not survive structured cloning with
   * its `code` intact.
   *
   * @param {string} code one of VB.ERR
   * @param {string} message human-readable detail
   * @param {object} [extra] additional diagnostic fields
   */
  VB.fail = (code, message, extra) => ({ ok: false, code, message, ...(extra || {}) });

  /** Build a successful result object. */
  VB.done = (value) => ({ ok: true, value });
})();
