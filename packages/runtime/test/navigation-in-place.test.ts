/**
 * Navigation in place, Back/Forward as a whole state, and navigations a
 * renderer requests from inside its own render (`@airo-js/core` 0.11.1).
 *
 *   - `PageRenderer.applyNavState`: a same-page context change the renderer
 *     applies itself, so it is not destroyed and rendered again. Asked for
 *     so a carousel can put its selection in the shareable URL without
 *     losing its transition, its focus, or announcing the selection twice.
 *   - `navigate(state, { history: 'replace' })`.
 *   - A router event replaces the state instead of merging into it.
 *   - A hash-mode `push` fires `navigation:changed` once, not twice.
 *   - `ctx.navigate` called during `render` / `hydrate` / `applyNavState` is
 *     applied after the call returns, bounded, instead of recursing.
 *
 * Lives in @airo-js/runtime because that is where happy-dom is wired.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  EventBus,
  PageManager,
  createApp,
  type NavigationState,
  type Page,
  type PageRenderer,
  type PageManagerOptions,
  type RenderContext,
  type RouterOption,
} from '@airo-js/core';
import { defineHydrateOnlyRenderer, defineSSRSafeRenderer } from '@airo-js/cartridge-kit';
import type { AiroEvent } from '@airo-js/log';
import { resetLogLevels, resetSink, setLogLevel, setSink } from '@airo-js/log';

type PageType = 'home' | 'product' | 'list' | 'quickview';

const PAGES: Page<PageType>[] = [
  { id: 'home', type: 'home', enabled: true } as Page<PageType>,
  { id: 'product', type: 'product', enabled: true } as Page<PageType>,
  { id: 'list', type: 'list', enabled: true } as Page<PageType>,
];

const originalUrl = window.location.href;
let logs: AiroEvent[];

beforeEach(() => {
  window.history.replaceState(null, '', '/shop');
  logs = [];
  setSink({ emit: (e) => logs.push(e) });
  setLogLevel('warn');
});

afterEach(() => {
  window.history.replaceState(null, '', originalUrl);
  resetSink();
  resetLogLevels();
});

/** Everything the renderers and the bus did, in order. */
interface Journal {
  calls: string[];
  /** `navigation:changed` payloads. */
  changes: NavigationState[];
  /** The ctx each render was handed, latest last. */
  ctxs: RenderContext<PageType>[];
}

type ApplyImpl = (
  next: NavigationState,
  previous: NavigationState,
  ctx: RenderContext<PageType>,
) => boolean;

interface RendererBehaviour {
  /** Present: the renderer implements `applyNavState` with this body. */
  apply?: ApplyImpl;
  /** Called inside `render` (and `hydrate`), after it is journalled. */
  onRender?: (ctx: RenderContext<PageType>) => void;
  /** Present: the renderer implements `activateSubpage` with this body. */
  activate?: (ctx: RenderContext<PageType>) => void;
}

function rendererFor(
  journal: Journal,
  pageId: string,
  behaviour: RendererBehaviour = {},
): PageRenderer<PageType> {
  let ctx: RenderContext<PageType> | undefined;
  const paint = (verb: string) => (_el: HTMLElement, c: RenderContext<PageType>) => {
    ctx = c;
    journal.ctxs.push(c);
    journal.calls.push(`${verb}:${pageId}:${c.navState.item ?? '-'}`);
    behaviour.onRender?.(c);
  };
  const renderer: PageRenderer<PageType> = {
    render: paint('render'),
    hydrate: paint('hydrate'),
    destroy() {
      journal.calls.push(`destroy:${pageId}`);
    },
  };
  if (behaviour.activate) {
    const activate = behaviour.activate;
    renderer.activateSubpage = (sub) => {
      journal.calls.push(`activate:${pageId}:${sub.id}`);
      activate(ctx as RenderContext<PageType>);
    };
  }
  if (behaviour.apply) {
    const apply = behaviour.apply;
    renderer.applyNavState = (next, previous) => {
      journal.calls.push(`apply:${pageId}:${previous.item ?? '-'}->${next.item ?? '-'}`);
      return apply(next, previous, ctx as RenderContext<PageType>);
    };
  }
  return renderer;
}

function setup(
  opts: {
    router?: RouterOption;
    behaviour?: Partial<Record<PageType, RendererBehaviour>>;
    initialNavState?: Partial<NavigationState>;
    navDefaults?: Record<string, string>;
    postRender?: PageManagerOptions<PageType>['postRender'];
    pages?: Page<PageType>[];
    /** Page types whose chunk has not loaded: the resolver returns nothing for them. */
    missing?: Set<PageType>;
  } = {},
) {
  const journal: Journal = { calls: [], changes: [], ctxs: [] };
  const events = new EventBus();
  events.on('navigation:changed', (s: unknown) => {
    journal.changes.push({ ...(s as NavigationState) });
  });
  const container = document.createElement('div');
  const pm = new PageManager<PageType>({
    container,
    pages: opts.pages ?? PAGES,
    events,
    appContext: {},
    resolveRenderer: (type) =>
      opts.missing?.has(type) ? undefined : () => rendererFor(journal, type, opts.behaviour?.[type]),
    enableRouter: opts.router ?? false,
    initialNavState: opts.initialNavState,
    navDefaults: opts.navDefaults,
    postRender: opts.postRender,
  });
  live.push(pm);
  return { pm, journal, events };
}

// Every PageManager a test made, destroyed after it: a live router from an
// earlier test would answer the next test's popstate and rewrite the URL.
const live: PageManager<PageType>[] = [];
afterEach(() => {
  for (const pm of live.splice(0)) pm.destroy();
});

/** Navigate the browser to `url` and tell the router, as Back/Forward does. */
function popTo(url: string): void {
  window.history.replaceState(null, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

const takesItem: ApplyImpl = () => true;

describe('applyNavState — a same-page context change applied in place', () => {
  test('returning true keeps the renderer: no destroy, no render, state and event as usual', () => {
    const { pm, journal } = setup({ behaviour: { product: { apply: takesItem } } });
    pm.navigate({ page: 'product', item: 'a' });
    journal.calls.length = 0;
    journal.changes.length = 0;

    pm.navigate({ item: 'b' });

    expect(journal.calls).toEqual(['apply:product:a->b']);
    expect(pm.getNavigationState()).toEqual({ page: 'product', item: 'b' });
    expect(journal.changes).toEqual([{ page: 'product', item: 'b' }]);
  });

  test('ctx.navState is the previous state during the call and the new one after', () => {
    let seenDuring: string | undefined;
    const { pm, journal } = setup({
      behaviour: {
        product: {
          apply: (_next, _prev, ctx) => {
            seenDuring = ctx.navState.item;
            return true;
          },
        },
      },
    });
    pm.navigate({ page: 'product', item: 'a' });
    pm.navigate({ item: 'b' });

    expect(seenDuring).toBe('a');
    expect(journal.ctxs).toHaveLength(1);
    expect(journal.ctxs[0]?.navState).toEqual({ page: 'product', item: 'b' });
  });

  test('next and previous are copies: changing them does not change navigation state', () => {
    const { pm } = setup({
      behaviour: {
        product: {
          apply: (next, previous) => {
            next.item = 'tampered';
            previous.item = 'tampered';
            return true;
          },
        },
      },
    });
    pm.navigate({ page: 'product', item: 'a' });
    pm.navigate({ item: 'b' });
    expect(pm.getNavigationState()).toEqual({ page: 'product', item: 'b' });
  });

  test('returning false re-renders the page exactly as a renderer without the method', () => {
    const { pm, journal } = setup({ behaviour: { product: { apply: () => false } } });
    pm.navigate({ page: 'product', item: 'a' });
    journal.calls.length = 0;

    pm.navigate({ item: 'b' });

    expect(journal.calls).toEqual(['apply:product:a->b', 'destroy:product', 'render:product:b']);
  });

  test('a renderer may take some keys and decline the rest', () => {
    const { pm, journal } = setup({
      behaviour: {
        product: { apply: (next, prev) => next.sort === prev.sort },
      },
    });
    pm.navigate({ page: 'product', item: 'a', sort: 'price' });
    journal.calls.length = 0;

    pm.navigate({ item: 'b' });
    pm.navigate({ sort: 'name' });

    expect(journal.calls).toEqual([
      'apply:product:a->b',
      'apply:product:b->b',
      'destroy:product',
      'render:product:b',
    ]);
  });

  test('a throwing applyNavState is logged and the page is rendered again', () => {
    const { pm, journal } = setup({
      behaviour: {
        product: {
          apply: () => {
            throw new Error('boom');
          },
        },
      },
    });
    pm.navigate({ page: 'product', item: 'a' });
    journal.calls.length = 0;

    pm.navigate({ item: 'b' });

    expect(journal.calls).toEqual(['apply:product:a->b', 'destroy:product', 'render:product:b']);
    expect(pm.getNavigationState()).toEqual({ page: 'product', item: 'b' });
    expect(logs.some((e) => e.level === 'error' && e.msg.includes('applyNavState threw'))).toBe(true);
  });

  test('a non-boolean truthy return is not "applied": only true is', () => {
    const { pm, journal } = setup({
      behaviour: { product: { apply: (() => 'yes') as unknown as ApplyImpl } },
    });
    pm.navigate({ page: 'product', item: 'a' });
    journal.calls.length = 0;
    pm.navigate({ item: 'b' });
    expect(journal.calls).toContain('render:product:b');
  });

  test('a page change never asks the renderer: the new page renders', () => {
    const { pm, journal } = setup({ behaviour: { product: { apply: takesItem } } });
    pm.navigate({ page: 'product', item: 'a' });
    journal.calls.length = 0;

    pm.navigate({ page: 'list' });

    expect(journal.calls).toEqual(['destroy:product', 'render:list:a']);
  });

  test('an unchanged context asks nothing', () => {
    const { pm, journal } = setup({ behaviour: { product: { apply: takesItem } } });
    pm.navigate({ page: 'product', item: 'a' });
    journal.calls.length = 0;
    pm.navigate({ item: 'a' });
    expect(journal.calls).toEqual([]);
  });

  test('no postRender run after an in-place apply; the last render keeps its effects', () => {
    const effects: string[] = [];
    const { pm } = setup({
      behaviour: { product: { apply: takesItem } },
      postRender: ({ navState }) => {
        effects.push(`apply:${navState.item}`);
        return () => effects.push(`teardown:${navState.item}`);
      },
    });
    pm.navigate({ page: 'product', item: 'a' });
    pm.navigate({ item: 'b' });
    expect(effects).toEqual(['apply:a']);
  });

  test('a same-page re-render unwinds post-render effects before it destroys the renderer', () => {
    const order: string[] = [];
    const journal: Journal = { calls: [], changes: [], ctxs: [] };
    const pm = new PageManager<PageType>({
      container: document.createElement('div'),
      pages: PAGES,
      events: new EventBus(),
      appContext: {},
      resolveRenderer: (type) => () => ({
        ...rendererFor(journal, type),
        destroy: () => order.push(`destroy:${type}`),
      }),
      postRender: () => () => order.push('teardown'),
    });
    pm.navigate({ page: 'product', item: 'a' });
    pm.navigate({ item: 'b' });
    expect(order).toEqual(['teardown', 'destroy:product']);
  });
});

describe('navigate options — history', () => {
  test("query mode: 'replace' rewrites the current entry, the default pushes one", () => {
    const { pm } = setup({ router: { mode: 'query', paramPrefix: 'w_' } });
    pm.navigate({ page: 'product', item: 'a' });
    const before = window.history.length;

    pm.navigate({ item: 'b' }, { history: 'replace' });
    expect(window.history.length).toBe(before);
    expect(window.location.search).toBe('?w_nav=product&w_item=b');

    pm.navigate({ item: 'c' });
    expect(window.history.length).toBe(before + 1);
    expect(window.location.search).toBe('?w_nav=product&w_item=c');
  });

  test("hash mode: 'replace' writes the hash without a history entry", () => {
    // happy-dom does not count hash assignments in `history.length`, so
    // watch the write: `replace` goes through `history.replaceState`, a
    // push assigns `location.hash`.
    const { pm } = setup({ router: { mode: 'hash' } });
    pm.navigate({ page: 'product', item: 'a' });
    const replaceState = vi.spyOn(window.history, 'replaceState');
    try {
      pm.navigate({ item: 'b' }, { history: 'replace' });
      expect(replaceState).toHaveBeenCalledTimes(1);
      expect(String(replaceState.mock.calls[0]?.[2])).toMatch(/#product\?item=b$/);
      expect(window.location.hash).toBe('#product?item=b');

      pm.navigate({ item: 'c' });
      expect(replaceState).toHaveBeenCalledTimes(1);
      expect(window.location.hash).toBe('#product?item=c');
    } finally {
      replaceState.mockRestore();
    }
  });

  test('createApp forwards the options to PageManager', () => {
    const journal: Journal = { calls: [], changes: [], ctxs: [] };
    const app = createApp<PageType>(
      { pages: PAGES } as never,
      {
        container: document.createElement('div'),
        resolveRenderer: (type: PageType) => () => rendererFor(journal, type),
        enableRouter: { mode: 'query', paramPrefix: 'w_' },
      } as never,
    );
    app.navigate({ page: 'product', item: 'a' });
    const before = window.history.length;
    app.navigate({ item: 'b' }, { history: 'replace' });
    expect(window.history.length).toBe(before);
    expect(window.location.search).toBe('?w_nav=product&w_item=b');
    app.destroy();
  });

  test('ctx.navigate forwards the options too', () => {
    const { pm, journal } = setup({
      router: { mode: 'query', paramPrefix: 'w_' },
      behaviour: { product: { apply: takesItem } },
    });
    pm.navigate({ page: 'product', item: 'a' });
    const before = window.history.length;
    journal.ctxs[0]?.navigate({ item: 'b' }, { history: 'replace' });
    expect(window.history.length).toBe(before);
    expect(window.location.search).toBe('?w_nav=product&w_item=b');
  });
});

describe('the router path — a history entry replaces the state', () => {
  test('Back to an entry that does not name a key drops that key', () => {
    const { pm, journal } = setup({ router: { mode: 'query', paramPrefix: 'w_' } });
    pm.navigate({ page: 'product', section: 'global' });
    pm.navigate({ section: 'labels', item: 'x' });
    journal.calls.length = 0;

    popTo('/shop?w_nav=product&w_section=global');

    expect(pm.getNavigationState()).toEqual({ page: 'product', section: 'global' });
    expect(journal.calls).toEqual(['destroy:product', 'render:product:-']);
  });

  test('Back is delivered to applyNavState, with the whole entry as next', () => {
    const { pm, journal } = setup({
      router: { mode: 'query', paramPrefix: 'w_' },
      behaviour: { product: { apply: takesItem } },
    });
    pm.navigate({ page: 'product', item: 'a' });
    pm.navigate({ item: 'b' });
    journal.calls.length = 0;
    journal.changes.length = 0;
    const before = window.history.length;

    popTo('/shop?w_nav=product&w_item=a');

    expect(journal.calls).toEqual(['apply:product:b->a']);
    expect(journal.changes).toEqual([{ page: 'product', item: 'a' }]);
    // The router started it, so nothing is written back.
    expect(window.history.length).toBe(before);
  });

  test('at mount, a URL that names a state is rewritten to carry the keys initialNavState added, without a new entry', () => {
    window.history.replaceState(null, '', '/shop?w_nav=product&w_item=a');
    const before = window.history.length;

    const { pm } = setup({
      router: { mode: 'query', paramPrefix: 'w_' },
      initialNavState: { region: 'US' },
    });

    expect(pm.getNavigationState()).toEqual({ page: 'product', item: 'a', region: 'US' });
    expect(new URLSearchParams(window.location.search).get('w_region')).toBe('US');
    expect(window.history.length).toBe(before);
  });

  test('at mount, a URL that already names the whole state is left alone', () => {
    window.history.replaceState(null, '', '/shop?w_nav=product&w_item=a&w_region=US');
    const replaceState = vi.spyOn(window.history, 'replaceState');
    try {
      setup({ router: { mode: 'query', paramPrefix: 'w_' }, initialNavState: { region: 'US' } });
      expect(replaceState).not.toHaveBeenCalled();
    } finally {
      replaceState.mockRestore();
    }
  });

  test('Back to the mount entry keeps the seeded key, because the mount entry carries it', () => {
    window.history.replaceState(null, '', '/shop?w_nav=product&w_item=a');
    const { pm } = setup({
      router: { mode: 'query', paramPrefix: 'w_' },
      initialNavState: { region: 'US' },
    });
    const mountUrl = window.location.pathname + window.location.search;
    pm.navigate({ item: 'b', region: 'CA' });

    popTo(mountUrl);

    expect(pm.getNavigationState()).toEqual({ page: 'product', item: 'a', region: 'US' });
  });

  test('after a remount, a key from its snapshot does not survive Back to an entry without it', () => {
    // A runtime remount hands the live state to the new PageManager as
    // initialNavState; the URL already holds that state.
    window.history.replaceState(null, '', '/shop?w_nav=product&w_item=b&w_section=x');
    const { pm } = setup({
      router: { mode: 'query', paramPrefix: 'w_' },
      initialNavState: { page: 'product', item: 'b', section: 'x' },
    });

    popTo('/shop?w_nav=product&w_item=a');

    expect(pm.getNavigationState()).toEqual({ page: 'product', item: 'a' });
  });

  test('a router event naming the state already showing does nothing', () => {
    const { pm, journal } = setup({ router: { mode: 'query', paramPrefix: 'w_' } });
    pm.navigate({ page: 'product', item: 'a' });
    journal.calls.length = 0;
    journal.changes.length = 0;

    window.dispatchEvent(new PopStateEvent('popstate'));

    expect(journal.calls).toEqual([]);
    expect(journal.changes).toEqual([]);
  });

  test("an empty value counts as absent: '' in state matches a URL without the key", () => {
    const { pm, journal } = setup({ router: { mode: 'query', paramPrefix: 'w_' } });
    pm.navigate({ page: 'product', item: 'a', filter: '' });
    journal.changes.length = 0;
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(journal.changes).toEqual([]);
  });

  // The browser fires `hashchange` asynchronously after a hash assignment.
  // These tests dispatch it themselves, right after the write, so the
  // assertion does not depend on when the real one lands. The router reads
  // the current URL on every event, so the real one, whenever it arrives,
  // names the same state and is a no-op too.

  test('hash mode: one navigate fires navigation:changed once, not again on its own hashchange', () => {
    window.location.hash = '';
    const { pm, journal } = setup({ router: { mode: 'hash' } });
    pm.mountInitial({ hydrate: false });
    journal.changes.length = 0;
    journal.calls.length = 0;

    pm.navigate({ page: 'product', item: 'b' });
    expect(window.location.hash).toBe('#product?item=b');
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    expect(journal.changes).toEqual([{ page: 'product', item: 'b' }]);
    expect(journal.calls).toEqual(['destroy:home', 'render:product:b']);
    pm.destroy();
  });

  test('hash mode: a key the app cleared stays cleared when its own write echoes back, even one initialNavState seeded', () => {
    window.location.hash = '';
    const { pm, journal } = setup({ router: { mode: 'hash' }, initialNavState: { region: 'US' } });
    pm.mountInitial({ hydrate: false });
    pm.navigate({ page: 'product', item: 'a' });
    journal.calls.length = 0;
    journal.changes.length = 0;

    pm.navigate({ region: undefined });
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    expect(pm.getNavigationState().region).toBeUndefined();
    expect(journal.calls).toEqual(['destroy:product', 'render:product:a']);
    expect(journal.changes).toHaveLength(1);
    pm.destroy();
  });

  test('hash mode: a real hash edit still navigates', () => {
    window.location.hash = '';
    const { pm } = setup({ router: { mode: 'hash' } });
    pm.mountInitial({ hydrate: false });

    window.location.hash = '#list';
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    expect(pm.getNavigationState().page).toBe('list');
    pm.destroy();
  });
});

describe('navDefaults — a derived value stays out of the URL until the visitor changes it', () => {
  const query: RouterOption = { mode: 'query', paramPrefix: 'w_' };
  const param = (k: string) => new URLSearchParams(window.location.search).get(k);

  test('at mount the key holds its default and the URL does not carry it', () => {
    const { pm } = setup({ router: query, navDefaults: { region: 'US-NY' } });
    pm.mountInitial({ hydrate: false });

    expect(pm.getNavigationState().region).toBe('US-NY');
    expect(param('w_nav')).toBe('home');
    expect(param('w_region')).toBeNull();
  });

  test('a navigation that keeps the default does not write it; one that changes it does', () => {
    const { pm } = setup({ router: query, navDefaults: { region: 'US-NY' } });
    pm.navigate({ page: 'product', item: 'a' });
    expect(window.location.search).toBe('?w_nav=product&w_item=a');

    pm.navigate({ region: 'US-CA' });
    expect(param('w_region')).toBe('US-CA');

    pm.navigate({ region: 'US-NY' });
    expect(param('w_region')).toBeNull();
  });

  test('the URL outranks the default: a shared link with a region opens on it', () => {
    window.history.replaceState(null, '', '/shop?w_nav=product&w_region=US-CA');
    const { pm } = setup({ router: query, navDefaults: { region: 'US-NY' } });

    expect(pm.getNavigationState()).toEqual({ page: 'product', region: 'US-CA' });
    expect(param('w_region')).toBe('US-CA');
  });

  test('initialNavState outranks the default and, like any value off the default, is written', () => {
    const { pm } = setup({
      router: query,
      initialNavState: { region: 'US-CA' },
      navDefaults: { region: 'US-NY' },
    });
    pm.mountInitial({ hydrate: false });

    expect(pm.getNavigationState().region).toBe('US-CA');
    expect(param('w_region')).toBe('US-CA');
  });

  test('a URL that carries the default value is rewritten without it at mount, and stays without it', () => {
    window.history.replaceState(null, '', '/shop?w_nav=product&w_region=US-NY');
    const { pm } = setup({ router: query, navDefaults: { region: 'US-NY' } });
    expect(pm.getNavigationState().region).toBe('US-NY');
    expect(param('w_region')).toBeNull();

    pm.navigate({ item: 'a' });
    expect(param('w_region')).toBeNull();
  });

  test('Back to an entry that does not name the key restores the default', () => {
    const { pm, journal } = setup({ router: query, navDefaults: { region: 'US-NY' } });
    pm.navigate({ page: 'product' });
    const atDefault = window.location.pathname + window.location.search;
    pm.navigate({ region: 'US-CA' });
    journal.changes.length = 0;

    popTo(atDefault);

    expect(pm.getNavigationState()).toEqual({ page: 'product', region: 'US-NY' });
    expect(journal.changes).toEqual([{ page: 'product', region: 'US-NY' }]);
  });

  test("navigating the key to '' or undefined restores the default: a defaulted key always has a value", () => {
    const { pm } = setup({ router: query, navDefaults: { region: 'US-NY' } });
    pm.navigate({ page: 'product', region: 'US-CA' });

    pm.navigate({ region: '' });
    expect(pm.getNavigationState().region).toBe('US-NY');
    pm.navigate({ region: 'US-CA' });
    pm.navigate({ region: undefined });
    expect(pm.getNavigationState().region).toBe('US-NY');
    expect(param('w_region')).toBeNull();
  });

  test('the router event for a URL that leaves the default out is recognised as the state showing', () => {
    const { pm, journal } = setup({ router: query, navDefaults: { region: 'US-NY' } });
    pm.navigate({ page: 'product', item: 'a' });
    journal.calls.length = 0;
    journal.changes.length = 0;

    window.dispatchEvent(new PopStateEvent('popstate'));

    expect(journal.calls).toEqual([]);
    expect(journal.changes).toEqual([]);
  });

  test("hash mode: the write leaves the default out, and its own echo changes nothing", () => {
    window.location.hash = '';
    const { pm, journal } = setup({ router: { mode: 'hash' }, navDefaults: { region: 'US-NY' } });
    pm.mountInitial({ hydrate: false });
    journal.calls.length = 0;
    journal.changes.length = 0;

    pm.navigate({ page: 'product', item: 'b' });
    expect(window.location.hash).toBe('#product?item=b');
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    expect(journal.changes).toEqual([{ page: 'product', item: 'b', region: 'US-NY' }]);
    expect(journal.calls).toEqual(['destroy:home', 'render:product:b']);
  });

  test('a runtime remount, which hands the live state back as initialNavState, keeps the default out of the URL', () => {
    const first = setup({ router: query, navDefaults: { region: 'US-NY' } });
    first.pm.navigate({ page: 'product', item: 'a' });
    const snapshot = first.pm.getNavigationState();
    first.pm.destroy();

    const { pm } = setup({ router: query, initialNavState: snapshot, navDefaults: { region: 'US-NY' } });

    expect(pm.getNavigationState()).toEqual({ page: 'product', item: 'a', region: 'US-NY' });
    expect(param('w_region')).toBeNull();
  });

  test('page in navDefaults is ignored: the entry page is the default page', () => {
    const { pm } = setup({ router: query, navDefaults: { page: 'list', region: 'US-NY' } });
    pm.mountInitial({ hydrate: false });
    expect(pm.getNavigationState().page).toBe('home');
    pm.navigate({ page: 'list' });
    expect(param('w_nav')).toBe('list');
  });

  test('ctx.navState and applyNavState see the default', () => {
    let seen: NavigationState | undefined;
    const { pm, journal } = setup({
      navDefaults: { region: 'US-NY' },
      behaviour: {
        product: {
          apply: (next) => {
            seen = next;
            return true;
          },
        },
      },
    });
    pm.navigate({ page: 'product', item: 'a' });
    pm.navigate({ item: 'b' });

    expect(journal.ctxs[0]?.navState.region).toBe('US-NY');
    expect(seen).toEqual({ page: 'product', item: 'b', region: 'US-NY' });
  });

  test('createApp forwards navDefaults', () => {
    const app = createApp<PageType>(
      { appId: 'w', pages: PAGES },
      {
        host: document.createElement('div'),
        appContext: {},
        resolveRenderer: () => () => ({ render() {}, destroy() {} }),
        enableRouter: query,
        navDefaults: { region: 'US-NY' },
      },
    );
    try {
      expect(app.getNavigationState().region).toBe('US-NY');
      expect(param('w_region')).toBeNull();
    } finally {
      app.destroy();
    }
  });
});

describe('navigate during render — applied after the render returns', () => {
  test('a renderer that navigates to an unknown page renders once and is told why', () => {
    const { pm, journal } = setup({
      behaviour: {
        home: { onRender: (ctx) => ctx.navigate({ page: 'does-not-exist' }) },
      },
    });

    expect(() => pm.mountInitial({ hydrate: false })).not.toThrow();

    expect(journal.calls).toEqual(['render:home:-']);
    expect(pm.getNavigationState().page).toBe('home');
    expect(
      logs.some((e) => e.level === 'warn' && e.msg.includes('unknown page "does-not-exist"')),
    ).toBe(true);
  });

  test('a renderer that navigates to its own page with new context renders again, once', () => {
    let first = true;
    const { pm, journal } = setup({
      behaviour: {
        product: {
          onRender: (ctx) => {
            if (first) {
              first = false;
              ctx.navigate({ item: 'fallback' });
            }
          },
        },
      },
    });

    pm.navigate({ page: 'product' });

    expect(journal.calls).toEqual(['render:product:-', 'destroy:product', 'render:product:fallback']);
    expect(pm.getNavigationState()).toEqual({ page: 'product', item: 'fallback' });
  });

  test('a redirect from render goes to the other page, and the events come in order', () => {
    const { pm, journal } = setup({
      behaviour: { home: { onRender: (ctx) => ctx.navigate({ page: 'list' }) } },
    });

    pm.mountInitial({ hydrate: false });

    expect(journal.calls).toEqual(['render:home:-', 'destroy:home', 'render:list:-']);
    expect(journal.changes.map((s) => s.page)).toEqual(['home', 'list']);
  });

  test('a renderer that navigates on every render stops after a bounded number, with an error', () => {
    let n = 0;
    const { pm, journal } = setup({
      behaviour: { product: { onRender: (ctx) => ctx.navigate({ item: String(++n) }) } },
    });

    expect(() => pm.navigate({ page: 'product' })).not.toThrow();

    const renders = journal.calls.filter((c) => c.startsWith('render:'));
    expect(renders.length).toBe(17); // the first render, then 16 applied navigations
    expect(logs.some((e) => e.level === 'error' && e.msg.includes('16 queued in a row'))).toBe(true);
  });

  test('during hydrate too', () => {
    const { pm, journal } = setup({
      behaviour: {
        home: { onRender: (ctx) => ctx.navigate({ page: 'does-not-exist' }) },
      },
    });

    expect(() => pm.mountInitial({ hydrate: true })).not.toThrow();
    expect(journal.calls).toEqual(['hydrate:home:-']);
  });

  test('during applyNavState too', () => {
    const { pm, journal } = setup({
      behaviour: {
        product: {
          apply: (next, _prev, ctx) => {
            if (next.item === 'b') ctx.navigate({ item: 'c' });
            return true;
          },
        },
      },
    });
    pm.navigate({ page: 'product', item: 'a' });
    journal.calls.length = 0;

    pm.navigate({ item: 'b' });

    expect(journal.calls).toEqual(['apply:product:a->b', 'apply:product:b->c']);
    expect(pm.getNavigationState()).toEqual({ page: 'product', item: 'c' });
  });

  test('a navigation after the render returns is immediate, as before', () => {
    const { pm, journal } = setup();
    pm.navigate({ page: 'product' });
    journal.ctxs[0]?.navigate({ page: 'list' });
    expect(pm.getNavigationState().page).toBe('list');
  });

  test('a render that queues a navigation and then throws: the queue is dropped, the next navigation lands where asked', () => {
    let throwOnce = true;
    const { pm, journal } = setup({
      behaviour: {
        product: {
          onRender: (ctx) => {
            if (!throwOnce) return;
            throwOnce = false;
            ctx.navigate({ page: 'list' });
            throw new Error('render failed');
          },
        },
      },
    });
    pm.navigate({ page: 'home' });

    expect(() => pm.navigate({ page: 'product' })).toThrow('render failed');
    journal.calls.length = 0;
    pm.navigate({ page: 'home', item: 'later' });

    expect(pm.getNavigationState()).toEqual({ page: 'home', item: 'later' });
    expect(journal.calls.some((c) => c.startsWith('render:list'))).toBe(false);
  });

  test('after a render throws, the next navigation still mounts its page', () => {
    let throwOnce = true;
    const { pm, journal } = setup({
      behaviour: {
        product: {
          onRender: () => {
            if (!throwOnce) return;
            throwOnce = false;
            throw new Error('render failed');
          },
        },
      },
    });
    expect(() => pm.navigate({ page: 'product' })).toThrow('render failed');
    journal.calls.length = 0;

    pm.navigate({ page: 'list' });

    expect(journal.calls).toEqual(['render:list:-']);
    expect(pm.getNavigationState().page).toBe('list');
  });

  test('a hydrate that queues a navigation and then throws drops the queue too', () => {
    const { pm, journal } = setup({
      behaviour: {
        home: {
          onRender: (ctx) => {
            ctx.navigate({ page: 'list' });
            throw new Error('hydrate failed');
          },
        },
      },
    });
    expect(() => pm.mountInitial({ hydrate: true })).toThrow('hydrate failed');
    journal.calls.length = 0;

    pm.navigate({ page: 'product' });

    expect(journal.calls).toEqual(['render:product:-']);
  });

  test('an applyNavState that queues a navigation and then throws: re-rendered, and the queued navigation dropped', () => {
    const { pm, journal } = setup({
      behaviour: {
        product: {
          apply: (_next, _prev, ctx) => {
            ctx.navigate({ page: 'list' });
            throw new Error('apply failed');
          },
        },
      },
    });
    pm.navigate({ page: 'product', item: 'a' });
    journal.calls.length = 0;

    pm.navigate({ item: 'b' });

    expect(journal.calls).toEqual(['apply:product:a->b', 'destroy:product', 'render:product:b']);
    expect(pm.getNavigationState()).toEqual({ page: 'product', item: 'b' });
  });

  test('destroy drops queued navigations', () => {
    let pmRef: PageManager<PageType> | undefined;
    const { pm, journal } = setup({
      behaviour: {
        home: {
          onRender: (ctx) => {
            ctx.navigate({ page: 'list' });
            pmRef?.destroy();
          },
        },
      },
    });
    pmRef = pm;
    pm.mountInitial({ hydrate: false });
    expect(journal.calls.some((c) => c.startsWith('render:list'))).toBe(false);
  });
});

describe('history writes keep what is not ours, and redirects do not trap Back', () => {
  test("query mode: the mount's rewrite keeps the entry's history.state", () => {
    window.history.replaceState({ host: 'draft-42' }, '', '/shop?w_nav=product&w_item=a');
    setup({ router: { mode: 'query', paramPrefix: 'w_' }, initialNavState: { region: 'US' } });
    expect(new URLSearchParams(window.location.search).get('w_region')).toBe('US');
    expect(window.history.state).toEqual({ host: 'draft-42' });
  });

  test("hash mode: a 'replace' navigation keeps the entry's history.state", () => {
    window.location.hash = '';
    const { pm } = setup({ router: { mode: 'hash' } });
    pm.navigate({ page: 'product', item: 'a' });
    window.history.replaceState({ host: 'route-7' }, '', window.location.href);
    pm.navigate({ item: 'b' }, { history: 'replace' });
    expect(window.location.hash).toBe('#product?item=b');
    expect(window.history.state).toEqual({ host: 'route-7' });
    pm.destroy();
  });

  test('path mode: replace keeps history.state too', () => {
    window.history.replaceState({ host: 'p' }, '', '/c/product/a');
    const { pm } = setup({ router: { mode: 'path', basePath: '/c' }, initialNavState: { region: 'US' } });
    expect(window.history.state).toEqual({ host: 'p' });
    pm.destroy();
  });

  test('a redirect from render replaces the entry the render was for: one entry, not two', () => {
    let redirect = true;
    const { pm } = setup({
      router: { mode: 'query', paramPrefix: 'w_' },
      behaviour: {
        product: {
          onRender: (ctx) => {
            if (redirect) ctx.navigate({ page: 'list' });
          },
        },
      },
    });
    pm.navigate({ page: 'home' });
    const before = window.history.length;

    pm.navigate({ page: 'product' });

    expect(window.history.length).toBe(before + 1);
    expect(window.location.search).toBe('?w_nav=list');
    expect(pm.getNavigationState().page).toBe('list');
    redirect = false;
  });

  test('Back to an entry whose render redirects rewrites that entry and adds none, so forward history survives', () => {
    const { pm } = setup({
      router: { mode: 'query', paramPrefix: 'w_' },
      behaviour: { product: { onRender: (ctx) => ctx.navigate({ page: 'list' }) } },
    });
    pm.navigate({ page: 'home' });
    const before = window.history.length;

    popTo('/shop?w_nav=product');

    expect(window.history.length).toBe(before);
    expect(window.location.search).toBe('?w_nav=list');
  });

  test("an explicit history: 'push' from render is honoured", () => {
    let redirect = true;
    const { pm } = setup({
      router: { mode: 'query', paramPrefix: 'w_' },
      behaviour: {
        product: {
          onRender: (ctx) => {
            if (redirect) ctx.navigate({ page: 'list' }, { history: 'push' });
          },
        },
      },
    });
    pm.navigate({ page: 'home' });
    const before = window.history.length;
    pm.navigate({ page: 'product' });
    expect(window.history.length).toBe(before + 2);
    redirect = false;
  });
});

describe('queued navigations: copied, ordered, and dropped on failure', () => {
  test('a queued navigation is a copy: mutating the object afterwards changes nothing', () => {
    const { pm } = setup({
      behaviour: {
        product: {
          onRender: (ctx) => {
            if (ctx.navState.item) return;
            const s: { item?: string } = { item: 'a' };
            const o: { history?: 'push' | 'replace' } = { history: 'replace' };
            ctx.navigate(s, o);
            s.item = 'b';
            o.history = 'push';
          },
        },
      },
    });
    pm.navigate({ page: 'product' });
    expect(pm.getNavigationState().item).toBe('a');
  });

  test("a postRender hook's navigation runs after the render's earlier redirect, so it wins", () => {
    let pmRef: PageManager<PageType> | undefined;
    let once = true;
    const { pm } = setup({
      behaviour: {
        product: {
          onRender: (ctx) => {
            if (once) ctx.navigate({ page: 'list' });
          },
        },
      },
      postRender: ({ navState }) => {
        if (once && navState.page === 'product') {
          once = false;
          pmRef?.navigate({ page: 'home' });
        }
      },
    });
    pmRef = pm;

    pm.navigate({ page: 'product' });

    expect(pm.getNavigationState().page).toBe('home');
  });

  test('a navigation:changed listener that navigates is applied after the current one, in order', () => {
    const { pm, events, journal } = setup();
    let once = true;
    events.on('navigation:changed', (s: unknown) => {
      if (once && (s as NavigationState).page === 'product') {
        once = false;
        pm.navigate({ page: 'list' });
      }
    });
    pm.navigate({ page: 'product' });
    expect(journal.changes.map((c) => c.page)).toEqual(['product', 'list']);
    expect(pm.getNavigationState().page).toBe('list');
  });

  test('a subpage activation that queues a navigation and then throws drops the queue', () => {
    const pages = [
      ...PAGES,
      { id: 'qv', type: 'quickview', enabled: true, parent: 'product' } as Page<PageType>,
    ];
    let throwOnce = true;
    const { pm, journal } = setup({
      pages,
      behaviour: {
        product: {
          activate: (ctx) => {
            if (!throwOnce) return;
            throwOnce = false;
            ctx.navigate({ page: 'list' });
            throw new Error('activate failed');
          },
        },
      },
    });
    pm.navigate({ page: 'product' });

    expect(() => pm.navigate({ page: 'qv' })).toThrow('activate failed');
    journal.calls.length = 0;
    pm.navigate({ page: 'home' });

    expect(pm.getNavigationState().page).toBe('home');
    expect(journal.calls.some((c) => c.startsWith('render:list'))).toBe(false);
  });

  test('after a render threw, a router event naming that URL gets it another try', () => {
    let throwOnce = true;
    const { pm, journal } = setup({
      router: { mode: 'query', paramPrefix: 'w_' },
      behaviour: {
        product: {
          onRender: () => {
            if (!throwOnce) return;
            throwOnce = false;
            throw new Error('render failed');
          },
        },
      },
    });
    pm.navigate({ page: 'home' });
    expect(() => pm.navigate({ page: 'product' })).toThrow('render failed');
    journal.calls.length = 0;

    popTo('/shop?w_nav=product');

    expect(journal.calls).toEqual(['render:product:-']);
  });
});

describe("a page waiting for its chunk: the router's echo is not a second attempt", () => {
  test('hash mode: one navigate to an unloaded page misses once and fires navigation:changed once', () => {
    window.location.hash = '';
    const missing = new Set<PageType>(['product']);
    const { pm, journal, events } = setup({ router: { mode: 'hash' }, missing });
    let misses = 0;
    events.on('renderer:missing', () => {
      misses++;
    });
    pm.mountInitial({ hydrate: false });
    journal.changes.length = 0;

    pm.navigate({ page: 'product', item: 'b' });
    expect(window.location.hash).toBe('#product?item=b');
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    expect(misses).toBe(1);
    expect(journal.changes).toEqual([{ page: 'product', item: 'b' }]);
  });

  test('once the chunk registers, the recovery navigate paints the page', () => {
    window.location.hash = '';
    const missing = new Set<PageType>(['product']);
    const { pm, journal } = setup({ router: { mode: 'hash' }, missing });
    pm.mountInitial({ hydrate: false });
    pm.navigate({ page: 'product', item: 'b' });
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    journal.calls.length = 0;

    missing.delete('product');
    pm.navigate({ page: 'product' });

    expect(journal.calls).toEqual(['render:product:b']);
  });

  test('while waiting, a router event to a different state still navigates', () => {
    window.location.hash = '';
    const missing = new Set<PageType>(['product']);
    const { pm, journal } = setup({ router: { mode: 'hash' }, missing });
    pm.mountInitial({ hydrate: false });
    pm.navigate({ page: 'product' });
    journal.calls.length = 0;

    window.location.hash = '#list';
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    expect(pm.getNavigationState().page).toBe('list');
    expect(journal.calls).toEqual(['render:list:-']);
  });

  test('query mode: a router event naming the state of a page still waiting for its chunk does not miss again', () => {
    const missing = new Set<PageType>(['product']);
    const { pm, events } = setup({ router: { mode: 'query', paramPrefix: 'w_' }, missing });
    let misses = 0;
    events.on('renderer:missing', () => {
      misses++;
    });
    pm.navigate({ page: 'product' });

    window.dispatchEvent(new PopStateEvent('popstate'));

    expect(misses).toBe(1);
  });
});

describe('through the cartridge-kit factories', () => {
  function mount(factory: () => PageRenderer<PageType>, hydrate: boolean) {
    const container = document.createElement('div');
    container.innerHTML = '<p data-item="a">a</p>';
    const pm = new PageManager<PageType>({
      container,
      pages: PAGES,
      events: new EventBus(),
      appContext: {},
      resolveRenderer: (type) => (type === 'product' ? factory : undefined),
      initialNavState: { page: 'product', item: 'a' },
    });
    pm.mountInitial({ hydrate });
    return { pm, container };
  }

  /** Moves the one `<p>` to the new item, as a carousel would slide to it. */
  const slide = (root: HTMLElement, next: NavigationState) => {
    const p = root.querySelector('p');
    if (!p || !next.item) return false;
    p.dataset.item = next.item;
    p.textContent = next.item;
    return true;
  };

  test('a hydrate-only view takes a same-page navigation in place, never reaching render', () => {
    const { pm, container } = mount(
      defineHydrateOnlyRenderer<PageType, unknown>({ hydrate: () => undefined, applyNavState: slide }),
      true,
    );

    expect(() => pm.navigate({ item: 'b' })).not.toThrow();

    expect(container.innerHTML).toBe('<p data-item="b">b</p>');
    expect(pm.getNavigationState()).toEqual({ page: 'product', item: 'b' });
  });

  test('without it, the same navigation reaches render, which a hydrate-only view refuses', () => {
    const { pm } = mount(defineHydrateOnlyRenderer<PageType, unknown>({ hydrate: () => undefined }), true);
    expect(() => pm.navigate({ item: 'b' })).toThrow(/hydrate-only view/);
  });

  test('an SSR-safe view applies it in place: the template is not called again, the listeners stay', () => {
    let templateCalls = 0;
    let cleanups = 0;
    const { pm, container } = mount(
      defineSSRSafeRenderer<PageType, unknown>({
        template: (ctx) => {
          templateCalls++;
          return `<p data-item="${ctx.navState.item}">${ctx.navState.item}</p>`;
        },
        hydrate: () => () => {
          cleanups++;
        },
        applyNavState: slide,
      }),
      false,
    );
    expect(templateCalls).toBe(1);

    pm.navigate({ item: 'b' });

    expect(templateCalls).toBe(1);
    expect(cleanups).toBe(0);
    // What the template would paint for the new state, so a reload agrees.
    expect(container.innerHTML).toBe('<p data-item="b">b</p>');
  });

  test('an SSR-safe view that declines is painted again from the template', () => {
    let templateCalls = 0;
    const { pm, container } = mount(
      defineSSRSafeRenderer<PageType, unknown>({
        template: (ctx) => {
          templateCalls++;
          return `<p data-item="${ctx.navState.item}">${ctx.navState.item}</p>`;
        },
        applyNavState: () => false,
      }),
      false,
    );

    pm.navigate({ item: 'b' });

    expect(templateCalls).toBe(2);
    expect(container.innerHTML).toBe('<p data-item="b">b</p>');
  });
});
