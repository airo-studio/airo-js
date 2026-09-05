/**
 * PostProcessor wiring (0.9.0).
 *
 * Until 0.9 `runPostProcessors` had zero call sites: `mountCartridge` built
 * the pipeline with `cartridge.postProcessors` and then only ever called
 * `runTransformers`. A cartridge that declared post-processors got silence —
 * no throw, no warn, no breadcrumb. Independently confirmed by a consumer
 * against the published 0.8.8 tarballs.
 *
 * The two guarantees these tests exist to pin:
 *
 *   1. PER RENDER, not per mount. A navigation swap or an appContext
 *      re-render destroys the subtree a hook decorated, so a mount-scoped
 *      hook silently stops applying the moment anyone navigates.
 *   2. TEARDOWN BEFORE THE NEXT APPLY, and before the DOM it owns is
 *      destroyed. The motivating case is an aria-live announcer: a
 *      re-render destroys and re-creates the live region, and a region
 *      that is destroyed and re-created with its content already inside
 *      announces nothing. Get the order backwards and that class of hook
 *      is unwritable.
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { Cartridge, PostProcessor, Template } from '@airo-js/cartridge-kit';
import type { PageRenderer } from '@airo-js/core';

import { mountCartridge } from '../src/mount-cartridge.js';
import { fakeCartridge, fakeDataSource } from './fixtures.js';
import type { TestConfig, TestData } from './fixtures.js';

let host: HTMLElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  host.remove();
});

/** Two-page template so navigation actually swaps renderers. */
function twoPageTemplate(): Template<TestConfig> {
  return {
    id: 'main',
    displayName: 'Main',
    description: 'Two-page template for render-cadence tests.',
    pages: [
      { id: 'home', type: 'home', enabled: true },
      { id: 'about', type: 'about', enabled: true },
    ],
    defaultConfig: {},
  };
}

function loggingRenderer(log: string[], label: string): PageRenderer {
  return {
    render() {
      log.push(`render:${label}`);
    },
    hydrate() {
      log.push(`hydrate:${label}`);
    },
    destroy() {
      log.push(`destroy:${label}`);
    },
  };
}

/** A post-processor that records apply/teardown into a shared log. */
function loggingPostProcessor(
  log: string[],
  name = 'pp',
  opts: { enabled?: boolean; throwOnApply?: boolean; throwOnTeardown?: boolean } = {},
): PostProcessor<TestData, TestConfig> {
  return {
    name,
    isEnabled: () => opts.enabled ?? true,
    apply() {
      log.push(`apply:${name}`);
      if (opts.throwOnApply) throw new Error(`${name} apply exploded`);
      return () => {
        log.push(`teardown:${name}`);
        if (opts.throwOnTeardown) throw new Error(`${name} teardown exploded`);
      };
    },
  };
}

function twoPageCartridge(
  log: string[],
  postProcessors: PostProcessor<TestData, TestConfig>[],
): Cartridge<TestData, TestConfig> {
  return fakeCartridge({
    postProcessors,
    dataSources: [fakeDataSource()],
    views: [
      {
        id: 'home-view',
        displayName: 'Home',
        pageType: 'home',
        factory: () => loggingRenderer(log, 'home'),
      },
      {
        id: 'about-view',
        displayName: 'About',
        pageType: 'about',
        factory: () => loggingRenderer(log, 'about'),
      },
    ],
    templates: [twoPageTemplate()],
  });
}

async function mount(
  log: string[],
  postProcessors: PostProcessor<TestData, TestConfig>[],
  extra: Record<string, unknown> = {},
) {
  const result = await mountCartridge<TestData, TestConfig>({
    cartridge: twoPageCartridge(log, postProcessors),
    config: {},
    template: twoPageTemplate(),
    host,
    preloadedData: { items: ['x'] },
    ...extra,
  });
  if (result.blocked) throw new Error('expected unblocked mount');
  return result;
}

describe('postProcessors — invocation', () => {
  test('runs after the initial render (the whole 0.8.8 bug)', async () => {
    const log: string[] = [];
    await mount(log, [loggingPostProcessor(log)]);
    expect(log).toContain('apply:pp');
  });

  test('applies AFTER the render it decorates, never before', async () => {
    const log: string[] = [];
    await mount(log, [loggingPostProcessor(log)]);
    expect(log.indexOf('render:home')).toBeLessThan(log.indexOf('apply:pp'));
  });

  test('a cartridge with no postProcessors wires nothing', async () => {
    const log: string[] = [];
    await mount(log, []);
    expect(log.filter((l) => l.startsWith('apply:'))).toHaveLength(0);
  });

  test('isEnabled(config) gates each processor independently', async () => {
    const log: string[] = [];
    await mount(log, [
      loggingPostProcessor(log, 'on', { enabled: true }),
      loggingPostProcessor(log, 'off', { enabled: false }),
    ]);
    expect(log).toContain('apply:on');
    expect(log).not.toContain('apply:off');
  });

  test('receives the live container plus post-transformer data and config', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const capture: PostProcessor<TestData, TestConfig> = {
      name: 'capture',
      isEnabled: () => true,
      apply(ctx) {
        seen.push({
          container: ctx.container,
          data: ctx.data,
          config: ctx.config,
          page: ctx.navState.page,
          hasEvents: typeof ctx.events?.emit === 'function',
        });
      },
    };
    await mountCartridge<TestData, TestConfig>({
      cartridge: twoPageCartridge([], [capture]),
      config: { locale: 'en-GB' },
      template: twoPageTemplate(),
      host,
      preloadedData: { items: ['from-preload'] },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.data).toEqual({ items: ['from-preload'] });
    expect((seen[0]!.config as TestConfig).locale).toBe('en-GB');
    expect(seen[0]!.page).toBe('home');
    expect(seen[0]!.hasEvents).toBe(true);
    // The container is the isolation root the renderer painted into, not
    // the caller's host element.
    expect(seen[0]!.container).toBeInstanceOf(HTMLElement);
  });
});

describe('postProcessors — per render, not per mount', () => {
  test('re-applies on navigation', async () => {
    const log: string[] = [];
    const result = await mount(log, [loggingPostProcessor(log)]);
    if (result.blocked) throw new Error('unreachable');

    log.length = 0;
    result.app.navigate({ page: 'about' });

    expect(log).toContain('apply:pp');
    expect(log.indexOf('render:about')).toBeLessThan(log.indexOf('apply:pp'));
  });

  test('teardown fires BEFORE the next apply', async () => {
    const log: string[] = [];
    const result = await mount(log, [loggingPostProcessor(log)]);
    if (result.blocked) throw new Error('unreachable');

    log.length = 0;
    result.app.navigate({ page: 'about' });

    expect(log.indexOf('teardown:pp')).toBeGreaterThanOrEqual(0);
    expect(log.indexOf('teardown:pp')).toBeLessThan(log.indexOf('apply:pp'));
  });

  test('teardown fires BEFORE the decorated renderer is destroyed', async () => {
    // The announcer case: a hook holding DOM must be able to see its own
    // nodes while unwinding.
    const log: string[] = [];
    const result = await mount(log, [loggingPostProcessor(log)]);
    if (result.blocked) throw new Error('unreachable');

    log.length = 0;
    result.app.navigate({ page: 'about' });

    expect(log.indexOf('teardown:pp')).toBeLessThan(log.indexOf('destroy:home'));
  });

  test('full navigation order is teardown → destroy → render → apply', async () => {
    const log: string[] = [];
    const result = await mount(log, [loggingPostProcessor(log)]);
    if (result.blocked) throw new Error('unreachable');

    log.length = 0;
    result.app.navigate({ page: 'about' });

    expect(log).toEqual(['teardown:pp', 'destroy:home', 'render:about', 'apply:pp']);
  });

  test('survives a config-delta remount via update()', async () => {
    const log: string[] = [];
    const result = await mount(log, [loggingPostProcessor(log)]);
    if (result.blocked) throw new Error('unreachable');

    log.length = 0;
    await result.update({ locale: 'fr-FR' });

    // Remount replays the whole pipeline, so the hook applies again
    // against the fresh snapshot rather than silently dropping out.
    expect(log).toContain('apply:pp');
    expect(log.indexOf('teardown:pp')).toBeLessThan(log.indexOf('apply:pp'));
  });

  test('runs on the hydrate path too', async () => {
    host.innerHTML = '<div>server rendered</div>';
    const log: string[] = [];
    await mount(log, [loggingPostProcessor(log)], { mode: 'hydrate', ssrHtml: '<p>hi</p>' });
    expect(log).toContain('hydrate:home');
    expect(log.indexOf('hydrate:home')).toBeLessThan(log.indexOf('apply:pp'));
  });
});

describe('postProcessors — teardown on destroy', () => {
  test('destroy() unwinds the active post-processors', async () => {
    const log: string[] = [];
    const result = await mount(log, [loggingPostProcessor(log)]);
    if (result.blocked) throw new Error('unreachable');

    log.length = 0;
    result.destroy();

    expect(log).toContain('teardown:pp');
  });

  test('teardown runs exactly once across destroy', async () => {
    const log: string[] = [];
    const result = await mount(log, [loggingPostProcessor(log)]);
    if (result.blocked) throw new Error('unreachable');

    log.length = 0;
    result.destroy();
    result.destroy();

    expect(log.filter((l) => l === 'teardown:pp')).toHaveLength(1);
  });

  test('teardowns unwind LIFO so destruction mirrors construction', async () => {
    const log: string[] = [];
    const result = await mount(log, [
      loggingPostProcessor(log, 'first'),
      loggingPostProcessor(log, 'second'),
    ]);
    if (result.blocked) throw new Error('unreachable');

    expect(log.indexOf('apply:first')).toBeLessThan(log.indexOf('apply:second'));

    log.length = 0;
    result.destroy();

    expect(log.filter((l) => l.startsWith('teardown:'))).toEqual([
      'teardown:second',
      'teardown:first',
    ]);
    // …and the whole unwind precedes the renderer teardown.
    expect(log.indexOf('teardown:first')).toBeLessThan(log.indexOf('destroy:home'));
  });
});

describe('postProcessors — isolation', () => {
  test('one throwing apply does not stop its siblings or the render', async () => {
    const log: string[] = [];
    const result = await mount(log, [
      loggingPostProcessor(log, 'boom', { throwOnApply: true }),
      loggingPostProcessor(log, 'fine'),
    ]);

    expect(log).toContain('apply:boom');
    expect(log).toContain('apply:fine');
    expect(result.blocked).toBe(false);
  });

  test('a throwing teardown does not abort the render that follows', async () => {
    const log: string[] = [];
    const result = await mount(log, [
      loggingPostProcessor(log, 'bad', { throwOnTeardown: true }),
    ]);
    if (result.blocked) throw new Error('unreachable');

    log.length = 0;
    expect(() => result.app.navigate({ page: 'about' })).not.toThrow();
    expect(log).toContain('render:about');
    expect(log).toContain('apply:bad');
  });

  test('a post-processor that returns no teardown is fine', async () => {
    const log: string[] = [];
    const result = await mount(log, [
      {
        name: 'void',
        isEnabled: () => true,
        apply() {
          log.push('apply:void');
        },
      },
    ]);
    if (result.blocked) throw new Error('unreachable');

    log.length = 0;
    expect(() => result.app.navigate({ page: 'about' })).not.toThrow();
    expect(log).toContain('apply:void');
  });
});
