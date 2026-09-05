/**
 * Smoke checks for the full-site example.
 *
 * These assert the CLAIMS, not the implementation: real urls, per-URL SSR,
 * per-page canonicals, a 404 that is a real 404, and — the one that matters
 * most — that every surface agrees about which pages are publishable.
 *
 *   node scripts/smoke.mjs            # assumes a server on :4317
 *   PORT=3000 node scripts/smoke.mjs
 */

const BASE = `http://localhost:${process.env.PORT ?? 4317}`;
let pass = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const get = async (path) => {
  const res = await fetch(BASE + path);
  return { status: res.status, body: await res.text() };
};

// ── real urls, real status codes ────────────────────────────────────
for (const [path, want] of [
  ['/', 200],
  ['/doc/why-snapshots', 200],
  ['/doc/silent-failures', 200],
  ['/doc/unfinished-draft', 404],   // blocked by the publish gate
  ['/does-not-exist', 404],         // fellBack.reason === 'unknown-page'
  ['/doc/nope', 404],
]) {
  const { status } = await get(path);
  check(`${path} → ${want}`, status === want, `got ${status}`);
}

// ── per-URL SSR: each page's own content is in the source, without JS ──
const doc = await get('/doc/silent-failures');
check('per-URL SSR: title', doc.body.includes('<title>The failures that do not fail'));
check('per-URL SSR: body', doc.body.includes('Make the silence loud'));

const index = await get('/');
check('index does not leak doc content', !index.body.includes('Make the silence loud'));

// ── per-page canonicals: the whole point of the crawler adapter ──────
for (const [path, canonical] of [
  ['/', 'https://field-notes.example"'],
  ['/doc/why-snapshots', 'https://field-notes.example/doc/why-snapshots"'],
  ['/doc/silent-failures', 'https://field-notes.example/doc/silent-failures"'],
]) {
  const { body } = await get(path);
  check(`${path} canonical`, body.includes(`<link rel="canonical" href="${canonical}`));
}

// ── OpenGraph uses property=, Twitter uses name= (a real spec difference) ──
const og = await get('/doc/why-snapshots');
check('og:title uses property=', og.body.includes('<meta property="og:title" content="Why one snapshot"'));
check('twitter:card uses name=', og.body.includes('<meta name="twitter:card"'));

// ── one snapshot, many audiences ────────────────────────────────────
check('inline JSON-LD is a TechArticle', og.body.includes('"@type":"TechArticle"'));
check('index JSON-LD is a WebSite', index.body.includes('"@type":"WebSite"'));

// ── every surface agrees about what is publishable ──────────────────
const sitemap = await get('/sitemap.xml');
const llms = await get('/llms.txt');
check('sitemap omits the blocked draft', !sitemap.body.includes('unfinished-draft'));
check('llms.txt omits the blocked draft', !llms.body.includes('unfinished-draft'));
check('sitemap lists the published docs', sitemap.body.includes('/doc/why-snapshots') && sitemap.body.includes('/doc/silent-failures'));
check('llms.txt lists the published docs', llms.body.includes('/doc/why-snapshots') && llms.body.includes('/doc/silent-failures'));

// ── machine surfaces ────────────────────────────────────────────────
const robots = await get('/robots.txt');
check('robots points at the sitemap', robots.body.includes('Sitemap: https://field-notes.example/sitemap.xml'));
const mcp = await get('/mcp/tools');
check('mcp exposes both tools', mcp.body.includes('list_pages') && mcp.body.includes('get_section'));

// ── microdata: same facts, different encoding ───────────────────────
const micro = await get('/microdata/why-snapshots');
check('microdata fragment served', micro.status === 200 && micro.body.includes('itemtype="https://schema.org/TechArticle"'));
check('microdata headline matches the rendered one', micro.body.includes('itemprop="headline">Why one snapshot<'));
check('microdata agrees with og:title', og.body.includes('content="Why one snapshot"') && micro.body.includes('>Why one snapshot<'));
check('microdata 404s for a blocked page', (await get('/microdata/unfinished-draft')).status === 404);

// ── static assets are routed before the wildcard ────────────────────
const fav = await get('/favicon.ico');
check('favicon is not decoded as a page', fav.status === 204);

console.log(`\n${pass}/${pass + failures.length} smoke checks passed`);
if (failures.length) {
  console.error('\nFAILED:');
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
