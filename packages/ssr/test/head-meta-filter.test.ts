/**
 * The default publication filter, and the trap it was built to avoid.
 *
 * A crawler bundle declared as `format: 'custom'` + `delivery: 'host-decides'`
 * fails BOTH halves of the pre-0.9 default filter, so it would have run
 * zero times and the `<head>` would have stayed silently empty. The fix was
 * a dedicated `'head-meta'` format member rather than widening the default
 * to `'custom'` — widening would drag every `llms.txt` and feed adapter onto
 * the render hot path and then discard the output.
 *
 * Both halves of that decision are pinned here.
 */

import { describe, expect, test } from 'vitest';

import type { AppConfig, PageRenderer } from '@airo-js/core';
import type { Cartridge, PublicationAdapter } from '@airo-js/cartridge-kit';

import { renderAppWithPublication } from '../src/render-with-publication.js';

interface D {
  marker: string;
}
interface C {
  locale?: string;
}

function adapter(
  id: string,
  format: PublicationAdapter<D, unknown, C>['format'],
  delivery: PublicationAdapter<D, unknown, C>['delivery'] = 'inline-in-host',
): PublicationAdapter<D, unknown, C> & { ran: () => number } {
  let runs = 0;
  const a: PublicationAdapter<D, unknown, C> = {
    id,
    displayName: id,
    description: id,
    format,
    delivery,
    requires: [],
    refreshCadence: { min: { ms: 0 }, max: { ms: 1000 } },
    async generate() {
      runs += 1;
      return {
        canonical: 'https://x.test/a',
        openGraph: { 'og:title': `from-${id}` },
        twitterCard: { 'twitter:card': 'summary' },
        sitemap: { loc: 'https://x.test/a' },
      };
    },
    validate: () => ({ valid: true, errors: [], warnings: [] }),
  };
  return Object.assign(a, { ran: () => runs });
}

function cartridge(adapters: PublicationAdapter<D, unknown, C>[]): Cartridge<D, C> {
  return {
    id: 'filter-test',
    industry: 'test',
    displayName: 'Filter Test',
    description: 'Fixture.',
    version: '0.0.0',
    mailboxName: '__AIRO_FILTER_TEST_PAGES__',
    schema: {
      parse: (i: unknown) => i as D,
      safeParse: (i: unknown) => ({ success: true as const, data: i as D }),
    },
    dataSources: [],
    views: [
      {
        id: 'home-view',
        displayName: 'Home',
        pageType: 'home',
        factory: (): PageRenderer => ({
          render: (c) => {
            c.innerHTML = '<p>widget</p>';
          },
          destroy: () => undefined,
        }),
      },
    ],
    templates: [],
    publicationAdapters: adapters,
  };
}

const appConfig: AppConfig = {
  appId: 'test',
  pages: [{ id: 'home', type: 'home', enabled: true }],
};

async function render(adapters: PublicationAdapter<D, unknown, C>[]) {
  return renderAppWithPublication<D, C>({
    cartridge: cartridge(adapters),
    appConfig,
    snapshot: { marker: 'x' },
    publicationCtx: { config: {}, locale: 'en', country: 'GB' },
    document: globalThis.document,
  });
}

describe('default publication filter', () => {
  test('RUNS head-meta adapters — the regression that made the head silently empty', async () => {
    const a = adapter('crawler', 'head-meta');
    const result = await render([a]);
    expect(a.ran()).toBe(1);
    expect(result.adapterResults.map((r) => r.adapterId)).toContain('crawler');
  });

  test('head-meta output does NOT get inlined into the html', async () => {
    // It belongs in <head> via headFromPublication, not in the fragment.
    const result = await render([adapter('crawler', 'head-meta')]);
    expect(result.html).not.toContain('og:title');
    expect(result.html).not.toContain('from-crawler');
    expect(result.html).toContain('widget');
  });

  test('still runs and inlines json-ld, unchanged', async () => {
    const result = await render([adapter('jsonld', 'json-ld')]);
    expect(result.html).toContain('application/ld+json');
  });

  test('does NOT run format: custom — no llms.txt on the render hot path', async () => {
    const a = adapter('llms-txt', 'custom', 'host-decides');
    const result = await render([a]);
    expect(a.ran()).toBe(0);
    expect(result.adapterResults.map((r) => r.adapterId)).not.toContain('llms-txt');
  });

  test('an explicit filter still overrides the default', async () => {
    const a = adapter('llms-txt', 'custom', 'host-decides');
    await renderAppWithPublication<D, C>({
      cartridge: cartridge([a]),
      appConfig,
      snapshot: { marker: 'x' },
      publicationCtx: { config: {}, locale: 'en', country: 'GB' },
      document: globalThis.document,
      publicationFilter: {},
    });
    expect(a.ran()).toBe(1);
  });

  test('head-meta and json-ld coexist in one run', async () => {
    const head = adapter('crawler', 'head-meta');
    const ld = adapter('jsonld', 'json-ld');
    const result = await render([head, ld]);
    expect([head.ran(), ld.ran()]).toEqual([1, 1]);
    expect(result.adapterResults).toHaveLength(2);
  });
});
