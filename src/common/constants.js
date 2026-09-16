/**
 * Shared constants for every extension context.
 *
 * Loaded as a classic script in all three contexts (content script, manager page,
 * service worker) and attaches to the single `VB` namespace. See README for why
 * there is no bundler.
 */
(() => {
  const VB = (globalThis.VB ||= {});

  /** Version of the ListingSnapshot / backup_manifest.json format we write. */
  const SCHEMA_VERSION = '1.0.0';

  /**
   * Vinted's per-country domains. Order matters for REGION_RE: `co.uk` is a
   * two-label TLD and must be offered to the alternation before `uk` could ever
   * be considered, otherwise the regex matches `uk` and leaves a stray `.co`.
   */
  const REGIONS = [
    { region: 'uk', domain: 'https://www.vinted.co.uk' },
    { region: 'fr', domain: 'https://www.vinted.fr' },
    { region: 'es', domain: 'https://www.vinted.es' },
    { region: 'de', domain: 'https://www.vinted.de' },
    { region: 'it', domain: 'https://www.vinted.it' },
    { region: 'pt', domain: 'https://www.vinted.pt' },
    { region: 'pl', domain: 'https://www.vinted.pl' },
    { region: 'nl', domain: 'https://www.vinted.nl' },
    { region: 'be', domain: 'https://www.vinted.be' },
    { region: 'lt', domain: 'https://www.vinted.lt' },
    { region: 'cz', domain: 'https://www.vinted.cz' },
    { region: 'at', domain: 'https://www.vinted.at' },
  ];

  const REGION_RE = /^https?:\/\/(?:www\.)?vinted\.(co\.uk|fr|es|de|it|pt|pl|nl|be|lt|cz|at)$/i;

  /** TLD -> region code. `co.uk` is spelled `uk` in our region codes. */
  const TLD_TO_REGION = { 'co.uk': 'uk' };

  /**
   * Resolve a page origin to `{ region, domain }`, or null when the origin is not
   * a Vinted storefront we know.
   *
   * @param {string} origin e.g. "https://www.vinted.co.uk"
   * @returns {{region: string, domain: string}|null}
   */
  function detectRegion(origin) {
    if (typeof origin !== 'string') return null;
    const m = REGION_RE.exec(origin.replace(/\/+$/, ''));
    if (!m) return null;
    const tld = m[1].toLowerCase();
    const region = TLD_TO_REGION[tld] || tld;
    const found = REGIONS.find((r) => r.region === region);
    return found ? { region: found.region, domain: found.domain } : null;
  }

  /**
   * Condition labels are taken from Vinted's own localized `status` string, never
   * from a status_id lookup table. The brief supplied a 1-3 table; a live item on
   * vinted.pt reported status id 50 for "Muito bom", so that table would mislabel
   * real data. The id is still recorded (as conditionId) for a future restore.
   */

  /**
   * Token-bucket settings. Vinted tolerates roughly 5 req/s and the brief says to
   * never exceed 4.
   *
   * The spec also suggested a 200ms floor between requests, but 200ms *is* 5 req/s,
   * so it would have been the looser of the two constraints and a burst could sit
   * above the 4 req/s ceiling indefinitely. 250ms is the gap that actually matches
   * 4 req/s, and it still satisfies the 200ms minimum.
   */
  const RATE_LIMIT = {
    capacity: 4,
    refillPerSecond: 4,
    minIntervalMs: 250,
    jitterMs: 50,
  };

  /**
   * Listing pages are ~2 MB of HTML each. Observed live: fetching them at the API
   * rate made a mid-run block of pages fail; a slower budget for HTML keeps the
   * run well inside what a person browsing would generate.
   */
  const PAGE_RATE_LIMIT = {
    capacity: 1,
    refillPerSecond: 0.7,
    minIntervalMs: 1200,
    jitterMs: 300,
  };

  const LIMITS = {
    /** Max items per API page. Vinted caps this at 96. */
    perPage: 96,
    /** Hard ceiling on a single listing's whole pipeline. */
    listingTimeoutMs: 30000,
    /** Backoff before extraction attempts 2 and 3. */
    extractionRetryDelaysMs: [2000, 4000, 8000],
    /** Extra attempts per image after the first. */
    imageRetries: 2,
    /** Profile scroll fallback. */
    scrollStepPx: 600,
    scrollPauseMs: 400,
    scrollEmptyRoundsBeforeStop: 3,
    /** Cap on how long we wait for lazy content in the DOM fallback. */
    lazyContentTimeoutMs: 8000,
    /** Longest folder name we will create. */
    maxFolderNameLength: 64,
  };

  /** chrome.storage.local keys. Collected here so nothing invents its own. */
  const STORAGE_KEYS = {
    runState: 'vb_run_state',
    log: 'vb_log',
    settings: 'vb_settings',
    proxyTabId: 'vb_proxy_tab_id',
  };

  VB.constants = {
    SCHEMA_VERSION,
    REGIONS,
    REGION_RE,
    detectRegion,
    RATE_LIMIT,
    PAGE_RATE_LIMIT,
    LIMITS,
    STORAGE_KEYS,
  };
})();
