// @vitest-environment node
/**
 * headFromPublication, and the end-to-end path it exists for.
 *
 * The single most valuable case in this file is
 * "`included: false` output never reaches the document". `validate()` is
 * advertised as a HARD PUBLISH GATE — an adapter that fails validation
 * under `block-publish` must not have its output served. This is where
 * that promise is kept for the `<head>`, so it gets an explicit test
 * rather than relying on the filter above it.
 */

import { describe, expect, test } from 'vitest';

import { defineCrawlerSurfaceAdapter } from '@airo-js/cartridge-kit';

import { headFromPublication } from '../src/head-from-publication.js';
import { renderDocument } from '../src/render-document.js';
import type { AdapterRunResult } from '../src/run-publication.js';

function result(over: Partial<AdapterRunResult> = {}): AdapterRunResult {
  return {
    adapterId: 'crawler-surface',
    format: 'head-meta',
    delivery: 'inline-in-host',
    output: {
      canonical: 'https://x.test/a',
      openGraph: { 'og:title': 'T' },
      twitterCard: { 'twitter:card': 'summary' },
      sitemap: { loc: 'https://x.test/a' },
    },
    validation: { valid: true, errors: [], warnings: [] },
    included: true,
    ...over,
  } as AdapterRunResult;
}

describe('headFromPublication', () => {
  test('folds canonical, openGraph and twitterCard into a head patch', () => {
    expect(headFromPublication([result()])).toEqual({
      canonical: 'https://x.test/a',
      openGraph: { 'og:title': 'T' },
      twitter: { 'twitter:card': 'summary' },
    });
  });

  test('SKIPS included: false — the hard publish gate', () => {
    expect(headFromPublication([result({ included: false })])).toEqual({});
  });

  test('keys on SHAPE, not on adapter id — a hand-written adapter works the same', () => {
    const patch = headFromPublication([
      result({ adapterId: 'something-nobody-has-heard-of', format: 'custom' }),
    ]);
    expect(patch.canonical).toBe('https://x.test/a');
  });

  test('ignores outputs that carry no head metadata', () => {
    expect(headFromPublication([result({ output: { rows: [1, 2] } })])).toEqual({});
    expect(headFromPublication([result({ output: 'a string' })])).toEqual({});
    expect(headFromPublication([result({ output: null })])).toEqual({});
  });

  test('merges og/twitter records key-by-key across adapters', () => {
    const patch = headFromPublication([
      result({ output: { openGraph: { 'og:title': 'T' } } }),
      result({ output: { openGraph: { 'og:image': 'https://x.test/i.jpg' } } }),
    ]);
    expect(patch.openGraph).toEqual({ 'og:title': 'T', 'og:image': 'https://x.test/i.jpg' });
  });

  test('later adapters win on a conflicting key', () => {
    const patch = headFromPublication([
      result({ output: { openGraph: { 'og:title': 'first' } } }),
      result({ output: { openGraph: { 'og:title': 'second' } } }),
    ]);
    expect(patch.openGraph!['og:title']).toBe('second');
  });

  test('EXCLUDES json-ld by default — renderAppWithPublication already inlined it', () => {
    const patch = headFromPublication([
      result({ format: 'json-ld', output: { '@type': 'Product' } }),
    ]);
    expect(patch.jsonLd).toBeUndefined();
  });

  test('includeJsonLd: true folds it in for the compose-it-yourself path', () => {
    const patch = headFromPublication(
      [result({ format: 'json-ld', output: { '@type': 'Product' } })],
      { includeJsonLd: true },
    );
    expect(patch.jsonLd).toEqual([{ '@type': 'Product' }]);
  });

  test('an empty result set yields an empty patch', () => {
    expect(headFromPublication([])).toEqual({});
  });
});

describe('adapter → head → document, end to end', () => {
  interface Doc {
    title: string;
    slug: string;
  }
  interface Cfg {
    siteUrl: string;
  }

  const adapter = defineCrawlerSurfaceAdapter<Doc, Cfg>({
    requires: [{ path: 'title', required: 'always' }],
    select: {
      canonical: (d, c) => `${c.config.siteUrl}/${d.slug}`,
      title: (d) => d.title,
      description: () => 'A record.',
    },
  });

  const ctx = { config: { siteUrl: 'https://label.test' }, locale: 'en', country: 'GB' };

  test('a valid bundle reaches the document in the right attribute forms', async () => {
    const output = await adapter.generate({ title: 'First', slug: 'first' }, ctx);
    const validation = adapter.validate(output);
    expect(validation.valid).toBe(true);

    const html = renderDocument({
      head: {
        lang: 'en',
        title: 'First',
        ...headFromPublication([
          { adapterId: adapter.id, format: 'head-meta', delivery: 'inline-in-host', output, validation, included: true } as AdapterRunResult,
        ]),
      },
      body: '<main>hi</main>',
    });

    expect(html).toContain('<link rel="canonical" href="https://label.test/first">');
    expect(html).toContain('<meta property="og:title" content="First">');
    expect(html).toContain('<meta name="twitter:card" content="summary">');
  });

  test('a bundle blocked by validate() NEVER reaches the document', async () => {
    // Relative canonical → canonical-not-absolute → valid: false →
    // runPublicationAdapters sets included: false under block-publish.
    const bad = defineCrawlerSurfaceAdapter<Doc, Cfg>({
      requires: [],
      select: {
        canonical: (d) => `/${d.slug}`,
        title: (d) => d.title,
        description: () => 'A record.',
      },
    });
    const output = await bad.generate({ title: 'First', slug: 'first' }, ctx);
    const validation = bad.validate(output);
    expect(validation.valid).toBe(false);

    const html = renderDocument({
      head: {
        lang: 'en',
        ...headFromPublication([
          { adapterId: bad.id, format: 'head-meta', delivery: 'inline-in-host', output, validation, included: false } as AdapterRunResult,
        ]),
      },
      body: '',
    });

    expect(html).not.toContain('canonical');
    expect(html).not.toContain('og:title');
  });
});
