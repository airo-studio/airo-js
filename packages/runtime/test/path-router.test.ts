/**
 * Tests for `@airo-js/core`'s PathRouter. Lives in runtime's test folder
 * because runtime's vitest config provides the happy-dom env PathRouter
 * needs (window.history, popstate, location.pathname mutation). Once
 * core gains its own test infra these move there.
 *
 * Covers the three verifications flagged in the 0.5.0 design review:
 *   1. basePath mismatch returns null cleanly (no thrown error).
 *   2. Trailing-slash normalisation across `/campaign/xyz`,
 *      `/campaign/xyz/`, `/campaign/xyz/products/abc`.
 *   3. Hash + path coexistence — path mode does NOT read window.location.hash;
 *      a hash on a path-mode URL is treated as a normal page anchor.
 *
 * Plus: push/replace round-trips, popstate fires onNavigate, parseCurrent
 * decodes the current URL.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { PathRouter, routerHrefFor } from '@airo-js/core';

const BASE = '/campaign/xyz';

function setLocation(pathname: string, hash = ''): void {
  // happy-dom permits direct mutation of location.pathname via assign.
  // Use a full URL so the parser routes the parts correctly.
  window.history.replaceState(null, '', `${pathname}${hash}`);
}

let originalUrl: string;

beforeEach(() => {
  originalUrl = window.location.href;
  setLocation('/', '');
});

afterEach(() => {
  window.history.replaceState(null, '', originalUrl);
});

describe('PathRouter — parseCurrent (the 3 verifications)', () => {
  test('basePath mismatch returns null cleanly (verification 1)', () => {
    setLocation('/other/widget/products/abc');
    const onNavigate = vi.fn();
    const router = new PathRouter(onNavigate, {
      basePath: BASE,
      validPages: ['products'],
    });
    expect(() => router.parseCurrent()).not.toThrow();
    expect(router.parseCurrent()).toBeNull();
  });

  test('basePath sibling collision (xyzabc vs xyz) returns null', () => {
    setLocation('/campaign/xyzabc/products/foo');
    const router = new PathRouter(vi.fn(), {
      basePath: BASE,
      validPages: ['products'],
    });
    expect(router.parseCurrent()).toBeNull();
  });

  test('trailing-slash normalisation (verification 2)', () => {
    const router = new PathRouter(vi.fn(), {
      basePath: BASE,
      validPages: ['products', 'product'],
    });

    // /campaign/xyz — no tail → null
    setLocation('/campaign/xyz');
    expect(router.parseCurrent()).toBeNull();

    // /campaign/xyz/ — trailing slash, no tail → null
    setLocation('/campaign/xyz/');
    expect(router.parseCurrent()).toBeNull();

    // /campaign/xyz/products/abc → real state
    setLocation('/campaign/xyz/products/abc');
    expect(router.parseCurrent()).toEqual({ page: 'products', productId: 'abc' });
  });

  test('hash + path coexistence — path mode does NOT read the hash (verification 3)', () => {
    // Path mode is active. URL has BOTH a path route AND a trailing
    // hash. The hash should be ignored (treated as a normal page
    // anchor); path wins.
    setLocation('/campaign/xyz/products/abc', '#some-anchor');
    const router = new PathRouter(vi.fn(), {
      basePath: BASE,
      validPages: ['products', 'product'],
    });
    const state = router.parseCurrent();
    expect(state).toEqual({ page: 'products', productId: 'abc' });
    // Verify the hash was not read into the state object.
    expect(JSON.stringify(state)).not.toContain('some-anchor');
  });

  test('hash without path content — still null (path is source of truth)', () => {
    // /campaign/xyz#products/abc — hash looks route-shaped but path
    // is empty under basePath. Path mode ignores hash; returns null.
    setLocation('/campaign/xyz', '#products/abc');
    const router = new PathRouter(vi.fn(), {
      basePath: BASE,
      validPages: ['products'],
    });
    expect(router.parseCurrent()).toBeNull();
  });
});

describe('PathRouter — push / replace / popstate', () => {
  test('push writes the encoded URL via pushState', () => {
    setLocation('/campaign/xyz');
    const router = new PathRouter(vi.fn(), {
      basePath: BASE,
      validPages: ['products', 'product'],
    });
    router.push({ page: 'product', productId: 'abc' });
    expect(window.location.pathname).toBe('/campaign/xyz/product/abc');
  });

  test('push is a no-op when URL already matches (no extra history entry)', () => {
    setLocation('/campaign/xyz/products');
    const router = new PathRouter(vi.fn(), {
      basePath: BASE,
      validPages: ['products'],
    });
    const lengthBefore = window.history.length;
    router.push({ page: 'products' });
    expect(window.history.length).toBe(lengthBefore);
  });

  test('replace updates the URL without adding a history entry', () => {
    setLocation('/campaign/xyz');
    const router = new PathRouter(vi.fn(), {
      basePath: BASE,
      validPages: ['products'],
    });
    const lengthBefore = window.history.length;
    router.replace({ page: 'products' });
    expect(window.location.pathname).toBe('/campaign/xyz/products');
    expect(window.history.length).toBe(lengthBefore);
  });

  test('popstate fires onNavigate with the decoded URL state', () => {
    setLocation('/campaign/xyz/products');
    const onNavigate = vi.fn();
    const router = new PathRouter(onNavigate, {
      basePath: BASE,
      validPages: ['products', 'product'],
    });
    router.start();

    setLocation('/campaign/xyz/product/abc');
    window.dispatchEvent(new PopStateEvent('popstate'));

    expect(onNavigate).toHaveBeenCalledWith({ page: 'product', productId: 'abc' });

    router.stop();
  });

  test('stop removes the popstate listener', () => {
    setLocation('/campaign/xyz/products');
    const onNavigate = vi.fn();
    const router = new PathRouter(onNavigate, {
      basePath: BASE,
      validPages: ['products', 'product'],
    });
    router.start();
    router.stop();

    setLocation('/campaign/xyz/product/abc');
    window.dispatchEvent(new PopStateEvent('popstate'));

    expect(onNavigate).not.toHaveBeenCalled();
  });

  test('round-trip: push then parseCurrent returns the pushed state', () => {
    setLocation('/campaign/xyz');
    const router = new PathRouter(vi.fn(), {
      basePath: BASE,
      validPages: ['products', 'product'],
    });
    const state = { page: 'product', productId: 'abc', filter: 'electronics' };
    router.push(state);
    expect(router.parseCurrent()).toEqual(state);
  });

  test('trailing slash in basePath option is normalised', () => {
    setLocation('/campaign/xyz/products');
    const router = new PathRouter(vi.fn(), {
      basePath: '/campaign/xyz/',  // trailing slash
      validPages: ['products'],
    });
    expect(router.parseCurrent()).toEqual({ page: 'products' });
  });
});

describe('PathRouter — root mount (basePath: "/")', () => {
  // Every case above uses a carve-out basePath. Root mount is the shape a
  // whole site uses, and until 0.9 nothing in the repo exercised it.

  test('emits real top-level urls', () => {
    setLocation('/');
    const router = new PathRouter(vi.fn(), { basePath: '/', validPages: ['roster'] });
    router.push({ page: 'roster' });
    expect(window.location.pathname).toBe('/roster');
  });

  test('decodes a top-level url', () => {
    setLocation('/roster');
    const router = new PathRouter(vi.fn(), { basePath: '/', validPages: ['roster'] });
    expect(router.parseCurrent()).toEqual({ page: 'roster' });
  });

  test('parseCurrent at bare "/" is null — the entry-page fallback case', () => {
    setLocation('/');
    const router = new PathRouter(vi.fn(), { basePath: '/', validPages: ['home'] });
    expect(router.parseCurrent()).toBeNull();
  });

  test('the validPages allowlist is what keeps static assets out', () => {
    // basePath '' makes `pathname.startsWith(base)` true for EVERY path, so
    // the allowlist is doing all the gating. Hosts must still route assets
    // before the wildcard, but a stray decode must not invent a page.
    setLocation('/favicon.ico');
    const router = new PathRouter(vi.fn(), { basePath: '/', validPages: ['home'] });
    expect(router.parseCurrent()).toBeNull();
  });

  test('round-trip with a context key and query state', () => {
    setLocation('/');
    const router = new PathRouter(vi.fn(), {
      basePath: '/',
      validPages: ['article'],
      pathContextKey: 'slug',
    });
    const state = { page: 'article', slug: 'first-post', filter: 'live' };
    router.push(state);
    expect(window.location.pathname).toBe('/article/first-post');
    expect(router.parseCurrent()).toEqual(state);
  });
});

describe('PathRouter — entryPageId collapse', () => {
  test('bare entry state collapses onto basePath instead of basePath/<id>', () => {
    setLocation('/');
    const router = new PathRouter(vi.fn(), {
      basePath: '/',
      validPages: ['home', 'roster'],
      entryPageId: 'home',
    });
    router.push({ page: 'home' });
    expect(window.location.pathname).toBe('/');
  });

  test('collapses on a carve-out basePath too', () => {
    setLocation(BASE);
    const router = new PathRouter(vi.fn(), {
      basePath: BASE,
      validPages: ['home'],
      entryPageId: 'home',
    });
    router.push({ page: 'home' });
    expect(window.location.pathname).toBe(BASE);
  });

  test('a non-entry page is unaffected', () => {
    setLocation('/');
    const router = new PathRouter(vi.fn(), {
      basePath: '/',
      validPages: ['home', 'roster'],
      entryPageId: 'home',
    });
    router.push({ page: 'roster' });
    expect(window.location.pathname).toBe('/roster');
  });

  test('entry page WITH extra state does not collapse — round-trip safety', () => {
    // '/?filter=live' would decode to a null tail and lose the filter, so
    // only a BARE entry state is collapsible.
    setLocation('/');
    const router = new PathRouter(vi.fn(), {
      basePath: '/',
      validPages: ['home'],
      entryPageId: 'home',
    });
    router.push({ page: 'home', filter: 'live' });
    expect(window.location.pathname).toBe('/home');
    expect(router.parseCurrent()).toEqual({ page: 'home', filter: 'live' });
  });

  test('replace at "/" no longer rewrites the url to /home', () => {
    // PageManager.initRouter calls replace() when parseCurrent() is null,
    // which is exactly the bare-basePath case. Without entryPageId a
    // visitor landing on '/' watched it silently become '/home'.
    setLocation('/');
    const router = new PathRouter(vi.fn(), {
      basePath: '/',
      validPages: ['home'],
      entryPageId: 'home',
    });
    router.replace({ page: 'home' });
    expect(window.location.pathname).toBe('/');
  });

  test('without entryPageId the pre-0.9 behaviour is unchanged', () => {
    setLocation('/');
    const router = new PathRouter(vi.fn(), { basePath: '/', validPages: ['home'] });
    router.replace({ page: 'home' });
    expect(window.location.pathname).toBe('/home');
  });
});

describe('routerHrefFor — path mode agrees with PathRouter', () => {
  test('collapses the bare entry state', () => {
    const opt = { mode: 'path' as const, basePath: '/', entryPageId: 'home' };
    expect(routerHrefFor(opt, { page: 'home' })).toBe('/');
    expect(routerHrefFor(opt, { page: 'roster' })).toBe('/roster');
  });

  test('collapses on a carve-out basePath', () => {
    const opt = { mode: 'path' as const, basePath: BASE, entryPageId: 'home' };
    expect(routerHrefFor(opt, { page: 'home' })).toBe(BASE);
    expect(routerHrefFor(opt, { page: 'products' })).toBe(`${BASE}/products`);
  });

  test('entry page with extra state keeps its own url', () => {
    const opt = { mode: 'path' as const, basePath: '/', entryPageId: 'home' };
    expect(routerHrefFor(opt, { page: 'home', filter: 'live' })).toBe('/home?filter=live');
  });

  test('without entryPageId the entry page still gets its own url', () => {
    expect(routerHrefFor({ mode: 'path', basePath: '/' }, { page: 'home' })).toBe('/home');
  });

  test('href matches what PathRouter.push writes — the encoders cannot drift', () => {
    const opt = { mode: 'path' as const, basePath: BASE, entryPageId: 'home' };
    for (const state of [
      { page: 'home' },
      { page: 'products' },
      { page: 'product', productId: 'abc' },
      { page: 'home', filter: 'live' },
    ]) {
      setLocation('/somewhere/else');
      const router = new PathRouter(vi.fn(), {
        basePath: BASE,
        validPages: ['home', 'products', 'product'],
        entryPageId: 'home',
      });
      router.push(state);
      expect(window.location.pathname + window.location.search).toBe(routerHrefFor(opt, state));
    }
  });
});
