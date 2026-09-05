/**
 * defineCrawlerSurfaceAdapter.
 *
 * The highest-value cases here are the validate() ones: `validate()` is a
 * HARD PUBLISH GATE, so "blocks on a missing canonical" and "blocks on a
 * relative canonical" are the tests that stop a page canonicalising to the
 * wrong url. The key-name contract test matters for a duller reason — a
 * rename of `og:title` would silently empty a `<head>` rather than fail
 * anything, so the exact strings are pinned.
 */

import { describe, expect, test } from 'vitest';

import type { PublicationAdapter, PublicationContext } from '../src/publication-adapter.js';
import {
  defineCrawlerSurfaceAdapter,
  type CrawlerSurfaceOutput,
} from '../src/define-crawler-surface-adapter.js';

interface Doc {
  title: string;
  summary: string;
  slug: string;
  updatedAt?: string;
  hero?: string;
}
interface Cfg {
  siteUrl: string;
  siteName?: string;
}

const ctx: PublicationContext<Cfg> = {
  config: { siteUrl: 'https://label.test', siteName: 'The Label' },
  locale: 'en-GB',
  country: 'GB',
};

const doc: Doc = {
  title: 'First Release',
  summary: 'A record.',
  slug: 'first-release',
  updatedAt: '2026-01-02T03:04:05.000Z',
};

type Options = Parameters<typeof defineCrawlerSurfaceAdapter<Doc, Cfg>>[0];

function build({ select, ...rest }: Partial<Options> = {}) {
  return defineCrawlerSurfaceAdapter<Doc, Cfg>({
    requires: [{ path: 'title', required: 'always' }],
    ...rest,
    // Merged, not replaced — `select` must keep the base projections when
    // a test overrides one of them.
    select: {
      canonical: (d, c) => `${c.config.siteUrl.replace(/\/$/, '')}/${d.slug}`,
      title: (d) => d.title,
      description: (d) => d.summary,
      siteName: (_d, c) => c.config.siteName,
      image: (d) => d.hero,
      lastModified: (d) => d.updatedAt,
      ...(select ?? {}),
    },
  });
}

describe('defineCrawlerSurfaceAdapter — shape and defaults', () => {
  test('produces an assignable PublicationAdapter', () => {
    const adapter = build();
    // A `satisfies`-style guard: if the contract shape ever drifts, this
    // fails at compile time rather than at a consumer.
    const asAdapter: PublicationAdapter<Doc, CrawlerSurfaceOutput, Cfg> = adapter;
    expect(asAdapter.id).toBe('crawler-surface');
  });

  test('defaults format to head-meta so the render filter picks it up', () => {
    // 'custom' + 'host-decides' would fail BOTH halves of
    // renderAppWithPublication's default filter and silently never run.
    expect(build().format).toBe('head-meta');
    expect(build().delivery).toBe('inline-in-host');
  });

  test('defaults onValidationFail to block-publish', () => {
    expect(build().onValidationFail).toBe('block-publish');
  });

  test('defaults refreshCadence to 0ms–24h', () => {
    expect(build().refreshCadence).toEqual({ min: { ms: 0 }, max: { ms: 86_400_000 } });
  });

  test('passes requires through verbatim', () => {
    const requires = [
      { path: 'title', required: 'always' as const },
      { path: 'hero', required: 'preferred' as const },
    ];
    expect(build({ requires }).requires).toEqual(requires);
  });

  test('id, displayName and description are overridable', () => {
    const a = build({ id: 'my-surface', displayName: 'Mine', description: 'Desc.' });
    expect([a.id, a.displayName, a.description]).toEqual(['my-surface', 'Mine', 'Desc.']);
  });
});

describe('defineCrawlerSurfaceAdapter — generate', () => {
  test('composes the canonical from selectors', async () => {
    const out = await build().generate(doc, ctx);
    expect(out.canonical).toBe('https://label.test/first-release');
  });

  test('emits the base OpenGraph keys', async () => {
    const out = await build().generate(doc, ctx);
    expect(out.openGraph).toEqual({
      'og:type': 'website',
      'og:url': 'https://label.test/first-release',
      'og:title': 'First Release',
      'og:description': 'A record.',
      'og:site_name': 'The Label',
    });
  });

  test('og:type is overridable', async () => {
    const out = await build({ select: { ogType: () => 'article' } as never }).generate(doc, ctx);
    expect(out.openGraph['og:type']).toBe('article');
  });

  test('no image → summary card, and no image keys at all', async () => {
    const out = await build().generate(doc, ctx);
    expect(out.twitterCard['twitter:card']).toBe('summary');
    expect(out.openGraph).not.toHaveProperty('og:image');
    expect(out.twitterCard).not.toHaveProperty('twitter:image');
  });

  test('image → large card plus both image keys', async () => {
    const out = await build().generate({ ...doc, hero: 'https://label.test/a.jpg' }, ctx);
    expect(out.twitterCard['twitter:card']).toBe('summary_large_image');
    expect(out.openGraph['og:image']).toBe('https://label.test/a.jpg');
    expect(out.twitterCard['twitter:image']).toBe('https://label.test/a.jpg');
  });

  test('an absent siteName omits the key rather than emitting empty', async () => {
    const out = await build().generate(doc, { ...ctx, config: { siteUrl: 'https://label.test' } });
    expect(out.openGraph).not.toHaveProperty('og:site_name');
  });

  test('extraOpenGraph merges last and can override a base key', async () => {
    const out = await build({
      select: {
        extraOpenGraph: () => ({ 'article:published_time': '2026-01-01', 'og:title': 'Overridden' }),
      } as never,
    }).generate(doc, ctx);
    expect(out.openGraph['article:published_time']).toBe('2026-01-01');
    expect(out.openGraph['og:title']).toBe('Overridden');
  });

  test('sitemap defaults loc to canonical and lastmod to lastModified', async () => {
    const out = await build().generate(doc, ctx);
    expect(out.sitemap).toEqual({
      loc: 'https://label.test/first-release',
      lastmod: '2026-01-02T03:04:05.000Z',
    });
  });

  test('a sitemap selector merges over the defaults', async () => {
    const out = await build({
      select: { sitemap: () => ({ changefreq: 'daily' as const, priority: 0.9 }) } as never,
    }).generate(doc, ctx);
    expect(out.sitemap.changefreq).toBe('daily');
    expect(out.sitemap.priority).toBe(0.9);
    expect(out.sitemap.loc).toBe('https://label.test/first-release');
  });

  test('lastmod is omitted when there is no lastModified', async () => {
    const out = await build().generate({ ...doc, updatedAt: undefined }, ctx);
    expect(out.sitemap).not.toHaveProperty('lastmod');
  });

  test('alternates are omitted when empty and passed through when present', async () => {
    expect(await build().generate(doc, ctx)).not.toHaveProperty('alternates');
    const withAlts = await build({
      select: { alternates: () => [{ hreflang: 'fr', href: 'https://label.test/fr' }] } as never,
    }).generate(doc, ctx);
    expect(withAlts.alternates).toEqual([{ hreflang: 'fr', href: 'https://label.test/fr' }]);
  });

  test('selectors receive both the snapshot and the publication context', async () => {
    const seen: unknown[] = [];
    await build({
      select: {
        title: (d: Doc, c: PublicationContext<Cfg>) => {
          seen.push([d.slug, c.locale, c.config.siteUrl]);
          return d.title;
        },
      } as never,
    }).generate(doc, ctx);
    expect(seen[0]).toEqual(['first-release', 'en-GB', 'https://label.test']);
  });

  test('is deterministic across calls', async () => {
    const a = build();
    expect(await a.generate(doc, ctx)).toEqual(await a.generate(doc, ctx));
  });

  test('the exact key names are a contract — a rename silently empties a <head>', async () => {
    const out = await build().generate({ ...doc, hero: 'https://label.test/a.jpg' }, ctx);
    expect(Object.keys(out.openGraph).sort()).toEqual([
      'og:description',
      'og:image',
      'og:site_name',
      'og:title',
      'og:type',
      'og:url',
    ]);
    expect(Object.keys(out.twitterCard).sort()).toEqual([
      'twitter:card',
      'twitter:description',
      'twitter:image',
      'twitter:title',
    ]);
  });
});

describe('defineCrawlerSurfaceAdapter — validate is a publish gate', () => {
  async function validated(overrides: Partial<CrawlerSurfaceOutput> = {}) {
    const adapter = build();
    const out = await adapter.generate(doc, ctx);
    return adapter.validate({ ...out, ...overrides });
  }

  test('a well-formed bundle is valid', async () => {
    expect((await validated()).valid).toBe(true);
  });

  test('BLOCKS on a missing canonical', async () => {
    const r = await validated({ canonical: '' });
    expect(r.valid).toBe(false);
    expect(r.errors.map((e) => e.code)).toContain('missing-canonical');
  });

  test('BLOCKS on a relative canonical — the most common real SEO defect', async () => {
    const r = await validated({ canonical: '/first-release' });
    expect(r.valid).toBe(false);
    expect(r.errors.map((e) => e.code)).toContain('canonical-not-absolute');
    expect(r.errors.find((e) => e.code === 'canonical-not-absolute')?.remediation).toBeTruthy();
  });

  test('blocks on a missing sitemap loc', async () => {
    const r = await validated({ sitemap: { loc: '' } });
    expect(r.valid).toBe(false);
    expect(r.errors.map((e) => e.code)).toContain('missing-sitemap-loc');
  });

  test('blocks on a missing og:title', async () => {
    const r = await validated({ openGraph: { 'og:description': 'd' } });
    expect(r.valid).toBe(false);
    expect(r.errors.map((e) => e.code)).toContain('missing-og-title');
  });

  test('warnings do NOT flip valid', async () => {
    const r = await validated(); // no image → missing-og-image warning
    expect(r.warnings.map((w) => w.code)).toContain('missing-og-image');
    expect(r.valid).toBe(true);
  });

  test('reports coverage over the optional enrichment fields', async () => {
    expect((await validated()).coverage).toEqual({ covered: 1, total: 2 }); // site_name, no image
    const adapter = build();
    const full = await adapter.generate({ ...doc, hero: 'https://label.test/a.jpg' }, ctx);
    expect(adapter.validate(full).coverage).toEqual({ covered: 2, total: 2 });
  });

  test('does NOT lint title or description length — that is content strategy', async () => {
    const adapter = build();
    const out = await adapter.generate({ ...doc, title: 'x'.repeat(400) }, ctx);
    const r = adapter.validate(out);
    expect(r.valid).toBe(true);
    expect([...r.errors, ...r.warnings].map((e) => e.code)).not.toContain('title-too-long');
  });
});
