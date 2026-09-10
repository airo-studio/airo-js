/**
 * Tests for `resolveMountEntry` — the URL > initialNavState > default
 * ladder as one function, and `createRouter` / `parseRouterUrl` behind it.
 *
 * Covers: default entry, `initialNavState` outranking the default, the URL
 * outranking both under path / hash / query routers, an unknown URL page
 * falling through to the hint, `fellBack` threading, gate pages excluded
 * from `validPages`, no `window` → no URL, and a router failure never
 * stopping a mount.
 */

import { afterEach, describe, expect, test, vi } from 'vitest';

import type { Page } from '../src/schema.js';
import { createRouter, parseRouterUrl, resolveMountEntry, validPagesFor } from '../src/mount-entry.js';

const layout = { regionOrder: [], regions: {} };
const pages: Page[] = [
  { id: 'home', type: 'home', enabled: true, layout },
  { id: 'members', type: 'members', enabled: true, layout, private: true },
  { id: 'quickview', type: 'quickview', enabled: true, layout, parent: 'home' },
  { id: 'age-gate', type: 'age-gate', enabled: true, layout },
  { id: 'off', type: 'off', enabled: false, layout },
];
const isGate = (t: string) => t === 'age-gate';

afterEach(() => {
  // Restore any stubbed `window` BEFORE touching it.
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('resolveMountEntry', () => {
  test('no router, no hint → the default entry', () => {
    const entry = resolveMountEntry({ pages, isGatePage: isGate });
    expect(entry.page?.id).toBe('home');
    expect(entry.navState).toEqual({ page: 'home' });
    expect(entry.resolution.fellBack).toBeUndefined();
  });

  test('initialNavState outranks the default and keeps its context fields', () => {
    const entry = resolveMountEntry({
      pages,
      isGatePage: isGate,
      initialNavState: { page: 'members', slug: 'roadmap' },
    });
    expect(entry.page?.id).toBe('members');
    expect(entry.navState).toEqual({ page: 'members', slug: 'roadmap' });
  });

  test('a rejected hint falls back with fellBack, never throws', () => {
    const entry = resolveMountEntry({ pages, isGatePage: isGate, initialNavState: { page: 'nope' } });
    expect(entry.page?.id).toBe('home');
    expect(entry.resolution.fellBack).toEqual({ requested: 'nope', reason: 'unknown-page' });
  });

  test('path router: the URL outranks initialNavState', () => {
    window.history.replaceState(null, '', '/members');
    const entry = resolveMountEntry({
      pages,
      isGatePage: isGate,
      enableRouter: { mode: 'path', basePath: '/' },
      initialNavState: { page: 'home' },
    });
    expect(entry.page?.id).toBe('members');
    expect(entry.page?.private).toBe(true);
  });

  test('path router: a URL naming an unknown page decodes to null and the hint wins', () => {
    window.history.replaceState(null, '', '/nope');
    const entry = resolveMountEntry({
      pages,
      isGatePage: isGate,
      enableRouter: { mode: 'path', basePath: '/' },
      initialNavState: { page: 'members' },
    });
    expect(entry.page?.id).toBe('members');
  });

  test('hash router (and the `true` alias) reads the fragment', () => {
    window.location.hash = '#/members';
    expect(resolveMountEntry({ pages, isGatePage: isGate, enableRouter: true }).page?.id).toBe('members');
    expect(resolveMountEntry({ pages, isGatePage: isGate, enableRouter: { mode: 'hash' } }).page?.id).toBe('members');
    window.location.hash = '';
  });

  test('query router reads prefixed params', () => {
    window.history.replaceState(null, '', '/?airo_nav=members');
    const entry = resolveMountEntry({ pages, isGatePage: isGate, enableRouter: { mode: 'query' } });
    expect(entry.page?.id).toBe('members');
  });

  test('a gate page is never decodable from the URL', () => {
    window.history.replaceState(null, '', '/age-gate');
    const entry = resolveMountEntry({ pages, isGatePage: isGate, enableRouter: { mode: 'path', basePath: '/' } });
    expect(entry.page?.id).toBe('home');
  });

  test('no window → the URL is not consulted', () => {
    window.history.replaceState(null, '', '/members');
    vi.stubGlobal('window', undefined);
    const entry = resolveMountEntry({ pages, isGatePage: isGate, enableRouter: { mode: 'path', basePath: '/' } });
    expect(entry.page?.id).toBe('home');
  });

  test('a router that cannot be built disables URL routing instead of failing the mount', () => {
    // `basePath` is required by PathRouter; a malformed option must not throw.
    const broken = { mode: 'path' } as unknown as { mode: 'path'; basePath: string };
    expect(parseRouterUrl(broken, ['home'])).toBeNull();
    expect(resolveMountEntry({ pages, isGatePage: isGate, enableRouter: broken }).page?.id).toBe('home');
  });
});

describe('validPagesFor / createRouter', () => {
  test('validPages excludes subpages and gate pages, keeps disabled ones', () => {
    expect(validPagesFor(pages, isGate)).toEqual(['home', 'members', 'off']);
  });

  test('createRouter builds a parse-capable router without attaching listeners', () => {
    const spy = vi.spyOn(window, 'addEventListener');
    window.history.replaceState(null, '', '/members');
    const router = createRouter({ mode: 'path', basePath: '/' }, () => {}, ['home', 'members']);
    expect(router.parseCurrent()).toEqual({ page: 'members' });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
