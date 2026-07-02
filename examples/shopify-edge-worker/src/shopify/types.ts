/**
 * Shared types for the Shopify edge-worker example.
 *
 * Three shapes, three audiences:
 *   - `ProductSnapshot`  — post-Transformer data shape consumed by all
 *                          three surfaces (views, MCP tools, JSON-LD).
 *                          Carries `snapshotId` for cross-surface
 *                          verifiability (Ask 2 in the framework asks
 *                          on the bridge — will hoist to
 *                          `RenderContext.snapshotId` when 0.9.x lands).
 *   - `ShopifyConfig`    — cartridge configuration (productHandle,
 *                          locale, display flags). Editable surface only;
 *                          credentials live in Worker env, not config.
 *   - `ProductJsonLd`    — Schema.org Product output emitted by the
 *                          PublicationAdapter and inlined in HTML.
 */

/**
 * Cartridge config — what the studio (v1) will write to KV, or what
 * `demo-config.ts` provides as fallback. Holds editable surface ONLY:
 * the Shopify storefront domain + access token are Worker env (host-app
 * secrets), not cartridge config — M13 holds.
 */
export interface ShopifyConfig {
  /** Shopify product handle, e.g. 'the-collection-snowboard-by-burton'. */
  productHandle: string;
  /** BCP-47 locale tag, e.g. 'en-US'. Used by the PublicationAdapter. */
  locale: string;
  display: {
    showVendor: boolean;
    showCompareAtPrice: boolean;
  };
}

/**
 * Post-Transformer product snapshot. The same shape consumed by:
 *   - the view (renders HTML)
 *   - the PublicationAdapter (emits Schema.org JSON-LD)
 *   - MCP tool handlers (answer agent queries)
 *
 * The `snapshotId` field is the v0 placeholder for Ask 2 — when the
 * framework hoists snapshotId into `RenderContext`, this field
 * disappears from the snapshot type and consumers read it from
 * `ctx.snapshotId`. Until then, putting it on the snapshot is the
 * pragmatic way to make all three surfaces report the same id.
 *
 * snapshotId timing per dotter-monorepo team advice (bridge thread
 * msg_mpgtzyld_19ef1e): computed post-pipeline, pre-PostProcessor.
 * In this example there are no transformers or post-processors, so
 * the snapshot the DataSource returns is the snapshot we render.
 */
export interface ProductSnapshot {
  id: string;
  handle: string;
  title: string;
  description: string;
  vendor: string;
  productType: string;
  availableForSale: boolean;
  sku: string | null;
  featuredImageUrl: string | null;
  images: string[];
  price: { amount: string; currencyCode: string };
  compareAtPrice: { amount: string; currencyCode: string } | null;
  onlineStoreUrl: string | null;
  /**
   * Stable hash of the snapshot's data fields above. Same value visible
   * across HTML (`<meta name="airo:snapshot-id">`), JSON-LD
   * (`airo:snapshotId`), and MCP tool responses. Demonstrates Ask 2.
   */
  snapshotId: string;
}

/**
 * Schema.org Product JSON-LD shape — what the PublicationAdapter emits.
 * One non-standard field (`airo:snapshotId`) for cross-surface
 * verifiability; everything else is Schema.org spec.
 */
export interface ProductJsonLd {
  '@context': 'https://schema.org';
  '@type': 'Product';
  '@id'?: string;
  name: string;
  description: string;
  brand: { '@type': 'Brand'; name: string };
  image: string[];
  sku?: string;
  category?: string;
  url?: string;
  offers: {
    '@type': 'Offer';
    price: string;
    priceCurrency: string;
    availability: string;
    url?: string;
  };
  'airo:snapshotId'?: string;
}
