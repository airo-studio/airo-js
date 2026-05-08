/**
 * Publish pipeline — emit a static, crawler-rich HTML site from cartridge
 * instances + their PublicationAdapter outputs.
 *
 * Per-page output structure:
 *   <slug>/index.html  — full <html> document with:
 *                         · <title>, canonical, OG/Twitter meta in <head>
 *                         · <script type="application/ld+json"> in <head>
 *                         · cartridge View HTML in <body> (microdata is
 *                           emitted INSIDE the view markup already, so we
 *                           don't append the schema-org-microdata adapter's
 *                           output separately — it would duplicate the
 *                           <article itemscope> wrapper)
 *
 * Site-level output:
 *   /llms.txt          — index lines from each page's llms-txt-fragment
 *                         adapter, plus the full-text dump appended below
 *                         a separator. Conforms to the emerging convention
 *                         (https://llmstxt.org/).
 *   /sitemap.xml       — aggregated from each page's classic-crawler-surface
 *                         adapter's sitemap entry.
 *   /robots.txt        — allow-all + sitemap pointer.
 *
 * Adapter-id lookup is convention-based: 'json-ld' adapters are matched by
 * format; 'llms-txt-fragment', 'classic-crawler-surface' by id (both shipped
 * by @airo-js/doc-cartridges). Cartridges that follow these conventions get
 * site-level aggregation for free; cartridges that don't still get their
 * inline JSON-LD + per-page HTML emitted.
 */

import { renderAppToHTML, runPublicationAdapters, type AdapterRunResult } from '@airo-js/ssr';
import { parseHTML } from 'linkedom';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type {
  Cartridge,
  PublicationContext,
  ValidationResult,
} from '@airo-js/cartridge-kit';
import type { AppConfig, Page, PageRendererFactory } from '@airo-js/core';

export interface PublishedFile {
  /** Path relative to the output directory. */
  path: string;
  bytes: number;
}

export interface PublishWarning {
  code: string;
  message: string;
}

export interface PublishedPage {
  slug: string;
  title: string;
  canonical: string;
}

export interface PublishResult {
  outputDir: string;
  files: PublishedFile[];
  pages: PublishedPage[];
  warnings: PublishWarning[];
  startedAt: number;
  completedAt: number;
}

export interface PublishOptions<TData, TConfig> {
  cartridge: Cartridge<TData, TConfig>;
  /** One per page emitted. Each entry's data is the post-Transformer snapshot. */
  instances: Array<{ data: TData }>;
  /** Absolute path to the output directory. Created if missing. */
  outputDir: string;
}

interface CrawlerOutput {
  canonical: string;
  sitemap: { loc: string; lastmod: string; changefreq?: string; priority?: number };
  openGraph: Record<string, string>;
  twitterCard: Record<string, string>;
}

interface LlmsOutput {
  indexLine: string;
  fullText: string;
}

export async function publishCartridge<TData, TConfig>(
  opts: PublishOptions<TData, TConfig>,
): Promise<PublishResult> {
  const { cartridge, instances, outputDir } = opts;
  const startedAt = Date.now();

  const files: PublishedFile[] = [];
  const warnings: PublishWarning[] = [];
  const pages: PublishedPage[] = [];

  const llmsLines: string[] = [];
  const llmsFullSections: string[] = [];
  const sitemapEntries: Array<{ loc: string; lastmod: string }> = [];

  const template = cartridge.templates.find((t) => t.id === cartridge.defaultTemplateId);
  if (!template) {
    throw new Error(
      `Cartridge ${cartridge.id} has no defaultTemplateId match in templates[]`,
    );
  }

  const appConfig: AppConfig = {
    appId: `${cartridge.id}-publish`,
    pages: template.pages.map((p): Page => ({
      id: p.id,
      type: p.type,
      enabled: p.enabled,
      layout: { regionOrder: [], regions: {} },
      ...(p.parent ? { parent: p.parent } : {}),
    })),
  };

  const resolveRenderer = (pageType: string): PageRendererFactory<string, unknown> | undefined => {
    const view = cartridge.views.find((v) => v.pageType === pageType);
    return view?.factory as PageRendererFactory<string, unknown> | undefined;
  };

  for (const instance of instances) {
    const slug = pickSlug(instance.data);
    const pubCtx: PublicationContext<TConfig> = {
      config: cartridge.defaultConfig,
      locale: 'en',
      country: 'US',
    };

    // Fresh DOM per page — linkedom Documents are stateful through createElement/innerHTML.
    const { document } = parseHTML('<!doctype html><html><body></body></html>');

    const view = renderAppToHTML(appConfig, {
      document: document as unknown as Document,
      resolveRenderer,
      appContext: {
        cartridgeId: cartridge.id,
        config: cartridge.defaultConfig,
        data: instance.data,
      },
    });

    const adapterResults = await runPublicationAdapters(cartridge, instance.data, pubCtx);

    for (const r of adapterResults) {
      if (!r.included) {
        warnings.push({
          code: 'adapter-not-included',
          message: `Adapter '${r.adapterId}' validation failed: ${describeErrors(r.validation)}`,
        });
      }
    }

    const jsonLdResult = pickIncluded(adapterResults, (r) => r.format === 'json-ld');
    const llmsResult = pickIncluded(adapterResults, (r) => r.adapterId === 'llms-txt-fragment');
    const crawlerResult = pickIncluded(
      adapterResults,
      (r) => r.adapterId === 'classic-crawler-surface',
    );

    const crawler = crawlerResult ? (crawlerResult.output as CrawlerOutput) : undefined;
    const title = pickTitle(instance.data) ?? cartridge.displayName;

    const html = assembleHtml({
      title,
      crawler,
      jsonLd: jsonLdResult ? jsonLdResult.output : undefined,
      viewHtml: view.html,
      stylesheets: collectStylesheets(cartridge),
    });

    const pagePath = `${slug}/index.html`;
    await writeFileSafe(resolve(outputDir, pagePath), html);
    files.push({ path: pagePath, bytes: Buffer.byteLength(html) });

    pages.push({
      slug,
      title,
      canonical: crawler?.canonical ?? '',
    });

    if (llmsResult) {
      const out = llmsResult.output as LlmsOutput;
      if (out.indexLine) llmsLines.push(out.indexLine);
      if (out.fullText) llmsFullSections.push(out.fullText);
    }

    if (crawler?.sitemap.loc) {
      sitemapEntries.push({
        loc: crawler.sitemap.loc,
        lastmod: crawler.sitemap.lastmod,
      });
    }
  }

  if (llmsLines.length > 0) {
    const llmsTxt =
      `# ${cartridge.displayName}\n\n` +
      `${llmsLines.join('\n')}\n\n` +
      `---\n\n` +
      `${llmsFullSections.join('\n\n---\n\n')}\n`;
    await writeFileSafe(resolve(outputDir, 'llms.txt'), llmsTxt);
    files.push({ path: 'llms.txt', bytes: Buffer.byteLength(llmsTxt) });
  }

  if (sitemapEntries.length > 0) {
    const sitemap = buildSitemap(sitemapEntries);
    await writeFileSafe(resolve(outputDir, 'sitemap.xml'), sitemap);
    files.push({ path: 'sitemap.xml', bytes: Buffer.byteLength(sitemap) });
  }

  const robots = `User-agent: *\nAllow: /\nSitemap: /sitemap.xml\n`;
  await writeFileSafe(resolve(outputDir, 'robots.txt'), robots);
  files.push({ path: 'robots.txt', bytes: Buffer.byteLength(robots) });

  return {
    outputDir,
    files,
    pages,
    warnings,
    startedAt,
    completedAt: Date.now(),
  };
}

// ─────────────────────────── HTML assembly ─────────────────────────

function assembleHtml(opts: {
  title: string;
  crawler: CrawlerOutput | undefined;
  jsonLd: unknown;
  viewHtml: string;
  stylesheets: string[];
}): string {
  const lines: string[] = [];
  lines.push('<!doctype html>');
  lines.push('<html lang="en">');
  lines.push('<head>');
  lines.push('<meta charset="utf-8">');
  lines.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  lines.push(`<title>${escapeHtml(opts.title)}</title>`);

  if (opts.crawler?.canonical) {
    lines.push(`<link rel="canonical" href="${escapeAttr(opts.crawler.canonical)}">`);
  }
  if (opts.crawler?.openGraph) {
    for (const [k, v] of Object.entries(opts.crawler.openGraph)) {
      lines.push(`<meta property="${escapeAttr(k)}" content="${escapeAttr(v)}">`);
    }
  }
  if (opts.crawler?.twitterCard) {
    for (const [k, v] of Object.entries(opts.crawler.twitterCard)) {
      lines.push(`<meta name="${escapeAttr(k)}" content="${escapeAttr(v)}">`);
    }
  }
  if (opts.jsonLd !== undefined) {
    // Compact JSON-LD; no pretty-printing in production HTML. The block is
    // still copy-out-of-DevTools readable.
    lines.push(`<script type="application/ld+json">${JSON.stringify(opts.jsonLd)}</script>`);
  }
  for (const css of opts.stylesheets) {
    lines.push(`<style>${css}</style>`);
  }

  lines.push('</head>');
  lines.push('<body>');
  lines.push(opts.viewHtml);
  lines.push('</body>');
  lines.push('</html>');
  return lines.join('\n');
}

/**
 * Pull `stylesheet` from each view the cartridge declares. Order is the
 * declaration order on the cartridge — last view's stylesheet wins on
 * cascade-equal selectors. De-duplicates by string identity so multiple
 * views sharing the same stylesheet only emit one <style> block.
 */
function collectStylesheets<TData, TConfig>(
  cartridge: Cartridge<TData, TConfig>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const view of cartridge.views) {
    if (typeof view.stylesheet === 'string' && view.stylesheet.length > 0) {
      if (!seen.has(view.stylesheet)) {
        seen.add(view.stylesheet);
        out.push(view.stylesheet);
      }
    }
  }
  return out;
}

function buildSitemap(entries: Array<{ loc: string; lastmod: string }>): string {
  const xmlEntries = entries
    .map(
      (e) =>
        `  <url>\n    <loc>${escapeXml(e.loc)}</loc>\n    <lastmod>${escapeXml(e.lastmod)}</lastmod>\n  </url>`,
    )
    .join('\n');
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${xmlEntries}\n</urlset>\n`
  );
}

// ─────────────────────────── helpers ───────────────────────────────

async function writeFileSafe(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}

function pickIncluded(
  results: AdapterRunResult[],
  predicate: (r: AdapterRunResult) => boolean,
): AdapterRunResult | undefined {
  return results.find((r) => predicate(r) && r.included);
}

function pickSlug(data: unknown): string {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const slug = (data as Record<string, unknown>).slug;
    if (typeof slug === 'string' && slug.length > 0) return slug;
  }
  return 'index';
}

function pickTitle(data: unknown): string | undefined {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const t = (data as Record<string, unknown>).title;
    if (typeof t === 'string') return t;
  }
  return undefined;
}

function describeErrors(v: ValidationResult): string {
  if (v.errors.length === 0) return 'no error detail';
  return v.errors
    .map((e) => `${e.code}${e.path ? ` @ ${e.path}` : ''}: ${e.message}`)
    .join('; ');
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
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
