import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type Cartridge, defineHydrateOnlyRenderer, type Template } from '@airo-js/cartridge-kit';
import type { RenderContext } from '@airo-js/core';
import { noopSink, resetSink, setSink } from '@airo-js/log';

import type { LynxErrorInfo } from '../src/runtime/errors.js';
import { type LynxMount, type LynxPage, mountLynx, type MountLynxOptions } from '../src/runtime/mount.js';
import type { NavigateRequest } from '../src/runtime/navigation.js';
import { type FakeLynx, installFakePapi } from './fake-papi.js';

interface Data {
  count: number;
}
type Ctx = RenderContext<string, { data: Data }>;
// biome-ignore lint/suspicious/noExplicitAny: the facade stands in for HTMLElement
type El = any;

const cleanups: string[] = [];

const view = (pageType: string, hydrate: (root: El, ctx: Ctx) => void | (() => void)) => ({
  id: `${pageType}-view`,
  displayName: pageType,
  pageType,
  capabilities: ['hydrate-only' as const],
  factory: defineHydrateOnlyRenderer<string, { data: Data }>({ hydrate: hydrate as never }),
});

const cartridge: Cartridge<Data, Record<string, never>> = {
  id: 'shop',
  mailboxName: '__AIRO_SHOP_PAGES__',
  industry: 'test',
  displayName: 'Shop',
  description: 'fixture',
  version: '0.0.0',
  schema: { parse: (i) => i as Data, safeParse: (i) => ({ success: true as const, data: i as Data }) },
  dataSources: [],
  views: [
    view('home', (root, ctx) => {
      root.querySelector('.count').textContent = String(ctx.app.data.count);
      const onClick = () => {
        root.querySelector('.count').textContent = 'clicked';
      };
      root.addEventListener('click', onClick);
      return () => cleanups.push('home');
    }),
    view('item', (root) => {
      root.querySelector('h1').setAttribute('data-ready', 'yes');
      return () => cleanups.push('item');
    }),
    view('broken', (root) => {
      root.addEventListener('click', () => {
        root.querySelector('.count').textContent = 'should not run';
      });
      root.getBoundingClientRect();
    }),
    view('later', () => {
      // An async attach, like a handler that loads its chunk first. The
      // refusal must reach onError although nothing awaits this promise.
      Promise.resolve()
        .then(() => {
          (globalThis as unknown as { localStorage: { getItem(k: string): string } }).localStorage.getItem('k');
        })
        .catch(() => undefined);
      return undefined;
    }),
  ],
  templates: [],
  defaultConfig: {},
  defaultTemplateId: 'main',
};

const template: Template<Record<string, never>> = {
  id: 'main',
  displayName: 'Main',
  description: 'fixture',
  defaultConfig: {},
  pages: [
    { id: 'home', type: 'home', enabled: true },
    { id: 'item', type: 'item', enabled: true },
    { id: 'broken', type: 'broken', enabled: true },
    { id: 'later', type: 'later', enabled: true },
    { id: 'orphan', type: 'orphan', enabled: true },
  ],
};

const HOME: LynxPage<Data> = {
  html: '<main class="home"><p class="count">0</p><a class="go" href="/item/1">Item</a><a class="go2" href="/item/2">Item 2</a></main>',
  snapshot: { count: 3 },
  nav: { page: 'home' },
};
const ITEM: LynxPage<Data> = { html: '<article><h1>Item</h1></article>', snapshot: { count: 0 }, nav: { page: 'item' } };

let fake: FakeLynx;
let mount: LynxMount | null = null;
let errors: LynxErrorInfo[];

function start(over: Partial<MountLynxOptions<Data, Record<string, never>>> = {}): LynxMount {
  fake = installFakePapi();
  errors = [];
  mount = mountLynx({
    cartridge,
    config: {},
    template,
    page: HOME,
    baseUrl: 'https://shop.example/',
    onError: (info) => errors.push(info),
    ...over,
  });
  return mount;
}

const screen = (): string => fake.render(fake.page());
const flushed = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => {
  setSink(noopSink);
  cleanups.length = 0;
});
afterEach(() => {
  mount?.destroy();
  mount = null;
  fake?.uninstall();
  resetSink();
});

describe('mounting a page', () => {
  it('paints the server HTML and hydrates it with the snapshot', async () => {
    start();
    await flushed();
    expect(screen()).toContain('text.count.tag-p("3")');
    expect(mount!.nav?.page).toBe('home');
    fake.tap(fake.byClass('count'));
    await flushed();
    expect(screen()).toContain('text.count.tag-p("clicked")');
    expect(errors).toEqual([]);
  });

  it('puts the page in a vertical scroller, as a browser viewport scrolls', () => {
    start();
    const scroller = fake.page().children[0]!;
    expect(scroller.tag).toBe('scroll-view');
    expect(scroller.attrs['scroll-orientation']).toBe('vertical');
    expect(scroller.classes.split(' ')[0]).toBe('airo-lynx-viewport');
  });

  it('sets the page theme class from colorScheme, and switches it', () => {
    start({ colorScheme: 'dark' });
    expect(fake.page().classes).toBe('airo-lynx-page airo-lynx-dark');
    mount!.setColorScheme('light');
    expect(fake.page().classes).toBe('airo-lynx-page');
  });

  it('waits for show() when the first page is not there yet', () => {
    start({ page: undefined });
    expect(fake.page().children).toEqual([]);
    mount!.show(ITEM);
    expect(screen()).toContain('tag-h1.a-data-ready.a-data-ready--yes');
  });

  it('markup it cannot build is reported, and nothing is half painted', () => {
    start({ page: { html: '<p>a&nbsp;b</p>', snapshot: { count: 0 }, nav: { page: 'home' } } });
    expect(fake.page().children).toEqual([]);
    expect(errors).toEqual([expect.objectContaining({ phase: 'render' })]);
  });

  it('reports a nav.page the template does not have as an entry', () => {
    start({ page: { ...ITEM, nav: { page: 'nope' } } });
    expect(errors.map((e) => e.error.message)).toEqual([expect.stringContaining('nav.page "nope" does not name an entry page')]);
    expect(mount!.nav).toBeNull();
    expect(screen()).toContain('tag-h1');
  });

  it('reports a page type with no renderer', () => {
    start({ page: { ...ITEM, nav: { page: 'orphan' } } });
    expect(errors.map((e) => e.error.message)).toEqual([expect.stringContaining('no renderer for page type "orphan"')]);
  });

  it('uses a host-supplied renderer lookup', () => {
    const hydrate = vi.fn();
    start({ resolveRenderer: () => defineHydrateOnlyRenderer({ hydrate }) as never });
    expect(hydrate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ page: expect.objectContaining({ id: 'home' }) }));
  });
});

describe('a hydrate handler that hits a refusal (O5)', () => {
  it('has its listeners rolled back, the error reported with the member, and the page kept', () => {
    start({ page: { ...HOME, nav: { page: 'broken' } } });
    expect(errors).toEqual([expect.objectContaining({ phase: 'hydrate', member: 'Element.getBoundingClientRect' })]);
    fake.tap(fake.byClass('count'));
    expect(screen()).toContain('text.count.tag-p("0")');
  });

  it('is reported even when the refusal happens after the hydrate call returned', async () => {
    start({ page: { ...HOME, nav: { page: 'later' } } });
    await flushed();
    expect(errors).toEqual([expect.objectContaining({ member: 'localStorage.getItem' })]);
  });
});

describe('navigation', () => {
  function deferred() {
    let resolve!: (page: LynxPage<Data> | undefined) => void;
    const promise = new Promise<LynxPage<Data> | undefined>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  it('shows the page onNavigate answers with, after the old one is cleaned up', async () => {
    const onNavigate = vi.fn(async (_r: NavigateRequest) => ITEM);
    start({ onNavigate });
    fake.tap(fake.byClass('go'));
    await flushed();
    expect(onNavigate).toHaveBeenCalledWith({ url: '/item/1', method: 'get', fields: {}, source: 'link' });
    expect(cleanups).toEqual(['home']);
    expect(mount!.nav?.page).toBe('item');
    expect(screen()).toContain('tag-h1.a-data-ready');
    expect(screen()).not.toContain('count');
  });

  it('stays on the page when onNavigate answers with nothing', async () => {
    start({ onNavigate: async () => undefined });
    fake.tap(fake.byClass('go'));
    await flushed();
    expect(mount!.nav?.page).toBe('home');
    expect(errors).toEqual([]);
  });

  it('stays on the page and reports when onNavigate throws or answers with something else', async () => {
    start({
      onNavigate: async (r) => {
        if (r.url === '/item/1') throw new Error('offline');
        return { not: 'a page' } as never;
      },
    });
    fake.tap(fake.byClass('go'));
    await flushed();
    fake.tap(fake.byClass('go2'));
    await flushed();
    expect(mount!.nav?.page).toBe('home');
    expect(errors.map((e) => [e.phase, e.error.message])).toEqual([
      ['navigate', 'offline'],
      ['navigate', expect.stringContaining('not { html, snapshot, nav }')],
    ]);
  });

  it('keeps the old page when the new markup cannot be built', async () => {
    start({ onNavigate: async () => ({ ...ITEM, html: '<dialog open>x</dialog>' }) });
    fake.tap(fake.byClass('go'));
    await flushed();
    expect(mount!.nav?.page).toBe('home');
    expect(screen()).toContain('count');
    expect(cleanups).toEqual([]);
  });

  it('shows only the newest request’s answer, whichever order they arrive in (D12)', async () => {
    const answers = new Map<string, ReturnType<typeof deferred>>();
    start({
      onNavigate: (r) => {
        const d = deferred();
        answers.set(r.url, d);
        return d.promise;
      },
    });
    fake.tap(fake.byClass('go'));
    fake.tap(fake.byClass('go2'));
    await flushed();
    answers.get('/item/2')!.resolve({ ...ITEM, html: '<article><h1>Two</h1></article>' });
    await flushed();
    answers.get('/item/1')!.resolve({ ...ITEM, html: '<article><h1>One</h1></article>' });
    await flushed();
    expect(screen()).toContain('"Two"');
    expect(screen()).not.toContain('"One"');
  });

  it('reports a tap that would navigate when the host gave no onNavigate', () => {
    start();
    fake.tap(fake.byClass('go'));
    expect(errors.map((e) => e.error.message)).toEqual([expect.stringContaining('has no onNavigate')]);
  });
});

describe('destroy', () => {
  it('cleans up the app, the elements and the global guards', () => {
    start();
    expect(typeof (globalThis as Record<string, unknown>).window).toBe('function');
    mount!.destroy();
    expect(cleanups).toEqual(['home']);
    expect(fake.page().children).toEqual([]);
    expect('window' in globalThis).toBe(false);
  });
});
