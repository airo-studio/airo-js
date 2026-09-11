/**
 * Smoke checks for the full-site example.
 *
 * These assert the CLAIMS, not the implementation: real urls, per-URL SSR,
 * per-page canonicals, a 404 that is a real 404, and — the one that matters
 * most — that every surface agrees about which pages are publishable.
 *
 * The second half walks the members area over HTTP with a cookie jar: the
 * 401 shell, the full authorization-code + PKCE round trip, the server-
 * rendered private page, every hardening check in the demo provider, and
 * the guarantee that no machine surface and no public page ever carries a
 * member byte.
 *
 *   node scripts/smoke.mjs            # assumes a server on :4317
 *   PORT=3000 node scripts/smoke.mjs
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const PORT = process.env.PORT ?? 4317;
const BASE = `http://localhost:${PORT}`;
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
// The heading comes from the INDEX snapshot, which has no `doc`. An adapter
// that over-declares `doc.*` as 'always' is gated out for that snapshot and
// the file silently loses its first line — which is what 0.10.0 did here.
check('llms.txt opens with the site heading', llms.body.startsWith('# Field Notes'));

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
const clientJs = await fetch(`${BASE}/client.js`);
check('client bundle is served as JavaScript', clientJs.status === 200 && /javascript/.test(clientJs.headers.get('content-type') ?? ''));

// ═══════════════════════ the members area ═══════════════════════════
//
// A cookie jar and `redirect: 'manual'`, so every hop of the round trip
// is visible and every Set-Cookie is inspectable.

function makeJar() {
  const jar = new Map();
  const header = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const absorb = (res) => {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const eq = pair.indexOf('=');
      const k = pair.slice(0, eq).trim();
      if (/Expires=Thu, 01 Jan 1970/.test(c)) jar.delete(k);
      else jar.set(k, pair.slice(eq + 1));
    }
  };
  const go = async (path, init = {}, base = BASE) => {
    const res = await fetch(base + path, {
      redirect: 'manual',
      ...init,
      headers: { cookie: header(), ...(init.headers ?? {}) },
    });
    absorb(res);
    return res;
  };
  return { jar, go };
}

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

/** Walk login → authorize → callback for one jar. Returns the callback response. */
async function signIn(go, next = '/members', creds = { username: 'demo', password: 'demo' }, mutate = (q) => q) {
  const login = await go(`/auth/login?next=${encodeURIComponent(next)}`);
  const authorize = new URL(login.headers.get('location'));
  const q = mutate(authorize.searchParams);
  const posted = await go('/oauth/authorize', {
    method: 'POST',
    headers: FORM,
    body: new URLSearchParams({
      state: q.get('state'), redirect_uri: q.get('redirect_uri'), code_challenge: q.get('code_challenge'),
      client_id: q.get('client_id'), ...creds,
    }),
  });
  if (posted.status !== 302) return { login, posted, callback: null };
  const cb = new URL(posted.headers.get('location'));
  const callback = await go(cb.pathname + cb.search);
  return { login, posted, callback };
}

// ── anonymous: the 401 shell, and the API is the authority ──────────
{
  const { go } = makeJar();
  const shell = await go('/members');
  const html = await shell.text();
  check('anonymous /members → 401', shell.status === 401, `got ${shell.status}`);
  check('anonymous /members is no-store', shell.headers.get('cache-control') === 'private, no-store');
  check('anonymous /members varies on Cookie', shell.headers.get('vary') === 'Cookie');
  check('anonymous /members is noindex (header)', shell.headers.get('x-robots-tag') === 'noindex');
  check('anonymous /members is noindex (meta)', html.includes('<meta name="robots" content="noindex, nofollow">'));
  check('401 shell carries no JSON-LD', !html.includes('ld+json'));
  check('401 shell carries no canonical', !html.includes('rel="canonical"'));
  check('401 shell mounts CSR with the members source', html.includes('<div id="app" data-airo-mode="csr" data-airo-source="members">'));
  check('401 shell server-renders the sign-in panel (usable without JS)', html.includes('class="fs-signin"') && html.includes('href="/auth/login?next=%2Fmembers"'));
  check('401 shell carries no satisfied-gates attribute', !html.includes('data-airo-gates-satisfied'));
  check('401 shell ships the client bundle (the gate repaints there)', html.includes('<script type="module" src="/client.js">'));
  // The member notes live in a server-only module; nothing the bundle
  // imports can reach them. Asserted on the bundle, not on the HTML routes.
  const bundle = await (await fetch(`${BASE}/client.js`)).text();
  check('client bundle carries no member content', !/What ships next|release-checklist|Demo Member|u_demo/.test(bundle));
  check('anonymous /note/roadmap → 401', (await go('/note/roadmap')).status === 401);
  check('anonymous /auth/session → 401', (await go('/auth/session')).status === 401);
  check('anonymous /api/members/me → 401', (await go('/api/members/me')).status === 401);
}

// ── the round trip: authorization code + PKCE ───────────────────────
{
  const { jar, go } = makeJar();
  const { login, callback } = await signIn(go, '/note/roadmap');
  const authorize = new URL(login.headers.get('location'));
  check('/auth/login redirects to the provider', login.status === 302 && authorize.pathname === '/oauth/authorize');
  check('authorize carries S256 code_challenge', authorize.searchParams.get('code_challenge_method') === 'S256' && (authorize.searchParams.get('code_challenge') ?? '').length >= 43);
  check('authorize carries state', (authorize.searchParams.get('state') ?? '').length >= 16);
  check('callback lands on next', callback.status === 302 && callback.headers.get('location') === '/note/roadmap');
  const sid = callback.headers.getSetCookie().find((c) => c.startsWith('sid='));
  check('session cookie is HttpOnly + SameSite=Lax', !!sid && /HttpOnly/.test(sid) && /SameSite=Lax/.test(sid));
  check('session cookie is not Secure over plain http', !!sid && !/Secure/.test(sid));
  check('oauth cookie is cleared after the callback', !jar.has('airo_oauth'));
  const session = await go('/auth/session');
  check('signed in: /auth/session → 200', session.status === 200 && (await session.text()).includes('"Demo Member"'));

  // The server-rendered private page.
  const members = await go('/members');
  const html = await members.text();
  check('signed in: /members → 200', members.status === 200, `got ${members.status}`);
  check('signed in: /members is server-rendered', html.includes('Hello, Demo Member'));
  check('signed in: /members lists the notes', html.includes('href="/note/roadmap"') && html.includes('href="/note/release-checklist"'));
  check('signed in: /members still no-store', members.headers.get('cache-control') === 'private, no-store');
  check('signed in: /members varies on Cookie', members.headers.get('vary') === 'Cookie');
  check('signed in: /members still noindex', members.headers.get('x-robots-tag') === 'noindex');
  check('signed in: /members still no JSON-LD', !html.includes('ld+json'));
  check('signed in: /members still no canonical', !html.includes('rel="canonical"'));
  check('signed in: /members hydrates with satisfied gates', html.includes('data-airo-mode="hydrate" data-airo-source="members" data-airo-gates-satisfied="login"'));
  check('no inline snapshot block anywhere', !html.includes('data-airo-snapshot'));

  const note = await go('/note/roadmap');
  check('signed in: /note/roadmap → 200 with the note', note.status === 200 && (await note.text()).includes('What ships next'));
  check('signed in: /note/nope → 404', (await go('/note/nope')).status === 404);

  // The API slice equals the SSR slice, and is shaped to what the views render.
  const api = await (await go('/api/members/me?slug=roadmap')).json();
  check('api member keys are exactly what the views render', JSON.stringify(Object.keys(api.member).sort()) === '["note","notes","user"]');
  check('api name equals the rendered name', html.includes(`Hello, ${api.member.user.name}`));

  // D18: public pages are keyed on the PAGE flag, not the session. A
  // signed-in visitor's public page is byte-identical to an anonymous one.
  const homeIn = await go('/');
  const homeInBody = await homeIn.text();
  check('signed in: / is still public-cacheable', homeIn.headers.get('cache-control') === 'public, max-age=60');
  check('signed in: / does not vary on Cookie', homeIn.headers.get('vary') === null);
  check('signed in: / is byte-identical to anonymous', homeInBody === index.body);
  const docIn = await go('/doc/why-snapshots');
  check('signed in: /doc/why-snapshots is byte-identical to anonymous', (await docIn.text()) === og.body);

  // Machine surfaces never see a session, so they never see a member.
  for (const [path, body] of [
    ['/sitemap.xml', sitemap.body], ['/llms.txt', llms.body], ['/mcp/tools', mcp.body],
  ]) {
    check(`${path} is free of member content`, !/members|\/note\/|Demo Member|roadmap/.test(body));
  }
  const listed = await (await fetch(`${BASE}/mcp/call`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: `sid=${jar.get('sid')}` },
    body: JSON.stringify({ name: 'list_pages', arguments: {} }),
  })).json();
  check('list_pages never lists a note, even with the cookie', !JSON.stringify(listed).includes('/note/'));

  // Sign out: POST only, clears the cookie, session gone.
  const out = await go('/auth/logout', { method: 'POST' });
  check('logout redirects home and clears the cookie', out.status === 302 && out.headers.get('location') === '/' && !jar.has('sid'));
  check('after logout: /auth/session → 401', (await go('/auth/session')).status === 401);
  check('after logout: /members → 401', (await go('/members')).status === 401);
  check('logout is not a GET', (await go('/auth/logout')).status === 404);
}

// ── the provider's hardening: each check names the attack it closes ──
{
  const { go } = makeJar();
  const { posted, callback } = await signIn(go, '/members', { username: 'demo', password: 'wrong' });
  check('wrong password: stays on the form with an error', posted.status === 401 && (await posted.text()).includes('Wrong username or password'));
  check('wrong password: no callback, no session', callback === null && (await go('/auth/session')).status === 401);
}
{
  // Tampered state: the callback is not our round trip.
  const { go } = makeJar();
  const login = await go('/auth/login?next=/members');
  const state = new URL(login.headers.get('location')).searchParams.get('state');
  const cb = await go(`/auth/callback?code=whatever&state=${state}x`);
  check('tampered state → 400, no cookie', cb.status === 400 && !cb.headers.getSetCookie().some((c) => c.startsWith('sid=')));
}
{
  // Cancel at the provider: back to next, still anonymous.
  const { go } = makeJar();
  const login = await go('/auth/login?next=/note/roadmap');
  const state = new URL(login.headers.get('location')).searchParams.get('state');
  const cb = await go(`/auth/callback?error=access_denied&state=${state}`);
  check('cancel at the provider → back to next, anonymous', cb.status === 302 && cb.headers.get('location') === '/note/roadmap' && (await go('/auth/session')).status === 401);
}
{
  // A `next` that is not a same-origin path is replaced by `/`.
  const { go } = makeJar();
  const { callback } = await signIn(go, 'https://evil.example/phish');
  check('external next is rejected', callback.status === 302 && callback.headers.get('location') === '/');
  const { go: go2 } = makeJar();
  const { callback: cb2 } = await signIn(go2, '//evil.example');
  check('protocol-relative next is rejected', cb2.status === 302 && cb2.headers.get('location') === '/');
}
{
  // Unknown client, wrong redirect_uri (a trailing slash is a different
  // URI), PKCE downgrade — all refused before a form renders.
  const base = `/oauth/authorize?response_type=code&state=${'s'.repeat(24)}&code_challenge=${'c'.repeat(43)}&code_challenge_method=S256`;
  const good = `&client_id=full-site&redirect_uri=${encodeURIComponent(`${BASE}/auth/callback`)}`;
  check('unknown client_id → 400 at authorize', (await get(`${base}&client_id=nope&redirect_uri=${encodeURIComponent(`${BASE}/auth/callback`)}`)).status === 400);
  check('redirect_uri off by a trailing slash → 400', (await get(`${base}&client_id=full-site&redirect_uri=${encodeURIComponent(`${BASE}/auth/callback/`)}`)).status === 400);
  check('plain code_challenge_method → 400', (await get(`${base.replace('S256', 'plain')}${good}`)).status === 400);
  check('a valid authorize request renders the form', (await get(`${base}${good}`)).body.includes('DemoAuth'));
}
{
  // The token endpoint: client secret, exact redirect_uri, S256 verifier, one-shot code.
  const { go } = makeJar();
  const login = await go('/auth/login?next=/members');
  const q = new URL(login.headers.get('location')).searchParams;
  const posted = await go('/oauth/authorize', {
    method: 'POST', headers: FORM,
    body: new URLSearchParams({ state: q.get('state'), redirect_uri: q.get('redirect_uri'), code_challenge: q.get('code_challenge'), client_id: 'full-site', username: 'demo', password: 'demo' }),
  });
  const code = new URL(posted.headers.get('location')).searchParams.get('code');
  const token = (body) => fetch(`${BASE}/oauth/token`, { method: 'POST', headers: FORM, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: q.get('redirect_uri'), client_id: 'full-site', client_secret: 'demo-client-secret', code_verifier: 'x'.repeat(43), ...body }) });
  check('token: wrong client secret → 401', (await token({ client_secret: 'nope' })).status === 401);
  check('token: unknown client_id → 401', (await token({ client_id: 'nope' })).status === 401);
  // A wrong verifier consumes the code — the exchange fails AND the code is spent.
  const badVerifier = await token({});
  check('token: wrong code_verifier → 400', badVerifier.status === 400 && (await badVerifier.text()).includes('code_verifier'));
  const reused = await token({});
  check('token: a code is one-shot', reused.status === 400 && (await reused.text()).includes('already-used'));
}
{
  // Secure flag: present when the callback arrives over https (behind a
  // TLS terminator that sets X-Forwarded-Proto), absent over plain http.
  const { go } = makeJar();
  const { callback } = await signIn(go, '/members');
  const sid = callback.headers.getSetCookie().find((c) => c.startsWith('sid='));
  check('http: cookie without Secure', !!sid && !/Secure/.test(sid));
  const { go: goTls } = makeJar();
  const login = await goTls('/auth/login?next=/members', { headers: { 'x-forwarded-proto': 'https' } });
  const q = new URL(login.headers.get('location')).searchParams;
  const posted = await goTls('/oauth/authorize', { method: 'POST', headers: FORM, body: new URLSearchParams({ state: q.get('state'), redirect_uri: q.get('redirect_uri'), code_challenge: q.get('code_challenge'), client_id: 'full-site', username: 'demo', password: 'demo' }) });
  const cb = new URL(posted.headers.get('location'));
  const tlsCallback = await goTls(cb.pathname + cb.search, { headers: { 'x-forwarded-proto': 'https' } });
  const tlsSid = tlsCallback.headers.getSetCookie().find((c) => c.startsWith('sid='));
  check('https (X-Forwarded-Proto): cookie is Secure', !!tlsSid && /Secure/.test(tlsSid), tlsSid ?? 'no cookie');
}

// ── the provider is down: a 502 with a message, never a stack trace, no cookie ──
//
// A second server instance with AUTH_ISSUER pointed at a closed port. Its
// /auth/login still mints state + verifier (that is local), so the callback
// carries a valid state and reaches the token exchange, which fails.
{
  // A free port, not PORT+1: anything already listening there would answer
  // the readiness poll and the four checks below would fail confusingly.
  const port = await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, () => { const { port: p } = probe.address(); probe.close(() => resolve(p)); });
  });
  const child = spawn(process.execPath, ['dist/server.js'], {
    env: { ...process.env, PORT: String(port), AUTH_ISSUER: 'http://127.0.0.1:9' },
    stdio: 'ignore',
  });
  try {
    let up = false;
    // Same budget as CI's readiness loop for the primary server (~10 s); a
    // cold `node dist/server.js` plus its imports can take a while on a slow runner.
    for (let i = 0; i < 100 && !up; i++) {
      try {
        const res = await fetch(`http://localhost:${port}/robots.txt`);
        up = res.ok && (await res.text()).includes('Disallow: /members');
      } catch {
        // not up yet
      }
      if (!up) await new Promise((r) => setTimeout(r, 100));
    }
    check('provider-down: second server started', up);
    if (up) {
      const { go } = makeJar();
      const alt = `http://localhost:${port}`;
      const login = await go('/auth/login?next=/members', {}, alt);
      const state = new URL(login.headers.get('location')).searchParams.get('state');
      const cb = await go(`/auth/callback?code=anything&state=${state}`, {}, alt);
      const body = await cb.text();
      check('provider-down: callback → 502', cb.status === 502, `got ${cb.status}`);
      check('provider-down: a plain message, no stack trace', body.includes('Sign-in provider unavailable') && !body.includes('at '));
      check('provider-down: no session cookie', !cb.headers.getSetCookie().some((c) => c.startsWith('sid=')));
      check('provider-down: still anonymous', (await go('/auth/session', {}, alt)).status === 401);
    }
  } finally {
    child.kill();
  }
}

console.log(`\n${pass}/${pass + failures.length} smoke checks passed`);
if (failures.length) {
  console.error('\nFAILED:');
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
