/**
 * Fallback cartridge configs + AppConfigs used when the KV store has no
 * entry for the cartridge. The studio (v1) writes these shapes into KV;
 * v0 reads from KV if present, falls back here.
 *
 * One AppConfig + one cartridge-config per cartridge. The framework
 * renders one App per request; the worker picks which based on URL prefix.
 */

import type { AppConfig } from '@airo-js/core';
import type { ShopifyConfig } from './shopify/types.js';
import type { WpConfig } from './wp/types.js';

// ─── Shopify ────────────────────────────────────────────────────────

export const SHOPIFY_APP_CONFIG: AppConfig<'product'> = {
  appId: 'shopify-edge-demo',
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
  styleIsolation: 'light',
};

export const SHOPIFY_CONFIG: ShopifyConfig = {
  productHandle: 'the-collection-snowboard-liquid',
  locale: 'en-US',
  display: {
    showVendor: true,
    showCompareAtPrice: true,
  },
};

// ─── WordPress ──────────────────────────────────────────────────────

export const WP_APP_CONFIG: AppConfig<'post'> = {
  appId: 'wp-edge-demo',
  pages: [
    {
      id: 'post',
      type: 'post',
      enabled: true,
      layout: {
        regionOrder: ['main'],
        regions: { main: { id: 'main', components: [] } },
      },
    },
  ],
  styleIsolation: 'light',
};

export const WP_CONFIG: WpConfig = {
  site: 'wordpress.org/news',
  postSlug: '',
  locale: 'en-US',
};
