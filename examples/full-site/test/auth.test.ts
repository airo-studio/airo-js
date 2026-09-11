/**
 * The relying party and the demo provider over HTTP, in-process.
 *
 * What the smoke does not reach: the clock. Sessions, authorization codes
 * and access tokens all expire on `Date.now()`, and the only way to see the
 * expiry branches is to move it. Also the callback's own refusals — a
 * malformed pending-login cookie, a callback with no code, a code the
 * provider rejects — and the provider's request validation that never
 * reaches a form.
 *
 * `server.ts` derives the relying party's `redirect_uri` and the provider's
 * issuer from `PORT` at import time, so the port is chosen first and the
 * server imported after. Everything else is the same `app` `pnpm dev` runs.
 *
 * @vitest-environment node
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';

import { parseCookies, safeNext } from '../src/auth/session.js';

const HOUR = 60 * 60_000;
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

let server: Server;
let BASE = '';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

beforeAll(async () => {
  const port = await freePort();
  process.env.PORT = String(port);
  const { app } = await import('../src/server.js');
  server = app.listen(port);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  BASE = `http://localhost:${port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Move the server's clock forward. Only `Date.now` is touched — timers stay real. */
function advanceClock(ms: number): void {
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now + ms);
}

/** A cookie jar over `fetch` with `redirect: 'manual'`, so every hop is visible. */
function makeJar() {
  const jar = new Map<string, string>();
  const go = async (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) => {
    const res = await fetch(BASE + path, {
      redirect: 'manual',
      ...init,
      headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(init.headers ?? {}) },
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair = ''] = c.split(';');
      const eq = pair.indexOf('=');
      const k = pair.slice(0, eq).trim();
      if (/Expires=Thu, 01 Jan 1970/.test(c)) jar.delete(k);
      else jar.set(k, pair.slice(eq + 1));
    }
    return res;
  };
  return { jar, go };
}

type Go = ReturnType<typeof makeJar>['go'];

/** `/auth/login` → the provider's authorize params, with the pending-login cookie in the jar. */
async function startLogin(go: Go, next = '/members'): Promise<URLSearchParams> {
  const login = await go(`/auth/login?next=${encodeURIComponent(next)}`);
  expect(login.status).toBe(302);
  return new URL(login.headers.get('location') ?? '').searchParams;
}

/** POST the form as `demo` / `demo`; returns the authorization code the provider minted. */
async function mintCode(go: Go, q: URLSearchParams): Promise<string> {
  const posted = await go('/oauth/authorize', {
    method: 'POST',
    headers: FORM,
    body: new URLSearchParams({
      state: q.get('state') ?? '',
      redirect_uri: q.get('redirect_uri') ?? '',
      code_challenge: q.get('code_challenge') ?? '',
      client_id: q.get('client_id') ?? '',
      username: 'demo',
      password: 'demo',
    }),
  });
  expect(posted.status).toBe(302);
  return new URL(posted.headers.get('location') ?? '').searchParams.get('code') ?? '';
}

/** The whole round trip for one jar; resolves once the session cookie is set. */
async function signIn(go: Go, next = '/members'): Promise<void> {
  const q = await startLogin(go, next);
  const code = await mintCode(go, q);
  const callback = await go(`/auth/callback?${new URLSearchParams({ code, state: q.get('state') ?? '' })}`);
  expect(callback.status).toBe(302);
  expect(callback.headers.get('location')).toBe(next);
}

/** The PKCE verifier `/auth/login` stashed in the pending-login cookie (`<payload>.<signature>`). */
function pendingVerifier(jar: Map<string, string>): string {
  const raw = jar.get('airo_oauth') ?? '';
  const payload = raw.slice(0, raw.lastIndexOf('.'));
  return (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { verifier: string }).verifier;
}

describe('the cookie and next helpers', () => {
  test('parseCookies: empty header, junk parts, whitespace and percent-decoding', () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('')).toEqual({});
    expect(parseCookies('sid=abc; junk; =nokey;  airo_oauth = x%3Dy ')).toEqual({
      sid: 'abc',
      airo_oauth: 'x=y',
    });
  });

  test('parseCookies: a malformed %-escape is kept raw, never thrown — and the routes answer 401, not 500', async () => {
    expect(() => parseCookies('sid=%E0%A4%A')).not.toThrow();
    expect(parseCookies('sid=%E0%A4%A')).toEqual({ sid: '%E0%A4%A' });
    const bad = { headers: { cookie: 'sid=%E0%A4%A; airo_oauth=%' } };
    expect((await fetch(`${BASE}/auth/session`, bad)).status).toBe(401);
    expect((await fetch(`${BASE}/api/members/me`, bad)).status).toBe(401);
    expect((await fetch(`${BASE}/members`, bad)).status).toBe(401);
  });

  test('safeNext honours only a same-origin path, up to the length the cookie can carry', () => {
    expect(safeNext(undefined)).toBe('/');
    expect(safeNext(42)).toBe('/');
    expect(safeNext('https://evil.example/phish')).toBe('/');
    expect(safeNext('//evil.example')).toBe('/');
    expect(safeNext('/note\\..\\x')).toBe('/');
    expect(safeNext('members')).toBe('/');
    expect(safeNext('/note/roadmap?tab=1')).toBe('/note/roadmap?tab=1');
    expect(safeNext(`/note/${'a'.repeat(1024)}`)).toBe('/');
    expect(safeNext(`/note/${'a'.repeat(1000)}`)).toBe(`/note/${'a'.repeat(1000)}`);
  });
});

describe('the pending-login cookie is signed', () => {
  test('a re-signed or unsigned pending-login cookie is not our round trip → 400, no session', async () => {
    const { go, jar } = makeJar();
    const q = await startLogin(go, '/members');
    const raw = jar.get('airo_oauth') ?? '';
    const dot = raw.lastIndexOf('.');
    // Same payload (so the state inside matches), wrong signature.
    const forged = `${raw.slice(0, dot)}.${'x'.repeat(43)}`;
    const res = await fetch(`${BASE}/auth/callback?code=any&state=${q.get('state')}`, {
      redirect: 'manual',
      headers: { cookie: `airo_oauth=${forged}` },
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Sign-in could not be verified');
    expect(res.headers.getSetCookie().some((c) => c.startsWith('sid='))).toBe(false);

    // Unsigned: a bare base64 payload with no dot.
    const unsigned = await fetch(`${BASE}/auth/callback?code=any&state=${q.get('state')}`, {
      redirect: 'manual',
      headers: { cookie: `airo_oauth=${raw.slice(0, dot)}` },
    });
    expect(unsigned.status).toBe(400);
  });
});

describe('/auth/callback refusals', () => {
  test('a malformed pending-login cookie → 400, no session cookie', async () => {
    const { go } = makeJar();
    const res = await go('/auth/callback?code=x&state=y', { headers: { cookie: 'airo_oauth=garbage' } });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Sign-in could not be verified');
    expect(res.headers.getSetCookie().some((c) => c.startsWith('sid='))).toBe(false);
  });

  test('with the right state: no code and no error → 400; a code the provider rejects → 400 "refused"', async () => {
    const { go } = makeJar();
    const q = await startLogin(go, '/note/roadmap');
    const noCode = await go(`/auth/callback?state=${q.get('state')}`);
    expect(noCode.status).toBe(400);
    const body = await noCode.text();
    expect(body).toContain('No authorization code was returned');
    // The retry link carries the visitor's original destination.
    expect(body).toContain('/auth/login?next=%2Fnote%2Froadmap');
    expect((await go('/auth/session')).status).toBe(401);

    // The pending-login cookie is single-use (cleared on the first callback),
    // so a fresh round trip for the second refusal.
    const q2 = await startLogin(go);
    const refused = await go(`/auth/callback?code=bogus&state=${q2.get('state')}`);
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain('The identity provider refused the code (400)');
    expect(refused.headers.getSetCookie().some((c) => c.startsWith('sid='))).toBe(false);
    expect((await go('/auth/session')).status).toBe(401);
  });
});

describe('expiry — the branches only the clock reaches', () => {
  test('a session lapses after its TTL: /auth/session, /members and the API all go back to 401', async () => {
    const { go } = makeJar();
    await signIn(go);
    expect((await go('/auth/session')).status).toBe(200);
    // Without a slug the slice carries no `note` key at all.
    const me = (await (await go('/api/members/me')).json()) as { member: Record<string, unknown> };
    expect(Object.keys(me.member).sort()).toEqual(['notes', 'user']);

    advanceClock(24 * HOUR + 1000);
    expect((await go('/auth/session')).status).toBe(401);
    expect((await go('/api/members/me')).status).toBe(401);
    const members = await go('/members');
    expect(members.status).toBe(401);
    expect(await members.text()).toContain('data-airo-mode="csr"');
  });

  test('an authorization code lapses after 60s → invalid_grant', async () => {
    const { go, jar } = makeJar();
    const q = await startLogin(go);
    const code = await mintCode(go, q);
    advanceClock(61_000);
    const res = await fetch(`${BASE}/oauth/token`, {
      method: 'POST',
      headers: FORM,
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: q.get('redirect_uri') ?? '',
        client_id: 'full-site',
        client_secret: 'demo-client-secret',
        code_verifier: pendingVerifier(jar),
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_grant' });
  });

  test('an access token lapses after an hour → userinfo 401; no bearer at all → 401', async () => {
    expect((await fetch(`${BASE}/oauth/userinfo`)).status).toBe(401);

    const { go, jar } = makeJar();
    const q = await startLogin(go);
    const code = await mintCode(go, q);
    const token = await fetch(`${BASE}/oauth/token`, {
      method: 'POST',
      headers: FORM,
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: q.get('redirect_uri') ?? '',
        client_id: 'full-site',
        client_secret: 'demo-client-secret',
        code_verifier: pendingVerifier(jar),
      }),
    });
    expect(token.status).toBe(200);
    const { access_token } = (await token.json()) as { access_token: string };
    const auth = { authorization: `Bearer ${access_token}` };
    expect((await fetch(`${BASE}/oauth/userinfo`, { headers: auth })).status).toBe(200);

    advanceClock(HOUR + 1000);
    expect((await fetch(`${BASE}/oauth/userinfo`, { headers: auth })).status).toBe(401);
  });
});

describe('the provider validates before it renders or mints', () => {
  const valid = () =>
    new URLSearchParams({
      client_id: 'full-site',
      redirect_uri: `${BASE}/auth/callback`,
      state: 's'.repeat(24),
      code_challenge: 'c'.repeat(43),
      code_challenge_method: 'S256',
      response_type: 'code',
    });

  test('GET /oauth/authorize: missing response_type, short state, absent challenge → 400 each', async () => {
    const noType = valid();
    noType.delete('response_type');
    const r1 = await fetch(`${BASE}/oauth/authorize?${noType}`);
    expect(r1.status).toBe(400);
    expect(await r1.text()).toContain('unsupported_response_type');

    const shortState = valid();
    shortState.set('state', 'short');
    const r2 = await fetch(`${BASE}/oauth/authorize?${shortState}`);
    expect(r2.status).toBe(400);
    expect(await r2.text()).toContain('state required');

    const noChallenge = valid();
    noChallenge.delete('code_challenge');
    const r3 = await fetch(`${BASE}/oauth/authorize?${noChallenge}`);
    expect(r3.status).toBe(400);
    expect(await r3.text()).toContain('S256 code_challenge required');
  });

  test('POST /oauth/authorize: an unknown client, a missing or short state, or a short challenge → 400 before credentials are read', async () => {
    const post = (body: Record<string, string>) =>
      fetch(`${BASE}/oauth/authorize`, { method: 'POST', headers: FORM, body: new URLSearchParams(body), redirect: 'manual' });
    const base = {
      redirect_uri: `${BASE}/auth/callback`,
      state: 's'.repeat(24),
      code_challenge: 'c'.repeat(43),
      username: 'demo',
      password: 'demo',
    };
    expect((await post({ ...base, client_id: 'nope' })).status).toBe(400);
    const { state: _dropped, ...noState } = base;
    expect((await post({ ...noState, client_id: 'full-site' })).status).toBe(400);
    expect((await post({ ...base, client_id: 'full-site', state: 'short' })).status).toBe(400);
    // The hidden form field is client-editable: a direct POST must not mint
    // a code bound to a trivial challenge (PKCE downgrade at the minting step).
    expect((await post({ ...base, client_id: 'full-site', code_challenge: 'short' })).status).toBe(400);
  });

  test('a bearer-protected 401 says how to authenticate (RFC 6750 §3)', async () => {
    const res = await fetch(`${BASE}/oauth/userinfo`, { headers: { authorization: 'Bearer nope' } });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Bearer');
    expect(res.headers.get('www-authenticate')).toContain('invalid_token');
  });

  test('POST /oauth/token: wrong grant_type → 400; a redirect_uri swap → invalid_grant and the code is spent', async () => {
    const { go, jar } = makeJar();
    const q = await startLogin(go);
    const code = await mintCode(go, q);
    const token = (body: Record<string, string>) =>
      fetch(`${BASE}/oauth/token`, {
        method: 'POST',
        headers: FORM,
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: q.get('redirect_uri') ?? '',
          client_id: 'full-site',
          client_secret: 'demo-client-secret',
          code_verifier: pendingVerifier(jar),
          ...body,
        }),
      });

    const wrongGrant = await token({ grant_type: 'client_credentials' });
    expect(wrongGrant.status).toBe(400);
    expect(await wrongGrant.json()).toEqual({ error: 'unsupported_grant_type' });

    const swapped = await token({ redirect_uri: `${BASE}/auth/callback/` });
    expect(swapped.status).toBe(400);
    expect(await swapped.json()).toMatchObject({
      error: 'invalid_grant',
      error_description: expect.stringContaining('redirect_uri'),
    });

    // The swap consumed the code: a correct retry is now a replay.
    const replay = await token({});
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({
      error_description: expect.stringContaining('already-used'),
    });
  });
});
