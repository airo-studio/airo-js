/**
 * Cartridge envelope — Shopify Product Card.
 *
 * Declares the full contract: schema, dataSources, views,
 * publicationAdapters, mcpTools, templates, defaults, mailbox.
 *
 * The view uses `defineSSRSafeRenderer` from cartridge-kit — one pure
 * `template(ctx)` function produces byte-identical HTML on server and
 * client, with `hydrate(root, ctx)` attaching any client-side
 * listeners.
 *
 * Three contract guarantees, demonstrated:
 *   1. Snapshot fidelity — view, MCP tools, and JSON-LD adapter ALL
 *      consume the same `ProductSnapshot` post-DataSource. The
 *      `snapshotId` on the snapshot demonstrates this is the same
 *      data.
 *   2. Coverage gating — adapter declares `requires` (id/title/price/
 *      currency as 'always'); the framework can skip if upstream
 *      data is incomplete.
 *   3. Validation as hard gate — `productJsonLdAdapter.validate()`
 *      blocks the JSON-LD from being inlined if the output is broken
 *      (default `onValidationFail: 'block-publish'`).
 */

import type {
  Cartridge,
  DataSource,
  ViewDefinition,
  Template,
  SchemaDefinition,
} from '@airo-js/cartridge-kit';
import { defineSSRSafeRenderer } from '@airo-js/cartridge-kit';

import { productJsonLdAdapter, merchantCenterXmlAdapter } from './adapters.js';
import { PRODUCT_TOOLS } from './mcp.js';
import { fetchShopifyProduct } from './client.js';
import { hashSnapshot } from '../snapshot-id.js';
import type { ProductSnapshot, ShopifyConfig } from './types.js';

/**
 * SchemaDefinition stub — v0 doesn't validate the Shopify response
 * at runtime to keep the Worker bundle small. The schema contract is
 * declared; tools that need a wire format (MCP, OpenAPI) can fall
 * through to `toJsonSchema()` once implemented.
 *
 * When upgrading: drop in a real Zod schema in a server-only entry
 * (two-envelope pattern from §6 of CLAUDE.md / docs/best-practices).
 */
const productSchema: SchemaDefinition<ProductSnapshot> = {
  parse(input: unknown): ProductSnapshot {
    return input as ProductSnapshot;
  },
  safeParse(input: unknown) {
    return { success: true as const, data: input as ProductSnapshot };
  },
};

/**
 * DataSource — connects to the Shopify Storefront API.
 *
 * `fetch(input, ctx)` is called by the host app (the Worker) with:
 *   - input.kind: 'custom' carrying the productHandle override
 *     (typically derived from URL `?product=...` or from config)
 *   - ctx.config: ShopifyConfig (productHandle is the default)
 *   - ctx.credentials: { SHOPIFY_DOMAIN, SHOPIFY_STOREFRONT_TOKEN }
 *   - ctx.signal: AbortSignal threaded from the Worker's request
 *
 * `errorPolicy` — declared inline in the Worker today via try/catch
 * (the Worker decides whether to serve a fallback, fail-render, or
 * retry). Framework Ask 1 will lift this into a typed field on
 * DataSource itself; see msg_mpgtzyld_19ef1e on the bridge.
 */
export const shopifyProductDataSource: DataSource<ProductSnapshot, ShopifyConfig> = {
  id: 'shopify-storefront',
  displayName: 'Shopify Storefront API',
  onboardingShape: {
    kind: 'oauth-connect',
    provider: 'shopify-storefront',
  },
  cacheTtlMs: 0, // Live data — no host-app caching. The whole point of the demo.

  async fetch(input, ctx): Promise<ProductSnapshot> {
    const token = ctx.credentials?.SHOPIFY_STOREFRONT_TOKEN;
    const domain = ctx.credentials?.SHOPIFY_DOMAIN;
    if (!token || !domain) {
      throw new Error(
        '[shopify-edge-worker] Missing credentials: pass SHOPIFY_STOREFRONT_TOKEN and SHOPIFY_DOMAIN via ctx.credentials.',
      );
    }

    // Resolve handle: prefer input.payload.handle override, else fall
    // back to config.productHandle. Lets the Worker render
    // `/?product=...` for one-off URLs without rewriting KV config.
    const handle = (input.kind === 'custom' && (input.payload as { handle?: string })?.handle)
      || ctx.config.productHandle;

    const raw = await fetchShopifyProduct({ domain, token, handle, signal: ctx.signal });

    // Build the post-DataSource snapshot. snapshotId is computed AFTER
    // assembling all the fields the snapshot exposes — this is the
    // shape the view, JSON-LD adapter, and MCP tools all consume.
    const snapshotMinusId = {
      id: raw.id,
      handle: raw.handle,
      title: raw.title,
      description: raw.description,
      vendor: raw.vendor,
      productType: raw.productType,
      availableForSale: raw.availableForSale,
      sku: raw.variants.edges[0]?.node.sku ?? null,
      featuredImageUrl: raw.featuredImage?.url ?? null,
      images: raw.images.edges.map((e) => e.node.url),
      price: {
        amount: raw.priceRange.minVariantPrice.amount,
        currencyCode: raw.priceRange.minVariantPrice.currencyCode,
      },
      compareAtPrice: raw.compareAtPriceRange.minVariantPrice.amount === '0.0'
        ? null
        : {
            amount: raw.compareAtPriceRange.minVariantPrice.amount,
            currencyCode: raw.compareAtPriceRange.minVariantPrice.currencyCode,
          },
      onlineStoreUrl: raw.onlineStoreUrl,
    } satisfies Omit<ProductSnapshot, 'snapshotId'>;

    const snapshotId = await hashSnapshot(snapshotMinusId);

    return { ...snapshotMinusId, snapshotId };
  },

  cacheKey(input) {
    if (input.kind === 'custom') {
      const handle = (input.payload as { handle?: string })?.handle ?? 'default';
      return `shopify-product:${handle}`;
    }
    return 'shopify-product:default';
  },
};

/**
 * The product page view. `defineSSRSafeRenderer` derives `render`,
 * `renderSSR`, and `hydrate` from one pure `template(ctx)` + one
 * `hydrate(root, ctx)` handler — drift between the three paths is
 * structurally impossible.
 */
const productView: ViewDefinition<ProductSnapshot, ShopifyConfig> = {
  id: 'product-card',
  displayName: 'Shopify product card',
  pageType: 'product',
  capabilities: ['ssr-safe', 'hydratable'],
  stylesheet: undefined, // Loaded as a separate /demo.css link in the worker's HTML wrapper.
  factory: defineSSRSafeRenderer<'product', { cartridgeId: string; config: ShopifyConfig; data: ProductSnapshot }>({
    template(ctx) {
      const product = ctx.app.data;
      const config = ctx.app.config;
      const formattedPrice = formatPrice(product.price.amount, product.price.currencyCode);
      const compareAt = product.compareAtPrice && config.display.showCompareAtPrice
        ? formatPrice(product.compareAtPrice.amount, product.compareAtPrice.currencyCode)
        : null;
      const heroSrc = product.featuredImageUrl ?? product.images[0] ?? '';

      return `
        <article class="airo-product-card" data-cartridge="shopify-product-card" data-snapshot-id="${escapeAttr(product.snapshotId)}">
          ${heroSrc ? `<img class="airo-product-card__image" src="${escapeAttr(heroSrc)}" alt="${escapeAttr(product.title)}" loading="lazy" />` : ''}
          <div class="airo-product-card__body">
            ${config.display.showVendor && product.vendor ? `<p class="airo-product-card__vendor">${escapeHtml(product.vendor)}</p>` : ''}
            <h1 class="airo-product-card__title">${escapeHtml(product.title)}</h1>
            <div class="airo-product-card__price-row">
              <span class="airo-product-card__price">${escapeHtml(formattedPrice)}</span>
              ${compareAt ? `<s class="airo-product-card__compare">${escapeHtml(compareAt)}</s>` : ''}
            </div>
            <p class="airo-product-card__description">${escapeHtml(truncate(product.description, 240))}</p>
            <a class="airo-product-card__buy" href="${escapeAttr(product.onlineStoreUrl ?? '#')}" ${product.availableForSale ? '' : 'aria-disabled="true"'}>
              ${product.availableForSale ? 'Buy on Shopify' : 'Out of stock'}
            </a>
            <p class="airo-product-card__snapshot">snapshot · <code>${escapeHtml(product.snapshotId)}</code></p>
          </div>
        </article>
      `.trim();
    },
    hydrate(_root, _ctx) {
      // v0 has no client-side interactivity (buy button is a plain
      // anchor). Hook here when adding quantity selectors, variant
      // pickers, or analytics.
      return undefined;
    },
  }),
};

const defaultConfig: ShopifyConfig = {
  productHandle: 'the-collection-snowboard-by-burton',
  locale: 'en-US',
  display: {
    showVendor: true,
    showCompareAtPrice: true,
  },
};

const defaultTemplate: Template<ShopifyConfig> = {
  id: 'default',
  displayName: 'Default product layout',
  description: 'Single product page; uses the configured productHandle as the entry.',
  pages: [
    {
      id: 'product',
      type: 'product',
      enabled: true,
      layout: {
        regionOrder: ['main'],
        regions: { main: { id: 'main', components: [] } },
      },
    },
  ],
  defaultConfig,
};

export const shopifyProductCartridge: Cartridge<ProductSnapshot, ShopifyConfig> = {
  id: 'shopify-product-card',
  industry: 'commerce',
  displayName: 'Shopify product card',
  description:
    'Edge-rendered product card backed by the Shopify Storefront API. Emits human HTML, Schema.org Product JSON-LD, and an MCP tool manifest from one render snapshot — no cache to bust.',
  version: '0.1.0',

  schema: productSchema,
  dataSources: [shopifyProductDataSource],
  views: [productView],
  templates: [defaultTemplate],
  publicationAdapters: [productJsonLdAdapter, merchantCenterXmlAdapter],
  mcpTools: PRODUCT_TOOLS,

  defaultConfig,
  defaultTemplateId: 'default',
  mailboxName: '__AIRO_SHOPIFY_PRODUCT_CARD_PAGES__',
};

// --- formatting + escaping helpers (template-local; no client deps) ---

function formatPrice(amount: string, currencyCode: string): string {
  // Edge runtimes have Intl.NumberFormat but not necessarily all locale data.
  // Best-effort: fall back to a simple template if the runtime fails.
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currencyCode,
    }).format(Number(amount));
  } catch {
    return `${currencyCode} ${amount}`;
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
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
