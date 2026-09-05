/**
 * `fellBack` — the soft-404 seam.
 *
 * The entry resolver deliberately substitutes the default entry for a
 * requested page it rejects, so a tampered or stale deeplink can never
 * crash a render. That is correct for an embedded widget whose HOST owns
 * the URL and its status code.
 *
 * It is a trap for an app that owns its own URLs: `/does-not-exist` renders
 * the home page with a 200 and a canonical of `/`. Search engines penalise
 * that, and nothing errors or warns — a consumer shipped it without
 * noticing. The fallback stays; the decision stops being discarded.
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
