// @vitest-environment node
/**
 * dispatchTool — resolution, coverage gating, input validation, invocation.
 *
 * The cases that matter most are the ones a hand-rolled dispatcher gets
 * wrong, because two of them shipped in this repo's own examples before this
 * package existed:
 *
 *   - an unknown tool THROWING rather than returning, which turns an agent
 *     calling a stale name into a crashed request handler;
 *   - `ctx.schema` invented as a stub, when the cartridge already carries the
 *     schema that describes the data next to it.
 *
 * The third is the guarantee itself: the data a tool answers from is the
 * snapshot it was handed, unmodified.
 */

import { describe, expect, test, vi } from 'vitest';

import type { Cartridge, McpToolDefinition, SchemaDefinition } from '@airo-js/cartridge-kit';

import { dispatchTool } from '../src/dispatch.js';

interface TestData {
  product?: { gtin?: string | null; title?: string };
  items?: string[];
}
interface TestConfig {
  locale: string;
}

const schema: SchemaDefinition<TestData> = {
  parse: (input) => input as TestData,
  safeParse: (input) => ({ success: true as const, data: input as TestData }),
};

function tool(over: Partial<McpToolDefinition<TestData, TestConfig>> = {}) {
  return {
    name: 'get_product',
    description: 'Return the product.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: vi.fn(async (_input: unknown, ctx: { data: TestData }) => ctx.data.product),
    ...over,
  } as McpToolDefinition<TestData, TestConfig>;
}

function cartridgeWith(...tools: McpToolDefinition<TestData, TestConfig>[]) {
  return {
    id: 'test-cartridge',
    schema,
    mcpTools: tools,
  } as unknown as Cartridge<TestData, TestConfig>;
}

const config: TestConfig = { locale: 'en-GB' };
const snapshot: TestData = { product: { gtin: '123', title: 'A thing' }, items: ['x'] };

describe('dispatchTool', () => {
  test('invokes the named tool and returns its result', async () => {
    const t = tool();
    const out = await dispatchTool(cartridgeWith(t), 'get_product', {}, snapshot, { config });

    expect(out).toEqual({
      ok: true,
      toolName: 'get_product',
      result: { gtin: '123', title: 'A thing' },
    });
    expect(t.handler).toHaveBeenCalledOnce();
  });

  test('answers from the snapshot it was handed — the fidelity guarantee', async () => {
    const seen: TestData[] = [];
    const t = tool({
      handler: async (_i, ctx) => {
        seen.push(ctx.data);
        return null;
      },
    });
    await dispatchTool(cartridgeWith(t), 'get_product', {}, snapshot, { config });

    expect(seen[0]).toBe(snapshot);
  });

  test('builds ctx.schema from the cartridge — no stub needed', async () => {
    // The hand-rolled dispatcher this package replaces had to invent a
    // passthrough schema to satisfy ToolContext. The cartridge carries one.
    let seenSchema: unknown;
    const t = tool({
      handler: async (_i, ctx) => {
        seenSchema = ctx.schema;
        return null;
      },
    });
    await dispatchTool(cartridgeWith(t), 'get_product', {}, snapshot, { config });

    expect(seenSchema).toBe(schema);
  });

  test('threads config, locale and opaque scope onto the context', async () => {
    let seen: Record<string, unknown> = {};
    const t = tool({
      handler: async (_i, ctx) => {
        seen = { config: ctx.config, locale: ctx.locale, scope: ctx.scope };
        return null;
      },
    });
    await dispatchTool(cartridgeWith(t), 'get_product', {}, snapshot, {
      config,
      locale: 'fr-FR',
      scope: { tenantId: 't1' },
    });

    expect(seen).toEqual({ config, locale: 'fr-FR', scope: { tenantId: 't1' } });
  });

  test('omits locale and scope entirely when not supplied', async () => {
    let ctxKeys: string[] = [];
    const t = tool({
      handler: async (_i, ctx) => {
        ctxKeys = Object.keys(ctx);
        return null;
      },
    });
    await dispatchTool(cartridgeWith(t), 'get_product', {}, snapshot, { config });

    expect(ctxKeys).not.toContain('locale');
    expect(ctxKeys).not.toContain('scope');
  });

  describe('unknown tool', () => {
    test('RETURNS an error rather than throwing', async () => {
      // An agent calling a stale tool name is ordinary, not exceptional. The
      // predecessor threw, which turns this into a crashed request handler.
      const out = await dispatchTool(cartridgeWith(tool()), 'nope', {}, snapshot, { config });

      expect(out.ok).toBe(false);
      expect(out.ok === false && out.error.code).toBe('unknown-tool');
    });

    test('names the tools that DO exist, so an agent can retry', async () => {
      const out = await dispatchTool(
        cartridgeWith(tool({ name: 'a' }), tool({ name: 'b' })),
        'nope',
        {},
        snapshot,
        { config },
      );

      expect(out.ok === false && out.error.message).toContain('a, b');
    });

    test('a cartridge with no mcpTools is a valid cartridge, not a crash', async () => {
      const bare = { id: 'bare', schema } as unknown as Cartridge<TestData, TestConfig>;
      const out = await dispatchTool(bare, 'anything', {}, snapshot, { config });

      expect(out.ok === false && out.error.code).toBe('unknown-tool');
      expect(out.ok === false && out.error.message).toContain('no tools at all');
    });
  });

  describe('coverage gating', () => {
    test('refuses a tool whose always-path is absent, before the handler runs', async () => {
      const t = tool({ requires: [{ path: 'product.gtin', required: 'always' }] });
      const out = await dispatchTool(cartridgeWith(t), 'get_product', {}, { items: [] }, {
        config,
      });

      expect(out.ok === false && out.error.code).toBe('missing-required-fields');
      expect(out.ok === false && out.error.missing).toEqual(['product.gtin']);
      expect(t.handler).not.toHaveBeenCalled();
    });

    test('uses the same non-nullish rule as the adapter runner', async () => {
      const t = tool({ requires: [{ path: 'product.gtin', required: 'always' }] });
      const out = await dispatchTool(
        cartridgeWith(t),
        'get_product',
        {},
        { product: { gtin: null } },
        { config },
      );

      expect(out.ok === false && out.error.missing).toEqual(['product.gtin']);
    });

    test("'preferred' does not gate", async () => {
      const t = tool({ requires: [{ path: 'product.gtin', required: 'preferred' }] });
      const out = await dispatchTool(cartridgeWith(t), 'get_product', {}, {}, { config });

      expect(out.ok).toBe(true);
    });

    test('an omitted requires runs against any snapshot', async () => {
      const out = await dispatchTool(cartridgeWith(tool()), 'get_product', {}, {}, { config });
      expect(out.ok).toBe(true);
    });

    test('coverage is checked BEFORE input validation', async () => {
      // A well-formed input to a tool with no data to answer from should
      // report the missing data, not a schema complaint about a fine input.
      const validateInput = vi.fn(() => ({ valid: false, errors: ['bad'] }));
      const t = tool({ requires: [{ path: 'product.gtin', required: 'always' }] });
      const out = await dispatchTool(cartridgeWith(t), 'get_product', {}, {}, {
        config,
        validateInput,
      });

      expect(out.ok === false && out.error.code).toBe('missing-required-fields');
      expect(validateInput).not.toHaveBeenCalled();
    });
  });

  describe('input validation seam', () => {
    test('skips validation entirely when no validator is supplied', async () => {
      const t = tool();
      const out = await dispatchTool(cartridgeWith(t), 'get_product', { junk: 1 }, snapshot, {
        config,
      });

      expect(out.ok).toBe(true);
      expect(t.handler).toHaveBeenCalledOnce();
    });

    test('rejects on a validator verdict, and reports its errors', async () => {
      const t = tool();
      const out = await dispatchTool(cartridgeWith(t), 'get_product', { junk: 1 }, snapshot, {
        config,
        validateInput: () => ({ valid: false, errors: ['unexpected property "junk"'] }),
      });

      expect(out.ok === false && out.error.code).toBe('invalid-input');
      expect(out.ok === false && out.error.validationErrors).toEqual([
        'unexpected property "junk"',
      ]);
      expect(t.handler).not.toHaveBeenCalled();
    });

    test('a THROWING validator becomes a result, not an exception', async () => {
      // The common validator wraps a JSON Schema library, and ajv throws on a
      // malformed schema rather than returning false. If that escaped, one bad
      // inputSchema would become the unhandled rejection this package exists
      // to remove from a host's request handler.
      const boom = new Error('schema is not valid JSON Schema');
      const t = tool();
      const out = await dispatchTool(cartridgeWith(t), 'get_product', {}, snapshot, {
        config,
        validateInput: () => {
          throw boom;
        },
      });

      expect(out.ok).toBe(false);
      expect(out.ok === false && out.error.code).toBe('invalid-input');
      expect(out.ok === false && out.error.cause).toBe(boom);
      expect(out.ok === false && out.error.message).toContain('malformed inputSchema');
      expect(t.handler).not.toHaveBeenCalled();
    });

    test('a validator rejecting without an errors array reports []', async () => {
      const out = await dispatchTool(cartridgeWith(tool()), 'get_product', {}, snapshot, {
        config,
        validateInput: () => ({ valid: false }),
      });

      expect(out.ok === false && out.error.validationErrors).toEqual([]);
    });

    test("hands the validator the tool's own inputSchema", async () => {
      const inputSchema = { type: 'object', properties: { id: { type: 'string' } } };
      const validateInput = vi.fn(() => ({ valid: true }));
      await dispatchTool(
        cartridgeWith(tool({ inputSchema })),
        'get_product',
        { id: 'x' },
        snapshot,
        { config, validateInput },
      );

      expect(validateInput).toHaveBeenCalledWith({ id: 'x' }, inputSchema);
    });
  });

  describe('a throwing handler', () => {
    test('becomes a result, not an exception — the other tools still work', async () => {
      const t = tool({
        handler: async () => {
          throw new Error('upstream 503');
        },
      });
      const out = await dispatchTool(cartridgeWith(t), 'get_product', {}, snapshot, { config });

      expect(out.ok === false && out.error.code).toBe('handler-threw');
      // The thrown text must NOT reach `message` — every host wiring in our
      // own docs forwards that field to the caller, and handlers close over
      // server credentials. It goes on `cause`, which a host opts into.
      expect(out.ok === false && out.error.message).not.toContain('upstream 503');
      expect(out.ok === false && (out.error.cause as Error).message).toBe('upstream 503');
    });

    test('preserves the thrown value for the host to log', async () => {
      const boom = new Error('boom');
      const t = tool({
        handler: async () => {
          throw boom;
        },
      });
      const out = await dispatchTool(cartridgeWith(t), 'get_product', {}, snapshot, { config });

      expect(out.ok === false && out.error.cause).toBe(boom);
    });

    test('handles a non-Error throw', async () => {
      const t = tool({
        handler: async () => {
          throw 'a string';
        },
      });
      const out = await dispatchTool(cartridgeWith(t), 'get_product', {}, snapshot, { config });

      expect(out.ok === false && out.error.code).toBe('handler-threw');
      expect(out.ok === false && out.error.cause).toBe('a string');
      expect(out.ok === false && out.error.message).not.toContain('a string');
    });
  });
});
