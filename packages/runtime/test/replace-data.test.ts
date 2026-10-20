/**
 * Tests for `replaceData` from `@airo-js/runtime/editor` — 0.11.2. An
 * editor shows a mounted widget against sample data (plus a transient
 * config overlay) without a remount, then gives the mount its own data
 * back. It reaches the mount through the versioned editor hook.
 *
 * Bands:
 *   1. Apply / restore — transformers over the given data, in-place
 *      render, event, no fetch, `null` restores without a refetch.
 *   2. Interplay with update() / updatePages() — hot-swaps keep the
 *      replacement, remounts re-apply it (and drop it if it no longer
 *      transforms), the overlay never leaks into the mount's config.
 *   3. Failure + ordering — rejections change nothing, the FIFO queue
 *      orders replaceData with the other dispatchers.
 *   4. Post-processors read what is on screen after an in-place swap —
 *      the stale-capture fix that ships with replaceData.
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type {
  CartridgeAppContext,
  Gate,
  PostProcessor,
  Template,
  Transformer,
} from '@airo-js/cartridge-kit';
import type { PageRenderer } from '@airo-js/core';

import { replaceData, type DataReplacedEvent } from '../src/editor.js';
import { EDITOR_HOOK } from '../src/editor-hook.js';
import { mountCartridge } from '../src/mount-cartridge.js';
import {
  blockingGate,
  fakeCartridge,
  fakeDataSource,
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

interface Painted {
  items: string[];
  config: TestConfig;
  page: string;
}

function paintingRenderer(painted: Painted[]): PageRenderer {
  return {
    render(_container, ctx) {
      const app = ctx.app as CartridgeAppContext<TestData, TestConfig>;
      painted.push({ items: app.data.items, config: app.config, page: ctx.navState.page });
    },
    destroy() {
      // no-op
    },
  };
}

function twoPageTemplate(): Template<TestConfig> {
  return {
    id: 'two',
    displayName: 'Two',
    description: 'Home and about.',
    pages: [
      { id: 'home', type: 'home', enabled: true },
      { id: 'about', type: 'about', enabled: true },
    ],
    defaultConfig: {},
  };
}

/** Records the config and page each run saw; tags every item so tests can tell a transformed snapshot from raw data. */
function taggingTransformer(
  seen: Array<{ items: string[]; config: TestConfig; page: string }>,
): Transformer<TestData, TestConfig> {
  return {
    name: 'tagging',
    isEnabled: () => true,
    transform: (data, ctx) => {
      seen.push({ items: data.items, config: ctx.config, page: ctx.navState.page });
      return { items: data.items.map((i) => `t:${i}`) };
    },
    errorPolicy: 'fail-render',
  };
}

interface Harness {
  painted: Painted[];
  transformed: Array<{ items: string[]; config: TestConfig; page: string }>;
  fetches: number;
  events: DataReplacedEvent[];
  remounts: number;
  errors: string[];
}

async function mount(
  overrides: {
    transformers?: Transformer<TestData, TestConfig>[];
    postProcessors?: PostProcessor<TestData, TestConfig>[];
    gates?: Gate<TestConfig>[];
    config?: TestConfig;
  } = {},
) {
  const h: Harness = { painted: [], transformed: [], fetches: 0, events: [], remounts: 0, errors: [] };
  const result = await mountCartridge<TestData, TestConfig>({
    cartridge: fakeCartridge({
      hotSwapKeys: ['display.showPrices'],
      transformers: overrides.transformers ?? [taggingTransformer(h.transformed)],
      postProcessors: overrides.postProcessors,
      gates: overrides.gates,
      dataSources: [
        fakeDataSource({
          fetch: async () => {
            h.fetches += 1;
            return { items: [`live-${h.fetches}`] };
          },
        }),
      ],
      views: [
        { id: 'home-view', displayName: 'Home', pageType: 'home', factory: () => paintingRenderer(h.painted) },
        { id: 'about-view', displayName: 'About', pageType: 'about', factory: () => paintingRenderer(h.painted) },
      ],
      templates: [twoPageTemplate()],
      defaultTemplateId: 'two',
    }),
    config: overrides.config ?? { feed: { url: 'https://feed.example/x.json' } },
    template: twoPageTemplate(),
    host,
    onShellReady: (shell) => {
      shell.events.on('mount:data-replaced', (p: unknown) => h.events.push(p as DataReplacedEvent));
      shell.events.on('mount:remounted', () => {
        h.remounts += 1;
      });
    },
    onError: (phase) => {
      h.errors.push(phase);
    },
  });
  if (result.blocked) throw new Error('expected unblocked mount');
  return { result, h };
}

const last = <T>(xs: T[]): T => xs[xs.length - 1]!;

// ---------------------------------------------------------------------------
// 1. Apply / restore
// ---------------------------------------------------------------------------

describe('replaceData — apply', () => {
  test('runs the transformers over the given data and re-renders in place, without a fetch', async () => {
    const { result, h } = await mount();
    expect(last(h.painted).items).toEqual(['t:live-1']);

    const out = await replaceData(result, { data: { items: ['sample'] } });

    expect(out?.mode).toBe('hot-swap');
    expect(last(h.painted).items).toEqual(['t:sample']);
    expect(h.fetches).toBe(1);
    expect(h.remounts).toBe(0);
  });

  test('transformers see the ACTIVE page, and navState is preserved', async () => {
    const { result, h } = await mount();
    result.app.navigate({ page: 'about' });

    const out = await replaceData(result, { data: { items: ['sample'] } });

    expect(last(h.transformed).page).toBe('about');
    expect(out?.navState.page).toBe('about');
    expect(result.app.getNavigationState().page).toBe('about');
    expect(last(h.painted).page).toBe('about');
  });

  test('the overlay reaches transformers and views, merged over the mount config', async () => {
    const { result, h } = await mount({
      config: { feed: { url: 'u' }, display: { showPrices: true } },
    });

    await replaceData(result, { data: { items: ['s'] }, config: { display: { categoryFilter: 'shoes' } } });

    const expected = { feed: { url: 'u' }, display: { showPrices: true, categoryFilter: 'shoes' } };
    expect(last(h.transformed).config).toEqual(expected);
    expect(last(h.painted).config).toEqual(expected);
  });

  test('emits mount:data-replaced { replaced: true } before the promise resolves', async () => {
    const { result, h } = await mount();
    const order: string[] = [];
    result.shell.events.on('mount:data-replaced', () => order.push('event'));

    await replaceData(result, { data: { items: ['s'] } }).then(() => order.push('resolved'));

    expect(order).toEqual(['event', 'resolved']);
    expect(h.events).toEqual([{ replaced: true, navState: result.app.getNavigationState() }]);
  });

  test('applying again replaces the previous replacement', async () => {
    const { result, h } = await mount();
    await replaceData(result, { data: { items: ['a'] }, config: { locale: 'fr-FR' } });
    await replaceData(result, { data: { items: ['b'] } });

    expect(last(h.painted).items).toEqual(['t:b']);
    // The second call carried no overlay, so the first one's is gone.
    expect(last(h.painted).config.locale).toBeUndefined();
  });
});

describe('replaceData — restore (null)', () => {
  test('puts back the mount’s own snapshot and drops the overlay, with no refetch', async () => {
    const { result, h } = await mount();
    await replaceData(result, { data: { items: ['s'] }, config: { locale: 'fr-FR' } });
    const transformRuns = h.transformed.length;

    await replaceData(result, null);

    expect(last(h.painted).items).toEqual(['t:live-1']);
    expect(last(h.painted).config.locale).toBeUndefined();
    expect(h.fetches).toBe(1);
    // The held own snapshot is post-Transformer already — nothing re-runs.
    expect(h.transformed.length).toBe(transformRuns);
    expect(last(h.events).replaced).toBe(false);
  });

  test('is a no-op when nothing is replaced — no render, no event', async () => {
    const { result, h } = await mount();
    const renders = h.painted.length;

    const out = await replaceData(result, null);

    expect(out?.mode).toBe('hot-swap');
    expect(h.painted.length).toBe(renders);
    expect(h.events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Interplay with update() / updatePages()
// ---------------------------------------------------------------------------

describe('replaceData — with update() / updatePages()', () => {
  test('a hot-swap keeps the replaced snapshot and re-applies the overlay over the new config', async () => {
    const { result, h } = await mount();
    await replaceData(result, { data: { items: ['s'] }, config: { locale: 'fr-FR' } });

    const out = await result.update({ display: { showPrices: true } });

    expect(out.mode).toBe('hot-swap');
    expect(last(h.painted).items).toEqual(['t:s']);
    expect(last(h.painted).config.locale).toBe('fr-FR');
    expect(last(h.painted).config.display?.showPrices).toBe(true);
  });

  test('the overlay never enters the mount config — a restore after a hot-swap keeps the update, not the overlay', async () => {
    const { result, h } = await mount();
    await replaceData(result, { data: { items: ['s'] }, config: { locale: 'fr-FR' } });
    await result.update({ display: { showPrices: true } });

    await replaceData(result, null);

    expect(last(h.painted).config.locale).toBeUndefined();
    expect(last(h.painted).config.display?.showPrices).toBe(true);
    expect(last(h.painted).items).toEqual(['t:live-1']);
  });

  test('a page hot-swap keeps the replacement', async () => {
    const { result, h } = await mount();
    await replaceData(result, { data: { items: ['s'] } });

    await result.updatePages([
      { id: 'home', type: 'home', enabled: true },
      { id: 'about', type: 'about', enabled: true, styles: { color: 'red' } },
    ] as never);

    expect(last(h.painted).items).toEqual(['t:s']);
  });

  test('a remount fetches under the real config, then re-applies the replacement over the new config', async () => {
    const { result, h } = await mount();
    await replaceData(result, { data: { items: ['s'] }, config: { locale: 'fr-FR' } });
    h.events.length = 0;

    const out = await result.update({ display: { categoryFilter: 'shoes' } });

    expect(out.mode).toBe('remount');
    expect(h.fetches).toBe(2);
    expect(last(h.painted).items).toEqual(['t:s']);
    expect(last(h.painted).config).toMatchObject({
      locale: 'fr-FR',
      display: { categoryFilter: 'shoes' },
    });
    // Re-applying does not change `replaced`, so no data-replaced event.
    expect(h.events).toEqual([]);
  });

  test('after a remount, a restore shows the snapshot that remount fetched — still no extra fetch', async () => {
    const { result, h } = await mount();
    await replaceData(result, { data: { items: ['s'] } });
    await result.update({ display: { categoryFilter: 'shoes' } });

    await replaceData(result, null);

    expect(last(h.painted).items).toEqual(['t:live-2']);
    expect(last(h.painted).config.display?.categoryFilter).toBe('shoes');
    expect(h.fetches).toBe(2);
  });

  test('gates and fetch never see the overlay on a remount', async () => {
    const gateConfigs: TestConfig[] = [];
    const recordingGate: Gate<TestConfig> = {
      id: 'recording',
      displayName: 'Recording',
      isEnabled: (config) => {
        gateConfigs.push(config);
        return true;
      },
      async precheck() {
        return 'allow';
      },
      async mount() {
        return 'allow';
      },
      destroy() {
        // no-op
      },
    };
    const { result } = await mount({ gates: [recordingGate] });
    await replaceData(result, { data: { items: ['s'] }, config: { locale: 'fr-FR' } });
    gateConfigs.length = 0;

    await result.update({ display: { categoryFilter: 'shoes' } });

    expect(gateConfigs.length).toBeGreaterThan(0);
    for (const c of gateConfigs) expect(c.locale).toBeUndefined();
  });

  test('a remount whose transformers throw on the replacement drops it, mounts live data and says so', async () => {
    const picky: Transformer<TestData, TestConfig> = {
      name: 'picky',
      isEnabled: () => true,
      transform: (data, ctx) => {
        if (ctx.config.display?.categoryFilter === 'shoes' && data.items.includes('s')) {
          throw new Error('sample does not fit the new config');
        }
        return data;
      },
      errorPolicy: 'fail-render',
    };
    const { result, h } = await mount({ transformers: [picky] });
    await replaceData(result, { data: { items: ['s'] } });
    h.events.length = 0;

    const out = await result.update({ display: { categoryFilter: 'shoes' } });

    expect(out.mode).toBe('remount');
    expect(last(h.painted).items).toEqual(['live-2']);
    expect(h.events).toEqual([{ replaced: false, navState: out.navState }]);
    // Nothing left to restore: a later null is a no-op.
    const renders = h.painted.length;
    await replaceData(result, null);
    expect(h.painted.length).toBe(renders);
  });
});

// ---------------------------------------------------------------------------
// 3. Failure + ordering
// ---------------------------------------------------------------------------

describe('replaceData — failures', () => {
  test('a transformer that throws on the data rejects, reports pipeline, and changes nothing', async () => {
    const strict: Transformer<TestData, TestConfig> = {
      name: 'strict',
      isEnabled: () => true,
      transform: (data) => {
        if (data.items.includes('bad')) throw new Error('bad sample');
        return data;
      },
      errorPolicy: 'fail-render',
    };
    const { result, h } = await mount({ transformers: [strict] });
    const renders = h.painted.length;

    await expect(replaceData(result, { data: { items: ['bad'] } })).rejects.toThrow('bad sample');

    expect(h.errors).toEqual(['pipeline']);
    expect(h.painted.length).toBe(renders);
    expect(h.events).toEqual([]);
    // Still not replaced: null stays a no-op.
    await replaceData(result, null);
    expect(h.painted.length).toBe(renders);
  });

  test('rejects after destroy()', async () => {
    const { result } = await mount();
    result.destroy();
    await expect(replaceData(result, { data: { items: ['s'] } })).rejects.toThrow(/mount was destroyed/);
  });

  test('rejects while a gate blocks the last remount', async () => {
    let block = false;
    const gate: Gate<TestConfig> = {
      ...blockingGate('late'),
      isEnabled: () => block,
    };
    const { result } = await mount({ gates: [gate] });
    block = true;
    await expect(result.update({ display: { categoryFilter: 'x' } })).rejects.toThrow(/blocked/);

    await expect(replaceData(result, { data: { items: ['s'] } })).rejects.toThrow(/gate blocked/);
  });
});

describe('replaceData — FIFO queue', () => {
  test('a replaceData queued behind a remount applies to the remounted App', async () => {
    const { result, h } = await mount();

    const remount = result.update({ display: { categoryFilter: 'shoes' } });
    const replace = replaceData(result, { data: { items: ['s'] } });
    await Promise.all([remount, replace]);

    expect(last(h.painted).items).toEqual(['t:s']);
    expect(last(h.painted).config.display?.categoryFilter).toBe('shoes');
  });

  test('an update queued behind a replaceData sees the replacement', async () => {
    const { result, h } = await mount();

    const replace = replaceData(result, { data: { items: ['s'] } });
    const hotSwap = result.update({ display: { showPrices: true } });
    await Promise.all([replace, hotSwap]);

    expect(last(h.painted).items).toEqual(['t:s']);
    expect(last(h.painted).config.display?.showPrices).toBe(true);
  });
});

describe('replaceData — the editor hook', () => {
  test('resolves null, applying nothing, for a mount whose runtime has no hook (older than 0.11.2)', async () => {
    const { result, h } = await mount();
    const renders = h.painted.length;
    const older = { ...result, app: result.app } as typeof result;
    delete (older as Partial<typeof result>)[EDITOR_HOOK];

    await expect(replaceData(older, { data: { items: ['s'] } })).resolves.toBeNull();
    expect(h.painted.length).toBe(renders);
  });

  test('resolves null for a gate-blocked mount', async () => {
    const blocked = await mountCartridge<TestData, TestConfig>({
      cartridge: fakeCartridge({ gates: [blockingGate()] }),
      config: {},
      template: fakeCartridge().templates[0]!,
      host,
      preloadedData: { items: ['x'] },
    });
    expect(blocked.blocked).toBe(true);
    await expect(replaceData(blocked, { data: { items: ['s'] } })).resolves.toBeNull();
  });

  test('the key is a registry symbol, so a separately bundled editor finds it', async () => {
    const { result } = await mount();
    expect(EDITOR_HOOK).toBe(Symbol.for('airo-js.runtime.editor.v1'));
    expect(result[Symbol.for('airo-js.runtime.editor.v1') as typeof EDITOR_HOOK]).toBeDefined();
  });

  test('the package barrel does not reach the editor entry', async () => {
    const barrel = await import('../src/index.js');
    expect(Object.keys(barrel)).not.toContain('replaceData');
  });
});

// ---------------------------------------------------------------------------
// 4. Post-processors read what is on screen
// ---------------------------------------------------------------------------

describe('post-processors after an in-place swap', () => {
  function capture(seen: Array<{ items: string[]; config: TestConfig }>): PostProcessor<TestData, TestConfig> {
    return {
      name: 'capture',
      isEnabled: () => true,
      apply(ctx) {
        seen.push({ items: ctx.data.items, config: ctx.config });
      },
    };
  }

  test('an update() hot-swap hands post-processors the new config, not the mount-time one', async () => {
    const seen: Array<{ items: string[]; config: TestConfig }> = [];
    const { result } = await mount({ postProcessors: [capture(seen)] });

    await result.update({ display: { showPrices: true } });

    expect(last(seen).config.display?.showPrices).toBe(true);
  });

  test('replaceData hands post-processors the replaced snapshot and overlay, and a restore hands back the own', async () => {
    const seen: Array<{ items: string[]; config: TestConfig }> = [];
    const { result } = await mount({ postProcessors: [capture(seen)] });

    await replaceData(result, { data: { items: ['s'] }, config: { locale: 'fr-FR' } });
    expect(last(seen)).toEqual({ items: ['t:s'], config: expect.objectContaining({ locale: 'fr-FR' }) });

    await replaceData(result, null);
    expect(last(seen).items).toEqual(['t:live-1']);
    expect(last(seen).config.locale).toBeUndefined();
  });

  test('after a remount that re-applied a replacement, post-processors read the replacement', async () => {
    const seen: Array<{ items: string[]; config: TestConfig }> = [];
    const { result } = await mount({ postProcessors: [capture(seen)] });
    await replaceData(result, { data: { items: ['s'] } });

    await result.update({ display: { categoryFilter: 'shoes' } });

    expect(last(seen).items).toEqual(['t:s']);
    expect(last(seen).config.display?.categoryFilter).toBe('shoes');
  });
});
