/**
 * Shopify Storefront API fetch — minimal GraphQL client for the demo.
 *
 * One query: product-by-handle. Returns the canonical product fields the
 * cartridge needs to render HTML + emit JSON-LD + answer MCP tool calls.
 *
 * No retries, no caching here — the host app (worker.ts) decides those.
 * The DataSource passes `ctx.signal` through to fetch so the worker can
 * cancel on client disconnect.
 */

const PRODUCT_QUERY = /* GraphQL */ `
  query ProductByHandle($handle: String!) {
    product(handle: $handle) {
      id
      handle
      title
      description
      descriptionHtml
      vendor
      productType
      tags
      onlineStoreUrl
      availableForSale
      featuredImage {
        url
        altText
        width
        height
      }
      images(first: 4) {
        edges {
          node {
            url
            altText
          }
        }
      }
      priceRange {
        minVariantPrice {
          amount
          currencyCode
        }
        maxVariantPrice {
          amount
          currencyCode
        }
      }
      compareAtPriceRange {
        minVariantPrice {
          amount
          currencyCode
        }
      }
      variants(first: 1) {
        edges {
          node {
            id
            sku
            availableForSale
          }
        }
      }
    }
  }
`;

export interface ShopifyProductRaw {
  id: string;
  handle: string;
  title: string;
  description: string;
  descriptionHtml: string;
  vendor: string;
  productType: string;
  tags: string[];
  onlineStoreUrl: string | null;
  availableForSale: boolean;
  featuredImage: {
    url: string;
    altText: string | null;
    width: number;
    height: number;
  } | null;
  images: {
    edges: Array<{ node: { url: string; altText: string | null } }>;
  };
  priceRange: {
    minVariantPrice: { amount: string; currencyCode: string };
    maxVariantPrice: { amount: string; currencyCode: string };
  };
  compareAtPriceRange: {
    minVariantPrice: { amount: string; currencyCode: string };
  };
  variants: {
    edges: Array<{ node: { id: string; sku: string | null; availableForSale: boolean } }>;
  };
}

export interface FetchProductOptions {
  domain: string;
  token: string;
  handle: string;
  signal?: AbortSignal;
}

/**
 * Fetch one product from Shopify Storefront API.
 *
 * Throws on network failure, non-200 response, GraphQL errors, or missing
 * product. The caller (DataSource in cartridge.ts) decides error policy —
 * for v0, errors propagate to the worker which returns a 502.
 */
export async function fetchShopifyProduct(
  opts: FetchProductOptions,
): Promise<ShopifyProductRaw> {
  // Accept anything that contains a *.myshopify.com host — wrangler.toml
  // is a string bag and a user pasting from the Shopify docs is just as
  // likely to paste the full GraphQL endpoint URL ('https://x/api/2024-
  // 04/graphql.json'), the admin URL ('https://x/admin/...'), or just
  // the bare host. Strip scheme, then everything from the first '/' or
  // '?' so we land on `<host>` regardless.
  const host = opts.domain
    .replace(/^https?:\/\//, '')
    .replace(/[/?].*$/, '');
  const url = `https://${host}/api/2024-04/graphql.json`;

  // Debug log — comment out for production. Surfaces what URL the worker
  // is actually hitting plus the upstream response shape. Wrangler dev
  // prints these to the terminal running it.
  console.log('[shopify] POST', url, 'handle=', opts.handle, 'token=', opts.token?.slice(0, 6) + '…');

  const res = await fetch(url, {
    method: 'POST',
    signal: opts.signal,
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Storefront-Access-Token': opts.token,
    },
    body: JSON.stringify({
      query: PRODUCT_QUERY,
      variables: { handle: opts.handle },
    }),
  });

  if (!res.ok) {
    const bodyText = await res.text();
    console.log('[shopify] response', res.status, res.statusText,
      'content-type=', res.headers.get('content-type'),
      'body-first-300=', bodyText.slice(0, 300));
    throw new Error(
      `Shopify API ${res.status} ${res.statusText}: ${bodyText.slice(0, 200)}`,
    );
  }

  const body = (await res.json()) as {
    data?: { product: ShopifyProductRaw | null };
    errors?: Array<{ message: string }>;
  };

  if (body.errors?.length) {
    throw new Error(
      `Shopify GraphQL errors: ${body.errors.map((e) => e.message).join('; ')}`,
    );
  }

  const product = body.data?.product;
  if (!product) {
    throw new Error(`Shopify product not found: handle="${opts.handle}"`);
  }

  return product;
}
