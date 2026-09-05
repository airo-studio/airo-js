// @vitest-environment node
/**
 * buildToolManifest — what an MCP client sees.
 *
 * The manifest must carry MCP's three descriptor fields and nothing else.
 * `handler` is not serialisable, and leaking `requires` would advertise
 * framework bookkeeping a client cannot act on — so the shape is pinned
 * exactly rather than checked field by field.
 */

import { describe, expect, test } from 'vitest';

import type { Cartridge, McpToolDefinition, SchemaDefinition } from '@airo-js/cartridge-kit';

import { buildToolManifest } from '../src/manifest.js';

interface TestData {
  product?: { gtin?: string };
}

const schema: SchemaDefinition<TestData> = {
  parse: (input) => input as TestData,
  safeParse: (input) => ({ success: true as const, data: input as TestData }),
};

function tool(over: Partial<McpToolDefinition<TestData, unknown>> = {}) {
  return {
    name: 'get_product',
    description: 'Return the product.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => null,
    ...over,
  } as McpToolDefinition<TestData, unknown>;
}

function cartridgeWith(...tools: McpToolDefinition<TestData, unknown>[]) {
  return { id: 'c', schema, mcpTools: tools } as unknown as Cartridge<TestData, unknown>;
}

describe('buildToolManifest', () => {
  test('emits exactly MCP\'s tool descriptor — no handler, no requires', () => {
    const manifest = buildToolManifest(
      cartridgeWith(tool({ requires: [{ path: 'product.gtin', required: 'always' }] })),
    );

    expect(manifest).toEqual({
      tools: [
        {
          name: 'get_product',
          description: 'Return the product.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
      ],
    });
  });

  test('preserves declaration order', () => {
    const manifest = buildToolManifest(
      cartridgeWith(tool({ name: 'a' }), tool({ name: 'b' }), tool({ name: 'c' })),
    );
    expect(manifest.tools.map((t) => t.name)).toEqual(['a', 'b', 'c']);
  });

  test('a cartridge with no mcpTools yields an empty manifest, not a throw', () => {
    const bare = { id: 'bare', schema } as unknown as Cartridge<TestData, unknown>;
    expect(buildToolManifest(bare)).toEqual({ tools: [] });
  });

  test('toolNames restricts the set, still in declaration order', () => {
    const manifest = buildToolManifest(
      cartridgeWith(tool({ name: 'a' }), tool({ name: 'b' }), tool({ name: 'c' })),
      { toolNames: ['c', 'a'] },
    );
    expect(manifest.tools.map((t) => t.name)).toEqual(['a', 'c']);
  });

  describe('coverage filtering is opt-in', () => {
    const starved = tool({
      name: 'needs_gtin',
      requires: [{ path: 'product.gtin', required: 'always' }],
    });

    test('lists an unanswerable tool by default — absence tells an agent nothing', () => {
      const manifest = buildToolManifest(cartridgeWith(tool({ name: 'free' }), starved));
      expect(manifest.tools.map((t) => t.name)).toEqual(['free', 'needs_gtin']);
    });

    test('omits it when a snapshot is supplied', () => {
      const manifest = buildToolManifest(cartridgeWith(tool({ name: 'free' }), starved), {
        snapshot: {},
      });
      expect(manifest.tools.map((t) => t.name)).toEqual(['free']);
    });

    test('keeps it when the snapshot covers it', () => {
      const manifest = buildToolManifest(cartridgeWith(starved), {
        snapshot: { product: { gtin: '123' } },
      });
      expect(manifest.tools.map((t) => t.name)).toEqual(['needs_gtin']);
    });

    test('an empty-object snapshot still triggers filtering', () => {
      // `snapshot: {}` is a real snapshot that covers nothing — it must not
      // be confused with "no snapshot given", which means do not filter.
      expect(buildToolManifest(cartridgeWith(starved), { snapshot: {} }).tools).toHaveLength(0);
      expect(buildToolManifest(cartridgeWith(starved)).tools).toHaveLength(1);
    });
  });
});
