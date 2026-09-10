/**
 * The relying party: sessions, cookies and the four `/auth/*` routes.
 *
 * All of it is host code — M13 puts every byte of auth outside the
 * framework. The framework's whole involvement is one gate that asks
 * `GET /auth/session` and paints a sign-in panel, and one `renderPrivate`
 * flag the wildcard route sets after `readSession` said yes.
 *
 * Sessions live in a Map with a TTL and a sweep on insert — a demo store,
 * not a production one. The cookie carries an opaque id and nothing else.
 */

import { randomBytes } from 'node:crypto';

import express, { type Request, type Response } from 'express';

import { escapeHtml } from '@airo-js/core';
import { renderDocument } from '@airo-js/ssr';

import { DEMO_USER, type MemberUser } from '../content.js';
import { s256, type RegisteredClient } from './oauth-provider.js';

const SESSION_COOKIE = 'sid';
const OAUTH_COOKIE = 'airo_oauth';
const SESSION_TTL_MS = 24 * 60 * 60_000;
const OAUTH_TTL_MS = 5 * 60_000;

export interface Session {
  userId: string;
  user: MemberUser;
  expiresAt: number;
}

const sessions = new Map<string, Session>();

function sweepSessions(): void {
  const now = Date.now();
  for (const [k, v] of sessions) if (v.expiresAt < now) sessions.delete(k);
}

/** Ten lines instead of a dependency: split, decode, pick. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

/** The one place the session cookie is read. Called only from private branches. */
export function readSession(req: Request): Session | null {
  const sid = parseCookies(req.get('cookie'))[SESSION_COOKIE];
  if (!sid) return null;
  const session = sessions.get(sid);
  if (!session) return null;
  if (session.expiresAt < Date.now()) { sessions.delete(sid); return null; }
  return session;
}

/**
 * `Secure` when the request arrived over HTTPS — directly, or via a TLS
 * terminator that sets `X-Forwarded-Proto` (`app.set('trust proxy', 1)`
 * makes Express honour it). Without it the cookie would travel in clear.
 */
function cookieOptions(req: Request, maxAgeMs: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    secure: req.secure,
    maxAge: maxAgeMs,
  };
}

/** A `next` is honoured only as a same-origin path — never an absolute URL. */
export function safeNext(candidate: unknown): string {
  if (typeof candidate !== 'string') return '/';
  if (!candidate.startsWith('/') || candidate.startsWith('//') || candidate.includes('\\')) return '/';
  return candidate;
}

/** A plain error page with a retry link. The status is the caller's to set. */
function errorDocument(title: string, body: string, next: string): string {
  return renderDocument({
    head: { lang: 'en', title, viewport: 'width=device-width, initial-scale=1', meta: [{ name: 'robots', content: 'noindex' }] },
    body: `<main style="max-width:32rem;margin:4rem auto;font:16px/1.5 system-ui,sans-serif"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p><p><a href="/auth/login?next=${encodeURIComponent(next)}">Try again</a> · <a href="/">Home</a></p></main>`,
  });
}

export interface RelyingPartyOptions {
  client: RegisteredClient;
  /** Origin of the identity provider, e.g. `http://localhost:3000` for the in-process demo. */
  issuer: string;
}

/** What `/auth/login` stashes in the short-lived cookie for `/auth/callback` to verify against. */
interface PendingLogin {
  state: string;
  verifier: string;
  next: string;
}

function readPendingLogin(raw: string | undefined): PendingLogin | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<PendingLogin>;
    if (typeof parsed.state !== 'string' || typeof parsed.verifier !== 'string') return null;
    return { state: parsed.state, verifier: parsed.verifier, next: safeNext(parsed.next) };
  } catch {
    return null;
  }
}

/**
 * Mount `/auth/login`, `/auth/callback`, `/auth/logout`, `/auth/session`.
 */
export function relyingParty(opts: RelyingPartyOptions): express.Router {
  const router = express.Router();

  // Start the round trip: random state + PKCE verifier in a short-lived
  // HttpOnly cookie, then off to the provider. `next` is the page to return
  // to — the gate links here with the current pathname + search, so the
  // visitor lands back where they were.
  router.get('/auth/login', (req, res) => {
    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const next = safeNext(req.query.next);
    const payload = Buffer.from(JSON.stringify({ state, verifier, next })).toString('base64url');
    res.cookie(OAUTH_COOKIE, payload, cookieOptions(req, OAUTH_TTL_MS));
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: opts.client.clientId,
      redirect_uri: opts.client.redirectUri,
      state,
      code_challenge: s256(verifier),
      code_challenge_method: 'S256',
    });
    res.set('Cache-Control', 'no-store').redirect(302, `${opts.issuer}/oauth/authorize?${params}`);
  });

  router.get('/auth/callback', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const pending = readPendingLogin(parseCookies(req.get('cookie'))[OAUTH_COOKIE]);
    res.clearCookie(OAUTH_COOKIE, { path: '/' });
    const next = pending?.next ?? '/';

    // Closes: CSRF / session fixation — a callback that does not carry the
    // state we minted for this browser is not our round trip.
    if (!pending || typeof req.query.state !== 'string' || req.query.state !== pending.state) {
      res.status(400).type('text/html').send(errorDocument('Sign-in could not be verified', 'The state did not match this browser’s sign-in attempt.', next));
      return;
    }
    if (req.query.error === 'access_denied') {
      // The visitor cancelled at the provider. Back to where they were, still anonymous.
      res.redirect(302, next);
      return;
    }
    if (typeof req.query.code !== 'string') {
      res.status(400).type('text/html').send(errorDocument('Sign-in could not be completed', 'No authorization code was returned.', next));
      return;
    }

    // Exchange the code. The provider may be down or misconfigured; that is
    // a 502 with a message and no cookie, never a stack trace.
    let tokenRes: globalThis.Response;
    try {
      tokenRes = await fetch(`${opts.issuer}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: req.query.code,
          redirect_uri: opts.client.redirectUri,
          client_id: opts.client.clientId,
          client_secret: opts.client.clientSecret,
          code_verifier: pending.verifier,
        }),
      });
    } catch {
      res.status(502).type('text/html').send(errorDocument('Sign-in provider unavailable', 'The identity provider could not be reached. Nothing was signed in.', next));
      return;
    }
    if (!tokenRes.ok) {
      res.status(400).type('text/html').send(errorDocument('Sign-in was refused', `The identity provider refused the code (${tokenRes.status}).`, next));
      return;
    }
    const { access_token } = (await tokenRes.json()) as { access_token?: string };
    let info: { sub?: string; name?: string } = {};
    try {
      const infoRes = await fetch(`${opts.issuer}/oauth/userinfo`, { headers: { authorization: `Bearer ${access_token}` } });
      if (infoRes.ok) info = (await infoRes.json()) as typeof info;
    } catch {
      // fall through — treated as an unusable identity below
    }
    if (info.sub !== DEMO_USER.id) {
      res.status(502).type('text/html').send(errorDocument('Sign-in provider unavailable', 'The identity provider returned no usable identity.', next));
      return;
    }

    sweepSessions();
    const sid = randomBytes(32).toString('base64url');
    sessions.set(sid, { userId: DEMO_USER.id, user: DEMO_USER, expiresAt: Date.now() + SESSION_TTL_MS });
    res.cookie(SESSION_COOKIE, sid, cookieOptions(req, SESSION_TTL_MS));
    res.redirect(302, next);
  });

  // POST, not GET: a sign-out that any `<img src>` could trigger is a CSRF
  // footgun. The dashboard's button is a plain form.
  router.post('/auth/logout', (req, res) => {
    const sid = parseCookies(req.get('cookie'))[SESSION_COOKIE];
    if (sid) sessions.delete(sid);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.set('Cache-Control', 'no-store').redirect(302, '/');
  });

  // What the gate's precheck asks. 200 with the user, or 401.
  router.get('/auth/session', (req, res) => {
    res.set('Cache-Control', 'private, no-store').set('Vary', 'Cookie');
    const session = readSession(req);
    if (!session) { res.status(401).json({ error: 'unauthenticated' }); return; }
    res.json({ user: session.user });
  });

  return router;
}

/** Shared by the wildcard route and `/api/members/me` for private responses. */
export function privateHeaders(res: Response): void {
  res.set('Cache-Control', 'private, no-store');
  res.set('Vary', 'Cookie');
  res.set('X-Robots-Tag', 'noindex');
}
