/**
 * Schema.org Product JSON-LD mapper — pure function.
 *
 * Used by the PublicationAdapter in `adapters.ts`. The adapter wraps
 * this mapper with the framework contract (requires + generate +
 * validate + refreshCadence). Keeping the mapper pure makes it easy
 * to unit-test against frozen fixtures.
 *
 * Schema reference: https://schema.org/Product
 */

import type { ProductSnapshot, ProductJsonLd } from './types.js';

export function toProductJsonLd(product: ProductSnapshot): ProductJsonLd {
  const availability = product.availableForSale
    ? 'https://schema.org/InStock'
    : 'https://schema.org/OutOfStock';

  const images = product.images.length > 0
    ? product.images
    : product.featuredImageUrl
      ? [product.featuredImageUrl]
      : [];

  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    '@id': product.id,
    name: product.title,
    description: product.description,
    brand: { '@type': 'Brand', name: product.vendor },
    image: images,
    sku: product.sku ?? undefined,
    category: product.productType,
    url: product.onlineStoreUrl ?? undefined,
    offers: {
      '@type': 'Offer',
      price: product.price.amount,
      priceCurrency: product.price.currencyCode,
      availability,
      url: product.onlineStoreUrl ?? undefined,
    },
    'airo:snapshotId': product.snapshotId,
  };
}
