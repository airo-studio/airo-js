/**
 * WTB cartridge type skeleton.
 *
 * Validates the @ai-ro/cartridge-kit contract against a real cartridge
 * shape — Where-to-Buy: Products with Retailers and Offers. Every primitive
 * the contract defines is exercised here so contract gaps surface as
 * type errors before the framework ships.
 *
 * THROWAWAY. None of this runs. Factories return `{} as ...` stubs.
 * Real implementations live in consuming studio codebases.
 *
 * Contract gaps surfaced while writing this skeleton are tracked
 * separately, not fixed inline.
 */

import type {
  Cartridge,
  DataSource,
  McpToolDefinition,
  PostProcessor,
  PublicationAdapter,
  SchemaDefinition,
  Template,
  Transformer,
  ValidationResult,
  ViewDefinition,
} from '@ai-ro/cartridge-kit';
import type { PageRenderer } from '@ai-ro/core';

// ─── 1. Schema (TData) ─────────────────────────────────────────────

interface WtbProduct {
  id: string;
  gtin: string;
  title: string;
  brand: string;
  description: string;
  images: string[];
  category: string;
  skus: WtbSku[];
}

interface WtbSku {
  id: string;
  variantAttributes: Record<string, string>;
  offers: WtbOffer[];
}

interface WtbOffer {
  retailerId: string;
  price: number;
  currency: string;
  availability: 'InStock' | 'OutOfStock' | 'PreOrder';
  url: string;
  shippingCountry: string;
}

interface WtbRetailer {
  id: string;
  name: string;
  logoUrl: string;
  countryCoverage: string[];
}

interface WtbData {
  products: WtbProduct[];
  retailers: Record<string, WtbRetailer>;
}

// ─── 2. Config (TConfig) ───────────────────────────────────────────

interface WtbConfig {
  feedUrl: string;
  retailers: { enabled: string[] };
  display: {
    showRatings: boolean;
    variantGroupingAttribute?: string;
  };
  storeFinder: {
    enabled: boolean;
    googleMapsKey?: string;
  };
}

// ─── 3. Schema definition ──────────────────────────────────────────

// Stub: real cartridge wraps Zod here. Skeleton just satisfies the contract shape.
const wtbSchema: SchemaDefinition<WtbData> = {
  parse: (input: unknown): WtbData => input as WtbData,
  safeParse: (input: unknown) => ({ success: true, data: input as WtbData }),
  toJsonSchema: () => ({}),
};

// ─── 4. DataSource ─────────────────────────────────────────────────

const feedUrlDataSource: DataSource<WtbData, WtbConfig> = {
  id: 'feed-url',
  displayName: 'Product Feed URL',
  onboardingShape: {
    kind: 'url-input',
    placeholder: 'https://example.com/feeds/products.json',
  },
  fetch: async (_input, _ctx) => ({ products: [], retailers: {} }),
  cacheTtlMs: 5 * 60_000,
};

// ─── 5. Transformers (six named, lifted from v1 production) ────────

const retailerFilter: Transformer<WtbData, WtbConfig> = {
  name: 'retailer-filter',
  isEnabled: (config) => config.retailers.enabled.length > 0,
  transform: (data) => data,
};

const categoryFilter: Transformer<WtbData, WtbConfig> = {
  name: 'category-filter',
  isEnabled: (_config) => true,
  transform: (data) => data,
};

const variantGrouper: Transformer<WtbData, WtbConfig> = {
  name: 'variant-grouper',
  isEnabled: (config) => Boolean(config.display.variantGroupingAttribute),
  transform: (data) => data,
};

const sortByPrice: Transformer<WtbData, WtbConfig> = {
  name: 'sort-by-price',
  isEnabled: (_config) => true,
  transform: (data) => data,
};

const stockFilter: Transformer<WtbData, WtbConfig> = {
  name: 'stock-filter',
  isEnabled: (_config) => true,
  transform: (data) => data,
};

const localeFilter: Transformer<WtbData, WtbConfig> = {
  name: 'locale-filter',
  isEnabled: (_config) => true,
  transform: (data) => data,
};

// ─── 6. PostProcessor ──────────────────────────────────────────────

const ageGateRouter: PostProcessor<WtbData, WtbConfig> = {
  name: 'age-gate-router',
  isEnabled: (_config) => true,
  apply: (_ctx) => {
    // Skeleton — real impl wires up navigation interception.
    return () => undefined;
  },
};

// ─── 7. Views (4 PageRenderer factories) ───────────────────────────

const stubRenderer: () => PageRenderer = () => ({
  render: () => undefined,
  destroy: () => undefined,
});

const carouselView: ViewDefinition<WtbData, WtbConfig> = {
  id: 'carousel-view',
  displayName: 'Carousel',
  pageType: 'carousel',
  factory: stubRenderer,
  capabilities: ['responsive', 'ssr-safe', 'hydratable'],
};

const heroView: ViewDefinition<WtbData, WtbConfig> = {
  id: 'hero-view',
  displayName: 'Hero',
  pageType: 'hero',
  factory: stubRenderer,
  capabilities: ['responsive', 'ssr-safe'],
};

const storefrontView: ViewDefinition<WtbData, WtbConfig> = {
  id: 'storefront-view',
  displayName: 'Storefront',
  pageType: 'storefront',
  factory: stubRenderer,
  capabilities: ['responsive', 'ssr-safe', 'hydratable'],
};

const storeFinderView: ViewDefinition<WtbData, WtbConfig> = {
  id: 'store-finder-view',
  displayName: 'Store Finder',
  pageType: 'storeFinder',
  factory: stubRenderer,
  // Map needs JS — no useful SSR markup. Mirrors Phase E.9 storeFinder skip.
  capabilities: ['responsive', 'csr-only'],
};

// ─── 8. Template ───────────────────────────────────────────────────

const whereToBuyTemplate: Template<WtbConfig> = {
  id: 'where-to-buy',
  displayName: 'Where to Buy',
  description: 'Carousel + Hero + Storefront — the canonical CPG product surface.',
  pages: [
    { id: 'carousel', type: 'carousel', enabled: true },
    { id: 'hero', type: 'hero', enabled: true },
    { id: 'storefront', type: 'storefront', enabled: true },
  ],
  defaultConfig: {
    feedUrl: '',
    retailers: { enabled: [] },
    display: { showRatings: true },
    storeFinder: { enabled: false },
  },
};

// ─── 9. MCP tools (3) ──────────────────────────────────────────────

const whereToBuyTool: McpToolDefinition<WtbData, WtbConfig> = {
  name: 'where_to_buy',
  description: 'Returns retailer URLs for a given GTIN or product id.',
  inputSchema: {
    type: 'object',
    required: ['productId'],
    properties: { productId: { type: 'string' } },
  },
  handler: async (_input, _ctx) => ({ retailers: [] }),
};

const compareRetailersTool: McpToolDefinition<WtbData, WtbConfig> = {
  name: 'compare_retailers',
  description: 'Compares price + availability across retailers for a product.',
  inputSchema: {
    type: 'object',
    required: ['productId'],
    properties: { productId: { type: 'string' } },
  },
  handler: async (_input, _ctx) => ({ comparisons: [] }),
};

const listRetailersTool: McpToolDefinition<WtbData, WtbConfig> = {
  name: 'list_retailers',
  description: 'Lists retailers carrying products in this brand.',
  inputSchema: { type: 'object', properties: {} },
  handler: async (_input, _ctx) => ({ retailers: [] }),
};

// ─── 10. Publication adapters (Schema.org JSON-LD + Merchant Center XML) ───

interface SchemaOrgJsonLdOutput {
  '@context': 'https://schema.org';
  '@graph': Record<string, unknown>[];
}

const stubValidation: ValidationResult = {
  valid: true,
  errors: [],
  warnings: [],
};

const schemaOrgJsonLdAdapter: PublicationAdapter<WtbData, SchemaOrgJsonLdOutput, WtbConfig> = {
  id: 'schema-org-json-ld',
  displayName: 'Schema.org JSON-LD',
  description: 'Inline Product + Offer + AggregateOffer for Google Rich Results.',
  format: 'json-ld',
  requires: [
    { path: 'product.gtin', required: 'always' },
    { path: 'product.title', required: 'always' },
    { path: 'product.images', required: 'always' },
    { path: 'offer.price', required: 'always' },
    { path: 'offer.availability', required: 'always' },
    { path: 'offer.url', required: 'always' },
  ],
  generate: async (_snapshot, _ctx) => ({
    '@context': 'https://schema.org',
    '@graph': [],
  }),
  validate: () => stubValidation,
  refreshCadence: { min: { ms: 0 }, max: { ms: 6 * 60 * 60 * 1000 } },
  delivery: 'inline-in-host',
  onValidationFail: 'block-publish',
};

interface MerchantCenterXmlOutput {
  xml: string;
  itemCount: number;
}

const merchantCenterXmlAdapter: PublicationAdapter<WtbData, MerchantCenterXmlOutput, WtbConfig> = {
  id: 'merchant-center-xml',
  displayName: 'Google Merchant Center XML feed',
  description: 'Signed feed URL Google Shopping polls. Free Shopping listings derive automatically.',
  format: 'xml',
  requires: [
    { path: 'product.gtin', required: 'always' },
    { path: 'product.mpn', required: 'preferred' },
    { path: 'product.brand', required: 'always' },
    { path: 'product.images', required: 'always' },
    { path: 'product.googleProductCategory', required: 'always' },
    { path: 'offer.price', required: 'always' },
    { path: 'offer.availability', required: 'always' },
    { path: 'offer.url', required: 'always' },
    { path: 'offer.condition', required: 'preferred' },
  ],
  generate: async (_snapshot, _ctx) => ({ xml: '', itemCount: 0 }),
  validate: () => stubValidation,
  refreshCadence: { min: { ms: 60 * 60_000 }, max: { ms: 24 * 60 * 60_000 } },
  delivery: 'signed-feed-url',
  onValidationFail: 'block-publish',
};

// ─── 11. Cartridge envelope ────────────────────────────────────────

export const wtbCartridge: Cartridge<WtbData, WtbConfig> = {
  id: 'wtb',
  industry: 'CPG product',
  displayName: 'Where to Buy',
  description: 'Live retailer availability and pricing for CPG products.',
  version: '0.1.0',

  schema: wtbSchema,

  dataSources: [feedUrlDataSource],

  transformers: [
    retailerFilter,
    categoryFilter,
    variantGrouper,
    sortByPrice,
    stockFilter,
    localeFilter,
  ],

  postProcessors: [ageGateRouter],

  views: [carouselView, heroView, storefrontView, storeFinderView],

  templates: [whereToBuyTemplate],

  mcpTools: [whereToBuyTool, compareRetailersTool, listRetailersTool],

  publicationAdapters: [schemaOrgJsonLdAdapter, merchantCenterXmlAdapter],

  defaultConfig: whereToBuyTemplate.defaultConfig,
  defaultTemplateId: whereToBuyTemplate.id,

  mailboxName: '__AIRO_WTB_PAGES__',
};
