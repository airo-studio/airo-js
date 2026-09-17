/**
 * `unknownPage: 'refuse'` (0.11.1).
 *
 * A surface that owns its urls answers 404 from `fellBack`. Before this
 * option the runner still rendered the fallback page and ran its adapters
 * for every unknown url, only for the host to throw the result away, and
 * logged a `warn` telling a host that already did the right thing to do it.
 * `'refuse'` skips the work and the warning. The default is unchanged,
 * because on a customer's page the fallback is mandatory.
 */

import { describe, expect, test } from 'vitest';

import type { AppConfig, PageRenderer } from '@airo-js/core';
import type { Cartridge, Gate, PublicationAdapter } from '@airo-js/cartridge-kit';

import { renderAppToHTML } from '../src/render-app.js';
import { renderAppWithPublication } from '../src/render-with-publication.js';

interface D {
  marker: string;
}
interface C {
  locale?: string;
}

let renders = 0;

const renderer = (): PageRenderer => ({
  render: (c) => {
    c.innerHTML = '<p>page</p>';
  },
  renderSSR: (c, ctx) => {
    renders += 1;
    c.innerHTML = `<p data-page="${ctx.page.id}">page</p>`;
  },
  destroy: () => undefined,
});

const pages: AppConfig['pages'] = [
  { id: 'home', type: 'home', enabled: true },
  { id: 'members', type: 'members', enabled: true, private: true },
  { id: 'draft', type: 'home', enabled: false },
  { id: 'artist', type: 'artist', enabled: true, parent: 'home' },
  { id: 'age-gate', type: 'gate', enabled: true },
];
const publicFirst: AppConfig = { appId: 'site', pages };
/** First enabled page private: an unknown url falls back onto a private page. */
const privateFirst: AppConfig = { appId: 'site', pages: [pages[1]!, pages[0]!] };

const isGatePage = (t: string) => t === 'gate';

function countingAdapter(): PublicationAdapter<D, unknown, C> & { runs: number } {
  const adapter = {
    id: 'json-ld',
    displayName: 'JSON-LD',
    description: 'Counts its runs.',
    format: 'json-ld' as const,
    delivery: 'inline-in-host' as const,
    requires: [],
    refreshCadence: { min: { ms: 0 }, max: { ms: 1000 } },
    runs: 0,
    async generate(data: D) {
      adapter.runs += 1;
      return { '@type': 'Thing', name: data.marker };
    },
    validate() {
      return { valid: true, errors: [], warnings: [] };
    },
  };
  return adapter;
}

function gate(id: string, appliesTo: 'all' | 'private'): Gate<C> {
  return {
    id,
    displayName: id,
    appliesTo,
    isEnabled: () => true,
    async mount() {
      return 'block';
    },
    destroy() {},
  };
}

function cartridgeWith(adapter: PublicationAdapter<D, unknown, C>, csrOnlyHome = false): Cartridge<D, C> {
  return {
    id: 'site',
    industry: 'test',
    displayName: 'Site',
    description: 'Fixture.',
    version: '0.0.0',
    mailboxName: '__AIRO_UNKNOWN_PAGE_PAGES__',
    schema: {
      parse: (i: unknown) => i as D,
      safeParse: (i: unknown) => ({ success: true as const, data: i as D }),
    },
    dataSources: [],
    gates: [gate('consent', 'all'), gate('login', 'private')],
    views: [
      {
        id: 'home-view',
        displayName: 'Home',
        pageType: 'home',
        factory: renderer,
        ...(csrOnlyHome ? { capabilities: ['csr-only' as const] } : {}),
      },
      { id: 'members-view', displayName: 'Members', pageType: 'members', factory: renderer },
      { id: 'artist-view', displayName: 'Artist', pageType: 'artist', factory: renderer },
      { id: 'gate-view', displayName: 'Gate', pageType: 'gate', factory: renderer },
    ],
    templates: [],
    publicationAdapters: [adapter],
  };
}

async function captureLogs(fn: () => unknown): Promise<{ level: string; msg: string }[]> {
  const { setSink, resetSink, setLogLevel, resetLogLevels } = await import('@airo-js/log');
  const captured: { level: string; msg: string }[] = [];
  setSink({ emit: (e) => captured.push({ level: e.level, msg: e.msg }) });
  setLogLevel('debug');
  try {
    await fn();
  } finally {
    resetSink();
    resetLogLevels();
  }
  return captured;
}

describe('renderAppToHTML — unknownPage', () => {
  function render(page: string | undefined, unknownPage?: 'fallback' | 'refuse', appConfig = publicFirst) {
    return renderAppToHTML(appConfig, {
      document: globalThis.document,
      resolveRenderer: () => renderer,
      isGatePage,
      appContext: {},
      ...(page ? { initialNavState: { page } } : {}),
      ...(unknownPage ? { unknownPage } : {}),
    });
  }

  test("'refuse': an unknown page renders nothing and still reports fellBack", () => {
    renders = 0;
    const result = render('does-not-exist', 'refuse');
    expect(result).toEqual({ html: '', fellBack: { requested: 'does-not-exist', reason: 'unknown-page' } });
    expect(renders).toBe(0);
  });

  test("'refuse' refuses before the private check — no skipped for a page nobody asked for", () => {
    const result = render('does-not-exist', 'refuse', privateFirst);
    expect(result.skipped).toBeUndefined();
    expect(result.fellBack?.reason).toBe('unknown-page');
  });

  test("'refuse' leaves the other three rejections alone — they are real urls", () => {
    for (const [page, reason] of [
      ['draft', 'disabled'],
      ['artist', 'subpage'],
      ['age-gate', 'gate-page'],
    ] as const) {
      const result = render(page, 'refuse');
      expect(result.fellBack).toEqual({ requested: page, reason });
      expect(result.html).toContain('data-page="home"');
    }
  });

  test("'refuse' changes nothing for a page that resolves, or for no request at all", () => {
    expect(render('home', 'refuse')).toEqual(render('home'));
    expect(render(undefined, 'refuse')).toEqual(render(undefined));
  });

  test("the default is 'fallback', and 'fallback' is the behaviour it always had", () => {
    const explicit = render('does-not-exist', 'fallback');
    expect(explicit).toEqual(render('does-not-exist'));
    expect(explicit.html).toContain('data-page="home"');
  });

  test("'refuse' narrates at debug, never warn", async () => {
    const logs = await captureLogs(() => render('does-not-exist', 'refuse'));
    expect(logs.some((e) => e.level === 'warn')).toBe(false);
    expect(logs.find((e) => e.level === 'debug')?.msg).toContain('does-not-exist');
  });

  test("the fallback warning names the option that silences it", async () => {
    const logs = await captureLogs(() => render('does-not-exist'));
    expect(logs.find((e) => e.level === 'warn')?.msg).toContain("unknownPage: 'refuse'");
  });
});

describe('renderAppWithPublication — unknownPage', () => {
  async function run(
    opts: { page?: string; unknownPage?: 'fallback' | 'refuse'; appConfig?: AppConfig; csrOnlyHome?: boolean } = {},
  ) {
    const adapter = countingAdapter();
    renders = 0;
    const result = await renderAppWithPublication<D, C>({
      cartridge: cartridgeWith(adapter, opts.csrOnlyHome),
      appConfig: opts.appConfig ?? publicFirst,
      snapshot: { marker: 'x' },
      publicationCtx: { config: {}, locale: 'en', country: 'GB' },
      document: globalThis.document,
      isGatePage,
      ...(opts.page ? { initialNavState: { page: opts.page } } : {}),
      ...(opts.unknownPage ? { unknownPage: opts.unknownPage } : {}),
    });
    return { result, adapterRuns: adapter.runs, renders };
  }

  test("'refuse': no render, no adapter, no gates to report", async () => {
    const { result, adapterRuns, renders: rendered } = await run({ page: 'nope', unknownPage: 'refuse' });
    expect(result).toEqual({
      html: '',
      adapterResults: [],
      gates: { pending: [], satisfied: [] },
      fellBack: { requested: 'nope', reason: 'unknown-page' },
    });
    expect(adapterRuns).toBe(0);
    expect(rendered).toBe(0);
  });

  test('the default still renders the fallback and runs its adapters — the work refuse saves', async () => {
    const { result, adapterRuns, renders: rendered } = await run({ page: 'nope' });
    expect(result.fellBack?.reason).toBe('unknown-page');
    expect(result.html).toContain('data-page="home"');
    expect(adapterRuns).toBe(1);
    expect(rendered).toBe(1);
  });

  test("'refuse' onto a private default: fellBack alone, not the private skip", async () => {
    const refused = await run({ page: 'nope', unknownPage: 'refuse', appConfig: privateFirst });
    expect(refused.result.skipped).toBeUndefined();
    expect(refused.result.fellBack?.reason).toBe('unknown-page');

    // Without it, both are set — the co-occurrence hosts are told to order.
    const fallback = await run({ page: 'nope', appConfig: privateFirst });
    expect(fallback.result.skipped?.reason).toBe('private');
    expect(fallback.result.fellBack?.reason).toBe('unknown-page');
  });

  test("'refuse' onto a csr-only default: no csr-only skip and no inlined JSON-LD", async () => {
    const { result, adapterRuns } = await run({ page: 'nope', unknownPage: 'refuse', csrOnlyHome: true });
    expect(result.skipped).toBeUndefined();
    expect(result.html).toBe('');
    expect(adapterRuns).toBe(0);
  });

  test("'refuse' leaves known pages, private refusals and legitimate fallbacks exactly as they were", async () => {
    for (const opts of [{ page: 'home' }, { page: 'members' }, { page: 'draft' }, {}]) {
      const withRefuse = await run({ ...opts, unknownPage: 'refuse' });
      const without = await run(opts);
      expect(withRefuse.result).toEqual(without.result);
      expect(withRefuse.adapterRuns).toBe(without.adapterRuns);
    }
  });

  test("'refuse' narrates at debug, never warn", async () => {
    const logs = await captureLogs(() => run({ page: 'nope', unknownPage: 'refuse' }));
    expect(logs.some((e) => e.level === 'warn')).toBe(false);
    expect(logs.find((e) => e.level === 'debug' && e.msg.includes('nope'))).toBeDefined();
  });
});
