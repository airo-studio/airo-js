/**
 * Tests for `@airo-js/core`'s nav-encoding primitives. Lives in
 * cartridge-kit's test folder because cartridge-kit already has a
 * vitest config (node env) and the encoding fns are pure — no DOM
 * required. core ships no test infrastructure yet; when it does these
 * tests move there.
 *
 * Covers: stateToFragment/fragmentToState round-trip, validPages gate,
 * decodeNavHint server-side surface, extractPathTail boundary + trailing
 * slash, decode-rejection cases (empty / malformed / unknown page).
 */

import { describe, expect, test } from 'vitest';

import {
  decodeNavHint,
  extractPathTail,
  fragmentToState,
  stateToFragment,
  type RouteState,
} from '@airo-js/core';

describe('stateToFragment / fragmentToState (round-trip)', () => {
  test('page only — encodes to bare page id', () => {
    const state: RouteState = { page: 'products' };
    expect(stateToFragment(state)).toBe('products');
  });

  test('page + context key — encodes as path segments', () => {
    const state: RouteState = { page: 'product', productId: 'abc-123' };
    expect(stateToFragment(state)).toBe('product/abc-123');
  });

  test('page + query params — encodes via URLSearchParams', () => {
    const state: RouteState = { page: 'products', filter: 'electronics', sort: 'price' };
    const fragment = stateToFragment(state);
    expect(fragment).toMatch(/^products\?/);
    expect(fragment).toContain('filter=electronics');
    expect(fragment).toContain('sort=price');
  });

  test('round-trip preserves state with validPages', () => {
    const state: RouteState = { page: 'product', productId: 'abc-123', filter: 'electronics' };
    const fragment = stateToFragment(state);
    const decoded = fragmentToState(fragment, { validPages: ['products', 'product', 'categories'] });
    expect(decoded).toEqual(state);
  });

  test('custom pathContextKey threads through encode + decode', () => {
    const state: RouteState = { page: 'menu', menuId: 'dinner' };
    const fragment = stateToFragment(state, { pathContextKey: 'menuId' });
    expect(fragment).toBe('menu/dinner');
    const decoded = fragmentToState(fragment, {
      pathContextKey: 'menuId',
      validPages: ['menu'],
    });
    expect(decoded).toEqual(state);
  });

  test('decode rejects unknown page when validPages is supplied', () => {
    const decoded = fragmentToState('admin', { validPages: ['products', 'categories'] });
    expect(decoded).toBeNull();
  });

  test('decode accepts any page when validPages is omitted', () => {
    const decoded = fragmentToState('admin');
    expect(decoded).toEqual({ page: 'admin' });
  });

  test('decode handles empty / malformed input', () => {
    expect(fragmentToState('')).toBeNull();
    expect(fragmentToState('?orphan=value')).toBeNull();
    expect(fragmentToState('/')).toBeNull();
  });

  test('URL-encoded context values round-trip correctly', () => {
    const state: RouteState = { page: 'product', productId: 'has spaces & symbols' };
    const fragment = stateToFragment(state);
    const decoded = fragmentToState(fragment, { validPages: ['product'] });
    expect(decoded?.productId).toBe('has spaces & symbols');
  });
});

describe('decodeNavHint (server-side surface)', () => {
  const validPages = ['categories', 'products', 'product'];

  test('returns null for empty / nullish input', () => {
    expect(decodeNavHint(null, validPages)).toBeNull();
    expect(decodeNavHint(undefined, validPages)).toBeNull();
    expect(decodeNavHint('', validPages)).toBeNull();
  });

  test('decodes a valid hint with validPages gate', () => {
    expect(decodeNavHint('product/abc', validPages)).toEqual({ page: 'product', productId: 'abc' });
  });

  test('rejects unknown page (fails closed)', () => {
    expect(decodeNavHint('admin/secret', validPages)).toBeNull();
  });

  test('decodes query params alongside the page', () => {
    const result = decodeNavHint('products?filter=electronics', validPages);
    expect(result).toEqual({ page: 'products', filter: 'electronics' });
  });
});

describe('extractPathTail (basePath boundary + trailing slash)', () => {
  const basePath = '/campaign/xyz';

  test('extracts tail from a deep path', () => {
    expect(extractPathTail('/campaign/xyz/products/abc', basePath)).toBe('products/abc');
  });

  test('returns null when pathname equals basePath exactly (no tail)', () => {
    expect(extractPathTail('/campaign/xyz', basePath)).toBeNull();
  });

  test('returns null when pathname is basePath plus trailing slash only', () => {
    expect(extractPathTail('/campaign/xyz/', basePath)).toBeNull();
  });

  test('boundary check — sibling basePath does NOT match', () => {
    // Naive startsWith would return 'abc/foo' here; the boundary check
    // requires '/' after basePath so adjacent widget ids don't collide.
    expect(extractPathTail('/campaign/xyzabc/foo', basePath)).toBeNull();
  });

  test('returns null when pathname is outside basePath entirely', () => {
    expect(extractPathTail('/other/path', basePath)).toBeNull();
    expect(extractPathTail('/', basePath)).toBeNull();
    expect(extractPathTail('', basePath)).toBeNull();
  });

  test('normalises trailing slashes on basePath', () => {
    // '/campaign/xyz/' as basePath behaves identically to '/campaign/xyz'.
    expect(extractPathTail('/campaign/xyz/products/abc', '/campaign/xyz/')).toBe('products/abc');
    expect(extractPathTail('/campaign/xyz', '/campaign/xyz/')).toBeNull();
  });

  test('handles deeply nested tails', () => {
    expect(extractPathTail('/campaign/xyz/product/abc?filter=foo', basePath))
      .toBe('product/abc?filter=foo');
  });
});
