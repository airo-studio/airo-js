/**
 * The login gate under happy-dom, with `fetch` mocked.
 *
 * What the HTTP smoke cannot see: that the gate runs BEFORE any data fetch
 * (a 401 from `/auth/session` paints the panel and `/api/members/me` is
 * never asked), that a satisfied initial mount never asks `/auth/session`,
 * that a public entry never runs the gate at all, and the one failure a
 * visitor can act on — the session expiring between the server's render
 * and the hydrate fetch.
 *
 * @vitest-environment happy-dom
 * @vitest-environment-options { "url": "http://localhost:4317/members" }
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mountCartridge } from '@airo-js/runtime';

import {
  docSiteCartridge,
  docSiteTemplate,
  sessionEndedHandler,
  toSummary,
  type DocSiteConfig,
  type DocSiteData,
} from '../src/cartridge.js';
import { SITE } from '../src/content.js';
import { DEMO_USER, MEMBER_NOTES } from '../src/members-content.js';

const config: DocSiteConfig = { locale: 'en-GB', siteUrl: SITE.url, siteName: SITE.name };

const apiSnapshot = (): DocSiteData => ({
  site: SITE,
  index: [],
  member: {
    user: DEMO_USER,
    notes: MEMBER_NOTES.map(toSummary),
  },
});

type Route = { status: number; body?: unknown } | Error;

/** Route `fetch` by pathname; record every url asked for. */
function mockFetch(routes: Record<string, Route>): { calls: string[]; inits: RequestInit[] } {
  const calls: string[] = [];
  const inits: RequestInit[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost:4317');
      calls.push(url.pathname);
      inits.push(init ?? {});
      const route = routes[url.pathname];
      if (!route) throw new Error(`unrouted ${url.pathname}`);
      if (route instanceof Error) throw route;
      return new Response(route.body === undefined ? null : JSON.stringify(route.body), {
        status: route.status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return { calls, inits };
}

let host: HTMLElement;

beforeEach(() => {
  host = document.createElement('div');
  host.id = 'app';
  document.body.appendChild(host);
});

afterEach(() => {
  host.remove();
  vi.unstubAllGlobals();
});

function mountMembers(extra: Partial<Parameters<typeof mountCartridge<DocSiteData, DocSiteConfig>>[0]> = {}) {
  return mountCartridge<DocSiteData, DocSiteConfig>({
    cartridge: docSiteCartridge,
    config,
    template: docSiteTemplate,
    host,
    mode: 'csr',
    styleIsolation: 'light',
    initialNavState: { page: 'members' },
    dataSourceId: 'members',
    dataSourceInput: { kind: 'custom', payload: {} },
    ...extra,
  });
}

describe('the 401 shell: the gate runs before any fetch', () => {
  test('a 401 from /auth/session paints the sign-in panel, blocks, and never asks the API', async () => {
    const { calls } = mockFetch({ '/auth/session': { status: 401 } });

    const result = await mountMembers();

    expect(result.blocked).toBe(true);
    if (result.blocked) expect(result.blockedBy).toBe('login');
    expect(calls).toEqual(['/auth/session']);
    const panel = host.querySelector('.fs-signin');
    expect(panel).not.toBeNull();
    // The panel links back to where the visitor was, so the round trip
    // returns them here.
    expect(panel?.querySelector('a.fs-signin__button')?.getAttribute('href')).toBe('/auth/login?next=%2Fmembers');
    expect(panel?.textContent).not.toContain('Could not reach');
  });

  test('a network error in precheck paints the panel with retry copy instead of throwing', async () => {
    const onError = vi.fn();
    mockFetch({ '/auth/session': new Error('offline') });

    const result = await mountMembers({ onError });

    expect(result.blocked).toBe(true);
    expect(onError).not.toHaveBeenCalled();
    expect(host.querySelector('.fs-signin__error')?.textContent).toContain('Could not reach the sign-in service');
  });

  test('a 200 from /auth/session lets the mount through: one API fetch with the cookie, dashboard rendered', async () => {
    const { calls, inits } = mockFetch({
      '/auth/session': { status: 200, body: { user: DEMO_USER } },
      '/api/members/me': { status: 200, body: apiSnapshot() },
    });

    const result = await mountMembers();

    expect(result.blocked).toBe(false);
    expect(calls).toEqual(['/auth/session', '/api/members/me']);
    expect(inits[1]?.credentials).toBe('same-origin');
    // `ctx.signal` is threaded through even when the runtime supplies none
    // (it is optional on `DataSourceContext`); a host that does supply one
    // can cancel the fetch.
    expect(Object.hasOwn(inits[1] ?? {}, 'signal')).toBe(true);
    expect(host.querySelector('.fs-signin')).toBeNull();
    expect(host.querySelector('h1.fs-title')?.textContent).toBe('Hello, Demo Member');
    expect(host.querySelectorAll('a.fs-card__link')).toHaveLength(MEMBER_NOTES.length);
  });

  test('the session expiring between precheck and the fetch reports onError("fetch") and rejects', async () => {
    const onError = vi.fn();
    mockFetch({
      '/auth/session': { status: 200, body: { user: DEMO_USER } },
      '/api/members/me': { status: 401, body: { error: 'unauthenticated' } },
    });

    await expect(mountMembers({ onError })).rejects.toThrow(/members api answered 401/);
    expect(onError).toHaveBeenCalledWith('fetch', expect.any(Error), expect.anything());
  });

  test("the client's handler for that failure paints the session-ended panel, linking back to the page", async () => {
    mockFetch({ '/api/members/me': { status: 401, body: { error: 'unauthenticated' } } });
    host.innerHTML = '<div class="fs-page"><h1 class="fs-title">Hello, Demo Member</h1></div>';

    await expect(
      mountMembers({ mode: 'hydrate', satisfiedGates: ['login'], onError: sessionEndedHandler(host) }),
    ).rejects.toThrow(/401/);

    expect(host.querySelector('.fs-signin__error')?.textContent).toContain('Your session has ended');
    expect(host.querySelector('a.fs-signin__button')?.getAttribute('href')).toBe('/auth/login?next=%2Fmembers');
    expect(host.querySelector('h1.fs-title')?.textContent).toBe('Members');
  });

  test('two concurrent mounts keep their own precheck error: one offline, one signed out', async () => {
    const other = document.createElement('div');
    document.body.appendChild(other);
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        // First precheck fails (offline), second answers 401. Both mounts
        // race; the copy on each panel must match its own precheck.
        calls += 1;
        if (calls === 1) throw new Error('offline');
        return new Response(null, { status: 401 });
      }),
    );

    const [a, b] = await Promise.all([
      mountMembers(),
      mountCartridge<DocSiteData, DocSiteConfig>({
        cartridge: docSiteCartridge,
        config,
        template: docSiteTemplate,
        host: other,
        mode: 'csr',
        styleIsolation: 'light',
        initialNavState: { page: 'members' },
        dataSourceId: 'members',
        dataSourceInput: { kind: 'custom', payload: {} },
      }),
    ]);

    expect(a.blocked).toBe(true);
    expect(b.blocked).toBe(true);
    expect(host.querySelector('.fs-signin__error')?.textContent).toContain('Could not reach');
    expect(other.querySelector('.fs-signin__error')).toBeNull();
    other.remove();
  });
});

describe('the server-verified hand-off', () => {
  test('satisfiedGates: ["login"] skips the precheck on the initial mount — no /auth/session call', async () => {
    const { calls } = mockFetch({ '/api/members/me': { status: 200, body: apiSnapshot() } });

    const result = await mountMembers({ satisfiedGates: ['login'] });

    expect(result.blocked).toBe(false);
    expect(calls).toEqual(['/api/members/me']);
    expect(host.querySelector('h1.fs-title')?.textContent).toBe('Hello, Demo Member');
  });

  test('hydrate: the server-rendered dashboard is adopted, not repainted, and the member slice is refetched', async () => {
    const { calls } = mockFetch({ '/api/members/me': { status: 200, body: apiSnapshot() } });
    host.innerHTML = '<div class="fs-page"><header class="fs-head"><h1 class="fs-title">Hello, Demo Member</h1></header></div>';
    const serverNode = host.querySelector('.fs-page');

    const result = await mountMembers({ mode: 'hydrate', satisfiedGates: ['login'] });

    expect(result.blocked).toBe(false);
    expect(calls).toEqual(['/api/members/me']);
    expect(host.contains(serverNode)).toBe(true);
  });
});

describe('scoping and the no-paint attribute', () => {
  test('a public entry never runs the gate: no /auth/session call, content rendered', async () => {
    const { calls } = mockFetch({});

    const result = await mountMembers({
      initialNavState: { page: 'home' },
      dataSourceId: 'content',
    });

    expect(result.blocked).toBe(false);
    expect(calls).toEqual([]);
    expect(host.querySelector('h1.fs-title')?.textContent).toBe(SITE.name);
  });

  test('data-airo-gate="pending" on the host flips to blocked / passed', async () => {
    mockFetch({ '/auth/session': { status: 401 } });
    host.setAttribute('data-airo-gate', 'pending');
    await mountMembers();
    expect(host.getAttribute('data-airo-gate')).toBe('blocked');

    host.remove();
    host = document.createElement('div');
    host.setAttribute('data-airo-gate', 'pending');
    document.body.appendChild(host);
    mockFetch({
      '/auth/session': { status: 200, body: { user: DEMO_USER } },
      '/api/members/me': { status: 200, body: apiSnapshot() },
    });
    await mountMembers();
    expect(host.getAttribute('data-airo-gate')).toBe('passed');
  });
});
