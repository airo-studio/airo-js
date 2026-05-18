/**
 * Tests for MountCartridgeResult.updatePages() — the live page-graph
 * dispatcher landed in 0.8.0. Coverage in three bands:
 *
 *   1. Helper-level — `pagesDiffIsCoveredByHotSwap` + `diffLeafPaths`
 *      classify per-page diffs against `cartridge.pageHotSwapKeys`.
 *   2. Dispatcher-level — mount a cartridge with rich template pages,
 *      call `updatePages(nextPages)` with different `pageHotSwapKeys`
 *      declarations + diff shapes, assert `mode` and side effects
 *      (transformer call count, navState preservation).
 *   3. End-to-end — `componentSettings` round-trips from
 *      `template.pages[].componentSettings` through `templateToAppConfig`
 *      to `ctx.page.componentSettings` reaching the renderer.
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { Cartridge, Transformer } from '@airo-js/cartridge-kit';
import type { Page, PageRenderer, RenderContext } from '@airo-js/core';

import {
  mountCartridge,
  pagesDiffIsCoveredByHotSwap,
  diffLeafPaths,
} from '../src/mount-cartridge.js';
import {
  fakeCartridge,
  fakeTemplate,
  type TestConfig,
  type TestData,
} from './fixtures.js';

let host: HTMLElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  host.remove();
});

// ---------------------------------------------------------------------------
// 1. Helpers — diffLeafPaths, pagesDiffIsCoveredByHotSwap
// ---------------------------------------------------------------------------

describe('diffLeafPaths', () => {
  test('returns empty for Object.is-equal references', () => {
    const a = { x: 1 };
    expect(diffLeafPaths(a, a)).toEqual([]);
  });

  test('returns empty for deep-equal but distinct objects', () => {
    expect(diffLeafPaths({ x: 1, y: { z: 2 } }, { x: 1, y: { z: 2 } })).toEqual([]);
  });

  test('returns the dot-path where a leaf differs', () => {
    expect(diffLeafPaths({ a: 1 }, { a: 2 })).toEqual(['a']);
    expect(diffLeafPaths({ a: { b: 1 } }, { a: { b: 9 } })).toEqual(['a.b']);
  });

  test('reports the array path itself, not indices, when arrays differ', () => {
    expect(diffLeafPaths({ tags: ['a'] }, { tags: ['b'] })).toEqual(['tags']);
  });

  test('reports an added key and a removed key on the side that has it', () => {
    expect(diffLeafPaths({ a: 1 }, { a: 1, b: 2 })).toEqual(['b']);
    expect(diffLeafPaths({ a: 1, b: 2 }, { a: 1 })).toEqual(['b']);
  });

  test('skipKeys excludes only top-level keys, never nested', () => {
    const cur = { id: 'home', componentSettings: { rating: { visible: true } } };
    const nxt = { id: 'home', componentSettings: { rating: { visible: false } } };
    const diff = diffLeafPaths(cur, nxt, '', new Set(['id']));
    expect(diff).toEqual(['componentSettings.rating.visible']);
  });
});

describe('pagesDiffIsCoveredByHotSwap', () => {
  function page(over: Partial<Page> = {}): Page {
    return {
      id: 'home',
      type: 'home',
      enabled: true,
      layout: { regionOrder: [], regions: {} },
      ...over,
    };
  }

  test('identical pages → covered (true)', () => {
    expect(pagesDiffIsCoveredByHotSwap([page()], [page()], [])).toBe(true);
  });

  test('page added → never covered (false), regardless of allowlist', () => {
    const cur = [page({ id: 'home' })];
    const nxt = [page({ id: 'home' }), page({ id: 'about' })];
    expect(pagesDiffIsCoveredByHotSwap(cur, nxt, ['componentSettings'])).toBe(false);
  });

  test('page removed → not covered', () => {
    const cur = [page({ id: 'home' }), page({ id: 'about' })];
    const nxt = [page({ id: 'home' })];
    expect(pagesDiffIsCoveredByHotSwap(cur, nxt, ['componentSettings'])).toBe(false);
  });

  test('page reorder → not covered', () => {
    const cur = [page({ id: 'a' }), page({ id: 'b' })];
    const nxt = [page({ id: 'b' }), page({ id: 'a' })];
    expect(pagesDiffIsCoveredByHotSwap(cur, nxt, ['componentSettings'])).toBe(false);
  });

  test('structural change (type / enabled / parent) → not covered', () => {
    expect(
      pagesDiffIsCoveredByHotSwap(
        [page({ enabled: true })],
        [page({ enabled: false })],
        ['componentSettings'],
      ),
    ).toBe(false);
    expect(
      pagesDiffIsCoveredByHotSwap(
        [page()],
        [page({ parent: 'main' })],
        ['componentSettings', 'parent'],
      ),
    ).toBe(false);
  });

  test('componentSettings change covered by allowlist → covered', () => {
    const cur = [page({ componentSettings: { r: { visible: true } } })];
    const nxt = [page({ componentSettings: { r: { visible: false } } })];
    expect(pagesDiffIsCoveredByHotSwap(cur, nxt, ['componentSettings'])).toBe(true);
  });

  test('componentSettings change NOT covered → not covered', () => {
    const cur = [page({ componentSettings: { r: { visible: true } } })];
    const nxt = [page({ componentSettings: { r: { visible: false } } })];
    expect(pagesDiffIsCoveredByHotSwap(cur, nxt, ['styles'])).toBe(false);
  });

  test('dot-path allowlist covers only the named subtree', () => {
    const cur = [
      page({
        componentSettings: {
          rating: { visible: true },
          breadcrumb: { visible: true },
        },
      }),
    ];
    const nxt = [
      page({
        componentSettings: {
          rating: { visible: false },
          breadcrumb: { visible: true },
        },
      }),
    ];
    expect(
      pagesDiffIsCoveredByHotSwap(cur, nxt, ['componentSettings.rating']),
    ).toBe(true);
    // A change OUTSIDE rating is no longer covered by the same dot-path key.
    const nxt2 = [
      page({
        componentSettings: {
          rating: { visible: true },
          breadcrumb: { visible: false },
        },
      }),
    ];
    expect(
      pagesDiffIsCoveredByHotSwap(cur, nxt2, ['componentSettings.rating']),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Dispatcher — mount → updatePages integration
// ---------------------------------------------------------------------------

function countingTransformer(seen: TestConfig[]): Transformer<TestData, TestConfig> {
  return {
    name: 'counting',
    isEnabled: () => true,
    transform: (data, ctx) => {
      seen.push(ctx.config);
      return data;
    },
    errorPolicy: 'fail-render',
  };
}

describe('updatePages() dispatcher', () => {
  test('no pageHotSwapKeys declared → any per-page change remounts', async () => {
    const runs: TestConfig[] = [];
    const result = await mountCartridge<TestData, TestConfig>({
      cartridge: fakeCartridge({ transformers: [countingTransformer(runs)] }),
      config: {},
      template: {
        ...fakeTemplate(),
        pages: [
          {
            id: 'home',
            type: 'home',
            enabled: true,
            componentSettings: { rating: { visible: true } },
          },
        ],
      },
      host,
      preloadedData: { items: [] },
    });
    if (result.blocked) throw new Error('expected unblocked');

    expect(runs).toHaveLength(1);

    const out = await result.updatePages([
      {
        id: 'home',
        type: 'home',
        enabled: true,
        componentSettings: { rating: { visible: false } },
      },
    ]);
    expect(out.mode).toBe('remount');
    expect(runs).toHaveLength(2);
  });

  test('pageHotSwapKeys covers componentSettings → hot-swap, no transformer re-run', async () => {
    const runs: TestConfig[] = [];
    const result = await mountCartridge<TestData, TestConfig>({
      cartridge: fakeCartridge({
        pageHotSwapKeys: ['componentSettings'],
        transformers: [countingTransformer(runs)],
      }),
      config: {},
      template: {
        ...fakeTemplate(),
        pages: [
          {
            id: 'home',
            type: 'home',
            enabled: true,
            componentSettings: { rating: { visible: true } },
          },
        ],
      },
      host,
      preloadedData: { items: [] },
    });
    if (result.blocked) throw new Error('expected unblocked');

    expect(runs).toHaveLength(1);

    const out = await result.updatePages([
      {
        id: 'home',
        type: 'home',
        enabled: true,
        componentSettings: { rating: { visible: false } },
      },
    ]);
    expect(out.mode).toBe('hot-swap');
    expect(runs).toHaveLength(1);
  });

  test('structural change always remounts, even with broad allowlist', async () => {
    const runs: TestConfig[] = [];
    const result = await mountCartridge<TestData, TestConfig>({
      cartridge: fakeCartridge({
        pageHotSwapKeys: ['componentSettings', 'styles', 'layout', 'props'],
        transformers: [countingTransformer(runs)],
      }),
      config: {},
      template: {
        ...fakeTemplate(),
        pages: [{ id: 'home', type: 'home', enabled: true }],
      },
      host,
      preloadedData: { items: [] },
    });
    if (result.blocked) throw new Error('expected unblocked');

    // Adding a page is structural — remount.
    const out = await result.updatePages([
      { id: 'home', type: 'home', enabled: true },
      { id: 'about', type: 'home', enabled: true },
    ]);
    expect(out.mode).toBe('remount');
    expect(runs).toHaveLength(2);
  });

  test('NavigationState is preserved across hot-swap', async () => {
    const result = await mountCartridge<TestData, TestConfig>({
      cartridge: fakeCartridge({ pageHotSwapKeys: ['componentSettings'] }),
      config: {},
      template: {
        ...fakeTemplate(),
        pages: [
          {
            id: 'home',
            type: 'home',
            enabled: true,
            componentSettings: { rating: { visible: true } },
          },
        ],
      },
      host,
      preloadedData: { items: [] },
    });
    if (result.blocked) throw new Error('expected unblocked');

    const before = result.app.getNavigationState();

    const out = await result.updatePages([
      {
        id: 'home',
        type: 'home',
        enabled: true,
        componentSettings: { rating: { visible: false } },
      },
    ]);
    expect(out.mode).toBe('hot-swap');
    expect(out.navState).toEqual(before);
    expect(result.app.getNavigationState()).toEqual(before);
  });

  test('NavigationState is preserved across remount', async () => {
    const result = await mountCartridge<TestData, TestConfig>({
      cartridge: fakeCartridge({ pageHotSwapKeys: [] }),
      config: {},
      template: {
        ...fakeTemplate(),
        pages: [{ id: 'home', type: 'home', enabled: true }],
      },
      host,
      preloadedData: { items: [] },
    });
    if (result.blocked) throw new Error('expected unblocked');

    const before = result.app.getNavigationState();

    const out = await result.updatePages([
      {
        id: 'home',
        type: 'home',
        enabled: true,
        componentSettings: { rating: { visible: false } },
      },
    ]);
    expect(out.mode).toBe('remount');
    expect(out.navState).toEqual(before);
    expect(result.app.getNavigationState()).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// 3. End-to-end — componentSettings reaches ctx.page
// ---------------------------------------------------------------------------

describe('componentSettings → ctx.page round-trip', () => {
  function capturingRenderer(captured: RenderContext[]): PageRenderer {
    return {
      render(_target, ctx) {
        captured.push(ctx);
      },
      destroy() {
        // no-op
      },
    };
  }

  function cartridgeWithCapture(
    captured: RenderContext[],
    over: Partial<Cartridge<TestData, TestConfig>> = {},
  ): Cartridge<TestData, TestConfig> {
    return fakeCartridge({
      views: [
        {
          id: 'home-view',
          displayName: 'Home',
          pageType: 'home',
          factory: () => capturingRenderer(captured),
        },
      ],
      ...over,
    });
  }

  test('initial mount: componentSettings on TemplatePage reaches ctx.page.componentSettings', async () => {
    const captured: RenderContext[] = [];
    await mountCartridge<TestData, TestConfig>({
      cartridge: cartridgeWithCapture(captured),
      config: {},
      template: {
        ...fakeTemplate(),
        pages: [
          {
            id: 'home',
            type: 'home',
            enabled: true,
            componentSettings: {
              productRating: { props: { showStars: false } },
              breadcrumb: { visible: false },
            },
          },
        ],
      },
      host,
      preloadedData: { items: [] },
    });

    expect(captured).toHaveLength(1);
    const ctx = captured[0]!;
    expect(ctx.page.componentSettings).toEqual({
      productRating: { props: { showStars: false } },
      breadcrumb: { visible: false },
    });
  });

  test('updatePages hot-swap rebuilds RenderContext with new componentSettings', async () => {
    const captured: RenderContext[] = [];
    const result = await mountCartridge<TestData, TestConfig>({
      cartridge: cartridgeWithCapture(captured, {
        pageHotSwapKeys: ['componentSettings'],
      }),
      config: {},
      template: {
        ...fakeTemplate(),
        pages: [
          {
            id: 'home',
            type: 'home',
            enabled: true,
            componentSettings: { productRating: { props: { showStars: true } } },
          },
        ],
      },
      host,
      preloadedData: { items: [] },
    });
    if (result.blocked) throw new Error('expected unblocked');

    expect(captured).toHaveLength(1);

    const out = await result.updatePages([
      {
        id: 'home',
        type: 'home',
        enabled: true,
        componentSettings: { productRating: { props: { showStars: false } } },
      },
    ]);
    expect(out.mode).toBe('hot-swap');
    expect(captured).toHaveLength(2);
    expect(
      (captured[1]!.page.componentSettings?.productRating?.props as {
        showStars: boolean;
      } | undefined)?.showStars,
    ).toBe(false);
  });

  test('ctx.pages also reflects the new graph after updatePages', async () => {
    const captured: RenderContext[] = [];
    const result = await mountCartridge<TestData, TestConfig>({
      cartridge: cartridgeWithCapture(captured, {
        pageHotSwapKeys: ['styles'],
      }),
      config: {},
      template: {
        ...fakeTemplate(),
        pages: [
          {
            id: 'home',
            type: 'home',
            enabled: true,
            styles: { padding: 16 },
          },
        ],
      },
      host,
      preloadedData: { items: [] },
    });
    if (result.blocked) throw new Error('expected unblocked');

    await result.updatePages([
      { id: 'home', type: 'home', enabled: true, styles: { padding: 32 } },
    ]);

    const latest = captured.at(-1)!;
    expect(latest.pages[0]?.styles).toEqual({ padding: 32 });
  });
});
