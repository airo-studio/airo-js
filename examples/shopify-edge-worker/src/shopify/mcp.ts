/**
 * MCP tool manifest + dispatcher for the demo.
 *
 * `@airo-js/mcp` is a stub today (only exports PACKAGE_NAME), so this
 * file hand-rolls the manifest + invocation shape. When the MCP package
 * gains a real dispatcher, replace this with framework calls — the
 * cartridge's `mcpTools[]` already declares the tools in the right
 * shape, so the migration is one import path away.
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

export interface McpToolManifestEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function buildToolManifest(
  tools: McpToolDefinition<ProductSnapshot, ShopifyConfig>[],
): { tools: McpToolManifestEntry[] } {
  return {
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  };
}

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

/**
 * Schema stub passed to McpTool handlers. v0 doesn't use Zod (keeps
 * the Worker bundle tiny). When the framework needs real validation
 * here, swap in the cartridge's actual SchemaDefinition.
 */
const PRODUCT_SCHEMA_STUB = {
  parse(input: unknown): ProductSnapshot {
    return input as ProductSnapshot;
  },
  safeParse(input: unknown) {
    return { success: true as const, data: input as ProductSnapshot };
  },
};

/**
 * Dispatch an MCP tool call. The contract guarantee: the same `data`
 * that was rendered into HTML (and inlined as JSON-LD) is the data
 * each tool sees. Returns the tool's payload plus the snapshotId for
 * cross-surface verifiability.
 */
export async function dispatchTool(
  toolName: string,
  input: unknown,
  ctx: { data: ProductSnapshot; config: ShopifyConfig },
): Promise<{ result: unknown; snapshotId: string }> {
  const tool = PRODUCT_TOOLS.find((t) => t.name === toolName);
  if (!tool) {
    throw new Error(`Unknown MCP tool: ${toolName}`);
  }
  const result = await tool.handler(input, {
    data: ctx.data,
    config: ctx.config,
    schema: PRODUCT_SCHEMA_STUB,
  });
  return { result, snapshotId: ctx.data.snapshotId };
}
