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

import { PathRouter } from '@airo-js/core';

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
