/**
 * The relying party: sessions, cookies and the four `/auth/*` routes.
 *
 * All of it is host code — M13 puts every byte of auth outside the
 * framework. The framework's whole involvement is one gate that asks
 * `GET /auth/session` and paints a sign-in panel, and one `renderPrivate`
 * flag the wildcard route sets after `readSession` said yes.
 *
 * Sessions live in a Map with a TTL, a sweep on insert and a hard cap — a
 * demo store, not a production one. The cookie carries an opaque id and
 * nothing else. Every check below names the attack it closes, because this
 * file is written to be copied.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import express, { type Request, type Response } from 'express';

import { escapeHtml } from '@airo-js/core';
import { renderDocument } from '@airo-js/ssr';

import type { MemberUser } from '../content.js';
import { DEMO_USER } from '../members-content.js';
import { s256, type RegisteredClient } from './oauth-provider.js';

const SESSION_COOKIE = 'sid';
const OAUTH_COOKIE = 'airo_oauth';
const SESSION_TTL_MS = 24 * 60 * 60_000;
const OAUTH_TTL_MS = 5 * 60_000;
/** Demo bound: the oldest session is evicted past this many. */
const MAX_SESSIONS = 10_000;
/** A `next` longer than this cannot be trusted to fit the cookie budget. */
const MAX_NEXT_LENGTH = 1024;
/** Every server-to-provider call gives up after this long — a hung provider is a 502, not a pinned worker. */
const PROVIDER_TIMEOUT_MS = 5_000;

/**
 * Signs the pending-login cookie. Random per process unless the host sets
 * one — fine for a demo (a restart invalidates in-flight sign-ins, nothing
 * else); a real deployment sets `AUTH_COOKIE_SECRET` so every instance
 * verifies the same signature.
 */
const COOKIE_SECRET = process.env.AUTH_COOKIE_SECRET ?? randomBytes(32).toString('base64url');

export interface Session {
  user: MemberUser;
  expiresAt: number;
}

const sessions = new Map<string, Session>();

function sweepSessions(): void {
  const now = Date.now();
  for (const [k, v] of sessions) if (v.expiresAt < now) sessions.delete(k);
  // Map iteration is insertion-ordered, so the first key is the oldest.
  while (sessions.size >= MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
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
    if (!k) continue;
    // Closes: a malformed %-escape in a cookie value throwing URIError out
    // of every route that reads cookies (a 500 on the whole private site).
    // A value that does not decode is kept raw; it will match no session.
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
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
 * makes Express honour it from the one trusted hop). The terminator must
 * OVERWRITE that header, not append to a client-supplied one: Express reads
 * the leftmost value. Without `Secure` the cookie would travel in clear.
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

/**
 * A `next` is honoured only as a same-origin path — never an absolute URL,
 * never protocol-relative, never a backslash trick — and only up to a
 * length the pending-login cookie can carry (past ~4 KB browsers drop the
 * cookie silently and every sign-in from that link would fail at the
 * callback with a state mismatch nobody could explain).
 */
export function safeNext(candidate: unknown): string {
  if (typeof candidate !== 'string') return '/';
  if (!candidate.startsWith('/') || candidate.startsWith('//') || candidate.includes('\\')) return '/';
  if (candidate.length > MAX_NEXT_LENGTH) return '/';
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

function sign(payload: string): string {
  return createHmac('sha256', COOKIE_SECRET).update(payload).digest('base64url');
}

/** Constant-time equality on two strings of possibly different length. */
function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function writePendingLogin(pending: PendingLogin): string {
  const payload = Buffer.from(JSON.stringify(pending)).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

/**
 * Closes: a planted pending-login cookie (login CSRF via cookie tossing
 * from a sibling subdomain). The payload is HMAC-signed; an unsigned or
 * re-signed cookie reads as "no sign-in in flight" and the callback
 * refuses.
 */
function readPendingLogin(raw: string | undefined): PendingLogin | null {
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot < 0) return null;
  const payload = raw.slice(0, dot);
  if (!safeEqual(raw.slice(dot + 1), sign(payload))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<PendingLogin>;
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

  // Start the round trip: random state + PKCE verifier in a short-lived,
  // signed, HttpOnly cookie, then off to the provider. `next` is the page
  // to return to — the gate links here with the current pathname + search,
  // so the visitor lands back where they were.
  router.get('/auth/login', (req, res) => {
    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const next = safeNext(req.query.next);
    res.cookie(OAUTH_COOKIE, writePendingLogin({ state, verifier, next }), cookieOptions(req, OAUTH_TTL_MS));
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
    if (!pending || typeof req.query.state !== 'string' || !safeEqual(req.query.state, pending.state)) {
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

    // Exchange the code. The provider may be down, hung, misconfigured, or
    // answering with something that is not JSON; every one of those is a
    // 502 with a message and no cookie, never a stack trace. The timeout is
    // what turns "hung" into "down".
    const unavailable = (why: string): void => {
      res.status(502).type('text/html').send(errorDocument('Sign-in provider unavailable', why, next));
    };
    let accessToken: string;
    try {
      const tokenRes = await fetch(`${opts.issuer}/oauth/token`, {
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
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
      if (!tokenRes.ok) {
        res.status(400).type('text/html').send(errorDocument('Sign-in was refused', `The identity provider refused the code (${tokenRes.status}).`, next));
        return;
      }
      const body = (await tokenRes.json()) as { access_token?: unknown };
      if (typeof body.access_token !== 'string' || body.access_token.length === 0) {
        unavailable('The identity provider returned no access token.');
        return;
      }
      accessToken = body.access_token;
    } catch {
      unavailable('The identity provider could not be reached. Nothing was signed in.');
      return;
    }

    let info: { sub?: unknown; name?: unknown } = {};
    try {
      const infoRes = await fetch(`${opts.issuer}/oauth/userinfo`, {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
      if (infoRes.ok) info = (await infoRes.json()) as typeof info;
    } catch {
      // fall through — treated as an unusable identity below
    }
    if (info.sub !== DEMO_USER.id) {
      unavailable('The identity provider returned no usable identity.');
      return;
    }

    sweepSessions();
    const sid = randomBytes(32).toString('base64url');
    sessions.set(sid, { user: DEMO_USER, expiresAt: Date.now() + SESSION_TTL_MS });
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
