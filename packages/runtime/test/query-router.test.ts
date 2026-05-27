/**
 * Tests for `@airo-js/core`'s QueryRouter + `routerHrefFor` helper +
 * `decodeNavParams` SSR helper. Lives in runtime's test folder because
 * runtime's vitest config provides the happy-dom env QueryRouter needs
 * (window.history, popstate, location.search mutation). Mirrors
 * `path-router.test.ts`'s shape.
 *
 * Discrete-param encoding (post pivot from single-blob):
 *   Each RouteState field maps to its own top-level URL param under a
 *   configurable prefix. The page selector lands at `<prefix>nav`.
 *
 *     navState { page: 'quickshop', category: 'whiskey' }
 *       → ?dtr_nav=quickshop&dtr_category=whiskey
 *
 * Coverage:
 *   - parseCurrent: prefix scan, page-slot decoding, validPages gate,
 *     non-prefixed params ignored
 *   - push / replace: discrete-param emission, host-page params
 *     preserved, stale prefixed slots cleared on push, idempotency
 *   - popstate: fires onNavigate with decoded state
 *   - routerHrefFor: emits the right URL shape across all RouterOption
 *     variants, including the new discrete-param query mode
 *   - decodeNavParams: SSR-side decoder (symmetric with client parse)
 *   - Special-character round-trip across all three modes
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  QueryRouter,
  decodeNavParams,
  routerHrefFor,
} from '@airo-js/core';
import type { RouterOption } from '@airo-js/core';

function setLocation(pathname: string, search = '', hash = ''): void {
  // happy-dom lets us mutate the URL surface via history.replaceState.
  const url = `${pathname}${search}${hash}`;
  window.history.replaceState(null, '', url);
}

let originalUrl: string;

beforeEach(() => {
  originalUrl = window.location.href;
  setLocation('/');
});

afterEach(() => {
  window.history.replaceState(null, '', originalUrl);
});

describe('QueryRouter — parseCurrent (discrete params)', () => {
  test('returns null when the configured paramPrefix has no `<prefix>nav` slot', () => {
    setLocation('/', '?utm_source=newsletter');
    const router = new QueryRouter(vi.fn(), { paramPrefix: 'dtr_' });
    expect(router.parseCurrent()).toBeNull();
  });

  test('decodes a single-field state from `<prefix>nav` only', () => {
    setLocation('/', '?dtr_nav=quickshop');
    const router = new QueryRouter(vi.fn(), {
      paramPrefix: 'dtr_',
      validPages: ['quickshop'],
    });
    expect(router.parseCurrent()).toEqual({ page: 'quickshop' });
  });

  test('decodes multiple discrete prefixed params into one RouteState', () => {
    setLocation(
      '/',
      '?dtr_nav=quickshop&dtr_category=Tennessee+Whiskey&dtr_retailer=walmart',
    );
    const router = new QueryRouter(vi.fn(), {
      paramPrefix: 'dtr_',
      validPages: ['quickshop'],
    });
    expect(router.parseCurrent()).toEqual({
      page: 'quickshop',
      category: 'Tennessee Whiskey',
      retailer: 'walmart',
    });
  });

  test('defaults paramPrefix to "airo_" when option omitted', () => {
    setLocation('/', '?airo_nav=home');
    const router = new QueryRouter(vi.fn(), { validPages: ['home'] });
    expect(router.parseCurrent()).toEqual({ page: 'home' });
  });

  test('validPages gate — unknown page id returns null', () => {
    setLocation('/', '?airo_nav=attacker-page');
    const router = new QueryRouter(vi.fn(), { validPages: ['home', 'quickshop'] });
    expect(router.parseCurrent()).toBeNull();
  });

  test('non-prefixed params on the URL are ignored (host-page coexistence)', () => {
    setLocation(
      '/',
      '?utm_source=newsletter&dtr_nav=home&ref=feed&dtr_locale=en',
    );
    const router = new QueryRouter(vi.fn(), {
      paramPrefix: 'dtr_',
      validPages: ['home'],
    });
    expect(router.parseCurrent()).toEqual({ page: 'home', locale: 'en' });
  });

  test('field-name preservation — productId stays productId, no case conversion', () => {
    setLocation('/', '?dtr_nav=product&dtr_productId=abc-123');
    const router = new QueryRouter(vi.fn(), {
      paramPrefix: 'dtr_',
      validPages: ['product'],
    });
    expect(router.parseCurrent()).toEqual({
      page: 'product',
      productId: 'abc-123',
    });
  });
});

describe('QueryRouter — push / replace', () => {
  test('push writes the state as discrete prefixed params', () => {
    setLocation('/');
    const router = new QueryRouter(vi.fn(), { paramPrefix: 'dtr_' });
    router.push({ page: 'quickshop', category: 'whiskey', retailer: 'walmart' });

    const params = new URLSearchParams(window.location.search);
    expect(params.get('dtr_nav')).toBe('quickshop');
    expect(params.get('dtr_category')).toBe('whiskey');
    expect(params.get('dtr_retailer')).toBe('walmart');
  });

  test('push preserves OTHER (non-prefixed) query params', () => {
    setLocation('/', '?utm_source=newsletter&ref=feed');
    const router = new QueryRouter(vi.fn(), { paramPrefix: 'dtr_' });
    router.push({ page: 'quickshop' });

    const params = new URLSearchParams(window.location.search);
    expect(params.get('utm_source')).toBe('newsletter');
    expect(params.get('ref')).toBe('feed');
    expect(params.get('dtr_nav')).toBe('quickshop');
  });

  test('push CLEARS stale prefixed slots from the prior state', () => {
    // Critical: a state transition that REMOVES a field (e.g. clearing a
    // filter) must drop its URL slot. Without explicit clear, the prior
    // filter would re-decode on reload.
    setLocation('/', '?dtr_nav=quickshop&dtr_category=whiskey&dtr_retailer=walmart');
    const router = new QueryRouter(vi.fn(), { paramPrefix: 'dtr_' });
    router.push({ page: 'quickshop' });  // dropped category + retailer

    const params = new URLSearchParams(window.location.search);
    expect(params.get('dtr_nav')).toBe('quickshop');
    expect(params.has('dtr_category')).toBe(false);
    expect(params.has('dtr_retailer')).toBe(false);
  });

  test('replace uses replaceState (no history entry)', () => {
    setLocation('/');
    const startLength = window.history.length;
    const router = new QueryRouter(vi.fn(), { paramPrefix: 'dtr_' });
    router.replace({ page: 'home' });
    expect(window.history.length).toBe(startLength);
    expect(new URLSearchParams(window.location.search).get('dtr_nav')).toBe('home');
  });

  test('push is idempotent — same state twice does NOT stack history entries', () => {
    setLocation('/');
    const router = new QueryRouter(vi.fn(), { paramPrefix: 'dtr_' });
    router.push({ page: 'home' });
    const lengthAfterFirst = window.history.length;
    router.push({ page: 'home' });
    expect(window.history.length).toBe(lengthAfterFirst);
  });
});

describe('QueryRouter — popstate handling', () => {
  test('popstate fires onNavigate with the decoded state', () => {
    const onNavigate = vi.fn();
    const router = new QueryRouter(onNavigate, {
      paramPrefix: 'dtr_',
      validPages: ['home', 'quickshop'],
    });
    router.start();

    setLocation('/', '?dtr_nav=quickshop&dtr_category=whiskey');
    window.dispatchEvent(new PopStateEvent('popstate'));

    expect(onNavigate).toHaveBeenCalledWith({
      page: 'quickshop',
      category: 'whiskey',
    });
    router.stop();
  });

  test('popstate with no `<prefix>nav` slot does NOT fire onNavigate', () => {
    const onNavigate = vi.fn();
    const router = new QueryRouter(onNavigate, { paramPrefix: 'dtr_' });
    router.start();

    setLocation('/', '?utm_source=newsletter');
    window.dispatchEvent(new PopStateEvent('popstate'));

    expect(onNavigate).not.toHaveBeenCalled();
    router.stop();
  });

  test('stop removes the popstate listener', () => {
    const onNavigate = vi.fn();
    const router = new QueryRouter(onNavigate, { paramPrefix: 'dtr_' });
    router.start();
    router.stop();

    setLocation('/', '?dtr_nav=home');
    window.dispatchEvent(new PopStateEvent('popstate'));

    expect(onNavigate).not.toHaveBeenCalled();
  });
});

describe('routerHrefFor — link emission across all RouterOption variants', () => {
  const state = { page: 'quickshop', category: 'whiskey' };

  test('false (no router) → "#" no-op anchor', () => {
    expect(routerHrefFor(false, state)).toBe('#');
  });

  test('true (back-compat alias for hash) → "#fragment"', () => {
    expect(routerHrefFor(true, state)).toBe('#quickshop?category=whiskey');
  });

  test("{ mode: 'hash' } → '#fragment' (single-blob, unchanged)", () => {
    const opt: RouterOption = { mode: 'hash' };
    expect(routerHrefFor(opt, state)).toBe('#quickshop?category=whiskey');
  });

  test("{ mode: 'path', basePath } → '/basePath/fragment' (single-blob, unchanged)", () => {
    const opt: RouterOption = { mode: 'path', basePath: '/campaign/xyz' };
    expect(routerHrefFor(opt, state)).toBe('/campaign/xyz/quickshop?category=whiskey');
  });

  test("{ mode: 'path', basePath } — strips trailing slash on basePath", () => {
    const opt: RouterOption = { mode: 'path', basePath: '/campaign/xyz/' };
    expect(routerHrefFor(opt, state)).toBe('/campaign/xyz/quickshop?category=whiskey');
  });

  test("{ mode: 'query' } defaults paramPrefix to 'airo_' and emits discrete params", () => {
    const opt: RouterOption = { mode: 'query' };
    expect(routerHrefFor(opt, state)).toBe('?airo_nav=quickshop&airo_category=whiskey');
  });

  test("{ mode: 'query', paramPrefix } honors the override", () => {
    const opt: RouterOption = { mode: 'query', paramPrefix: 'dtr_' };
    expect(routerHrefFor(opt, state)).toBe('?dtr_nav=quickshop&dtr_category=whiskey');
  });

  test("query mode — multi-field state emits multiple discrete params", () => {
    const opt: RouterOption = { mode: 'query', paramPrefix: 'dtr_' };
    const richState = {
      page: 'quickshop',
      productId: 'abc-123',
      category: 'whiskey',
      retailer: 'walmart',
    };
    const href = routerHrefFor(opt, richState);
    // URLSearchParams.toString() doesn't guarantee iteration order across
    // engines; assert by re-parsing rather than literal string match.
    expect(href.startsWith('?')).toBe(true);
    const params = new URLSearchParams(href.slice(1));
    expect(params.get('dtr_nav')).toBe('quickshop');
    expect(params.get('dtr_productId')).toBe('abc-123');
    expect(params.get('dtr_category')).toBe('whiskey');
    expect(params.get('dtr_retailer')).toBe('walmart');
  });

  test('hash + path modes still use pathContextKey override', () => {
    const stateWithMenu = { page: 'menu', menuId: 'dinner' };
    const hashOpt: RouterOption = { mode: 'hash', pathContextKey: 'menuId' };
    const pathOpt: RouterOption = {
      mode: 'path',
      basePath: '/c/xyz',
      pathContextKey: 'menuId',
    };
    expect(routerHrefFor(hashOpt, stateWithMenu)).toBe('#menu/dinner');
    expect(routerHrefFor(pathOpt, stateWithMenu)).toBe('/c/xyz/menu/dinner');
  });
});

describe('Special-character round-trip — all three router modes', () => {
  // Coverage for &, =, +, ?, /, %, space, multi-byte Unicode. Each
  // mode's encoder must round-trip cleanly with its decoder. Query mode
  // round-trips via discrete-param URLSearchParams encoding; hash + path
  // round-trip via the shared fragment encoding.

  const trickyState = {
    page: 'quickshop',
    productId: 'sku/AB&CD+EF',          // reserved chars
    category: 'Tom & Jerry',             // & and space
    filter: 'price=high+ABV',            // literal = and +
    locale: '日本語',                     // multi-byte Unicode
    note: 'is this?',                    // literal ?
  };

  test('query-mode: routerHrefFor → setLocation → parseCurrent yields original', () => {
    const opt: RouterOption = { mode: 'query', paramPrefix: 'dtr_' };
    const href = routerHrefFor(opt, trickyState);
    setLocation('/', href);

    const router = new QueryRouter(vi.fn(), {
      paramPrefix: 'dtr_',
      validPages: ['quickshop'],
    });
    expect(router.parseCurrent()).toEqual(trickyState);
  });

  test('query-mode: QueryRouter.push → parseCurrent yields original (push path)', () => {
    setLocation('/');
    const router = new QueryRouter(vi.fn(), {
      paramPrefix: 'dtr_',
      validPages: ['quickshop'],
    });
    router.push(trickyState);
    expect(router.parseCurrent()).toEqual(trickyState);
  });

  test('hash-mode round-trip survives tricky chars', async () => {
    const { HashRouter } = await import('@airo-js/core');
    const opt: RouterOption = { mode: 'hash' };
    const href = routerHrefFor(opt, trickyState);
    setLocation('/', '', href);

    const router = new HashRouter(vi.fn(), { validPages: ['quickshop'] });
    expect(router.parseCurrent()).toEqual(trickyState);
  });

  test('path-mode round-trip survives tricky chars', async () => {
    const { PathRouter } = await import('@airo-js/core');
    const opt: RouterOption = { mode: 'path', basePath: '/c/xyz' };
    const href = routerHrefFor(opt, trickyState);
    const u = new URL('http://example.com' + href);
    setLocation(u.pathname, u.search);

    const router = new PathRouter(vi.fn(), {
      basePath: '/c/xyz',
      validPages: ['quickshop'],
    });
    expect(router.parseCurrent()).toEqual(trickyState);
  });

  test('query-mode encoding alignment: routerHrefFor and QueryRouter.push produce IDENTICAL URL strings', () => {
    // Anchor click (browser updates URL via href) and programmatic push
    // of the same state must produce the same URL string. Otherwise
    // the idempotency check (`currentUrl() !== url`) fires false-
    // positive and a redundant history entry stacks.
    const opt: RouterOption = { mode: 'query', paramPrefix: 'dtr_' };
    setLocation('/');

    const router = new QueryRouter(vi.fn(), { paramPrefix: 'dtr_' });
    router.push(trickyState);
    const urlFromPush = window.location.pathname + window.location.search + window.location.hash;

    const hrefFromHelper = routerHrefFor(opt, trickyState);
    const expectedUrl = window.location.pathname + hrefFromHelper;

    expect(urlFromPush).toBe(expectedUrl);
  });

  test('host-page params with special chars survive a QueryRouter.push', () => {
    setLocation(
      '/',
      '?utm_source=' + encodeURIComponent('Google & News') + '&ref=feed%2Bdaily',
    );
    const router = new QueryRouter(vi.fn(), { paramPrefix: 'dtr_' });
    router.push({ page: 'quickshop' });

    const params = new URLSearchParams(window.location.search);
    expect(params.get('utm_source')).toBe('Google & News');
    expect(params.get('ref')).toBe('feed+daily');
    expect(params.get('dtr_nav')).toBe('quickshop');
  });
});

describe('decodeNavParams — SSR-side decoder', () => {
  // Symmetric with QueryRouter.parseCurrent on the client. The same
  // (searchParams, paramPrefix, validPages) triplet yields the same
  // RouteState on both sides of the SSR-then-hydrate boundary.

  test('decodes a multi-field state from URLSearchParams', () => {
    const params = new URLSearchParams(
      '?dtr_nav=quickshop&dtr_category=whiskey&dtr_retailer=walmart',
    );
    const result = decodeNavParams(params, {
      paramPrefix: 'dtr_',
      validPages: ['quickshop'],
    });
    expect(result).toEqual({
      page: 'quickshop',
      category: 'whiskey',
      retailer: 'walmart',
    });
  });

  test('defaults paramPrefix to "airo_"', () => {
    const params = new URLSearchParams('?airo_nav=home');
    const result = decodeNavParams(params, { validPages: ['home'] });
    expect(result).toEqual({ page: 'home' });
  });

  test('returns null when no `<prefix>nav` slot is present', () => {
    const params = new URLSearchParams('?utm_source=newsletter');
    const result = decodeNavParams(params, {
      paramPrefix: 'dtr_',
      validPages: ['home'],
    });
    expect(result).toBeNull();
  });

  test('validPages gate — unknown page id returns null (tampering protection)', () => {
    const params = new URLSearchParams('?dtr_nav=attacker-page');
    const result = decodeNavParams(params, {
      paramPrefix: 'dtr_',
      validPages: ['home', 'quickshop'],
    });
    expect(result).toBeNull();
  });

  test('non-prefixed params on the URL are ignored', () => {
    const params = new URLSearchParams(
      '?utm_source=newsletter&dtr_nav=home&dtr_locale=en&ref=feed',
    );
    const result = decodeNavParams(params, {
      paramPrefix: 'dtr_',
      validPages: ['home'],
    });
    expect(result).toEqual({ page: 'home', locale: 'en' });
  });

  test('symmetric with QueryRouter.parseCurrent (same inputs, same output)', () => {
    setLocation('/', '?dtr_nav=quickshop&dtr_category=whiskey');
    const router = new QueryRouter(vi.fn(), {
      paramPrefix: 'dtr_',
      validPages: ['quickshop'],
    });
    const clientResult = router.parseCurrent();

    const serverParams = new URLSearchParams(window.location.search);
    const serverResult = decodeNavParams(serverParams, {
      paramPrefix: 'dtr_',
      validPages: ['quickshop'],
    });

    expect(clientResult).toEqual(serverResult);
  });
});
