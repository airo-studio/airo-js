/**
 * PublicationAdapter pair skeleton.
 *
 * Stresses the v0.2 contract's most-load-bearing primitive in isolation:
 * two adapters (Schema.org JSON-LD inline + Merchant Center XML signed-
 * feed) consuming the SAME post-Transformer snapshot and producing
 * genuinely different output formats (JSON-LD object vs XML string).
 *
 * If the contract holds for both adapters under one schema, the
 * "one cartridge fans out to multiple publication surfaces" property
 * the v0 product spec depends on is type-sound.
 *
 * THROWAWAY. Generate functions return stubs; validate returns canned
 * passes. Real implementations land in dotter-monorepo's WTB cartridge
 * port (Phase 1). This file's only job is "do these types compose?"
 */

import type {
  PublicationAdapter,
  PublicationContext,
  ValidationResult,
} from '@ai-ro/cartridge-kit';

// ─── Shared schema (mirrors a slice of WtbData) ────────────────────

interface ProductSnapshot {
  products: Array<{
    id: string;
    gtin: string;
    title: string;
    brand: string;
    images: string[];
    googleProductCategory?: string;
    offers: Array<{
      price: number;
      currency: string;
      availability: 'in_stock' | 'out_of_stock' | 'preorder';
      url: string;
      condition?: 'new' | 'refurbished' | 'used';
    }>;
  }>;
}

interface SharedConfig {
  brandName: string;
  publicationLocale: string;
  merchantCenterAccountId?: string;
}

const PASS: ValidationResult = { valid: true, errors: [], warnings: [] };

// ─── Adapter A — Schema.org JSON-LD (inline-in-host) ───────────────

interface JsonLdGraph {
  '@context': 'https://schema.org';
  '@graph': Record<string, unknown>[];
}

export const jsonLdAdapter: PublicationAdapter<ProductSnapshot, JsonLdGraph, SharedConfig> = {
  id: 'schema-org-json-ld',
  displayName: 'Schema.org JSON-LD',
  description: 'Inline structured data for Google Rich Results.',
  format: 'json-ld',
  requires: [
    { path: 'product.gtin', required: 'always' },
    { path: 'product.title', required: 'always' },
    { path: 'product.images', required: 'always' },
    { path: 'offer.price', required: 'always' },
    { path: 'offer.availability', required: 'always' },
    { path: 'offer.url', required: 'always' },
  ],
  generate: async (
    snapshot: ProductSnapshot,
    _ctx: PublicationContext<SharedConfig>,
  ): Promise<JsonLdGraph> => {
    // Stub — real impl projects ProductSnapshot into Product/Offer/AggregateOffer nodes.
    return {
      '@context': 'https://schema.org',
      '@graph': snapshot.products.map((p) => ({
        '@type': 'Product',
        gtin13: p.gtin,
        name: p.title,
        brand: { '@type': 'Brand', name: p.brand },
        image: p.images,
        offers: p.offers.map((o) => ({
          '@type': 'Offer',
          price: o.price,
          priceCurrency: o.currency,
          availability: `https://schema.org/${o.availability === 'in_stock' ? 'InStock' : 'OutOfStock'}`,
          url: o.url,
        })),
      })),
    };
  },
  validate: () => PASS,
  refreshCadence: { min: { ms: 0 }, max: { ms: 6 * 60 * 60_000 } },
  delivery: 'inline-in-host',
  onValidationFail: 'block-publish',
};

// ─── Adapter B — Merchant Center XML (signed-feed-url) ─────────────

interface MerchantCenterXml {
  xml: string;
  itemCount: number;
}

export const merchantCenterAdapter: PublicationAdapter<ProductSnapshot, MerchantCenterXml, SharedConfig> = {
  id: 'merchant-center-xml',
  displayName: 'Google Merchant Center XML feed',
  description: 'Polled-by-Google feed; free Shopping listings derive from this.',
  format: 'xml',
  requires: [
    { path: 'product.gtin', required: 'always' },
    { path: 'product.brand', required: 'always' },
    { path: 'product.images', required: 'always' },
    { path: 'product.googleProductCategory', required: 'always' },
    { path: 'offer.price', required: 'always' },
    { path: 'offer.availability', required: 'always' },
    { path: 'offer.url', required: 'always' },
    { path: 'offer.condition', required: 'preferred' },
  ],
  generate: async (
    snapshot: ProductSnapshot,
    _ctx: PublicationContext<SharedConfig>,
  ): Promise<MerchantCenterXml> => {
    return { xml: '<rss/>', itemCount: snapshot.products.length };
  },
  validate: () => PASS,
  refreshCadence: { min: { ms: 60 * 60_000 }, max: { ms: 24 * 60 * 60_000 } },
  delivery: 'signed-feed-url',
  onValidationFail: 'block-publish',
};

// ─── Both adapters consume the SAME snapshot type ──────────────────
// The contract guarantee tested here: a single ProductSnapshot fans out
// to two adapters with different TOutput types. This compiles → the type
// parameters are independent, the snapshot is shared, the contract holds.

export const adapters: ReadonlyArray<PublicationAdapter<ProductSnapshot, unknown, SharedConfig>> = [
  jsonLdAdapter,
  merchantCenterAdapter,
];
