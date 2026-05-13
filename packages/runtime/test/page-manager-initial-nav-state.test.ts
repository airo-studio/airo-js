/**
 * v3 contract — client-side `initialNavState` plumbing.
 *
 * Two seams under test:
 *   1. `PageManager` seeds `navState` from `initialNavState` at
 *      construction so `mountInitial` reads the right page.
 *   2. `createApp` threads `initialNavState` through to `PageManager`
 *      and delegates entry resolution to `mountInitial` (not its own
 *      first-enabled-non-parent scan).
 *
 * These tests live in @airo-js/runtime because that's where happy-dom
 * is wired and the symmetric SSR coverage already lives. The contract
 * itself is in @airo-js/core; runtime is the natural consumer.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
  EventBus,
  PageManager,
  createApp,
  type AppConfig,
  type PageRenderer,
  type RenderContext,
} from '@airo-js/core';

type PageType = 'home' | 'product' | 'category' | 'gate' | 'modal';

interface RecordedCalls {
  rendered: Array<{ pageId: string; navState: Record<string, string | undefined> }>;
  hydrated: Array<{ pageId: string; navState: Record<string, string | undefined> }>;
  destroyed: number;
}

function recordingRenderer(records: RecordedCalls): PageRenderer<PageType> {
  return {
    render(_root, ctx: RenderContext<PageType>) {
      records.rendered.push({
        pageId: ctx.page.id,
        navState: { ...ctx.navState },
      });
    },
    hydrate(_root, ctx: RenderContext<PageType>) {
      records.hydrated.push({
        pageId: ctx.page.id,
        navState: { ...ctx.navState },
      });
    },
    destroy() {
      records.destroyed += 1;
    },
  };
}

function makeRecords(): RecordedCalls {
  return { rendered: [], hydrated: [], destroyed: 0 };
}

function makeConfig(): AppConfig<PageType> {
  return {
    pages: [
      { id: 'home', type: 'home', enabled: true },
      { id: 'category', type: 'category', enabled: true },
      { id: 'product', type: 'product', enabled: true },
      // Subpage variant of product (parent set) — should NOT be selectable
      // via initialNavState.page (subpage URLs not supported).
      { id: 'product-quick', type: 'modal', enabled: true, parent: 'product' },
    ],
  };
}

let host: HTMLElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});

describe('PageManager — initialNavState seeding', () => {
  test('constructor seeds navState with default entry id when no initialNavState provided', () => {
    const pm = new PageManager<PageType>({
      container: host,
      pages: makeConfig().pages,
      events: new EventBus(),
      appContext: undefined,
      resolveRenderer: () => () => recordingRenderer(makeRecords()),
    });
    expect(pm.getNavigationState()).toEqual({ page: 'home' });
  });

  test('constructor merges initialNavState OVER default entry seed (host-config wins)', () => {
    const pm = new PageManager<PageType>({
      container: host,
      pages: makeConfig().pages,
      events: new EventBus(),
      appContext: undefined,
      resolveRenderer: () => () => recordingRenderer(makeRecords()),
      initialNavState: { page: 'product', productId: 'abc' },
    });
    expect(pm.getNavigationState()).toEqual({
      page: 'product',
      productId: 'abc',
    });
  });

  test('constructor preserves context fields when initialNavState omits .page', () => {
    // Edge case: host passes only context (e.g. a filter pre-seed) and
    // wants the default entry. .page falls back to entry; context fields
    // ride along.
    const pm = new PageManager<PageType>({
      container: host,
      pages: makeConfig().pages,
      events: new EventBus(),
      appContext: undefined,
      resolveRenderer: () => () => recordingRenderer(makeRecords()),
      initialNavState: { category: 'Coffee' },
    });
    expect(pm.getNavigationState()).toEqual({
      page: 'home', // default entry
      category: 'Coffee',
    });
  });
});

describe('PageManager.mountInitial — entry resolution', () => {
  test('renders the page named by initialNavState.page when valid', () => {
    const records = makeRecords();
    const pm = new PageManager<PageType>({
      container: host,
      pages: makeConfig().pages,
      events: new EventBus(),
      appContext: undefined,
      resolveRenderer: () => () => recordingRenderer(records),
      initialNavState: { page: 'product', productId: 'abc' },
    });
    pm.mountInitial({ hydrate: false });
    expect(records.rendered).toHaveLength(1);
    expect(records.rendered[0].pageId).toBe('product');
    expect(records.rendered[0].navState).toEqual({
      page: 'product',
      productId: 'abc',
    });
  });

  test('hydrates the page named by initialNavState.page when valid', () => {
    const records = makeRecords();
    const pm = new PageManager<PageType>({
      container: host,
      pages: makeConfig().pages,
      events: new EventBus(),
      appContext: undefined,
      resolveRenderer: () => () => recordingRenderer(records),
      initialNavState: { page: 'category', category: 'Cereal' },
    });
    pm.mountInitial({ hydrate: true });
    expect(records.hydrated).toHaveLength(1);
    expect(records.rendered).toHaveLength(0);
    expect(records.hydrated[0].pageId).toBe('category');
    expect(records.hydrated[0].navState).toEqual({
      page: 'category',
      category: 'Cereal',
    });
  });

  test('falls back to default entry when initialNavState.page is unknown', () => {
    const records = makeRecords();
    const pm = new PageManager<PageType>({
      container: host,
      pages: makeConfig().pages,
      events: new EventBus(),
      appContext: undefined,
      resolveRenderer: () => () => recordingRenderer(records),
      initialNavState: { page: 'does-not-exist' as PageType },
    });
    pm.mountInitial({ hydrate: false });
    expect(records.rendered).toHaveLength(1);
    expect(records.rendered[0].pageId).toBe('home');
  });

  test('falls back to default entry when initialNavState.page targets a subpage (subpage URLs not supported)', () => {
    const records = makeRecords();
    const pm = new PageManager<PageType>({
      container: host,
      pages: makeConfig().pages,
      events: new EventBus(),
      appContext: undefined,
      resolveRenderer: () => () => recordingRenderer(records),
      initialNavState: { page: 'product-quick' }, // subpage with parent='product'
    });
    pm.mountInitial({ hydrate: false });
    expect(records.rendered).toHaveLength(1);
    expect(records.rendered[0].pageId).toBe('home');
  });

  test('falls back to default non-gate entry when initialNavState.page targets a gate page', () => {
    const records = makeRecords();
    const pages: AppConfig<PageType>['pages'] = [
      { id: 'gate', type: 'gate', enabled: true },
      { id: 'home', type: 'home', enabled: true },
      { id: 'product', type: 'product', enabled: true },
    ];
    const pm = new PageManager<PageType>({
      container: host,
      pages,
      events: new EventBus(),
      appContext: undefined,
      resolveRenderer: () => () => recordingRenderer(records),
      isGatePage: (type) => type === 'gate',
      initialNavState: { page: 'gate' },
    });
    pm.mountInitial({ hydrate: false });
    expect(records.rendered).toHaveLength(1);
    // Gate filtered; first non-gate non-parent is 'home'.
    expect(records.rendered[0].pageId).toBe('home');
  });

  test('emits navigation:changed exactly once on initial mount', () => {
    const events = new EventBus();
    const onChange = vi.fn();
    events.on('navigation:changed', onChange);
    const pm = new PageManager<PageType>({
      container: host,
      pages: makeConfig().pages,
      events,
      appContext: undefined,
      resolveRenderer: () => () => recordingRenderer(makeRecords()),
      initialNavState: { page: 'product', productId: 'abc' },
    });
    pm.mountInitial({ hydrate: false });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({
      page: 'product',
      productId: 'abc',
    });
  });
});

describe('createApp — initialNavState delegation', () => {
  test('createApp forwards initialNavState to PageManager and mounts the deeplinked page', () => {
    const records = makeRecords();
    const app = createApp<PageType>(makeConfig(), {
      host,
      appContext: undefined,
      resolveRenderer: () => () => recordingRenderer(records),
      initialNavState: { page: 'product', productId: 'abc', category: 'Cereal' },
    });
    expect(app.state).toBe('mounted');
    expect(records.rendered).toHaveLength(1);
    expect(records.rendered[0].pageId).toBe('product');
    expect(records.rendered[0].navState).toEqual({
      page: 'product',
      productId: 'abc',
      category: 'Cereal',
    });
    expect(app.getNavigationState()).toEqual({
      page: 'product',
      productId: 'abc',
      category: 'Cereal',
    });
    app.destroy();
  });

  test('createApp delegates entry pick to PageManager — no duplicate scan; gate-aware default entry', () => {
    // Pre-v3 bug: createApp's entry pick at app.ts:112 used
    // `pages.find(p.enabled && !p.parent)` without gate filtering, so
    // a gate-page-as-first-enabled would have been selected as entry.
    // v3 hands off to PageManager.mountInitial → resolveEntryPage,
    // which IS gate-aware. This test pins the new behaviour.
    const records = makeRecords();
    const app = createApp<PageType>(
      {
        pages: [
          { id: 'gate', type: 'gate', enabled: true },
          { id: 'home', type: 'home', enabled: true },
        ],
      },
      {
        host,
        appContext: undefined,
        resolveRenderer: () => () => recordingRenderer(records),
        isGatePage: (type) => type === 'gate',
      },
    );
    expect(app.state).toBe('mounted');
    // First non-gate non-parent — home, NOT gate.
    expect(records.rendered).toHaveLength(1);
    expect(records.rendered[0].pageId).toBe('home');
    app.destroy();
  });

  test('createApp with hydrate=true and initialNavState hydrates the deeplinked page', () => {
    const records = makeRecords();
    const app = createApp<PageType>(makeConfig(), {
      host,
      appContext: undefined,
      resolveRenderer: () => () => recordingRenderer(records),
      hydrate: true,
      initialNavState: { page: 'product', productId: 'abc' },
    });
    expect(records.hydrated).toHaveLength(1);
    expect(records.hydrated[0].pageId).toBe('product');
    expect(records.hydrated[0].navState).toEqual({
      page: 'product',
      productId: 'abc',
    });
    expect(records.rendered).toHaveLength(0);
    app.destroy();
  });

  test('createApp without initialNavState mounts the default entry (no router phantom)', () => {
    const records = makeRecords();
    const app = createApp<PageType>(makeConfig(), {
      host,
      appContext: undefined,
      resolveRenderer: () => () => recordingRenderer(records),
    });
    expect(records.rendered).toHaveLength(1);
    expect(records.rendered[0].pageId).toBe('home');
    expect(records.rendered[0].navState).toEqual({ page: 'home' });
    app.destroy();
  });
});
