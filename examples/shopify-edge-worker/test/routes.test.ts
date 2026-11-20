/**
 * The worker's machine and head surfaces honour the adapters.
 *
 * Drives `worker.fetch` directly with the upstream Shopify / WordPress calls
 * stubbed, so no Wrangler runtime and no network.
 *
 *   - `/shopify/schema.json` and `/wp/schema.json` go through
 *     `runPublicationAdapters`, so an adapter's `requires` and `validate()`
 *     apply. They used to call the JSON-LD mapper directly and served a
 *     product with no price as a valid-looking Offer.
 *   - the page `<head>` carries the canonical the crawler-surface adapter
 *     produced (via `headFromPublication`), and none when it was blocked.
 */

import { afterEach, describe, expect, test, vi } from 'vitest';

import worker, { type Env } from '../src/worker.js';

const ENV = {
  CONFIG: { get: async () => null },
  SHOPIFY_DOMAIN: 'demo-store.myshopify.com',
  DEFAULT_PRODUCT_HANDLE: 'snowboard',
  SHOPIFY_STOREFRONT_TOKEN: 'token',
} as unknown as Env;

interface ProductOverrides {
  amount?: string | null;
  onlineStoreUrl?: string | null;
}

function shopifyBody({ amount = '799.99', onlineStoreUrl = 'https://demo-store.example/products/snowboard' }: ProductOverrides = {}) {
  return {
    data: {
      product: {
        id: 'gid://shopify/Product/1',
        handle: 'snowboard',
        title: 'The Collection Snowboard',
        description: 'The Collection Snowboard is the perfect board for the all-mountain rider.',
        descriptionHtml: '',
        vendor: 'Burton',
        productType: 'Snowboard',
        tags: [],
        onlineStoreUrl,
        availableForSale: true,
        featuredImage: { url: 'https://cdn.example/a.jpg', altText: null, width: 1, height: 1 },
        images: { edges: [{ node: { url: 'https://cdn.example/a.jpg', altText: null } }] },
        priceRange: {
          minVariantPrice: { amount, currencyCode: 'USD' },
          maxVariantPrice: { amount, currencyCode: 'USD' },
        },
        compareAtPriceRange: { minVariantPrice: { amount: '0.0', currencyCode: 'USD' } },
        variants: { edges: [{ node: { id: 'v1', sku: 'SB-1', availableForSale: true } }] },
      },
    },
  };
}

function stubShopify(overrides?: ProductOverrides) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(shopifyBody(overrides)), { status: 200 })),
  );
}

const get = (path: string) => worker.fetch(new Request(`https://edge.example${path}`), ENV, {} as ExecutionContext);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('/shopify/schema.json', () => {
  test('a valid product is served as its JSON-LD', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    stubShopify();
    const res = await get('/shopify/schema.json');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { '@type': string; offers: { price: string } };
    expect(body['@type']).toBe('Product');
    expect(body.offers.price).toBe('799.99');
  });

  test('a product with an empty price is not served: validate() blocks it', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    stubShopify({ amount: '' });
    const res = await get('/shopify/schema.json');
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toContain('invalid-price');
    expect(text).not.toContain('"@type": "Product"');
  });

  test('a product with no price at all is a 404: the adapter was skipped', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    stubShopify({ amount: null });
    const res = await get('/shopify/schema.json');
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('price.amount');
  });
});

describe('/shopify/ head', () => {
  test('the canonical and OpenGraph come from the crawler-surface adapter', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    stubShopify();
    const html = await (await get('/shopify/')).text();
    expect(html).toContain('<link rel="canonical" href="https://demo-store.example/products/snowboard">');
    expect(html).toContain('content="The Collection Snowboard"');
    expect(html).toMatch(/property="og:url"/);
  });

  test('a product with no storefront url has no canonical and no OpenGraph, and still renders', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    stubShopify({ onlineStoreUrl: null });
    const res = await get('/shopify/');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('rel="canonical"');
    expect(html).not.toContain('og:url');
    expect(html).toContain('airo-product-card');
  });
});

describe('/wp/', () => {
  const post = (over: Record<string, unknown> = {}) => [
    {
      id: 7,
      slug: 'hello',
      link: 'https://blog.example/hello/',
      date_gmt: '2026-05-20T12:00:00',
      modified_gmt: '2026-05-21T15:30:00',
      title: { rendered: 'Hello edge' },
      excerpt: { rendered: '<p>A short walkthrough of edge cartridges, long enough to index well.</p>' },
      content: { rendered: '<p>Body</p>' },
      _embedded: { author: [{ name: 'Sample Author' }] },
      ...over,
    },
  ];

  test('the canonical is the post link, via the adapter; schema.json is served', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(post()), { status: 200 })));
    const html = await (await get('/wp/')).text();
    expect(html).toContain('<link rel="canonical" href="https://blog.example/hello/">');
    const res = await get('/wp/schema.json');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { '@type': string })['@type']).toBe('BlogPosting');
  });

  test('a post whose JSON-LD fails validation is not served on schema.json', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // An empty title: present-but-empty, so the adapter runs (non-nullish
    // satisfies `requires`) and `validate()` rejects it (missing-headline).
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(post({ title: { rendered: '' } })), { status: 200 })),
    );
    const res = await get('/wp/schema.json');
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('BlogPosting"');
  });
});
