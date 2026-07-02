/**
 * PublicationAdapter — Schema.org Product JSON-LD for inline-in-host
 * delivery.
 *
 * The cartridge declares this adapter; the worker calls
 * `renderAppWithPublication` from `@airo-js/ssr`, which:
 *   1. runs this adapter against the post-Transformer snapshot
 *   2. validates the output via `validate()`
 *   3. inlines the result as `<script type="application/ld+json">`
 *      BEFORE the widget HTML
 *
 * Pattern mirrors the commerce cartridge in dotter-monorepo:
 *   packages/widget-runtime-ssr/src/cartridge/publication-adapters/products-json-ld.ts
 * Different source data (Shopify Storefront vs feed CDN), same output
 * surface, same framework contract.
 */

import type { PublicationAdapter, SchemaFieldRef } from '@airo-js/cartridge-kit';

import type { ProductJsonLd, ProductSnapshot, ShopifyConfig } from './types.js';
import { toProductJsonLd } from './jsonld.js';
import { toMerchantCenterXml, type MerchantCenterFeed } from './merchant-center.js';

/**
 * Field paths the adapter requires from the cartridge schema. Used by
 * (a) the host app to surface coverage gaps, (b) the framework to skip
 * the adapter if a required field is missing, (c) validation gate.
 */
const REQUIRES: SchemaFieldRef[] = [
  { path: 'id', required: 'always' },
  { path: 'title', required: 'always' },
  { path: 'description', required: 'preferred' },
  { path: 'vendor', required: 'preferred' },
  { path: 'price.amount', required: 'always' },
  { path: 'price.currencyCode', required: 'always' },
  { path: 'availableForSale', required: 'always' },
  { path: 'images', required: 'preferred' },
  { path: 'sku', required: 'optional' },
  { path: 'productType', required: 'optional' },
  { path: 'onlineStoreUrl', required: 'optional' },
];

/**
 * Validate the emitted JSON-LD against Schema.org Product's minimum
 * requirements. Hard gate: when `valid: false`, the framework drops
 * the output from the inline render (default
 * `onValidationFail: 'block-publish'`).
 *
 * Validation is intentionally narrow: required fields present + types
 * sane. Doesn't re-validate the Schema.org spec at large; that's a
 * downstream crawler concern.
 */
function validateProductJsonLd(output: ProductJsonLd): {
  valid: boolean;
  errors: { code: string; path?: string; message: string; remediation?: string }[];
  warnings: { code: string; path?: string; message: string }[];
  coverage?: { covered: number; total: number };
} {
  const errors: { code: string; path?: string; message: string; remediation?: string }[] = [];
  const warnings: { code: string; path?: string; message: string }[] = [];

  if (!output.name) {
    errors.push({
      code: 'missing-name',
      path: 'name',
      message: 'Product must have a name',
    });
  }
  if (!output.offers.price || isNaN(Number(output.offers.price))) {
    errors.push({
      code: 'invalid-price',
      path: 'offers.price',
      message: 'Product price must be a numeric string',
      remediation: 'Check that Shopify returned a price for this product',
    });
  }
  if (!output.offers.priceCurrency) {
    errors.push({
      code: 'missing-currency',
      path: 'offers.priceCurrency',
      message: 'Product price must declare a currency (ISO 4217)',
    });
  }
  if (output.image.length === 0) {
    warnings.push({
      code: 'no-images',
      path: 'image',
      message: 'Product has no images — AI Overviews + retail panels typically require at least one',
    });
  }
  if (!output.description || output.description.length < 30) {
    warnings.push({
      code: 'short-description',
      path: 'description',
      message: 'Product description is short — crawlers prefer >=30 chars for indexing quality',
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    coverage: {
      covered: REQUIRES.filter((r) => r.required !== 'optional').length,
      total: REQUIRES.length,
    },
  };
}

export const productJsonLdAdapter: PublicationAdapter<
  ProductSnapshot,
  ProductJsonLd,
  ShopifyConfig
> = {
  id: 'product-json-ld',
  displayName: 'Product JSON-LD',
  description:
    'Emits Schema.org Product JSON-LD for inline embedding in the host page. Indexable by Google + AI Overviews; agent-readable via the same snapshot the human view + /mcp tools see.',
  format: 'json-ld',
  delivery: 'inline-in-host',
  requires: REQUIRES,
  refreshCadence: {
    // Inline JSON-LD regenerates on every render. No lower bound; no
    // upper bound below ~6h (anything longer than that and the data
    // probably went stale).
    min: { ms: 0 },
    max: { ms: 6 * 60 * 60 * 1000 },
  },
  onValidationFail: 'block-publish',

  async generate(snapshot, _ctx) {
    // No locale-specific mapping for v0 — Schema.org Product is locale-
    // agnostic and Shopify already returns localized text via the
    // Storefront API when @inContext is set on the query (future work).
    return toProductJsonLd(snapshot);
  },

  validate(output) {
    return validateProductJsonLd(output);
  },
};

// ─── Merchant Center XML feed adapter ──────────────────────────────────────
//
// `delivery: 'signed-feed-url'` — Google polls a stable URL on a schedule
// (daily, typically). Cartridge ships the regeneration logic; host app
// serves the URL. The Worker exposes /shopify/feed.xml.
//
// Required-field declarations are stricter than JSON-LD's because
// Merchant Center rejects items missing required fields outright. JSON-LD
// is more forgiving (Google parses what's there and ignores gaps).

const MERCHANT_CENTER_REQUIRES: SchemaFieldRef[] = [
  { path: 'id', required: 'always' },
  { path: 'title', required: 'always' },
  { path: 'description', required: 'always' },
  { path: 'vendor', required: 'always' },
  { path: 'price.amount', required: 'always' },
  { path: 'price.currencyCode', required: 'always' },
  { path: 'availableForSale', required: 'always' },
  { path: 'featuredImageUrl', required: 'always' },
  { path: 'onlineStoreUrl', required: 'always' },
  { path: 'sku', required: 'preferred' },
  { path: 'productType', required: 'preferred' },
];

function validateMerchantCenterXml(output: MerchantCenterFeed): {
  valid: boolean;
  errors: { code: string; path?: string; message: string; remediation?: string }[];
  warnings: { code: string; path?: string; message: string }[];
  coverage?: { covered: number; total: number };
} {
  const errors: { code: string; path?: string; message: string; remediation?: string }[] = [];
  const warnings: { code: string; path?: string; message: string }[] = [];

  // XML well-formedness: cheap regex check that the envelope closed
  // properly. Real-world parser-based validation belongs in CI, not
  // hot-path; the framework's hard gate is enough for runtime safety.
  if (!output.xml.includes('<rss') || !output.xml.includes('</rss>')) {
    errors.push({
      code: 'malformed-xml',
      message: 'XML envelope missing <rss>/</rss>',
    });
  }
  if (!output.xml.includes('<g:price>') && !output.xml.includes('<g:sale_price>')) {
    errors.push({
      code: 'missing-price',
      path: 'item.g:price',
      message: 'Merchant Center rejects items without g:price or g:sale_price',
    });
  }
  if (!output.xml.includes('<g:image_link>')) {
    errors.push({
      code: 'missing-image',
      path: 'item.g:image_link',
      message: 'Merchant Center requires g:image_link on every item',
    });
  }
  if (!output.xml.includes('<g:link>')) {
    errors.push({
      code: 'missing-link',
      path: 'item.g:link',
      message: 'Merchant Center requires g:link on every item',
    });
  }
  if (output.itemCount === 0) {
    errors.push({
      code: 'empty-feed',
      message: 'Feed must contain at least one <item>',
    });
  }
  if (!output.xml.includes('<g:mpn>') && !output.xml.includes('<g:gtin>')) {
    warnings.push({
      code: 'no-identifier',
      message: 'No GTIN or MPN on item — Google will index but with weaker matching',
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    coverage: {
      covered: MERCHANT_CENTER_REQUIRES.filter((r) => r.required === 'always').length,
      total: MERCHANT_CENTER_REQUIRES.length,
    },
  };
}

export const merchantCenterXmlAdapter: PublicationAdapter<
  ProductSnapshot,
  MerchantCenterFeed,
  ShopifyConfig
> = {
  id: 'merchant-center-xml',
  displayName: 'Google Merchant Center XML',
  description:
    'Emits a Google Shopping XML feed (RSS 2.0 + g: namespace). Google Merchant Center polls the configured URL daily; products show up in Google Shopping ads + free Shopping listings + AI Overviews. Same post-Transformer snapshot as the inline JSON-LD adapter, so the two feeds never drift.',
  format: 'xml',
  delivery: 'signed-feed-url',
  requires: MERCHANT_CENTER_REQUIRES,
  refreshCadence: {
    // Google's Merchant Center polls at most every hour and at least
    // every 30 days. 1h-24h is the sensible operating window.
    min: { ms: 60 * 60 * 1000 },
    max: { ms: 24 * 60 * 60 * 1000 },
  },
  onValidationFail: 'block-publish',

  async generate(snapshot, ctx) {
    return toMerchantCenterXml(snapshot, ctx.locale);
  },

  validate(output) {
    return validateMerchantCenterXml(output);
  },
};
