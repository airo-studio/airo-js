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
 * is type-sound.
 *
 * THROWAWAY. Generate functions return stubs; validate returns canned
 * passes. Real implementations live in consuming studio codebases. This
 * file's only job is "do these types compose?"
 */

import type {
  PublicationAdapter,
  PublicationContext,
  ValidationResult,
} from '@airo-js/cartridge-kit';

// ─── Shared schema (a slice of a product-catalogue snapshot) ───────

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

type CatalogueProduct = ProductSnapshot['products'][number];

function productNode(p: CatalogueProduct): Record<string, unknown> {
  return {
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
  };
}

// `| null`: on a product page whose `productId` names nothing, this adapter
// publishes nothing (the view shows its "not found" state there). The type
// has to say so, and `validate` has to accept it.
export const jsonLdAdapter: PublicationAdapter<ProductSnapshot, JsonLdGraph | null, SharedConfig> = {
  id: 'schema-org-json-ld',
  displayName: 'Schema.org JSON-LD',
  description: 'Inline structured data for Google Rich Results.',
  format: 'json-ld',
  // The snapshot is a catalogue: `products` is an array, so the only
  // coverage path the generator genuinely cannot run without is the array
  // itself. A segment after an array is an index (`products.0.gtin` means
  // "the first product's gtin"), and "every product has a gtin" is not a
  // path at all — it is validate()'s job.
  //
  // This used to read `product.gtin`, `offer.price`, … — singular keys
  // ProductSnapshot never had. `SchemaFieldRef<ProductSnapshot>` rejects
  // them now; the previous shape was the one consumers copied.
  requires: [{ path: 'products', required: 'always' }],
  generate: async (
    snapshot: ProductSnapshot,
    ctx: PublicationContext<SharedConfig>,
  ): Promise<JsonLdGraph | null> => {
    // One snapshot, several pages. `renderAppWithPublication` puts the
    // entry it resolved on the context, so the block inlined beside a
    // deep-linked product describes that product instead of the catalogue.
    //
    // Page type FIRST, then the key that page type owns: after a fallback
    // `page` is the default entry while `navState` still carries the
    // rejected request's `productId`.
    if (ctx.page?.type === 'product') {
      const shown = snapshot.products.find((p) => p.id === ctx.navState?.productId);
      return shown ? { '@context': 'https://schema.org', '@graph': [productNode(shown)] } : null;
    }
    // Every other page, and every run with no page at all (a feed
    // endpoint or a schedule calling `runPublicationAdapters` directly).
    return {
      '@context': 'https://schema.org',
      '@graph': snapshot.products.map(productNode),
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
  // Same reasoning as the JSON-LD adapter above. `'preferred'` on an
  // indexed path is legal and occasionally useful — "does the first item
  // carry a category" is a real signal for a host's coverage UI — but it
  // never gates, and it is not a substitute for per-item validation.
  requires: [
    { path: 'products', required: 'always' },
    { path: 'products.0.googleProductCategory', required: 'preferred' },
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
