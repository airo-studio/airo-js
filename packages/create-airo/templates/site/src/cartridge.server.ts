/**
 * Your cartridge — the server half.
 *
 * The browser cartridge plus two things browsers never need: publication
 * adapters (what search engines and assistants read) and MCP tools (what AI
 * agents call). Only `server.ts` imports this file, so none of it reaches
 * `client.js`.
 *
 * Everything here reads the same snapshot the views render. That is the
 * point: the page, its metadata and an agent's answer cannot disagree.
 *
 * ## `requires`
 *
 * Adapters and tools declare which snapshot fields they need, and the paths
 * are type-checked against `SiteData`. At run time a declaration whose
 * `required: 'always'` fields are missing is skipped, and the result names
 * what was missing. Mark a field `'always'` only if the adapter truly cannot
 * produce anything without it; an over-declared `'always'` silently stops
 * that adapter from publishing.
 */

import {
  defineCrawlerSurfaceAdapter,
  type Cartridge,
  type McpToolDefinition,
  type PublicationAdapter,
  type ValidationResult,
} from '@airo-js/cartridge-kit';

import { isPublished, siteCartridge, type SiteConfig, type SiteData } from './cartridge.js';

function pageUrl(data: SiteData): string {
  const base = data.site.url.replace(/\/$/, '');
  return data.post ? `${base}/post/${data.post.slug}` : base;
}

// ──────────────────── publication adapters ────────────────────

/**
 * Canonical url, OpenGraph, Twitter Card and a sitemap entry.
 *
 * Built with the factory, which declares `format: 'head-meta'`. That format
 * is what puts it on the page-render path: an adapter declared as
 * `format: 'custom'` would never run there, and nothing would tell you.
 *
 * An empty canonical is how a page is kept off search engines: `validate()`
 * rejects it, `server.ts` answers 404, and the sitemap leaves it out.
 */
const crawlerSurface = defineCrawlerSurfaceAdapter<SiteData, SiteConfig>({
  id: 'crawler-surface',
  requires: [
    { path: 'site', required: 'always' },
    // The index has no post and still gets metadata, so these are only preferred.
    { path: 'post.title', required: 'preferred' },
    { path: 'post.updatedAt', required: 'preferred' },
  ],
  select: {
    canonical: (d) => (d.post && !isPublished(d.post) ? '' : pageUrl(d)),
    title: (d) => (d.post ? d.post.title : d.site.name),
    description: (d) => (d.post ? d.post.description : d.site.tagline),
    siteName: (d) => d.site.name,
    lastModified: (d) => d.post?.updatedAt || undefined,
    ogType: (d) => (d.post ? 'article' : 'website'),
    sitemap: (d) => ({ changefreq: 'weekly', priority: d.post ? 0.7 : 1.0 }),
  },
});

/** Schema.org structured data, written into the page as `<script type="application/ld+json">`. */
const jsonLd: PublicationAdapter<SiteData, Record<string, unknown>, SiteConfig> = {
  id: 'schema-org-jsonld',
  displayName: 'Schema.org JSON-LD',
  description: 'BlogPosting for a post, WebSite for the index.',
  format: 'json-ld',
  delivery: 'inline-in-host',
  requires: [{ path: 'site', required: 'always' }],
  refreshCadence: { min: { ms: 0 }, max: { ms: 86_400_000 } },
  async generate(data) {
    const url = pageUrl(data);
    if (!data.post) {
      return { '@context': 'https://schema.org', '@type': 'WebSite', name: data.site.name, url };
    }
    return {
      '@context': 'https://schema.org',
      '@type': 'BlogPosting',
      headline: data.post.title,
      description: data.post.description,
      url,
      datePublished: data.post.publishedAt,
      dateModified: data.post.updatedAt,
    };
  },
  validate(output): ValidationResult {
    const errors = output.url ? [] : [{ code: 'missing-url', path: 'url', message: 'JSON-LD needs a url.' }];
    return { valid: errors.length === 0, errors, warnings: [] };
  },
};

export interface LlmsTxtOutput {
  /** One line for `/llms.txt`. */
  line: string;
}

/**
 * A line for `/llms.txt`, the index file some AI assistants read.
 *
 * `format: 'custom'` on purpose: it should NOT run on every page render.
 * `server.ts` runs it on its own route.
 */
const llmsTxt: PublicationAdapter<SiteData, LlmsTxtOutput, SiteConfig> = {
  id: 'llms-txt',
  displayName: 'llms.txt line',
  description: 'The index heading, or one line per post.',
  format: 'custom',
  delivery: 'host-decides',
  requires: [
    // `site` is the only field both branches below read. The index has no
    // post, so `post` is only preferred — marking it 'always' would skip the
    // index and silently drop the file's heading.
    { path: 'site', required: 'always' },
    { path: 'post.title', required: 'preferred' },
  ],
  refreshCadence: { min: { ms: 0 }, max: { ms: 86_400_000 } },
  async generate(data) {
    if (!data.post) return { line: `# ${data.site.name}\n\n> ${data.site.tagline}\n` };
    return { line: `- [${data.post.title}](${pageUrl(data)}): ${data.post.description}` };
  },
  validate(output): ValidationResult {
    const errors = output.line ? [] : [{ code: 'empty-line', path: 'line', message: 'Needs a line.' }];
    return { valid: errors.length === 0, errors, warnings: [] };
  },
};

// ───────────────────────── MCP tools ─────────────────────────
//
// What an AI agent can call, from `server.ts`'s `/mcp/tools` and `/mcp/call`.
// A handler may close over server secrets — that is why tools live in this
// file, and why `server.ts` never returns a failed call's `cause` to the
// caller.

const listPosts: McpToolDefinition<SiteData, SiteConfig> = {
  name: 'list_posts',
  description: 'List every published post with its url and summary.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_input, ctx) {
    const base = ctx.data.site.url.replace(/\/$/, '');
    return {
      posts: ctx.data.posts.filter(isPublished).map((p) => ({
        url: `${base}/post/${p.slug}`,
        title: p.title,
        summary: p.description,
      })),
    };
  },
};

const getSection: McpToolDefinition<SiteData, SiteConfig> = {
  name: 'get_section',
  description: 'Return one section of the current post by its anchor id.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  // Called without a post, this tool is refused before the handler runs,
  // and the refusal says `post.sections` was missing.
  requires: [{ path: 'post.sections', required: 'always' }],
  async handler(input, ctx) {
    const { id } = input as { id: string };
    const section = ctx.data.post?.sections.find((s) => s.id === id);
    return section ? { id: section.id, title: section.title, html: section.html } : { error: `no section "${id}"` };
  },
};

// ─────────────────────────── cartridge ───────────────────────────

export const siteServerCartridge: Cartridge<SiteData, SiteConfig> = {
  ...siteCartridge,
  publicationAdapters: [jsonLd, crawlerSurface, llmsTxt],
  mcpTools: [listPosts, getSection],
};
