/**
 * Cloudflare Worker — multi-cartridge edge demo.
 *
 * Two cartridges, one Worker. Each cartridge ships its own DataSource,
 * View, PublicationAdapters, and MCP tools. The framework's render path
 * is identical for both — only the URL prefix and config differ.
 *
 * Routes:
 *
 *   Shared:
 *     GET /                       — landing index (links to both)
 *     GET /healthz                — liveness
 *     GET /demo.css               — stylesheet
 *
 *   Shopify product card:
 *     GET /shopify/               — HTML (JSON-LD inlined, snapshot meta)
 *     GET /shopify/schema.json    — Schema.org Product JSON-LD
 *     GET /shopify/feed.xml       — Google Merchant Center XML feed
 *     GET /shopify/mcp            — tool manifest
 *     GET /shopify/mcp/tools/:n   — tool invocation
 *
 *   WordPress blog post:
 *     GET /wp/                    — HTML (JSON-LD inlined)
 *     GET /wp/schema.json         — Schema.org BlogPosting JSON-LD
 *     GET /wp/mcp                 — tool manifest
 *     GET /wp/mcp/tools/:n        — tool invocation
 *
 * Per-cartridge snapshotId is consistent across each cartridge's three
 * (or four, for Shopify) surfaces — the airo-js cartridge contract's
 * snapshot-fidelity guarantee made visible at the edge.
 */

import { parseHTML } from 'linkedom';
import { renderAppWithPublication, renderDocument, runPublicationAdapters } from '@airo-js/ssr';
import { buildToolManifest, dispatchTool } from '@airo-js/mcp';
import type { PublicationContext } from '@airo-js/cartridge-kit';

import { shopifyProductCartridge } from './shopify/cartridge.js';
import { toProductJsonLd } from './shopify/jsonld.js';
import type { ProductSnapshot, ShopifyConfig } from './shopify/types.js';

import { wpPostCartridge } from './wp/cartridge.js';
import { toArticleJsonLd } from './wp/jsonld.js';
import type { PostSnapshot, WpConfig } from './wp/types.js';

import {
  SHOPIFY_APP_CONFIG,
  SHOPIFY_CONFIG,
  WP_APP_CONFIG,
  WP_CONFIG,
} from './demo-config.js';
import { DEMO_CSS } from './styles.js';

export interface Env {
  CONFIG: KVNamespace;
  // Shopify
  SHOPIFY_DOMAIN: string;
  DEFAULT_PRODUCT_HANDLE: string;
  SHOPIFY_STOREFRONT_TOKEN: string;
  // WordPress
  WP_SITE?: string;
  DEFAULT_POST_SLUG?: string;
}

const KV_SHOPIFY_KEY = 'cartridge:shopify-product-card';
const KV_WP_KEY = 'cartridge:wp-blog-post';
const CONTENT_TYPE_HTML = 'text/html; charset=utf-8';
const CONTENT_TYPE_JSON = 'application/json; charset=utf-8';
const CONTENT_TYPE_CSS = 'text/css; charset=utf-8';
const CONTENT_TYPE_XML = 'application/xml; charset=utf-8';
const CONTENT_TYPE_JSONLD = 'application/ld+json';

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      // ── Shared routes ───────────────────────────────────────────
      if (path === '/healthz') {
        return new Response('ok', { headers: { 'content-type': 'text/plain' } });
      }
      if (path === '/demo.css') {
        return new Response(DEMO_CSS, {
          headers: { 'content-type': CONTENT_TYPE_CSS, 'cache-control': 'public, max-age=300' },
        });
      }
      if (path === '/' || path === '/index.html') {
        return handleLanding();
      }

      // ── Shopify cartridge ───────────────────────────────────────
      if (path === '/shopify' || path === '/shopify/') {
        return handleShopifyHome(url, req, env);
      }
      if (path === '/shopify/schema.json') {
        return handleShopifySchemaJson(url, req, env);
      }
      if (path === '/shopify/feed.xml') {
        return handleShopifyFeedXml(url, req, env);
      }
      if (path === '/shopify/mcp' || path === '/shopify/mcp/') {
        return handleShopifyMcpManifest();
      }
      if (path.startsWith('/shopify/mcp/tools/')) {
        return handleShopifyMcpInvoke(url, req, env);
      }

      // ── WordPress cartridge ─────────────────────────────────────
      if (path === '/wp' || path === '/wp/') {
        return handleWpHome(url, req, env);
      }
      if (path === '/wp/schema.json') {
        return handleWpSchemaJson(url, req, env);
      }
      if (path === '/wp/mcp' || path === '/wp/mcp/') {
        return handleWpMcpManifest();
      }
      if (path.startsWith('/wp/mcp/tools/')) {
        return handleWpMcpInvoke(url, req, env);
      }

      return notFound(`No route for ${path}`);
    } catch (err) {
      return new Response(
        JSON.stringify({
          error: 'worker_exception',
          message: err instanceof Error ? err.message : String(err),
        }),
        { status: 500, headers: { 'content-type': CONTENT_TYPE_JSON } },
      );
    }
  },
};

// ─── Shopify config + snapshot ─────────────────────────────────────────────

async function loadShopifyConfig(env: Env): Promise<ShopifyConfig> {
  const stored = await env.CONFIG.get(KV_SHOPIFY_KEY, 'json');
  if (stored && typeof stored === 'object') {
    return stored as ShopifyConfig;
  }
  return {
    ...SHOPIFY_CONFIG,
    productHandle: env.DEFAULT_PRODUCT_HANDLE || SHOPIFY_CONFIG.productHandle,
  };
}

async function fetchShopifySnapshot(
  url: URL,
  req: Request,
  env: Env,
  config: ShopifyConfig,
): Promise<ProductSnapshot> {
  const handle = url.searchParams.get('product') ?? config.productHandle;
  const dataSource = shopifyProductCartridge.dataSources[0];
  if (!dataSource) throw new Error('Shopify cartridge has no dataSource');
  return dataSource.fetch(
    { kind: 'custom', payload: { handle } },
    {
      config,
      credentials: {
        SHOPIFY_DOMAIN: env.SHOPIFY_DOMAIN,
        SHOPIFY_STOREFRONT_TOKEN: env.SHOPIFY_STOREFRONT_TOKEN,
      },
      signal: req.signal,
    },
  );
}

function buildShopifyPublicationCtx(config: ShopifyConfig): PublicationContext<ShopifyConfig> {
  return {
    config,
    locale: config.locale,
    country: config.locale.split('-')[1] ?? 'US',
    currency: 'USD',
  };
}

// ─── WordPress config + snapshot ───────────────────────────────────────────

async function loadWpConfig(env: Env): Promise<WpConfig> {
  const stored = await env.CONFIG.get(KV_WP_KEY, 'json');
  if (stored && typeof stored === 'object') {
    return stored as WpConfig;
  }
  return {
    ...WP_CONFIG,
    site: env.WP_SITE || WP_CONFIG.site,
    postSlug: env.DEFAULT_POST_SLUG ?? WP_CONFIG.postSlug,
  };
}

async function fetchWpSnapshot(
  url: URL,
  req: Request,
  // Unused: the WP REST API needs no credentials. The parameter stays for
  // symmetry with fetchShopifySnapshot, which threads Storefront tokens.
  _env: Env,
  config: WpConfig,
): Promise<PostSnapshot> {
  // URL param can override either the site or the slug — useful for
  // demoing the cartridge against multiple WP sites without redeploying.
  const site = url.searchParams.get('site') ?? config.site;
  const slug = url.searchParams.get('post') ?? config.postSlug;
  const dataSource = wpPostCartridge.dataSources[0];
  if (!dataSource) throw new Error('WP cartridge has no dataSource');
  return dataSource.fetch(
    { kind: 'custom', payload: { slug } },
    {
      config: { ...config, site, postSlug: slug },
      signal: req.signal,
    },
  );
}

function buildWpPublicationCtx(config: WpConfig): PublicationContext<WpConfig> {
  return {
    config,
    locale: config.locale,
    country: config.locale.split('-')[1] ?? 'US',
  };
}

// ─── Shared HTML doc shell ─────────────────────────────────────────────────

/**
 * Document shell. Since 0.9.0 this is `renderDocument` from `@airo-js/ssr`
 * rather than a hand-written template literal — the framework owns doctype
 * ordering, charset placement, the OpenGraph `property=` vs Twitter `name=`
 * distinction, and escaping, and this example stopped keeping its own copy.
 *
 * Note what stays here: `DEMO_CSS` and the viewport string. Both are this
 * example's choices, passed in as caller values. The framework authors no
 * CSS and has no opinion about viewport policy.
 */
function htmlDoc(
  title: string,
  locale: string,
  canonical: string,
  meta: Record<string, string>,
  widgetHtml: string,
  blockedNote: string,
): string {
  return renderDocument({
    head: {
      lang: locale,
      title,
      viewport: 'width=device-width, initial-scale=1',
      canonical,
      meta: Object.entries(meta).map(([name, content]) => ({ name, content })),
      inlineStyles: [DEMO_CSS],
      raw: blockedNote,
    },
    body: widgetHtml,
  });
}

// ─── Shopify route handlers ────────────────────────────────────────────────

async function handleShopifyHome(url: URL, req: Request, env: Env): Promise<Response> {
  const config = await loadShopifyConfig(env);
  const snapshot = await fetchShopifySnapshot(url, req, env, config);
  const { document } = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>');

  const { html: widgetHtml, adapterResults } = await renderAppWithPublication({
    cartridge: shopifyProductCartridge,
    appConfig: SHOPIFY_APP_CONFIG,
    snapshot,
    publicationCtx: buildShopifyPublicationCtx(config),
    document,
  });

  const blocked = adapterResults.filter((r) => !r.included);
  const blockedNote = blocked.length > 0
    ? `<!-- ${blocked.length} adapter(s) blocked by validation; see logs -->`
    : '';

  const doc = htmlDoc(
    `${snapshot.title} — airo-js edge demo`,
    config.locale,
    snapshot.onlineStoreUrl ?? url.toString(),
    {
      description: truncate(snapshot.description, 160),
      'airo:snapshot-id': snapshot.snapshotId,
      'airo:cartridge-id': shopifyProductCartridge.id,
      'airo:cartridge-version': shopifyProductCartridge.version,
    },
    widgetHtml,
    blockedNote,
  );

  return new Response(doc, {
    headers: {
      'content-type': CONTENT_TYPE_HTML,
      'cache-control': 'no-store',
      'x-airo-snapshot-id': snapshot.snapshotId,
      'x-airo-cartridge-id': shopifyProductCartridge.id,
    },
  });
}

async function handleShopifySchemaJson(url: URL, req: Request, env: Env): Promise<Response> {
  const config = await loadShopifyConfig(env);
  const snapshot = await fetchShopifySnapshot(url, req, env, config);
  const jsonLd = toProductJsonLd(snapshot);
  return new Response(JSON.stringify(jsonLd, null, 2), {
    headers: {
      'content-type': CONTENT_TYPE_JSONLD,
      'cache-control': 'no-store',
      'x-airo-snapshot-id': snapshot.snapshotId,
    },
  });
}

async function handleShopifyFeedXml(url: URL, req: Request, env: Env): Promise<Response> {
  const config = await loadShopifyConfig(env);
  const snapshot = await fetchShopifySnapshot(url, req, env, config);
  const results = await runPublicationAdapters(
    shopifyProductCartridge,
    snapshot,
    buildShopifyPublicationCtx(config),
    { formats: ['xml'] },
  );
  const result = results.find((r) => r.adapterId === 'merchant-center-xml');
  if (!result) {
    return new Response(JSON.stringify({ error: 'feed_adapter_missing' }), {
      status: 500,
      headers: { 'content-type': CONTENT_TYPE_JSON },
    });
  }
  if (!result.included) {
    return new Response(
      JSON.stringify({
        error: 'feed_validation_failed',
        snapshotId: snapshot.snapshotId,
        validation: result.validation,
      }),
      { status: 500, headers: { 'content-type': CONTENT_TYPE_JSON } },
    );
  }
  const feed = result.output as { xml: string; itemCount: number };
  return new Response(feed.xml, {
    headers: {
      'content-type': CONTENT_TYPE_XML,
      // Google polls daily; cache for 1 hour at the edge so concurrent
      // requests don't all re-fetch from Shopify. min/max bounds from
      // the adapter's refreshCadence declaration.
      'cache-control': 'public, max-age=3600',
      'x-airo-snapshot-id': snapshot.snapshotId,
      'x-airo-item-count': String(feed.itemCount),
    },
  });
}

function handleShopifyMcpManifest(): Response {
  const manifest = buildToolManifest(shopifyProductCartridge);
  return new Response(
    JSON.stringify({
      ...manifest,
      protocolVersion: '2025-03-26',
      serverInfo: {
        name: shopifyProductCartridge.id,
        version: shopifyProductCartridge.version,
      },
    }, null, 2),
    {
      headers: { 'content-type': CONTENT_TYPE_JSON, 'cache-control': 'public, max-age=60' },
    },
  );
}

async function handleShopifyMcpInvoke(url: URL, req: Request, env: Env): Promise<Response> {
  const toolName = url.pathname.replace('/shopify/mcp/tools/', '');
  if (!toolName) return badRequest('missing_tool_name');

  const config = await loadShopifyConfig(env);
  const snapshot = await fetchShopifySnapshot(url, req, env, config);

  const input: Record<string, string> = {};
  url.searchParams.forEach((v, k) => {
    if (k !== 'product') input[k] = v;
  });

  // The hand-rolled dispatcher this replaces THREW on an unknown tool name,
  // so an agent calling a stale name produced an unhandled rejection and a
  // 500. `dispatchTool` returns a verdict, so the same request is now the
  // 400 it always was.
  const out = await dispatchTool(shopifyProductCartridge, toolName, input, snapshot, { config });
  if (!out.ok) return badRequest(`${out.error.code}: ${out.error.message}`);

  const { snapshotId } = snapshot;
  return new Response(JSON.stringify({ tool: toolName, result: out.result, snapshotId }, null, 2), {
    headers: {
      'content-type': CONTENT_TYPE_JSON,
      'cache-control': 'no-store',
      'x-airo-snapshot-id': snapshotId,
    },
  });
}

// ─── WordPress route handlers ──────────────────────────────────────────────

async function handleWpHome(url: URL, req: Request, env: Env): Promise<Response> {
  const config = await loadWpConfig(env);
  const snapshot = await fetchWpSnapshot(url, req, env, config);
  const { document } = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>');

  const { html: widgetHtml, adapterResults } = await renderAppWithPublication({
    cartridge: wpPostCartridge,
    appConfig: WP_APP_CONFIG,
    snapshot,
    publicationCtx: buildWpPublicationCtx(config),
    document,
  });

  const blocked = adapterResults.filter((r) => !r.included);
  const blockedNote = blocked.length > 0
    ? `<!-- ${blocked.length} adapter(s) blocked by validation; see logs -->`
    : '';

  const doc = htmlDoc(
    `${snapshot.title} — airo-js edge demo`,
    config.locale,
    snapshot.link,
    {
      description: truncate(snapshot.excerpt, 160),
      'airo:snapshot-id': snapshot.snapshotId,
      'airo:cartridge-id': wpPostCartridge.id,
      'airo:cartridge-version': wpPostCartridge.version,
    },
    widgetHtml,
    blockedNote,
  );

  return new Response(doc, {
    headers: {
      'content-type': CONTENT_TYPE_HTML,
      'cache-control': 'no-store',
      'x-airo-snapshot-id': snapshot.snapshotId,
      'x-airo-cartridge-id': wpPostCartridge.id,
    },
  });
}

async function handleWpSchemaJson(url: URL, req: Request, env: Env): Promise<Response> {
  const config = await loadWpConfig(env);
  const snapshot = await fetchWpSnapshot(url, req, env, config);
  const jsonLd = toArticleJsonLd(snapshot);
  return new Response(JSON.stringify(jsonLd, null, 2), {
    headers: {
      'content-type': CONTENT_TYPE_JSONLD,
      'cache-control': 'no-store',
      'x-airo-snapshot-id': snapshot.snapshotId,
    },
  });
}

function handleWpMcpManifest(): Response {
  const manifest = buildToolManifest(wpPostCartridge);
  return new Response(
    JSON.stringify({
      ...manifest,
      protocolVersion: '2025-03-26',
      serverInfo: {
        name: wpPostCartridge.id,
        version: wpPostCartridge.version,
      },
    }, null, 2),
    {
      headers: { 'content-type': CONTENT_TYPE_JSON, 'cache-control': 'public, max-age=60' },
    },
  );
}

async function handleWpMcpInvoke(url: URL, req: Request, env: Env): Promise<Response> {
  const toolName = url.pathname.replace('/wp/mcp/tools/', '');
  if (!toolName) return badRequest('missing_tool_name');

  const config = await loadWpConfig(env);
  const snapshot = await fetchWpSnapshot(url, req, env, config);

  const input: Record<string, string> = {};
  url.searchParams.forEach((v, k) => {
    if (k !== 'post' && k !== 'site') input[k] = v;
  });

  const out = await dispatchTool(wpPostCartridge, toolName, input, snapshot, { config });
  if (!out.ok) return badRequest(`${out.error.code}: ${out.error.message}`);

  const { snapshotId } = snapshot;
  return new Response(JSON.stringify({ tool: toolName, result: out.result, snapshotId }, null, 2), {
    headers: {
      'content-type': CONTENT_TYPE_JSON,
      'cache-control': 'no-store',
      'x-airo-snapshot-id': snapshotId,
    },
  });
}

// ─── Landing index ─────────────────────────────────────────────────────────

function handleLanding(): Response {
  // The landing page has no cartridge and no snapshot — which is exactly
  // why `renderDocument` composes with `renderAppWithPublication` rather
  // than wrapping it. A wrapper could not serve this route at all.
  const doc = renderDocument({
    head: {
      lang: 'en',
      title: 'airo-js edge demo — two cartridges, four audience surfaces',
      viewport: 'width=device-width, initial-scale=1',
      inlineStyles: [DEMO_CSS],
    },
    body: `
  <div class="airo-landing">
    <h1>airo-js edge demo</h1>
    <p>One Cloudflare Worker, two cartridges, four surfaces per cartridge — all rendered from one snapshot per request. No cache to bust.</p>

    <h2>Shopify product card</h2>
    <ul>
      <li><a href="/shopify/"><code>/shopify/</code></a> — human HTML + inline JSON-LD</li>
      <li><a href="/shopify/schema.json"><code>/shopify/schema.json</code></a> — Schema.org Product</li>
      <li><a href="/shopify/feed.xml"><code>/shopify/feed.xml</code></a> — Google Merchant Center XML feed</li>
      <li><a href="/shopify/mcp"><code>/shopify/mcp</code></a> — MCP tool manifest (Claude / Operator / agents)</li>
      <li>Override per-request: <code>?product=&lt;handle&gt;</code></li>
    </ul>

    <h2>WordPress blog post</h2>
    <ul>
      <li><a href="/wp/"><code>/wp/</code></a> — human HTML + inline JSON-LD</li>
      <li><a href="/wp/schema.json"><code>/wp/schema.json</code></a> — Schema.org BlogPosting</li>
      <li><a href="/wp/mcp"><code>/wp/mcp</code></a> — MCP tool manifest</li>
      <li>Override per-request: <code>?post=&lt;slug&gt;</code> and/or <code>?site=&lt;hostname&gt;</code></li>
    </ul>

    <p>Same render path, same snapshotId consistency, different data sources. The framework's snapshot-fidelity guarantee applied to commerce and content side-by-side.</p>
  </div>`,
  });
  return new Response(doc, { headers: { 'content-type': CONTENT_TYPE_HTML, 'cache-control': 'public, max-age=60' } });
}

// ─── Generic helpers ───────────────────────────────────────────────────────

function notFound(message: string): Response {
  return new Response(JSON.stringify({ error: 'not_found', message }), {
    status: 404,
    headers: { 'content-type': CONTENT_TYPE_JSON },
  });
}

function badRequest(message: string): Response {
  return new Response(JSON.stringify({ error: 'bad_request', message }), {
    status: 400,
    headers: { 'content-type': CONTENT_TYPE_JSON },
  });
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}
