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
  joinPathFragment,
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

describe('joinPathFragment', () => {
  // The single encoder behind BOTH PathRouter.stateToUrl and
  // routerHrefFor. It exists so those two cannot disagree about which url
  // a RouteState has — the disagreement that shipped an entry page on two
  // urls with a canonical pointing at the wrong one.

  test('joins a fragment onto a carve-out basePath', () => {
    expect(joinPathFragment('/campaign/xyz', 'product/abc')).toBe('/campaign/xyz/product/abc');
  });

  test('root mount emits real top-level urls', () => {
    expect(joinPathFragment('/', 'roster')).toBe('/roster');
    expect(joinPathFragment('', 'roster')).toBe('/roster');
  });

  test('an empty fragment yields the bare basePath', () => {
    expect(joinPathFragment('/campaign/xyz', '')).toBe('/campaign/xyz');
    expect(joinPathFragment('/', '')).toBe('/');
    expect(joinPathFragment('', '')).toBe('/');
  });

  test('normalises trailing slashes on basePath', () => {
    expect(joinPathFragment('/campaign/xyz/', 'products')).toBe('/campaign/xyz/products');
    expect(joinPathFragment('/campaign/xyz///', 'products')).toBe('/campaign/xyz/products');
  });

  test('collapses a bare entry fragment onto basePath', () => {
    expect(joinPathFragment('/', 'home', 'home')).toBe('/');
    expect(joinPathFragment('/campaign/xyz', 'home', 'home')).toBe('/campaign/xyz');
  });

  test('a non-entry fragment is never collapsed', () => {
    expect(joinPathFragment('/', 'roster', 'home')).toBe('/roster');
  });

  test('the entry page WITH extra state keeps its own url — round-trip safety', () => {
    // '/?filter=live' would decode to a null tail and lose the filter, so
    // only a fragment that IS exactly the page id may collapse.
    expect(joinPathFragment('/', 'home?filter=live', 'home')).toBe('/home?filter=live');
    expect(joinPathFragment('/', 'home/abc', 'home')).toBe('/home/abc');
  });

  test('omitting entryPageId preserves pre-0.9 behaviour', () => {
    expect(joinPathFragment('/', 'home')).toBe('/home');
  });

  test('a fragment that merely starts with the entry id is not collapsed', () => {
    expect(joinPathFragment('/', 'homepage', 'home')).toBe('/homepage');
  });
});

describe('decoder choice — the gate that silences the other gate', () => {
  // Two consumers wired a root-mounted 404 through `decodeNavHint` and got
  // a soft 404 back, because the allowlist rejects an unknown page BEFORE
  // the runner can report it. These pin both behaviours so the guidance in
  // best-practices §5.10a cannot silently stop being true. A consumer
  // asserts the same two facts in their own smoke suite.
  const pages = [
    { id: 'home', enabled: true },
    { id: 'roster', enabled: true },
    { id: 'draft', enabled: false },
    { id: 'artist', enabled: true, parent: 'roster' },
    { id: 'age-gate', enabled: true },
  ];
  // The derivation the docs show for the embed surface.
  const validPages = pages.filter((p) => p.enabled && !p.parent).map((p) => p.id);

  test('decodeNavHint FILTERS an unknown page — correct for embed, fatal for owned urls', () => {
    expect(decodeNavHint('does-not-exist', validPages)).toBeNull();
  });

  test('fragmentToState decodes without an allowlist, so the runner can gate', () => {
    expect(fragmentToState('does-not-exist')).toEqual({ page: 'does-not-exist' });
  });

  test('an allowlist hides three of the four rejection reasons from the runner', () => {
    // Only `gate-page` survives: it is enabled and not a subpage, so it
    // passes the allowlist and is rejected by the runner instead.
    expect(decodeNavHint('does-not-exist', validPages)).toBeNull(); // unknown-page
    expect(decodeNavHint('draft', validPages)).toBeNull(); // disabled
    expect(decodeNavHint('artist', validPages)).toBeNull(); // subpage
    expect(decodeNavHint('age-gate', validPages)).toEqual({ page: 'age-gate' }); // gate-page
  });

  test('fragmentToState surfaces all four to the runner', () => {
    for (const id of ['does-not-exist', 'draft', 'artist', 'age-gate']) {
      expect(fragmentToState(id)).toEqual({ page: id });
    }
  });

  test('both decoders agree on a legitimately valid page', () => {
    expect(decodeNavHint('roster', validPages)).toEqual(fragmentToState('roster'));
  });
});
