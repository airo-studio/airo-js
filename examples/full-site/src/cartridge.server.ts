/**
 * The docs-site cartridge — its server half.
 *
 * `cartridge.ts` is what the browser loads. This file adds the two things a
 * browser never needs: publication adapters (what crawlers, `llms.txt` and
 * indexers read) and MCP tools (what agents call). Only `server.ts` imports
 * it, so none of it reaches `client.js` — the two-envelope pattern, at the
 * file boundary rather than through bundler configuration.
 *
 * Until 0.11.1 these lived in `cartridge.ts` and the browser bundle carried
 * all four adapters and both tools: bytes every reader downloaded for
 * nothing, and a place a tool closing over a server credential would have
 * shipped it to every browser. The smoke now checks the bundle for their
 * names.
 *
 * Everything here reads the same post-transformer snapshot the views
 * render, which is what makes the page, its metadata and an agent's answer
 * unable to disagree.
 */

import {
  defineCrawlerSurfaceAdapter,
  type Cartridge,
  type McpToolDefinition,
  type PublicationAdapter,
  type ValidationResult,
} from '@airo-js/cartridge-kit';
import { escapeAttr, escapeHtml } from '@airo-js/core';

import { docSiteCartridge, type DocSiteConfig, type DocSiteData } from './cartridge.js';

// ───────────────────────── MCP tools ─────────────────────────

const listPages: McpToolDefinition<DocSiteData, DocSiteConfig> = {
  name: 'list_pages',
  description: 'List every published page on the site with its url and summary.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_input, ctx) {
    return {
      pages: ctx.data.index.map((d) => ({
        url: `${ctx.data.site.url}/doc/${d.slug}`,
        title: d.title,
        summary: d.description,
      })),
    };
  },
};

const getSection: McpToolDefinition<DocSiteData, DocSiteConfig> = {
  name: 'get_section',
  description: 'Return one section of the current document by its anchor id.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const { id } = input as { id: string };
    const section = ctx.data.doc?.sections.find((s) => s.id === id);
    return section
      ? { id: section.id, title: section.title, html: section.html }
      : { error: `no section "${id}"` };
  },
};

// ──────────────────── publication adapters ────────────────────

function pageUrl(data: DocSiteData): string {
  const base = data.site.url.replace(/\/$/, '');
  return data.doc ? `${base}/doc/${data.doc.slug}` : base;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Canonical, OpenGraph, Twitter Card and a sitemap entry — from the 0.9.0
 * factory rather than by hand. It defaults to `format: 'head-meta'`, which
 * is what puts it inside `renderAppWithPublication`'s default filter; the
 * hand-rolled predecessor declared `format: 'custom'` and would silently
 * never have run.
 *
 * `canonical` returns `''` for a doc missing `updatedAt`, and `validate()`
 * blocks publish on a missing canonical. That is not a trick — a page that
 * cannot say when it was last meaningfully changed is not finished, and a
 * page that cannot say where it canonically lives should not reach a
 * crawler. One rule, enforced by the framework, no custom validator.
 *
 * None of these adapters ever see a `member` slice: the runner runs no
 * adapter for a private entry, and the machine routes build their
 * snapshots without a session.
 */
const crawlerSurface = defineCrawlerSurfaceAdapter<DocSiteData, DocSiteConfig>({
  id: 'crawler-surface',
  requires: [
    { path: 'site', required: 'always' },
    { path: 'doc.title', required: 'preferred' },
    { path: 'doc.updatedAt', required: 'preferred' },
  ],
  select: {
    canonical: (d) => (d.doc && !d.doc.updatedAt ? '' : pageUrl(d)),
    title: (d) => (d.doc ? d.doc.title : d.site.name),
    description: (d) => (d.doc ? d.doc.description : d.site.tagline),
    siteName: (d) => d.site.name,
    lastModified: (d) => d.doc?.updatedAt || undefined,
    ogType: (d) => (d.doc ? 'article' : 'website'),
    sitemap: (d) => ({ changefreq: 'weekly', priority: d.doc ? 0.7 : 1.0 }),
  },
});

const jsonLd: PublicationAdapter<DocSiteData, unknown, DocSiteConfig> = {
  id: 'schema-org-jsonld',
  displayName: 'Schema.org JSON-LD',
  description: 'TechArticle for a doc page, WebSite for the index. Inlined into the served HTML.',
  format: 'json-ld',
  delivery: 'inline-in-host',
  requires: [{ path: 'site', required: 'always' }],
  refreshCadence: { min: { ms: 0 }, max: { ms: 86_400_000 } },
  async generate(data) {
    const url = pageUrl(data);
    if (!data.doc) {
      return {
        '@context': 'https://schema.org',
        '@type': 'WebSite',
        name: data.site.name,
        url,
        description: data.site.tagline,
      };
    }
    return {
      '@context': 'https://schema.org',
      '@type': 'TechArticle',
      headline: data.doc.title,
      description: data.doc.description,
      url,
      datePublished: data.doc.publishedAt,
      dateModified: data.doc.updatedAt,
      keywords: data.doc.tags.join(', '),
    };
  },
  validate(output): ValidationResult {
    const o = output as { headline?: string; name?: string; url?: string };
    const errors = !o.url
      ? [{ code: 'missing-url', path: 'url', message: 'JSON-LD requires a url.' }]
      : [];
    return { valid: errors.length === 0, errors, warnings: [] };
  },
};

/**
 * `llms.txt` as a generated adapter rather than a hand-maintained file —
 * an index line for the site manifest plus a full-text dump for assistants
 * that fetch `llms-full.txt`. `format: 'custom'`, so it deliberately does
 * NOT run on the render hot path; the server calls it on its own routes.
 */
const llmsTxt: PublicationAdapter<DocSiteData, unknown, DocSiteConfig> = {
  id: 'llms-txt',
  displayName: 'llms.txt fragment',
  description: 'Index line for /llms.txt plus a full-text dump for /llms-full.txt.',
  format: 'custom',
  delivery: 'host-decides',
  // `site` is the only field BOTH branches of generate() read. `doc` is
  // 'preferred', not 'always': the index snapshot has no doc and still
  // yields a line — the `!data.doc` branch below is the /llms.txt heading.
  // An 'always' here made that branch unreachable, so on 0.10.0 the file
  // silently lost its `# heading`. The smoke now checks for it.
  requires: [
    { path: 'site', required: 'always' },
    { path: 'doc.sections', required: 'preferred' },
  ],
  refreshCadence: { min: { ms: 0 }, max: { ms: 86_400_000 } },
  async generate(data) {
    if (!data.doc) {
      return {
        indexLine: `# ${data.site.name}\n\n> ${data.site.tagline}`,
        fullText: `# ${data.site.name}\n\n${data.site.tagline}\n`,
      };
    }
    const url = pageUrl(data);
    const dump = data.doc.sections
      .map((s) => `## ${s.title}\n\n${stripHtml(s.html)}`)
      .join('\n\n');
    return {
      indexLine: `- [${data.doc.title}](${url}): ${data.doc.description}`,
      fullText: `# ${data.doc.title}\n\n${data.doc.description}\n\n${dump}\n`,
    };
  },
  validate(output): ValidationResult {
    const o = output as { indexLine?: string; fullText?: string };
    const errors = [];
    if (!o.indexLine) {
      errors.push({ code: 'missing-index-line', path: 'indexLine', message: 'Needs an index line.' });
    }
    if (!o.fullText) {
      errors.push({ code: 'missing-full-text', path: 'fullText', message: 'Needs a full-text dump.' });
    }
    return { valid: errors.length === 0, errors, warnings: [] };
  },
};

/**
 * Schema.org **microdata** — the inline-with-content alternative to JSON-LD,
 * for indexers that read attributes off the markup rather than a script block.
 *
 * Carried over from the predecessor cartridge because it is a genuinely
 * distinct audience surface, not a duplicate of the JSON-LD adapter: same
 * snapshot, same facts, different encoding. Emitting both is normal and they
 * cannot disagree, which is the entire argument for one snapshot.
 *
 * `format: 'custom'` — the host decides where this fragment goes.
 */
const microdata: PublicationAdapter<DocSiteData, unknown, DocSiteConfig> = {
  id: 'schema-org-microdata',
  displayName: 'Schema.org microdata (HTML)',
  description: 'HTML fragment with itemtype/itemprop attributes, for indexers that read microdata.',
  format: 'custom',
  delivery: 'host-decides',
  requires: [{ path: 'doc.title', required: 'always' }],
  refreshCadence: { min: { ms: 0 }, max: { ms: 86_400_000 } },
  async generate(data, ctx) {
    if (!data.doc) return { fragment: '' };
    const url = pageUrl(data);
    const keywords = data.doc.tags
      .map((t) => `  <meta itemprop="keywords" content="${escapeAttr(t)}">`)
      .join('\n');
    return {
      fragment: [
        '<article itemscope itemtype="https://schema.org/TechArticle">',
        `  <meta itemprop="url" content="${escapeAttr(url)}">`,
        `  <meta itemprop="inLanguage" content="${escapeAttr(ctx.locale)}">`,
        `  <meta itemprop="datePublished" content="${escapeAttr(data.doc.publishedAt)}">`,
        `  <meta itemprop="dateModified" content="${escapeAttr(data.doc.updatedAt)}">`,
        `  <h1 itemprop="headline">${escapeHtml(data.doc.title)}</h1>`,
        `  <p itemprop="description">${escapeHtml(data.doc.description)}</p>`,
        keywords,
        '</article>',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  },
  validate(output): ValidationResult {
    const o = output as { fragment?: string };
    const errors = !o.fragment
      ? [{ code: 'empty-fragment', path: 'fragment', message: 'Microdata fragment is empty.' }]
      : [];
    return { valid: errors.length === 0, errors, warnings: [] };
  },
};

// ─────────────────────────── cartridge ───────────────────────────

/** The browser cartridge plus its adapters and tools. Server only. */
export const docSiteServerCartridge: Cartridge<DocSiteData, DocSiteConfig> = {
  ...docSiteCartridge,
  mcpTools: [listPages, getSection],
  publicationAdapters: [jsonLd, crawlerSurface, llmsTxt, microdata],
};
