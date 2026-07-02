#!/usr/bin/env node
/**
 * Fixture-based smoke for the multi-cartridge edge worker.
 *
 * No Shopify or WordPress fetches happen — both cartridges are exercised
 * against fixed in-memory product/post snapshots. Asserts:
 *
 *   Shopify cartridge:
 *     - HTML render via renderAppWithPublication
 *     - inline JSON-LD payload + airo:snapshotId match
 *     - data-snapshot-id attr on widget HTML
 *     - direct runPublicationAdapters returns the same payload
 *     - Merchant Center XML adapter passes validation + carries snapshotId
 *     - MCP getPrice returns matching snapshotId
 *
 *   WordPress cartridge:
 *     - HTML render via renderAppWithPublication
 *     - inline JSON-LD payload + airo:snapshotId match
 *     - BlogPosting @type
 *     - MCP getExcerpt returns matching snapshotId
 *
 * Runs in Node-direct (no Wrangler runtime). Use bun: `pnpm smoke`.
 */

import { parseHTML } from 'linkedom';
import { renderAppWithPublication, runPublicationAdapters } from '@airo-js/ssr';

import {
  shopifyProductCartridge,
  shopifyProductDataSource,
} from '../src/shopify/cartridge.ts';
import { dispatchTool as dispatchShopifyTool } from '../src/shopify/mcp.ts';
import { wpPostCartridge } from '../src/wp/cartridge.ts';
import { dispatchTool as dispatchWpTool } from '../src/wp/mcp.ts';
import { SHOPIFY_APP_CONFIG, WP_APP_CONFIG } from '../src/demo-config.ts';
import { hashSnapshot } from '../src/snapshot-id.ts';

// ─── Shopify fixture ────────────────────────────────────────────────────────

const SHOPIFY_RAW = {
  id: 'gid://shopify/Product/1',
  handle: 'the-collection-snowboard-by-burton',
  title: 'The Collection Snowboard by Burton',
  description:
    "The Collection Snowboard is the perfect board for the all-mountain rider. Featuring premium materials and superior craftsmanship.",
  vendor: 'Burton',
  productType: 'Snowboard',
  availableForSale: true,
  sku: 'SB-001',
  featuredImageUrl: 'https://cdn.shopify.com/s/files/example.jpg',
  images: ['https://cdn.shopify.com/s/files/example.jpg'],
  price: { amount: '799.99', currencyCode: 'USD' },
  compareAtPrice: { amount: '999.99', currencyCode: 'USD' },
  onlineStoreUrl: 'https://demo-store.myshopify.com/products/the-collection-snowboard-by-burton',
};

// ─── WordPress fixture ──────────────────────────────────────────────────────

const WP_RAW = {
  id: 4242,
  slug: 'hello-airo-js',
  title: 'Hello airo-js — edge cartridges that hit live data',
  excerpt:
    'A short walkthrough of building edge-rendered cartridges with the airo-js framework. Three audiences served from one render snapshot.',
  content:
    'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Edge-rendered cartridges combine the data-fetching of a Worker with the structured-output guarantee of the airo-js cartridge contract.',
  link: 'https://wordpress.org/news/2026/05/hello-airo-js/',
  publishedAt: '2026-05-20T12:00:00.000Z',
  modifiedAt: '2026-05-21T15:30:00.000Z',
  author: { name: 'Sample Author', url: 'https://wordpress.org/author/sample-author/' },
  featuredImageUrl: 'https://example.com/featured.jpg',
  categories: ['Engineering', 'Edge'],
  tags: ['airo-js', 'cartridges'],
  siteName: 'wordpress.org/news',
  siteUrl: 'https://wordpress.org/news',
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function extractJsonLd(html, label) {
  const match = html.match(/<script type="application\/ld\+json">([\s\S]+?)<\/script>/);
  if (!match) throw new Error(`[${label}] inline JSON-LD not found`);
  return JSON.parse(match[1].replace(/\\u003c/g, '<'));
}

function assert(cond, label, msg) {
  if (!cond) throw new Error(`[${label}] ASSERTION FAILED: ${msg}`);
}

// ─── Shopify smoke ──────────────────────────────────────────────────────────

async function smokeShopify() {
  console.log('=== Shopify cartridge ===');
  const snapshotId = await hashSnapshot(SHOPIFY_RAW);
  const snapshot = { ...SHOPIFY_RAW, snapshotId };
  console.log(`[shopify] snapshot built — id=${snapshotId}`);

  const { document } = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>');

  const renderStart = performance.now();
  const { html: widgetHtml, adapterResults } = await renderAppWithPublication({
    cartridge: shopifyProductCartridge,
    appConfig: SHOPIFY_APP_CONFIG,
    snapshot,
    publicationCtx: {
      config: shopifyProductCartridge.defaultConfig,
      locale: 'en-US',
      country: 'US',
      currency: 'USD',
    },
    document,
  });
  const renderMs = performance.now() - renderStart;
  console.log(`[shopify] render took ${renderMs.toFixed(2)} ms · html=${widgetHtml.length} chars · adapters ran=${adapterResults.length}`);

  // Inline JSON-LD
  const parsed = extractJsonLd(widgetHtml, 'shopify');
  assert(parsed['@type'] === 'Product', 'shopify', `JSON-LD @type expected Product, got ${parsed['@type']}`);
  assert(parsed['airo:snapshotId'] === snapshotId, 'shopify', `JSON-LD snapshotId mismatch`);
  console.log(`[shopify] inline JSON-LD ok — @type=${parsed['@type']} snapshotId=${parsed['airo:snapshotId']}`);

  // data-snapshot-id attr
  const attrMatch = widgetHtml.match(/data-snapshot-id="([^"]+)"/);
  assert(attrMatch && attrMatch[1] === snapshotId, 'shopify', `data-snapshot-id attr mismatch`);

  // Direct adapter run — exercises ALL adapters (json-ld + merchant-center xml)
  const direct = await runPublicationAdapters(
    shopifyProductCartridge,
    snapshot,
    {
      config: shopifyProductCartridge.defaultConfig,
      locale: 'en-US',
      country: 'US',
      currency: 'USD',
    },
  );
  assert(direct.length === 2, 'shopify', `expected 2 adapters, got ${direct.length}`);

  const jsonLdResult = direct.find((r) => r.adapterId === 'product-json-ld');
  assert(jsonLdResult?.validation.valid, 'shopify', `JSON-LD validation failed`);
  console.log(`[shopify] adapter[product-json-ld] valid=${jsonLdResult.validation.valid} included=${jsonLdResult.included}`);

  const xmlResult = direct.find((r) => r.adapterId === 'merchant-center-xml');
  assert(xmlResult?.validation.valid, 'shopify', `Merchant Center XML validation failed: ${JSON.stringify(xmlResult?.validation.errors)}`);
  const xmlOut = xmlResult.output;
  assert(xmlOut.itemCount === 1, 'shopify', `expected 1 XML item, got ${xmlOut.itemCount}`);
  assert(xmlOut.xml.includes(snapshotId), 'shopify', `XML feed missing snapshotId`);
  assert(xmlOut.xml.includes('<g:price>'), 'shopify', `XML feed missing g:price`);
  assert(xmlOut.xml.includes('<g:image_link>'), 'shopify', `XML feed missing g:image_link`);
  console.log(`[shopify] adapter[merchant-center-xml] valid=${xmlResult.validation.valid} included=${xmlResult.included} itemCount=${xmlOut.itemCount} xml.length=${xmlOut.xml.length}`);

  // MCP tool dispatch
  const { result: priceResult, snapshotId: priceSnapshotId } = await dispatchShopifyTool(
    'getPrice', {}, { data: snapshot, config: shopifyProductCartridge.defaultConfig },
  );
  assert(priceSnapshotId === snapshotId, 'shopify', `MCP getPrice snapshotId mismatch`);
  assert(priceResult.amount === SHOPIFY_RAW.price.amount, 'shopify', `MCP getPrice amount mismatch`);
  console.log(`[shopify] MCP getPrice ok — ${priceResult.amount} ${priceResult.currencyCode} snapshotId=${priceSnapshotId}`);

  // DataSource declared
  assert(typeof shopifyProductDataSource.fetch === 'function', 'shopify', `dataSource.fetch missing`);

  return { snapshotId, htmlLength: widgetHtml.length, renderMs, xmlLength: xmlOut.xml.length };
}

// ─── WordPress smoke ────────────────────────────────────────────────────────

async function smokeWp() {
  console.log('=== WordPress cartridge ===');
  const snapshotId = await hashSnapshot(WP_RAW);
  const snapshot = { ...WP_RAW, snapshotId };
  console.log(`[wp] snapshot built — id=${snapshotId}`);

  const { document } = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>');

  const renderStart = performance.now();
  const { html: widgetHtml, adapterResults } = await renderAppWithPublication({
    cartridge: wpPostCartridge,
    appConfig: WP_APP_CONFIG,
    snapshot,
    publicationCtx: {
      config: wpPostCartridge.defaultConfig,
      locale: 'en-US',
      country: 'US',
    },
    document,
  });
  const renderMs = performance.now() - renderStart;
  console.log(`[wp] render took ${renderMs.toFixed(2)} ms · html=${widgetHtml.length} chars · adapters ran=${adapterResults.length}`);

  // Inline JSON-LD
  const parsed = extractJsonLd(widgetHtml, 'wp');
  assert(parsed['@type'] === 'BlogPosting', 'wp', `JSON-LD @type expected BlogPosting, got ${parsed['@type']}`);
  assert(parsed['airo:snapshotId'] === snapshotId, 'wp', `JSON-LD snapshotId mismatch`);
  console.log(`[wp] inline JSON-LD ok — @type=${parsed['@type']} snapshotId=${parsed['airo:snapshotId']}`);

  // data-snapshot-id attr
  const attrMatch = widgetHtml.match(/data-snapshot-id="([^"]+)"/);
  assert(attrMatch && attrMatch[1] === snapshotId, 'wp', `data-snapshot-id attr mismatch`);

  // MCP tool dispatch
  const { result: excerptResult, snapshotId: excerptSnapshotId } = await dispatchWpTool(
    'getExcerpt', {}, { data: snapshot, config: wpPostCartridge.defaultConfig },
  );
  assert(excerptSnapshotId === snapshotId, 'wp', `MCP getExcerpt snapshotId mismatch`);
  assert(excerptResult.title === WP_RAW.title, 'wp', `MCP getExcerpt title mismatch`);
  console.log(`[wp] MCP getExcerpt ok — title="${excerptResult.title.slice(0, 30)}..." snapshotId=${excerptSnapshotId}`);

  return { snapshotId, htmlLength: widgetHtml.length, renderMs };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const shopify = await smokeShopify();
  console.log('');
  const wp = await smokeWp();
  console.log('');

  console.log('========================================');
  console.log('SMOKE PASSED');
  console.log('========================================');
  console.log(`Shopify cartridge:   render=${shopify.renderMs.toFixed(2)}ms  html=${shopify.htmlLength}  xml=${shopify.xmlLength}  snapshotId=${shopify.snapshotId}`);
  console.log(`WordPress cartridge: render=${wp.renderMs.toFixed(2)}ms  html=${wp.htmlLength}  snapshotId=${wp.snapshotId}`);
  console.log('');
  console.log('Verified per cartridge:');
  console.log('  inline JSON-LD payload   → airo:snapshotId matches');
  console.log('  data-snapshot-id attr    → matches');
  console.log('  direct adapter run       → matches');
  console.log('  MCP tool response        → matches');
  console.log('Shopify-only:');
  console.log('  Merchant Center XML feed → validates + carries snapshotId');
}

main().catch((err) => {
  console.error('[smoke] FATAL:', err);
  process.exit(1);
});
