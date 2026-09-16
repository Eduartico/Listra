/**
 * Offline test harness. No dependencies, no test framework:
 *
 *   node tests/run.js
 *
 * The shared modules are plain classic scripts that attach themselves to
 * globalThis.VB, which is exactly what makes them loadable here — the same files the
 * extension ships are evaluated in this process and exercised directly, with no
 * build step and no browser.
 *
 * Covers the pure logic that a live Vinted run would otherwise be the only test of:
 * region detection, folder-name safety, price and timestamp normalization, tolerance
 * of renamed fields, the rate limiter's actual timing, and the ZIP writer.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

// Loaded in the same order the extension loads them.
const MODULES = [
  'src/common/constants.js',
  'src/common/messages.js',
  'src/common/logger.js',
  'src/common/selectors.js',
  'src/common/sanitize.js',
  'src/common/rate-limiter.js',
  'src/common/page-data.js',
  'src/common/normalize.js',
  'src/content/dom-extractor.js',
  'src/manager/storage-idb.js',
];

for (const rel of MODULES) {
  const file = path.join(ROOT, rel);
  vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
}

const VB = globalThis.VB;

// Keep the log quiet unless a test fails; the modules log warnings by design.
console.log = () => {};
console.warn = () => {};
const report = [];

let passed = 0;
let failed = 0;

function ok(condition, name, detail) {
  if (condition) {
    passed += 1;
    report.push('  pass  ' + name);
  } else {
    failed += 1;
    report.push('  FAIL  ' + name + (detail ? ' -> ' + detail : ''));
  }
}

function equal(actual, expected, name) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  ok(same, name, same ? null : 'got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected));
}

function section(title) {
  report.push('');
  report.push(title);
}

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
}

// ---------------------------------------------------------------------------

section('Region detection');
{
  const { detectRegion, REGIONS } = VB.constants;
  for (const { region, domain } of REGIONS) {
    const got = detectRegion(domain);
    ok(got && got.region === region, 'detects ' + domain, got ? got.region : 'null');
  }
  // co.uk is the one that breaks a naive single-label TLD regex.
  equal(detectRegion('https://www.vinted.co.uk').region, 'uk', 'co.uk maps to region uk');
  ok(detectRegion('https://vinted.fr') !== null, 'works without the www prefix');
  ok(detectRegion('https://www.vinted.fr/') !== null, 'tolerates a trailing slash');
  ok(detectRegion('https://www.vinted.com') === null, 'rejects an unknown storefront');
  ok(detectRegion('https://evil-vinted.fr.example.com') === null, 'rejects a lookalike host');
  ok(detectRegion(undefined) === null, 'tolerates a missing origin');
}

section('Folder names');
{
  const { folderName, uniqueFolderName, imageFileName } = VB.sanitize;
  equal(folderName('Nike Air Max 90'), 'Nike Air Max 90', 'keeps a plain title');
  equal(folderName('Nike / Air: Max*90?'), 'Nike _ Air_ Max_90_', 'replaces unsafe characters');
  equal(folderName('Robe été à fleurs'), 'Robe _t_ _ fleurs', 'flattens accents');
  equal(folderName('日本語のタイトル'), 'listing', 'all-non-Latin title falls back');
  equal(folderName(''), 'listing', 'empty title falls back');
  equal(folderName(null), 'listing', 'null title falls back');
  equal(folderName('CON'), 'CON_', 'guards the Windows CON device name');
  equal(folderName('com1'), 'com1_', 'guards device names case-insensitively');
  // A dot is outside the allowed set, so it becomes an underscore before the
  // trailing-character guard ever sees it. That guard exists for the space a
  // truncated title can end on.
  equal(folderName('Trailing dot.'), 'Trailing dot_', 'a dot becomes an underscore');
  equal(
    folderName('a'.repeat(63) + ' more words'),
    'a'.repeat(63),
    'strips the trailing space truncation leaves behind'
  );
  ok(folderName('x'.repeat(200)).length === 64, 'trims to 64 characters');

  const taken = new Set();
  equal(uniqueFolderName('Same Title', taken), 'Same Title', 'first use of a title');
  equal(uniqueFolderName('Same Title', taken), 'Same Title_2', 'second use gets a suffix');
  equal(uniqueFolderName('Same Title', taken), 'Same Title_3', 'third use keeps counting');
  const longName = uniqueFolderName('y'.repeat(200), taken);
  const longAgain = uniqueFolderName('y'.repeat(200), taken);
  ok(longAgain.length <= 64 && longAgain !== longName, 'suffix stays inside the length cap');

  equal(imageFileName(1, 'https://cdn/x/1.JPEG'), '1.jpg', 'normalizes jpeg to jpg');
  equal(imageFileName(2, 'https://cdn/x/2.webp?v=3'), '2.webp', 'keeps webp past a query string');
  equal(imageFileName(3, 'https://cdn/x/no-extension'), '3.jpg', 'defaults to jpg');
}

section('Field normalization');
{
  const { money, isoDate, num } = VB.normalize._internals;

  equal(money({ amount: '45.00', currency_code: 'EUR' }), { amount: 45, currency: 'EUR' }, 'price as an object');
  equal(money('19.50'), { amount: 19.5, currency: null }, 'price as a string');
  equal(money(12), { amount: 12, currency: null }, 'price as a number');
  equal(money(null, '7.25'), { amount: 7.25, currency: null }, 'price from the numeric fallback');
  equal(money(undefined, undefined), { amount: null, currency: null }, 'absent price');
  equal(num('19,50'), 19.5, 'comma decimal separator');

  equal(isoDate(1700000000), '2023-11-14T22:13:20.000Z', 'unix seconds');
  equal(isoDate(1700000000000), '2023-11-14T22:13:20.000Z', 'unix milliseconds');
  equal(isoDate('2025-03-04T10:00:00Z'), '2025-03-04T10:00:00.000Z', 'an ISO string');
  equal(isoDate(null), null, 'a missing timestamp');
  equal(isoDate('not a date'), null, 'an unparseable timestamp');
}

section('Snapshot from the documented API shape');
{
  const ctx = { domain: 'https://www.vinted.fr', region: 'fr', source: 'api' };
  const res = VB.normalize.normalizeItem(fixture('item-api.json'), ctx);
  ok(res.ok, 'normalizes the documented payload', res.ok ? null : res.message);
  const s = res.value;

  equal(s.id, '123456789', 'id as a string');
  equal(s.title, 'Nike Air Max 90 / Sneakers', 'title');
  equal(s.price, 45, 'price');
  equal(s.currency, 'EUR', 'currency from the price object');
  equal(s.originalPrice, 90, 'original price');
  equal(s.category, ['Women', 'Shoes'], 'breadcrumbs become the category path');
  equal(s.catalogId, 123, 'catalog id');
  equal(s.brand, 'Nike', 'brand');
  equal(s.condition, null, 'no status string means no condition label (status_id is never mapped)');
  equal(s.conditionId, 3, 'the status id is still recorded');
  equal(s.size, '42', 'size');
  equal(s.color, 'Black', 'colour');
  equal(s.material, null, 'material_id alone does not become a material name');
  equal(s.seller, { id: 99999, username: 'seller123', rating: 4.9 }, 'seller block');
  equal(s.favouriteCount, 12, 'favourite count');
  equal(s.viewCount, 340, 'view count');
  equal(s.createdAt, '2023-11-14T22:13:20.000Z', 'created timestamp');
  equal(s.shippingOptions, [{ carrier: 'Mondial Relay', price: 3.99, currency: 'EUR' }], 'shipping options');
  equal(s.images.length, 2, 'both photos kept');
  equal(s.images[0].originalUrl, 'https://images1.vinted.net/t/full/111.jpg', 'prefers full_size_url');
  equal(s.images[0].localPath, 'images/1.jpg', 'first image path');
  equal(s.images[1].localPath, 'images/2.webp', 'webp extension preserved');
  equal(s.domain, 'https://www.vinted.fr', 'domain recorded');
  equal(s.url, 'https://www.vinted.fr/items/123456789', 'url built from the domain and id');
  ok(VB.normalize.validateSnapshot(s).ok, 'snapshot passes validation');
}

section('Snapshot from a variant shape');
{
  const ctx = { domain: 'https://www.vinted.co.uk', region: 'uk', source: 'api' };
  const res = VB.normalize.normalizeItem(fixture('item-variant.json'), ctx);
  ok(res.ok, 'normalizes the variant payload', res.ok ? null : res.message);
  const s = res.value;

  equal(s.id, '987654321', 'id from item_id');
  equal(s.price, 19.5, 'price from price_numeric with a comma decimal');
  equal(s.currency, 'GBP', 'currency from a top-level field');
  equal(s.condition, 'Good', 'condition from the localized status string');
  equal(s.brand, 'Zara', 'brand from a nested object');
  equal(s.size, 'M', 'size from the short field name');
  equal(s.images.length, 1, 'photo given as a bare URL string');
  equal(s.createdAt, '2025-03-04T10:00:00.000Z', 'created from an ISO string');
  equal(s.updatedAt, '2025-03-04T10:00:00.000Z', 'updated from unix milliseconds');
  equal(s.shippingOptions, [{ carrier: 'InPost', price: 2.49, currency: 'GBP' }], 'shipping falls back to title');
  equal(s.originalPrice, null, 'absent original price is null, not undefined');
  equal(s.category, [], 'absent breadcrumbs give an empty path');
}

section('Loud failure on unrecognised shapes');
{
  const ctx = { domain: 'https://www.vinted.fr', region: 'fr', source: 'api' };

  const renamed = VB.normalize.normalizeItem(fixture('item-renamed.json'), ctx);
  ok(!renamed.ok, 'rejects a payload with renamed fields');
  equal(renamed.code, VB.ERR.SHAPE, 'reports a shape error');
  ok(
    Array.isArray(renamed.keys) && renamed.keys.includes('itemIdentifier'),
    'records the keys it actually saw, for diagnosis'
  );

  ok(!VB.normalize.normalizeItem(null, ctx).ok, 'rejects null');
  ok(!VB.normalize.normalizeItem([], ctx).ok, 'rejects an array');

  const noPhotos = VB.normalize.normalizeItem(
    { id: 1, title: 'No photos here', photos: [] },
    ctx
  );
  ok(noPhotos.ok, 'a photo-less item still normalizes');
  const check = VB.normalize.validateSnapshot(noPhotos.value);
  ok(!check.ok && check.code === VB.ERR.NO_IMAGES, 'but fails validation with NO_IMAGES');
}

section('Deep path reading');
{
  const { deepGet, firstPath } = VB.pageData;
  const obj = { props: { pageProps: { item: { id: 7 } } } };
  equal(deepGet(obj, 'props.pageProps.item.id'), 7, 'reads a present path');
  equal(deepGet(obj, 'props.missing.item.id'), undefined, 'missing path does not throw');
  equal(deepGet(null, 'a.b'), undefined, 'null object does not throw');
  equal(firstPath(obj, ['a.b', 'props.pageProps.item.id']), 7, 'falls through to the second candidate');
  equal(firstPath(obj, ['nope']), undefined, 'no candidate matches');
}

section('Profile URL detection');
{
  const re = VB.SELECTORS.profile.profileInUrl;
  ok(re.test('/member/110802743-franvalera'), 'id-and-login profile path');
  ok(re.test('/member/110802743'), 'id-only profile path');
  ok(re.test('/member/110802743-some-login/'), 'trailing slash tolerated');
  ok(!re.test('/member/login/email'), 'login form is not a profile (observed live)');
  ok(!re.test('/member/signup/select_type'), 'signup is not a profile');
  ok(!re.test('/member/settings'), 'settings is not a profile');
  ok(!re.test('/member/110802743-login/items'), 'a deeper path is not a profile');
  equal(re.exec('/member/110802743-franvalera')[1], '110802743', 'captures the numeric id');
  equal(re.exec('/member/110802743-franvalera')[2], 'franvalera', 'captures the login');
}

section('Flight payload reader (App Router)');
{
  const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'item-page.html'), 'utf8');
  const scripts = [];
  const re = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) scripts.push(m[1]);
  let flight = '';
  for (const s2 of scripts) flight += VB.pageData.flightFromScriptText(s2);

  ok(flight.length > 1000, 'concatenates the type-1 pushes', flight.length + ' chars');
  ok(flight.includes('text with ]) inside'), 'a "])" inside a string does not end the scan');
  ok(flight.includes('e3:"tail"'), 'a second push in the same tag is read');
  ok(!flight.includes('self.__next_f'), 'bootstrap marker push is not treated as data');

  const cfg = VB.pageData.getPageConfig(flight);
  equal(cfg.csrfToken, '75f6c9fa-dc8e-4e52-a000-e09dd4084b3e', 'finds CSRF_TOKEN');
  equal(cfg.anonId, '4e4db4c8-eb62-4792-aa5d-c32352fd5448', 'finds anon_id');

  const plugins = VB.pageData.getItemPlugins(flight);
  ok(plugins.has('breadcrumbs') && plugins.has('attributes') && plugins.has('description'), 'lifts the plugin blocks');
  ok(flight.includes('{"name":"description","type":"description","section"'), 'fixture has a name-first block (signed-in render order)');
  ok(flight.includes('"name":"breadcrumbs","section":"content","type":"breadcrumbs"}'), 'fixture has a data-first block (anonymous render order)');
  ok(!plugins.has('viewport') && !plugins.has('robots'), 'meta tags with a name key are not mistaken for plugins');
  equal(plugins.get('breadcrumbs').catalog_id, '525', 'breadcrumbs carry the catalog id');
  equal(plugins.get('description').description, 'Mallas en buen estado', 'description block');

  const sidebar = VB.pageData.getSidebarItem(flight);
  equal(sidebar && sidebar.title, 'Mallas Nike', 'sidebar item located');
  equal(VB.pageData.resolveRef(flight, sidebar.price), { amount: '5', currency_code: 'EUR' }, 'resolves an RSC reference through a React element tuple');
  equal(VB.pageData.resolveRef(flight, 'plain'), 'plain', 'non-references pass through');
  equal(VB.pageData.resolveRef(flight, '$ff:nope'), null, 'unknown reference is null, not a throw');
  equal(VB.pageData.resolveRef(flight, '$zz'), '$zz', 'a non-hex "$" string is not a reference');

  const item = VB.domExtractor._internals.fromFlight(flight, '10003090436');
  equal(item.title, 'Mallas Nike', 'page item title');
  equal(item.price, { amount: '5', currency_code: 'EUR' }, 'page item price resolved');
  equal(item.catalog_id, '525', 'page item catalog id');
  equal(item.catalog_breadcrumbs.map((c) => c.title), ['Mulher', 'Roupa', 'Calças e leggings', 'Leggings', 'Nike Leggings'], 'breadcrumb titles');
  equal(item.brand, 'Nike', 'brand from attributes');
  equal(item.brand_id, '53', 'brand id from attributes');
  equal(item.size, 'XS / 34 / 6', 'size from attributes');
  ok(item.size_id === undefined, 'size id is not taken from attributes (it is an FAQ id)');
  equal(item.status, 'Muito bom', 'status text from attributes');
  ok(item.status_id === undefined, 'status id is not taken from attributes (observed 50 for two different labels)');
  equal(item.color1, 'Verde-escuro', 'colour from attributes');
  equal(item.photos.length, 2, 'gallery photos');
  equal(item.user.login, 'seller_example', 'seller login from user_info_header');

  const normalized = VB.normalize.normalizeItem(item, { domain: 'https://www.vinted.pt', region: 'pt', source: 'page' });
  ok(normalized.ok, 'page-only item normalizes');
  equal(normalized.value.price, 5, 'page-only price');
  equal(normalized.value.conditionId, null, 'no conditionId without the item_upload record');
  equal(normalized.value.condition, 'Muito bom', 'condition is the localized label');
  ok(VB.normalize.validateSnapshot(normalized.value).ok, 'page-only snapshot validates');
}

section('Snapshot from a live wardrobe record');
{
  const ctx = { domain: 'https://www.vinted.pt', region: 'pt', source: 'api' };
  const res = VB.normalize.normalizeItem(fixture('wardrobe-item.json'), ctx);
  ok(res.ok, 'normalizes the wardrobe record', res.ok ? null : res.message);
  const s = res.value;
  equal(s.id, '10013561214', 'id');
  equal(s.title, 'Sudadera Nike', 'title');
  equal(s.price, 8, 'price from {amount, currency_code}');
  equal(s.currency, 'EUR', 'currency');
  equal(s.brand, 'Nike', 'brand given as a plain string');
  equal(s.size, 'S', 'size given as a plain string');
  equal(s.condition, 'Muito bom', 'condition from the localized status string');
  equal(s.url, 'https://www.vinted.pt/items/10013561214-sudadera-nike', 'url from the record');
  equal(s.seller, { id: 100000001, username: 'seller_example', rating: null }, 'seller');
  equal(s.favouriteCount, 4, 'favourite count');
  equal(s.images.length, 2, 'both photos');
  ok(/\/tc\//.test(s.images[0].originalUrl), 'prefers full_size_url (the /tc/ original) over the f800 render');
  equal(s.images[0].localPath, 'images/1.jpg', 'jpeg extension kept');
  equal(s.listingState, { draft: false, closed: false, reserved: false, hidden: false }, 'listing state flags');
  ok(VB.normalize.validateSnapshot(s).ok, 'validates');
}

section('ZIP writer');
{
  // Known CRC-32 of the string "123456789".
  equal(VB.crc32(new TextEncoder().encode('123456789')), 0xcbf43926, 'crc32 matches the known value');
  const zip = VB.buildZip([{ path: 'a/b.txt', bytes: new TextEncoder().encode('hello') }]);
  ok(zip.size > 0, 'produces a non-empty archive');
  ok(zip.type === 'application/zip', 'declares the zip media type');
}

// ---------------------------------------------------------------------------
// Timing test last: it is the only slow one.
// ---------------------------------------------------------------------------

(async () => {
  section('Rate limiter');
  {
    const limiter = new VB.RateLimiter();
    const calls = 12;
    const started = Date.now();
    for (let i = 0; i < calls; i += 1) await limiter.acquire();
    const elapsed = (Date.now() - started) / 1000;
    const rate = calls / elapsed;
    ok(rate <= 4.3, 'sustains no more than ~4 requests per second', rate.toFixed(2) + ' req/s');
    ok(elapsed >= (calls - VB.constants.RATE_LIMIT.capacity) / 4, 'burst is actually spaced out');
  }
  {
    // Ten callers racing the same limiter must still be spaced.
    const limiter = new VB.RateLimiter({ capacity: 1, refillPerSecond: 10, minIntervalMs: 50, jitterMs: 0 });
    const started = Date.now();
    await Promise.all(Array.from({ length: 6 }, () => limiter.acquire()));
    const elapsed = Date.now() - started;
    ok(elapsed >= 5 * 50 * 0.9, 'concurrent callers are serialised', elapsed + 'ms');
  }

  const restore = console.constructor.prototype.log;
  void restore;
  process.stdout.write(report.join('\n') + '\n\n');
  process.stdout.write(passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed ? 1 : 0);
})();
