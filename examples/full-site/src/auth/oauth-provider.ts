/**
 * A demo OAuth 2.0 identity provider — authorization-code grant with PKCE,
 * in-process, one account (`demo` / `demo`), one registered client.
 *
 * Nothing in here is framework code; it exists so the example is a complete
 * sign-in flow you can run with one `pnpm dev`. It is also written to be
 * copied: every check below closes a named attack, because a copied toy
 * that skips them is worse than no example.
 *
 *   browser ──GET /auth/login──► relying party (session.ts)
 *           ◄─302 /oauth/authorize?client_id&redirect_uri&state&code_challenge─
 *   browser ──GET /oauth/authorize──► this file: validate client + redirect_uri, show form
 *   browser ──POST /oauth/authorize (demo/demo)──► mint one-shot code bound to challenge
 *           ◄─302 redirect_uri?code&state──
 *   browser ──GET /auth/callback──► relying party: check state, POST /oauth/token
 *   relying party ──POST /oauth/token (code, verifier, client_secret)──► this file: S256, one-shot
 *                 ◄─{ access_token }──  then GET /oauth/userinfo ──► { sub, name }
 *
 * Swap this for GitHub / Google / Auth0 by pointing `AUTH_ISSUER` at them,
 * registering the same `client_id` / `redirect_uri` there and setting
 * `AUTH_CLIENT_SECRET` to the secret they issue; the relying party does not
 * change. The in-memory code and token stores are a demo limitation: they
 * are swept on every mint and exchange but have no persistence and no
 * cap beyond their TTLs.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import express from 'express';

import { escapeAttr, escapeHtml } from '@airo-js/core';
import { renderDocument } from '@airo-js/ssr';

import { DEMO_USER } from '../members-content.js';

export interface RegisteredClient {
  clientId: string;
  clientSecret: string;
  /** Exact string match. A trailing slash is a different URI. */
  redirectUri: string;
}

const DEMO_CREDENTIALS = { username: 'demo', password: 'demo' };
const CODE_TTL_MS = 60_000;
const TOKEN_TTL_MS = 60 * 60_000;
/** BASE64URL(SHA-256) is 43 characters; anything shorter is not an S256 challenge. */
export const S256_CHALLENGE_LENGTH = 43;
/** RFC 6749 §10.12 asks for unguessable state; 16 characters of base64url is the floor here. */
export const MIN_STATE_LENGTH = 16;

interface IssuedCode {
  codeChallenge: string;
  redirectUri: string;
  expiresAt: number;
  used: boolean;
}

/** RFC 7636 S256: BASE64URL(SHA256(verifier)). */
export function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/**
 * Constant-time equality on two strings of possibly different length.
 * Closes: timing side channels on the client secret, the demo password and
 * the verifier digest. Academic in-process with fixed demo values; not
 * academic in the copy of this file that fronts a real account table.
 */
function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function isS256Challenge(value: unknown): value is string {
  return typeof value === 'string' && value.length >= S256_CHALLENGE_LENGTH;
}

function formDocument(opts: {
  state: string;
  redirectUri: string;
  codeChallenge: string;
  clientId: string;
  error?: string;
}): string {
  const cancel = `${opts.redirectUri}?${new URLSearchParams({ error: 'access_denied', state: opts.state })}`;
  return renderDocument({
    head: {
      lang: 'en',
      title: 'Sign in — DemoAuth',
      viewport: 'width=device-width, initial-scale=1',
      meta: [{ name: 'robots', content: 'noindex, nofollow' }],
      inlineStyles: [
        `body{margin:0;font:16px/1.5 system-ui,sans-serif;color:#16161a;background:#f7f7f8}
         .idp{max-width:22rem;margin:4rem auto;padding:2rem;background:#fff;border:1px solid #e5e7eb;border-radius:8px}
         .idp h1{font-size:1.25rem;margin:0 0 .25rem}.idp p{color:#6b7280;margin:0 0 1.25rem}
         .idp label{display:block;font-size:.85rem;margin:.75rem 0 .25rem}.idp input{width:100%;padding:.5rem;border:1px solid #d1d5db;border-radius:4px;box-sizing:border-box}
         .idp button{margin-top:1rem;width:100%;padding:.6rem;background:#0b5cad;color:#fff;border:0;border-radius:4px;font-weight:600}
         .idp .err{color:#b91c1c;font-size:.9rem;margin:.5rem 0 0}.idp .cancel{display:block;text-align:center;margin-top:1rem;color:#6b7280;font-size:.9rem}`,
      ],
    },
    body: `<main class="idp">
  <h1>DemoAuth</h1>
  <p>A stand-in identity provider. Sign in as <code>demo</code> / <code>demo</code>.</p>
  <form method="post" action="/oauth/authorize">
    <input type="hidden" name="state" value="${escapeAttr(opts.state)}">
    <input type="hidden" name="redirect_uri" value="${escapeAttr(opts.redirectUri)}">
    <input type="hidden" name="code_challenge" value="${escapeAttr(opts.codeChallenge)}">
    <input type="hidden" name="client_id" value="${escapeAttr(opts.clientId)}">
    <label for="u">Username</label><input id="u" name="username" autocomplete="username" value="demo">
    <label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password">
    ${opts.error ? `<p class="err">${escapeHtml(opts.error)}</p>` : ''}
    <button type="submit">Sign in</button>
  </form>
  <a class="cancel" href="${escapeAttr(cancel)}">Cancel and go back</a>
</main>`,
  });
}

/**
 * Mount the provider's three endpoints. `client` is the one relying party
 * this provider knows; anything else is refused before a form renders.
 */
export function oauthProvider(client: RegisteredClient): express.Router {
  const router = express.Router();
  const codes = new Map<string, IssuedCode>();
  const tokens = new Map<string, { sub: string; expiresAt: number }>();

  const sweep = (): void => {
    const now = Date.now();
    for (const [k, v] of codes) if (v.expiresAt < now) codes.delete(k);
    for (const [k, v] of tokens) if (v.expiresAt < now) tokens.delete(k);
  };

  /** Exact-match validation of the client identity and its redirect target. */
  const validateClient = (clientId: unknown, redirectUri: unknown): string | null => {
    // Closes: an unknown client borrowing the provider to mint codes.
    if (clientId !== client.clientId) return 'unknown client_id';
    // Closes: an open redirector — a stolen code landing on an attacker's host.
    // Exact string match, never prefix or pattern.
    if (redirectUri !== client.redirectUri) return 'redirect_uri is not registered for this client';
    return null;
  };

  router.get('/oauth/authorize', (req, res) => {
    const { client_id, redirect_uri, state, code_challenge, code_challenge_method, response_type } = req.query;
    const clientError = validateClient(client_id, redirect_uri);
    if (clientError) { res.status(400).type('text/plain').send(`invalid_request: ${clientError}\n`); return; }
    if (response_type !== 'code') { res.status(400).type('text/plain').send('unsupported_response_type\n'); return; }
    // Closes: PKCE downgrade — plain or absent challenges are refused, not tolerated.
    if (code_challenge_method !== 'S256' || !isS256Challenge(code_challenge)) {
      res.status(400).type('text/plain').send('invalid_request: S256 code_challenge required\n');
      return;
    }
    if (typeof state !== 'string' || state.length < MIN_STATE_LENGTH) {
      res.status(400).type('text/plain').send('invalid_request: state required\n');
      return;
    }
    res.set('Cache-Control', 'no-store').type('text/html').send(
      formDocument({ state, redirectUri: redirect_uri as string, codeChallenge: code_challenge, clientId: client.clientId }),
    );
  });

  router.post('/oauth/authorize', (req, res) => {
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    const clientError = validateClient(body.client_id, body.redirect_uri);
    // The same checks as the GET: the hidden form fields are client-editable,
    // so a direct POST must not mint a code bound to a trivial challenge or
    // a short state. Closes: PKCE downgrade at the minting step.
    if (
      clientError ||
      typeof body.state !== 'string' ||
      body.state.length < MIN_STATE_LENGTH ||
      !isS256Challenge(body.code_challenge)
    ) {
      res.status(400).type('text/plain').send('invalid_request\n');
      return;
    }
    if (
      typeof body.username !== 'string' ||
      typeof body.password !== 'string' ||
      !safeEqual(body.username, DEMO_CREDENTIALS.username) ||
      !safeEqual(body.password, DEMO_CREDENTIALS.password)
    ) {
      res.status(401).set('Cache-Control', 'no-store').type('text/html').send(
        formDocument({
          state: body.state,
          redirectUri: body.redirect_uri as string,
          codeChallenge: body.code_challenge,
          clientId: client.clientId,
          error: 'Wrong username or password. The demo account is demo / demo.',
        }),
      );
      return;
    }
    sweep();
    const code = randomBytes(32).toString('base64url');
    // The code is bound to the challenge AND the redirect_uri it was issued
    // for, so the token endpoint can refuse a swap of either.
    codes.set(code, {
      codeChallenge: body.code_challenge,
      redirectUri: body.redirect_uri as string,
      expiresAt: Date.now() + CODE_TTL_MS,
      used: false,
    });
    res.redirect(302, `${body.redirect_uri}?${new URLSearchParams({ code, state: body.state })}`);
  });

  router.post('/oauth/token', (req, res) => {
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    if (body.grant_type !== 'authorization_code') { res.status(400).json({ error: 'unsupported_grant_type' }); return; }
    // Closes: a public caller using a confidential client's id.
    if (
      body.client_id !== client.clientId ||
      typeof body.client_secret !== 'string' ||
      !safeEqual(body.client_secret, client.clientSecret)
    ) {
      // No `WWW-Authenticate` here: this endpoint authenticates the client
      // from the form body only (RFC 6749 §2.3.1), and advertising a Basic
      // scheme it does not parse would mislead a copier.
      res.status(401).json({ error: 'invalid_client' });
      return;
    }
    sweep();
    const issued = typeof body.code === 'string' ? codes.get(body.code) : undefined;
    // Closes: replay — a code is consumed on first use, whether or not the
    // exchange then succeeds.
    if (!issued || issued.used || issued.expiresAt < Date.now()) {
      res.status(400).json({ error: 'invalid_grant', error_description: 'unknown, expired or already-used code' });
      return;
    }
    issued.used = true;
    if (body.redirect_uri !== issued.redirectUri) {
      res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri does not match the authorization request' });
      return;
    }
    // Closes: authorization-code injection — only the party that generated
    // the verifier can redeem the code (RFC 7636).
    if (typeof body.code_verifier !== 'string' || !safeEqual(s256(body.code_verifier), issued.codeChallenge)) {
      res.status(400).json({ error: 'invalid_grant', error_description: 'code_verifier does not match code_challenge' });
      return;
    }
    const accessToken = randomBytes(32).toString('base64url');
    tokens.set(accessToken, { sub: DEMO_USER.id, expiresAt: Date.now() + TOKEN_TTL_MS });
    res.set('Cache-Control', 'no-store').json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: TOKEN_TTL_MS / 1000,
    });
  });

  router.get('/oauth/userinfo', (req, res) => {
    const auth = req.get('authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? tokens.get(auth.slice(7)) : undefined;
    if (!token || token.expiresAt < Date.now()) {
      // RFC 6750 §3: a bearer-protected resource says how to authenticate.
      res.status(401).set('WWW-Authenticate', 'Bearer realm="demo", error="invalid_token"').json({ error: 'invalid_token' });
      return;
    }
    res.set('Cache-Control', 'no-store').json({ sub: token.sub, name: DEMO_USER.name });
  });

  return router;
}
