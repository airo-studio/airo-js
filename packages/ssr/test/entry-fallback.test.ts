/**
 * `fellBack` — the soft-404 seam.
 *
 * The entry resolver deliberately substitutes the default entry for a
 * requested page it rejects, so a tampered or stale deeplink can never
 * crash a render. Taken literally that renders the home page at
 * `/does-not-exist` with a 200 and a canonical of `/` — a soft 404, which
 * search engines penalise and which nothing errors about. TWO independent
 * consumers shipped it without noticing.
 *
 * The right answer is per SURFACE, not per consumer: the same codebase
 * serves a crawlable domain (404) and a widget embedded on a customer's
 * page (fall back — mandatory, because the URL is the customer's and a
 * widget refusing to render an unrecognised tail would break their page).
 * So the fallback stays and the decision stops being discarded.
 *
 * The framework has no opinion about status codes. It reports what it did.
 */

import { describe, expect, test } from 'vitest';

import type { AppConfig, PageRenderer } from '@airo-js/core';
import type { Cartridge } from '@airo-js/cartridge-kit';

import { renderAppToHTML } from '../src/render-app.js';
import { renderAppWithPublication } from '../src/render-with-publication.js';

interface D {
  marker: string;
}
interface C {
  locale?: string;
}

const renderer = (): PageRenderer => ({
  render: (c) => {
    c.innerHTML = '<p>page</p>';
  },
  renderSSR: (c) => {
    c.innerHTML = '<p>page</p>';
  },
  destroy: () => undefined,
});

const pages: AppConfig['pages'] = [
  { id: 'home', type: 'home', enabled: true },
  { id: 'roster', type: 'roster', enabled: true },
  { id: 'draft', type: 'roster', enabled: false },
  { id: 'artist', type: 'artist', enabled: true, parent: 'roster' },
  { id: 'age-gate', type: 'gate', enabled: true },
];

const appConfig: AppConfig = { appId: 'site', pages };

const cartridge: Cartridge<D, C> = {
  id: 'site',
  industry: 'test',
  displayName: 'Site',
  description: 'Fixture.',
  version: '0.0.0',
  mailboxName: '__AIRO_ENTRY_FALLBACK_PAGES__',
  schema: {
    parse: (i: unknown) => i as D,
    safeParse: (i: unknown) => ({ success: true as const, data: i as D }),
  },
  dataSources: [],
  views: [
    { id: 'home-view', displayName: 'Home', pageType: 'home', factory: renderer },
    { id: 'roster-view', displayName: 'Roster', pageType: 'roster', factory: renderer },
    { id: 'artist-view', displayName: 'Artist', pageType: 'artist', factory: renderer },
    { id: 'gate-view', displayName: 'Gate', pageType: 'gate', factory: renderer },
  ],
  templates: [],
};

const isGatePage = (t: string) => t === 'gate';

function render(page?: string) {
  return renderAppToHTML(appConfig, {
    document: globalThis.document,
    resolveRenderer: () => renderer,
    isGatePage,
    appContext: {},
    ...(page ? { initialNavState: { page } } : {}),
  });
}

describe('renderAppToHTML — fellBack', () => {
  test('absent when no page was requested — a bare basePath is legitimate', () => {
    expect(render().fellBack).toBeUndefined();
  });

  test('absent when the requested page resolved', () => {
    expect(render('roster').fellBack).toBeUndefined();
  });

  test('unknown-page — the soft-404 case', () => {
    expect(render('does-not-exist').fellBack).toEqual({
      requested: 'does-not-exist',
      reason: 'unknown-page',
    });
  });

  test('disabled — the page exists but is switched off', () => {
    expect(render('draft').fellBack).toEqual({ requested: 'draft', reason: 'disabled' });
  });

  test('subpage — subpages activate through their parent, never as an entry', () => {
    expect(render('artist').fellBack).toEqual({ requested: 'artist', reason: 'subpage' });
  });

  test('gate-page', () => {
    expect(render('age-gate').fellBack).toEqual({ requested: 'age-gate', reason: 'gate-page' });
  });

  test('the fallback still renders — reporting it does not break the page', () => {
    const result = render('does-not-exist');
    expect(result.html).toContain('<p>page</p>');
  });

  test('a host can distinguish 404 from a legitimate entry render', () => {
    // The whole point: these two produce identical html, and only
    // `fellBack` tells them apart.
    expect(render().html).toBe(render('does-not-exist').html);
    expect(render().fellBack).toBeUndefined();
    expect(render('does-not-exist').fellBack).toBeDefined();
  });
});

describe('renderAppWithPublication — fellBack', () => {
  async function run(page?: string) {
    return renderAppWithPublication<D, C>({
      cartridge,
      appConfig,
      snapshot: { marker: 'x' },
      publicationCtx: { config: {}, locale: 'en', country: 'GB' },
      document: globalThis.document,
      isGatePage,
      ...(page ? { initialNavState: { page } } : {}),
    });
  }

  test('forwards the discriminator verbatim', async () => {
    expect((await run('nope')).fellBack).toEqual({ requested: 'nope', reason: 'unknown-page' });
  });

  test('absent on a clean render', async () => {
    expect((await run('roster')).fellBack).toBeUndefined();
    expect((await run()).fellBack).toBeUndefined();
  });

  test('survives the csr-only skip path', async () => {
    // A host answering 404 must not have that decision depend on whether
    // the fallback page happened to be server-renderable.
    const csrOnly: Cartridge<D, C> = {
      ...cartridge,
      views: cartridge.views!.map((v) =>
        v.pageType === 'home' ? { ...v, capabilities: ['csr-only' as const] } : v,
      ),
    };
    const result = await renderAppWithPublication<D, C>({
      cartridge: csrOnly,
      appConfig,
      snapshot: { marker: 'x' },
      publicationCtx: { config: {}, locale: 'en', country: 'GB' },
      document: globalThis.document,
      isGatePage,
      initialNavState: { page: 'nope' },
    });
    expect(result.skipped).toEqual({ pageType: 'home', reason: 'csr-only' });
    expect(result.fellBack).toEqual({ requested: 'nope', reason: 'unknown-page' });
  });
});

describe('the reason is load-bearing — do not collapse it to a boolean', () => {
  // A second consumer serves all of these from ONE codebase across four
  // surfaces. On their crawlable campaign domain a disabled page and an
  // age gate are legitimate 200s (a publisher config state, and a real
  // page in the template); only an id naming nothing is a 404. A boolean
  // `fellBack` would 404 all three.
  test('only unknown-page indicates a missing url', () => {
    const reasons = ['does-not-exist', 'draft', 'artist', 'age-gate'].map(
      (p) => render(p).fellBack?.reason,
    );
    expect(reasons).toEqual(['unknown-page', 'disabled', 'subpage', 'gate-page']);

    const is404 = reasons.map((r) => r === 'unknown-page');
    expect(is404).toEqual([true, false, false, false]);
  });

  test('every rejection carries the id that was requested, for logging', () => {
    for (const p of ['does-not-exist', 'draft', 'artist', 'age-gate']) {
      expect(render(p).fellBack?.requested).toBe(p);
    }
  });
});

describe('the runner narrates an unknown-page fallback', () => {
  // Ask C. This failed silently on a consumer twice — once as the original
  // soft 404, and again AFTER the fix landed, in the same session, because
  // the wiring looked right and the page rendered.
  test('warns on unknown-page, pointing at the docs', async () => {
    const { setSink, resetSink, setLogLevel, resetLogLevels } = await import('@airo-js/log');
    const captured: { level: string; msg: string }[] = [];
    setSink({ emit: (e) => captured.push({ level: e.level, msg: e.msg }) });
    setLogLevel('debug');
    try {
      render('does-not-exist');
    } finally {
      resetSink();
      resetLogLevels();
    }
    const warn = captured.find((e) => e.level === 'warn');
    expect(warn?.msg).toContain('does-not-exist');
    expect(warn?.msg).toContain('5.10a');
  });

  test('legitimate rejections narrate at debug, not warn', async () => {
    const { setSink, resetSink, setLogLevel, resetLogLevels } = await import('@airo-js/log');
    for (const page of ['draft', 'artist', 'age-gate']) {
      const captured: { level: string }[] = [];
      setSink({ emit: (e) => captured.push({ level: e.level }) });
      setLogLevel('debug');
      try {
        render(page);
      } finally {
        resetSink();
        resetLogLevels();
      }
      expect(captured.some((e) => e.level === 'warn')).toBe(false);
      expect(captured.some((e) => e.level === 'debug')).toBe(true);
    }
  });

  test('silent when nothing was requested — a gated embed surface never spams', async () => {
    const { setSink, resetSink, setLogLevel, resetLogLevels } = await import('@airo-js/log');
    const captured: unknown[] = [];
    setSink({ emit: (e) => captured.push(e) });
    setLogLevel('debug');
    try {
      render();
      render('roster');
    } finally {
      resetSink();
      resetLogLevels();
    }
    expect(captured).toHaveLength(0);
  });
});
