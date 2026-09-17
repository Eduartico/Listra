/**
 * Every DOM selector, URL pattern, API path and embedded-data signature the
 * extension depends on, in one place.
 *
 * Vinted ships CSS Modules with hashed class names, so class selectors rot on each
 * deploy. Order of preference throughout: data-testid, then semantic HTML, then a
 * [class*=...] substring match as a last resort. When Vinted changes its markup or
 * its API, this file and normalize.js are the only two that should need editing.
 *
 * Entries marked "observed" were confirmed against vinted.pt on 2026-09-16.
 * Unmarked entries come from the original brief and are best-effort.
 */
(() => {
  const VB = (globalThis.VB ||= {});

  VB.SELECTORS = {
    /** Internal API paths, relative to the storefront origin. */
    api: {
      /** Observed: public, paginated, 96 per page, full photo records. */
      wardrobeItems: (userId) => '/api/v2/wardrobe/' + userId + '/items',
      /** Observed: public. */
      user: (userId) => '/api/v2/users/' + userId,
      /** Observed: 403 when signed out; the signed-in viewer otherwise. */
      currentUser: '/api/v2/users/current',
      /**
       * Observed: exists (403 when signed out). Expected to return the seller's own
       * editable item — ids for catalog, status, colours, package size. Fetched
       * opportunistically and stored raw; nothing depends on its shape.
       */
      itemUpload: (itemId) => '/api/v2/item_upload/items/' + itemId,
      /** Observed: the full category tree, one request. */
      catalogs: '/api/v2/item_upload/catalogs',
      /** Observed: colour id -> title. */
      colors: '/api/v2/item_upload/colors',
    },

    profile: {
      listingCards: 'a[href*="/items/"]',
      listingGrid: '[data-testid="profile-items-grid"]',
      /**
       * Observed: a profile URL is /member/{numericId}-{login}. Requiring the id is
       * what keeps /member/login and /member/signup from being mistaken for one.
       */
      profileInUrl: /^\/member\/(\d+)(?:-([^/?#]+))?\/?$/,
      /** Matches "/items/123456789-some-slug" and captures the numeric id. */
      itemIdInHref: /\/items\/(\d+)(?:-|$|[?#])/,
    },

    item: {
      /** Matches "/items/123456789-some-slug" and "/items/123456789"; captures the id. */
      itemInUrl: /^\/items\/(\d+)(?:-[^/?#]*)?\/?$/,
      /**
       * The owner's own action buttons on an item page (observed on vinted.pt,
       * 2026-09-17: bump, mark-as-sold, mark-as-reserved, hide, edit, delete, all
       * siblings in one `.u-grid` container). The Relist button is appended to
       * the container of the first one found; with none, it floats.
       */
      ownerActionButtons: [
        '[data-testid="item-bump-button"]',
        '[data-testid="item-edit-button"]',
        '[data-testid="mark-as-sold-button"]',
        '[data-testid="item-delete-button"]',
      ],
      /** The filled ("Destacar") button is the look the Relist button copies. */
      ownerActionTemplate: '[data-testid="item-bump-button"]',
    },

    /** Signatures inside the page's embedded data. See page-data.js. */
    pageData: {
      /** Legacy Pages Router block; not present on the App Router (observed). */
      nextDataScriptId: '__NEXT_DATA__',
      /** The call that carries flight data; its array argument is scanned out. */
      flightMarker: 'self.__next_f.push',
      /** Observed: `"CSRF_TOKEN":"<uuid>"` inside the page config. */
      csrfTokenPattern: '"CSRF_TOKEN":"([0-9a-f-]{36})"',
      /** Observed: `"anon_id":"<uuid>"` in the mirrored cookies object. */
      anonIdPattern: '"anon_id":"([0-9a-f-]{36})"',
      /**
       * Observed: every item-page block is an object with name, type, section and
       * data keys — in either order (data-first on an anonymous render, name-first
       * on a signed-in one). Blocks are located by name and the enclosing object is
       * parsed whole, so key order does not matter.
       */
      pluginNamePattern: '"name":"([a-z_]+)"',
      /** Observed: the sidebar's compact item object starts here. */
      sidebarItemKey: '"item":{',
      jsonLdSelector: 'script[type="application/ld+json"]',
      /** Legacy candidate paths, used only when __NEXT_DATA__ exists. */
      legacyItemPath: 'props.pageProps.item',
      legacyItemsListPath: 'props.pageProps.items',
      legacyViewerPaths: ['props.pageProps.currentUser.id', 'props.pageProps.currentUserId'],
      legacyProfileUserPaths: ['props.pageProps.user.id', 'props.pageProps.userInfo.id'],
    },

    /** Attribute codes inside the item page's `attributes` plugin (observed). */
    attributeCodes: {
      brand: 'brand',
      size: 'size',
      status: 'status',
      color: 'color',
      material: 'material',
      uploadDate: 'upload_date',
    },

    detail: {
      title: '[data-testid="item-title"], h1',
      price: '[data-testid="item-price"], [class*="price"]',
      description: '[data-testid="item-description"], [itemprop="description"]',
      brand: '[data-testid="item-attribute-brand"]',
      size: '[data-testid="item-attribute-size"]',
      condition: '[data-testid="item-attribute-status"]',
      color: '[data-testid="item-attribute-color"]',
      material: '[data-testid="item-attribute-material"]',
      categoryBreadcrumb: 'nav[aria-label="Breadcrumb"] a, [data-testid="breadcrumb-item"]',
      photoGallery: '[data-testid="item-photo-carousel"]',
      photoImages: 'img[src*="vinted.net"], img[src*="media.vinted"], img[src*="vinted"]',
      carouselNext: 'button[aria-label="Next"], [data-testid="carousel-next"]',
      shippingSection: '[data-testid="item-shipping"]',
      /** Cloudflare's container, and DataDome's captcha frame (observed). */
      challengeContainer: '#challenge-running, #cf-challenge-running, iframe[src*="captcha-delivery.com"]',
    },

    cookie: {
      /**
       * Essential-only first: a backup has no need for advertising consent. Observed:
       * OneTrust on vinted.pt with "Optar pelo essencial" / "Permitir todos".
       */
      acceptButton:
        '#onetrust-reject-all-handler, [data-testid="cookie-consent-accept-button"], #onetrust-accept-btn-handler',
    },

    auth: {
      /** Present in the header only while signed out (observed). */
      headerLoginButton: '[data-testid="header--login-button"]',
    },

    /**
     * Title fragments that identify a bot-protection page. Cloudflare's per the
     * brief; DataDome's "temporarily restricted" pages observed on vinted.pt.
     */
    challengeTitles: [
      'just a moment',
      'un momento',
      'attendez',
      'einen moment',
      'temporariamente restrito',
      'temporarily restricted',
      'acesso restrito',
    ],
  };
})();
