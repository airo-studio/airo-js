/**
 * MCP tool declarations for the demo.
 *
 * Declarations only. The manifest and the dispatcher come from
 * `@airo-js/mcp` — `buildToolManifest(cartridge)` and
 * `dispatchTool(cartridge, name, input, snapshot, opts)`. This file used to
 * hand-roll both, plus a passthrough schema stub to satisfy `ToolContext`;
 * all three are gone. The cartridge already carries the schema, and the
 * framework builds the context from it.
 *
 * Three tools:
 *   - getProduct       — full product snapshot
 *   - getPrice         — minimal price-only payload
 *   - getAvailability  — boolean + variant SKU
 *
 * All three answer from the SAME post-Transformer snapshot the HTML
 * route renders, with the same snapshotId — that's the multi-surface
 * consistency demo.
 *
 * Snapshot-id timing convention:
 * snapshotId is post-pipeline, pre-PostProcessor. This example
 * has no pipeline, so the snapshot the DataSource returns IS the
 * snapshot the renderer + adapters + MCP tools consume.
 */

import type { McpToolDefinition } from '@airo-js/cartridge-kit';
import type { ProductSnapshot, ShopifyConfig } from './types.js';

export const PRODUCT_TOOLS: McpToolDefinition<ProductSnapshot, ShopifyConfig>[] = [
  {
    name: 'getProduct',
    description:
      'Return the full product snapshot — id, title, vendor, description, price, availability, and images. Reflects the same data the rendered HTML shows.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    async handler(_input, ctx) {
      return ctx.data;
    },
  },
  {
    name: 'getPrice',
    description:
      'Return the current price for the product. Includes amount, currency, and compareAt price if set.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    async handler(_input, ctx) {
      return {
        amount: ctx.data.price.amount,
        currencyCode: ctx.data.price.currencyCode,
        compareAtPrice: ctx.data.compareAtPrice ?? null,
      };
    },
  },
  {
    name: 'getAvailability',
    description:
      'Return availability (in-stock / out-of-stock) plus the primary variant SKU if any.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    async handler(_input, ctx) {
      return {
        availableForSale: ctx.data.availableForSale,
        sku: ctx.data.sku,
      };
    },
  },
];
