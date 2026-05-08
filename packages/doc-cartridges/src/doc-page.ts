/**
 * DocPage cartridge — schema-driven documentation page with full AIO
 * surface coverage.
 *
 * Pre-structured input shape at v0: consumers parse markdown to DocPageData
 * upstream and feed it via the json-input data source. A markdown DataSource
 * follows in a subsequent commit (after a deliberate call on hand-rolled vs
 * vetted-tiny-dep parsing).
 *
 * Surfaces emitted:
 *   - View: HTML doc page (TOC + sectioned body, microdata-annotated)
 *   - MCP tools: list_headings, get_section
 *   - PublicationAdapters:
 *       1. Schema.org JSON-LD (TechArticle) — inline AI-Overview surface
 *       2. llms.txt fragment + per-page full-text dump
 *       3. Schema.org microdata (HTML) — inline-with-content alternative to JSON-LD
 *       4. Classic crawler bundle — canonical, sitemap, OpenGraph, Twitter Card
 */

import type {
  Cartridge,
  CartridgeAppContext,
  DataSource,
  McpToolDefinition,
  PublicationAdapter,
  SchemaDefinition,
  Template,
  Transformer,
  ValidationError,
  ValidationResult,
  ViewDefinition,
} from '@airo-js/cartridge-kit';
import type { PageRenderer } from '@airo-js/core';

// ────────────────────────────── Types ─────────────────────────────

export type DocPageHeadingDepth = 1 | 2 | 3 | 4 | 5 | 6;

export interface DocPageHeading {
  /** Slug-derived; HTML anchor. */
  id: string;
  depth: DocPageHeadingDepth;
  title: string;
}

export interface DocPageSection {
  id: string;
  depth: DocPageHeadingDepth;
  title: string;
  /** HTML for the section body (between this heading and the next sibling-or-shallower heading). */
  html: string;
}

export interface DocPageCodeBlock {
  /** Fence language tag — 'ts', 'js', 'bash', etc. Empty string when unspecified. */
  language: string;
  code: string;
  /** Section this block lives under, by section id. */
  sectionId: string;
}

export interface DocPageAuthor {
  name: string;
  url?: string;
}

export interface DocPageData {
  // Identity
  slug: string;
  title: string;
  description: string;

  // Timestamps (ISO 8601)
  publishedAt: string;
  updatedAt: string;

  // Optional metadata
  author?: DocPageAuthor;
  tags?: string[];
  /** OG image URL — used by the crawler-bundle adapter and JSON-LD. */
  ogImage?: string;

  // Body
  /** Flat heading outline, document order. */
  headings: DocPageHeading[];
  /** Sectioned body. */
  sections: DocPageSection[];
  /** Flat list of code blocks across the whole page. */
  codeBlocks: DocPageCodeBlock[];
}

export interface DocPageConfig {
  /** Origin of the host site — used for canonical / OG / sitemap urls. */
  siteUrl: string;
  siteName: string;
  /** Path prefix where doc pages live, e.g. '/docs'. */
  pathPrefix: string;
  /** Whether to render an in-page table of contents. */
  showTableOfContents: boolean;
  /** Maximum heading depth to include in TOC and structured-data outline. */
  tocMaxDepth: DocPageHeadingDepth;
  /** BCP-47 — e.g. 'en', 'en-GB'. */
  locale: string;
}

// ────────────────────────── Schema (validator) ────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseDocPageData(input: unknown): DocPageData {
  if (!isObject(input)) {
    throw new Error('DocPageData must be an object.');
  }
  const requiredStrings = ['slug', 'title', 'description', 'publishedAt', 'updatedAt'] as const;
  for (const k of requiredStrings) {
    if (typeof input[k] !== 'string') {
      throw new Error(`DocPageData.${k} must be a string.`);
    }
  }
  const requiredArrays = ['headings', 'sections', 'codeBlocks'] as const;
  for (const k of requiredArrays) {
    if (!Array.isArray(input[k])) {
      throw new Error(`DocPageData.${k} must be an array.`);
    }
  }
  return input as unknown as DocPageData;
}

const docPageJsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'DocPageData',
  type: 'object',
  required: [
    'slug',
    'title',
    'description',
    'publishedAt',
    'updatedAt',
    'headings',
    'sections',
    'codeBlocks',
  ],
  properties: {
    slug: { type: 'string' },
    title: { type: 'string' },
    description: { type: 'string' },
    publishedAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    author: {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' }, url: { type: 'string' } },
    },
    tags: { type: 'array', items: { type: 'string' } },
    ogImage: { type: 'string' },
    headings: { type: 'array', items: { $ref: '#/definitions/heading' } },
    sections: { type: 'array', items: { $ref: '#/definitions/section' } },
    codeBlocks: { type: 'array', items: { $ref: '#/definitions/codeBlock' } },
  },
  definitions: {
    heading: {
      type: 'object',
      required: ['id', 'depth', 'title'],
      properties: {
        id: { type: 'string' },
        depth: { type: 'integer', minimum: 1, maximum: 6 },
        title: { type: 'string' },
      },
    },
    section: {
      type: 'object',
      required: ['id', 'depth', 'title', 'html'],
      properties: {
        id: { type: 'string' },
        depth: { type: 'integer', minimum: 1, maximum: 6 },
        title: { type: 'string' },
        html: { type: 'string' },
      },
    },
    codeBlock: {
      type: 'object',
      required: ['language', 'code', 'sectionId'],
      properties: {
        language: { type: 'string' },
        code: { type: 'string' },
        sectionId: { type: 'string' },
      },
    },
  },
} as const;

const docPageSchema: SchemaDefinition<DocPageData> = {
  parse: parseDocPageData,
  safeParse(input) {
    try {
      return { success: true, data: parseDocPageData(input) };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e : new Error(String(e)) };
    }
  },
  toJsonSchema: () => docPageJsonSchema as unknown as Record<string, unknown>,
};

// ─────────────────────────── DataSource ───────────────────────────

const jsonInputDataSource: DataSource<DocPageData, DocPageConfig> = {
  id: 'json-input',
  displayName: 'Pre-structured DocPageData (JSON)',
  onboardingShape: { kind: 'custom', descriptor: 'doc-page-json' },
  async fetch(input, _ctx) {
    if (input.kind !== 'custom') {
      throw new Error(`json-input DataSource expects 'custom' input; got '${input.kind}'.`);
    }
    return parseDocPageData(input.payload);
  },
};

// ─────────────────────────── Transformer ──────────────────────────

/**
 * Idempotent: if a heading or section was authored without an explicit id,
 * derive it from the title. Sections whose title matches a heading's title
 * end up with the same id, which is what the in-page TOC relies on.
 */
const slugifyAnchorIds: Transformer<DocPageData, DocPageConfig> = {
  name: 'slugify-anchor-ids',
  isEnabled: () => true,
  transform(data) {
    const headings = data.headings.map((h) => ({ ...h, id: h.id || slugify(h.title) }));
    const sections = data.sections.map((s) => ({ ...s, id: s.id || slugify(s.title) }));
    return { ...data, headings, sections };
  },
};

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

// ─────────────────────────── MCP tools ────────────────────────────

const listHeadingsTool: McpToolDefinition<DocPageData, DocPageConfig> = {
  name: 'list_headings',
  description:
    'Return the heading outline of this doc page. Each heading has an id (anchor), a depth (1-6), and a title.',
  inputSchema: {
    type: 'object',
    properties: {
      maxDepth: { type: 'integer', minimum: 1, maximum: 6 },
    },
  },
  async handler(input, ctx) {
    const maxDepth =
      isObject(input) && typeof input.maxDepth === 'number'
        ? Math.min(6, Math.max(1, Math.floor(input.maxDepth)))
        : 6;
    return {
      headings: ctx.data.headings.filter((h) => h.depth <= maxDepth),
    };
  },
};

const getSectionTool: McpToolDefinition<DocPageData, DocPageConfig> = {
  name: 'get_section',
  description: 'Return the HTML body of a specific section, looked up by section id (slug).',
  inputSchema: {
    type: 'object',
    required: ['sectionId'],
    properties: { sectionId: { type: 'string' } },
  },
  async handler(input, ctx) {
    if (!isObject(input) || typeof input.sectionId !== 'string') {
      throw new Error('get_section requires { sectionId: string }.');
    }
    const section = ctx.data.sections.find((s) => s.id === input.sectionId);
    return section ? { found: true as const, section } : { found: false as const };
  },
};

// ──────────────────────────────── View ────────────────────────────

const docPageRendererFactory: () => PageRenderer<
  string,
  CartridgeAppContext<DocPageData, DocPageConfig>
> = () => ({
  render(targetEl, ctx) {
    targetEl.innerHTML = renderDocPageHtml(ctx.app.data, ctx.app.config);
  },
  destroy() {
    /* declarative render — nothing to tear down */
  },
  renderSSR(targetEl, ctx) {
    targetEl.innerHTML = renderDocPageHtml(ctx.app.data, ctx.app.config);
  },
});

function renderDocPageHtml(data: DocPageData, config: DocPageConfig): string {
  const toc = config.showTableOfContents
    ? renderTableOfContents(data.headings, config.tocMaxDepth)
    : '';
  const body = data.sections.map(renderSection).join('');
  const byline = data.author
    ? `<p class="doc-page__byline">By <span itemprop="author">${escapeHtml(data.author.name)}</span></p>`
    : '';

  return [
    `<article class="doc-page" itemscope itemtype="https://schema.org/TechArticle">`,
    `  <header class="doc-page__header">`,
    `    <h1 itemprop="headline">${escapeHtml(data.title)}</h1>`,
    `    <p class="doc-page__description" itemprop="description">${escapeHtml(data.description)}</p>`,
    `    ${byline}`,
    `    <p class="doc-page__updated"><time itemprop="dateModified" datetime="${escapeAttr(data.updatedAt)}">Updated ${formatDate(data.updatedAt)}</time></p>`,
    `  </header>`,
    `  ${toc}`,
    `  <div class="doc-page__body" itemprop="articleBody">${body}</div>`,
    `</article>`,
  ].join('\n');
}

function renderTableOfContents(headings: DocPageHeading[], maxDepth: DocPageHeadingDepth): string {
  const visible = headings.filter((h) => h.depth <= maxDepth);
  if (visible.length === 0) return '';
  const items = visible
    .map(
      (h) =>
        `<li class="doc-toc__item doc-toc__item--depth-${h.depth}"><a href="#${escapeAttr(h.id)}">${escapeHtml(h.title)}</a></li>`,
    )
    .join('');
  return `<nav class="doc-toc" aria-label="Table of contents"><ul class="doc-toc__list">${items}</ul></nav>`;
}

function renderSection(s: DocPageSection): string {
  return [
    `<section class="doc-section" id="${escapeAttr(s.id)}">`,
    `  <h${s.depth} class="doc-section__heading"><a href="#${escapeAttr(s.id)}" class="doc-section__anchor" aria-label="Link to ${escapeAttr(s.title)}">#</a>${escapeHtml(s.title)}</h${s.depth}>`,
    `  ${s.html}`,
    `</section>`,
  ].join('\n');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });
}

const docPageView: ViewDefinition<DocPageData, DocPageConfig> = {
  id: 'doc-page-view',
  displayName: 'Doc page',
  pageType: 'doc-page',
  factory: docPageRendererFactory,
  capabilities: ['responsive', 'ssr-safe'],
};

// ──────────────────────── Publication Adapters ───────────────────

interface SchemaOrgTechArticle {
  '@context': 'https://schema.org';
  '@type': 'TechArticle';
  headline: string;
  description: string;
  url: string;
  datePublished: string;
  dateModified: string;
  inLanguage: string;
  author?: { '@type': 'Person'; name: string; url?: string };
  image?: string;
  keywords?: string[];
  hasPart: Array<{ '@type': 'WebPageElement'; name: string; identifier: string }>;
}

const schemaOrgJsonLdAdapter: PublicationAdapter<DocPageData, SchemaOrgTechArticle, DocPageConfig> =
  {
    id: 'schema-org-tech-article',
    displayName: 'Schema.org JSON-LD (TechArticle)',
    description:
      'Inline JSON-LD for AI Overviews, Google Rich Results, and Schema.org-aware indexers.',
    format: 'json-ld',
    requires: [
      { path: 'title', required: 'always' },
      { path: 'description', required: 'always' },
      { path: 'slug', required: 'always' },
      { path: 'publishedAt', required: 'always' },
      { path: 'updatedAt', required: 'always' },
      { path: 'ogImage', required: 'preferred' },
      { path: 'author.name', required: 'preferred' },
    ],
    async generate(data, ctx) {
      const url = buildPageUrl(ctx.config, data.slug);
      const article: SchemaOrgTechArticle = {
        '@context': 'https://schema.org',
        '@type': 'TechArticle',
        headline: data.title,
        description: data.description,
        url,
        datePublished: data.publishedAt,
        dateModified: data.updatedAt,
        inLanguage: ctx.locale,
        hasPart: data.headings.map((h) => ({
          '@type': 'WebPageElement' as const,
          name: h.title,
          identifier: `${url}#${h.id}`,
        })),
      };
      if (data.author) {
        article.author = {
          '@type': 'Person',
          name: data.author.name,
          ...(data.author.url ? { url: data.author.url } : {}),
        };
      }
      if (data.ogImage) article.image = data.ogImage;
      if (data.tags && data.tags.length > 0) article.keywords = data.tags;
      return article;
    },
    validate(output): ValidationResult {
      const errors: ValidationError[] = [];
      if (!output.headline) {
        errors.push({
          code: 'missing-headline',
          path: 'headline',
          message: 'TechArticle requires a headline.',
        });
      }
      if (!output.description) {
        errors.push({
          code: 'missing-description',
          path: 'description',
          message: 'TechArticle requires a description.',
        });
      }
      if (!output.url) {
        errors.push({
          code: 'missing-url',
          path: 'url',
          message: 'TechArticle requires a canonical url.',
        });
      }
      return { valid: errors.length === 0, errors, warnings: [] };
    },
    refreshCadence: { min: { ms: 0 }, max: { ms: 24 * 60 * 60_000 } },
    delivery: 'inline-in-host',
    onValidationFail: 'block-publish',
  };

interface LlmsTextOutput {
  /** Single line for the parent /llms.txt index. */
  indexLine: string;
  /** Per-page full-text dump for /llms-full.txt or /docs/<slug>/llms.txt. */
  fullText: string;
}

const llmsTextAdapter: PublicationAdapter<DocPageData, LlmsTextOutput, DocPageConfig> = {
  id: 'llms-txt-fragment',
  displayName: 'llms.txt fragment',
  description:
    'A line for the parent /llms.txt index plus a full-text dump for AI assistants that fetch llms-full.txt.',
  format: 'custom',
  requires: [
    { path: 'title', required: 'always' },
    { path: 'description', required: 'always' },
    { path: 'slug', required: 'always' },
    { path: 'sections', required: 'always' },
  ],
  async generate(data, ctx) {
    const url = buildPageUrl(ctx.config, data.slug);
    const indexLine = `- [${data.title}](${url}): ${data.description}`;
    const sectionDumps = data.sections
      .map((s) => `## ${s.title}\n\n${stripHtml(s.html)}`)
      .join('\n\n');
    const fullText = `# ${data.title}\n\n${data.description}\n\n${sectionDumps}\n`;
    return { indexLine, fullText };
  },
  validate(output): ValidationResult {
    const errors: ValidationError[] = [];
    if (!output.indexLine) {
      errors.push({
        code: 'missing-index-line',
        path: 'indexLine',
        message: 'llms.txt fragment requires an index line.',
      });
    }
    if (!output.fullText) {
      errors.push({
        code: 'missing-full-text',
        path: 'fullText',
        message: 'llms.txt fragment requires a full-text dump.',
      });
    }
    return { valid: errors.length === 0, errors, warnings: [] };
  },
  refreshCadence: { min: { ms: 0 }, max: { ms: 24 * 60 * 60_000 } },
  delivery: 'host-decides',
  onValidationFail: 'block-publish',
};

interface MicrodataOutput {
  htmlFragment: string;
}

const microdataAdapter: PublicationAdapter<DocPageData, MicrodataOutput, DocPageConfig> = {
  id: 'schema-org-microdata',
  displayName: 'Schema.org microdata (HTML)',
  description:
    'HTML fragment with itemtype/itemprop attributes — the inline-with-content alternative to JSON-LD for indexers that read microdata.',
  format: 'custom',
  requires: [
    { path: 'title', required: 'always' },
    { path: 'description', required: 'always' },
    { path: 'publishedAt', required: 'always' },
    { path: 'updatedAt', required: 'always' },
  ],
  async generate(data, ctx) {
    const url = buildPageUrl(ctx.config, data.slug);
    const author = data.author
      ? `<span itemprop="author" itemscope itemtype="https://schema.org/Person"><meta itemprop="name" content="${escapeAttr(data.author.name)}">${data.author.url ? `<link itemprop="url" href="${escapeAttr(data.author.url)}">` : ''}</span>`
      : '';
    const image = data.ogImage
      ? `<meta itemprop="image" content="${escapeAttr(data.ogImage)}">`
      : '';
    const keywords = (data.tags ?? [])
      .map((t) => `<meta itemprop="keywords" content="${escapeAttr(t)}">`)
      .join('');
    const fragment = [
      `<article itemscope itemtype="https://schema.org/TechArticle">`,
      `  <meta itemprop="url" content="${escapeAttr(url)}">`,
      `  <meta itemprop="inLanguage" content="${escapeAttr(ctx.locale)}">`,
      `  <meta itemprop="datePublished" content="${escapeAttr(data.publishedAt)}">`,
      `  <meta itemprop="dateModified" content="${escapeAttr(data.updatedAt)}">`,
      `  <h1 itemprop="headline">${escapeHtml(data.title)}</h1>`,
      `  <p itemprop="description">${escapeHtml(data.description)}</p>`,
      `  ${author}`,
      `  ${image}`,
      `  ${keywords}`,
      `</article>`,
    ].join('\n');
    return { htmlFragment: fragment };
  },
  validate(output): ValidationResult {
    const errors: ValidationError[] = [];
    if (!output.htmlFragment) {
      errors.push({
        code: 'empty-fragment',
        path: 'htmlFragment',
        message: 'Microdata fragment cannot be empty.',
      });
    }
    return { valid: errors.length === 0, errors, warnings: [] };
  },
  refreshCadence: { min: { ms: 0 }, max: { ms: 24 * 60 * 60_000 } },
  delivery: 'inline-in-host',
  onValidationFail: 'block-publish',
};

interface CrawlerSurfaceOutput {
  canonical: string;
  sitemap: { loc: string; lastmod: string; changefreq?: string; priority?: number };
  openGraph: Record<string, string>;
  twitterCard: Record<string, string>;
}

const crawlerSurfaceAdapter: PublicationAdapter<
  DocPageData,
  CrawlerSurfaceOutput,
  DocPageConfig
> = {
  id: 'classic-crawler-surface',
  displayName: 'Classic crawler bundle',
  description:
    'Canonical URL, sitemap entry, OpenGraph, and Twitter Card metadata. Host app routes the bundle to its four delivery points.',
  format: 'custom',
  requires: [
    { path: 'title', required: 'always' },
    { path: 'description', required: 'always' },
    { path: 'slug', required: 'always' },
    { path: 'updatedAt', required: 'always' },
    { path: 'ogImage', required: 'preferred' },
  ],
  async generate(data, ctx) {
    const canonical = buildPageUrl(ctx.config, data.slug);
    const openGraph: Record<string, string> = {
      'og:type': 'article',
      'og:url': canonical,
      'og:title': data.title,
      'og:description': data.description,
      'og:site_name': ctx.config.siteName,
    };
    if (data.ogImage) openGraph['og:image'] = data.ogImage;
    const twitterCard: Record<string, string> = {
      'twitter:card': data.ogImage ? 'summary_large_image' : 'summary',
      'twitter:title': data.title,
      'twitter:description': data.description,
    };
    if (data.ogImage) twitterCard['twitter:image'] = data.ogImage;
    return {
      canonical,
      sitemap: { loc: canonical, lastmod: data.updatedAt, changefreq: 'weekly', priority: 0.7 },
      openGraph,
      twitterCard,
    };
  },
  validate(output): ValidationResult {
    const errors: ValidationError[] = [];
    if (!output.canonical) {
      errors.push({
        code: 'missing-canonical',
        path: 'canonical',
        message: 'Crawler bundle requires a canonical url.',
      });
    }
    if (!output.sitemap.loc) {
      errors.push({
        code: 'missing-sitemap-loc',
        path: 'sitemap.loc',
        message: 'Sitemap entry requires loc.',
      });
    }
    if (!output.openGraph['og:title']) {
      errors.push({
        code: 'missing-og-title',
        path: 'openGraph.og:title',
        message: 'OpenGraph requires og:title.',
      });
    }
    return { valid: errors.length === 0, errors, warnings: [] };
  },
  refreshCadence: { min: { ms: 0 }, max: { ms: 24 * 60 * 60_000 } },
  delivery: 'host-decides',
  onValidationFail: 'block-publish',
};

// ───────────────────────────── helpers ────────────────────────────

function buildPageUrl(config: DocPageConfig, slug: string): string {
  const base = config.siteUrl.replace(/\/$/, '');
  const prefix = (config.pathPrefix.startsWith('/') ? config.pathPrefix : `/${config.pathPrefix}`)
    .replace(/\/$/, '');
  return `${base}${prefix}/${slug}`;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ──────────────────────────── Template ────────────────────────────

const docPageTemplate: Template<DocPageConfig> = {
  id: 'doc-page-default',
  displayName: 'Doc page (default)',
  description: 'Single-page documentation layout with TOC + sectioned body.',
  pages: [{ id: 'doc-page', type: 'doc-page', enabled: true }],
  defaultConfig: {
    siteUrl: 'https://example.com',
    siteName: 'Example Docs',
    pathPrefix: '/docs',
    showTableOfContents: true,
    tocMaxDepth: 3,
    locale: 'en',
  },
};

// ───────────────────────── Cartridge envelope ─────────────────────

export const docPageCartridge: Cartridge<DocPageData, DocPageConfig> = {
  id: 'doc-page',
  industry: 'documentation',
  displayName: 'DocPage',
  description:
    'Schema-driven documentation page with full AIO surface coverage (JSON-LD, llms.txt, microdata, classic crawler).',
  version: '0.0.0',

  schema: docPageSchema,
  dataSources: [jsonInputDataSource],
  transformers: [slugifyAnchorIds],
  views: [docPageView],
  templates: [docPageTemplate],
  mcpTools: [listHeadingsTool, getSectionTool],
  publicationAdapters: [
    schemaOrgJsonLdAdapter,
    llmsTextAdapter,
    microdataAdapter,
    crawlerSurfaceAdapter,
  ],

  defaultConfig: docPageTemplate.defaultConfig,
  defaultTemplateId: docPageTemplate.id,
  mailboxName: '__AIRO_DOC_PAGE_PAGES__',
};
