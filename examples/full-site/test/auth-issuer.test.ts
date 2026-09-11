/**
 * The relying party against a MISBEHAVING issuer — the branches the
 * in-process demo provider can never take: a token exchange that succeeds
 * but hands back no usable identity, an answer that is not JSON, and a
 * provider that accepts the connection and never replies.
 *
 * A stub issuer is started first and `AUTH_ISSUER` pointed at it before
 * `server.ts` is imported (it reads the env at import time). Each test
 * flips the stub's behaviour; the relying party must answer 502 with a
 * plain message and set no session cookie in every case.
 *
 * @vitest-environment node
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

let issuer: Server;
let server: Server;
let BASE = '';
/** What the stub issuer does on the next token / userinfo call. */
let behaviour: 'no-identity' | 'not-json' | 'hang' = 'no-identity';

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
  const stub = express();
  stub.post('/oauth/token', (_req, res) => {
    if (behaviour === 'hang') return; // never answers; the relying party's timeout must fire
    if (behaviour === 'not-json') { res.type('text/html').send('<h1>maintenance</h1>'); return; }
    res.json({ access_token: 't', token_type: 'Bearer', expires_in: 60 });
  });
  stub.get('/oauth/userinfo', (_req, res) => {
    res.json({ sub: 'someone-else', name: 'Not The Demo User' });
  });
  const issuerPort = await freePort();
  issuer = stub.listen(issuerPort);
  await new Promise<void>((resolve) => issuer.once('listening', resolve));

  const port = await freePort();
  process.env.PORT = String(port);
  process.env.AUTH_ISSUER = `http://localhost:${issuerPort}`;
  const { app } = await import('../src/server.js');
  server = app.listen(port);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  BASE = `http://localhost:${port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  issuer.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => issuer.close(() => resolve()));
});

/** `/auth/login` mints the state + signed cookie; the callback then goes to the stub for the exchange. */
async function callbackWith(code = 'any'): Promise<Response> {
  const login = await fetch(`${BASE}/auth/login?next=/members`, { redirect: 'manual' });
  const state = new URL(login.headers.get('location') ?? '').searchParams.get('state') ?? '';
  const cookie = login.headers.getSetCookie().find((c) => c.startsWith('airo_oauth='))?.split(';')[0] ?? '';
  return fetch(`${BASE}/auth/callback?code=${code}&state=${state}`, { redirect: 'manual', headers: { cookie } });
}

describe('/auth/callback against a misbehaving issuer', () => {
  test('a token with no usable identity → 502, plain message, no session cookie', async () => {
    behaviour = 'no-identity';
    const res = await callbackWith();
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).toContain('no usable identity');
    expect(body).not.toContain('    at ');
    expect(res.headers.getSetCookie().some((c) => c.startsWith('sid='))).toBe(false);
  });

  test('a token response that is not JSON → 502, not a stack trace', async () => {
    behaviour = 'not-json';
    const res = await callbackWith();
    expect(res.status).toBe(502);
    expect(await res.text()).toContain('Sign-in provider unavailable');
    expect(res.headers.getSetCookie().some((c) => c.startsWith('sid='))).toBe(false);
  });

  test('a provider that accepts the connection and never answers → 502 once the timeout fires', async () => {
    behaviour = 'hang';
    const started = Date.now();
    const res = await callbackWith();
    expect(res.status).toBe(502);
    expect(await res.text()).toContain('could not be reached');
    // The relying party gives up on its own; nothing here waited for the stub.
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 20_000);
});
