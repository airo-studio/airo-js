// @vitest-environment node
/**
 * Coverage gating — contract guarantee #2.
 *
 * `PublicationAdapter.requires` documented framework-side skipping from the
 * start, but no runner ever read it; the docstring described behaviour that
 * did not exist until 1.0. These tests pin the behaviour that closes it, and
 * in particular the two narrowings that make it safe to enforce:
 *
 *   - only `required: 'always'` gates, and
 *   - "present" means non-nullish, NOT `hasByPath`'s declared-key semantic.
 *
 * The second one matters enough to test both directions: a falsy-but-real
 * value (`0`, `''`, `false`, `[]`) must NOT skip an adapter, and a declared
 * key holding `undefined` must.
 */

import { describe, expect, test, vi } from 'vitest';

import type { Cartridge, PublicationAdapter, PublicationContext } from '@airo-js/cartridge-kit';

import { runPublicationAdapters } from '../src/run-publication.js';

interface TestData {
  product?: { gtin?: string | null; images?: unknown[]; title?: string };
  offer?: { price?: number; note?: string; live?: boolean };
  site?: string;
}

const ctx: PublicationContext<unknown> = { config: {}, locale: 'en-GB', country: 'GB' };

function adapter(
  over: Partial<PublicationAdapter<TestData, unknown, unknown>> = {},
): PublicationAdapter<TestData, unknown, unknown> {
  return {
    id: 'feed',
    displayName: 'Feed',
    description: 'test adapter',
    format: 'json',
    requires: [],
    generate: vi.fn(async () => ({ ok: true })),
    validate: () => ({ valid: true, errors: [], warnings: [] }),
    refreshCadence: { min: { ms: 0 }, max: { ms: 1000 } },
    ...over,
  };
}

function cartridgeWith(
  ...adapters: PublicationAdapter<TestData, unknown, unknown>[]
): Cartridge<TestData, unknown> {
  return { publicationAdapters: adapters } as unknown as Cartridge<TestData, unknown>;
}

describe('runPublicationAdapters — coverage gating', () => {
  test('runs the adapter when every always-path holds a value', async () => {
    const a = adapter({
      requires: [
        { path: 'product.gtin', required: 'always' },
        { path: 'offer.price', required: 'always' },
      ],
    });
    const [r] = await runPublicationAdapters(
      cartridgeWith(a),
      { product: { gtin: '123' }, offer: { price: 10 } },
      ctx,
    );

    expect(r!.included).toBe(true);
    expect(r!.skipped).toBeUndefined();
    expect(a.generate).toHaveBeenCalledOnce();
  });

  test('skips before generate() when an always-path is absent', async () => {
    const a = adapter({ requires: [{ path: 'product.gtin', required: 'always' }] });
    const [r] = await runPublicationAdapters(cartridgeWith(a), { offer: { price: 10 } }, ctx);

    expect(r!.included).toBe(false);
    expect(r!.skipped).toEqual({
      reason: 'missing-required-fields',
      missing: ['product.gtin'],
    });
    expect(r!.output).toBeUndefined();
    // The whole point of gating: broken output is never generated, not
    // generated-then-discarded.
    expect(a.generate).not.toHaveBeenCalled();
  });

  test('a skipped adapter is still REPORTED, so the host can say why', async () => {
    const a = adapter({ requires: [{ path: 'product.gtin', required: 'always' }] });
    const results = await runPublicationAdapters(cartridgeWith(a), {}, ctx);

    expect(results).toHaveLength(1);
    expect(results[0]!.adapterId).toBe('feed');
    expect(results[0]!.validation.valid).toBe(false);
    expect(results[0]!.validation.errors[0]!.code).toBe('missing-required-field');
    expect(results[0]!.validation.errors[0]!.path).toBe('product.gtin');
    expect(results[0]!.validation.errors[0]!.remediation).toContain('preferred');
  });

  test('reports EVERY missing always-path, not just the first', async () => {
    const a = adapter({
      requires: [
        { path: 'product.gtin', required: 'always' },
        { path: 'product.images', required: 'always' },
        { path: 'offer.price', required: 'always' },
      ],
    });
    const [r] = await runPublicationAdapters(cartridgeWith(a), { product: { gtin: 'x' } }, ctx);

    expect(r!.skipped!.missing).toEqual(['product.images', 'offer.price']);
    expect(r!.validation.errors).toHaveLength(2);
  });

  test("'preferred' and 'optional' never gate", async () => {
    const a = adapter({
      requires: [
        { path: 'product.gtin', required: 'preferred' },
        { path: 'product.images', required: 'optional' },
      ],
    });
    const [r] = await runPublicationAdapters(cartridgeWith(a), {}, ctx);

    expect(r!.included).toBe(true);
    expect(r!.skipped).toBeUndefined();
    expect(a.generate).toHaveBeenCalledOnce();
  });

  test('an empty requires[] runs against any snapshot shape', async () => {
    const a = adapter({ requires: [] });
    const [r] = await runPublicationAdapters(cartridgeWith(a), {}, ctx);

    expect(r!.included).toBe(true);
    expect(r!.skipped).toBeUndefined();
  });

  describe('presence semantics', () => {
    test('falsy-but-real values count as PRESENT — the adapter owns that judgment', async () => {
      const a = adapter({
        requires: [
          { path: 'offer.price', required: 'always' },
          { path: 'offer.note', required: 'always' },
          { path: 'offer.live', required: 'always' },
          { path: 'product.images', required: 'always' },
        ],
      });
      const [r] = await runPublicationAdapters(
        cartridgeWith(a),
        { offer: { price: 0, note: '', live: false }, product: { images: [] } },
        ctx,
      );

      expect(r!.skipped).toBeUndefined();
      expect(r!.included).toBe(true);
    });

    test('a declared key holding undefined counts as ABSENT (not hasByPath semantics)', async () => {
      const a = adapter({ requires: [{ path: 'product.gtin', required: 'always' }] });
      // The key EXISTS — `'gtin' in product` is true. `hasByPath` would call
      // this present; coverage gating must not, because a feed cannot emit
      // `undefined`.
      const [r] = await runPublicationAdapters(
        cartridgeWith(a),
        { product: { gtin: undefined } },
        ctx,
      );

      expect(r!.skipped!.missing).toEqual(['product.gtin']);
    });

    test('an explicit null counts as ABSENT', async () => {
      const a = adapter({ requires: [{ path: 'product.gtin', required: 'always' }] });
      const [r] = await runPublicationAdapters(cartridgeWith(a), { product: { gtin: null } }, ctx);

      expect(r!.skipped!.missing).toEqual(['product.gtin']);
    });

    test('a path through a missing intermediate is absent, not a crash', async () => {
      const a = adapter({ requires: [{ path: 'product.gtin', required: 'always' }] });
      const [r] = await runPublicationAdapters(cartridgeWith(a), {}, ctx);

      expect(r!.skipped!.missing).toEqual(['product.gtin']);
    });
  });

  test("a skip does NOT throw under onValidationFail: 'fail-loud'", async () => {
    // `onValidationFail` is policy about output that failed `validate()`. A
    // skipped adapter produced no output, so the policy does not apply — and
    // the caller already gets the same `included: false` signal.
    const a = adapter({
      onValidationFail: 'fail-loud',
      requires: [{ path: 'product.gtin', required: 'always' }],
    });

    const [r] = await runPublicationAdapters(cartridgeWith(a), {}, ctx);
    expect(r!.skipped!.reason).toBe('missing-required-fields');
  });

  test("a skip overrides onValidationFail: 'publish-with-warnings'", async () => {
    // 'publish-with-warnings' says "ship it even if validate() complains".
    // It cannot say "ship it even though the data it needs does not exist".
    const a = adapter({
      onValidationFail: 'publish-with-warnings',
      requires: [{ path: 'product.gtin', required: 'always' }],
    });

    const [r] = await runPublicationAdapters(cartridgeWith(a), {}, ctx);
    expect(r!.included).toBe(false);
  });

  test('gating runs AFTER the id/format/delivery filters', async () => {
    // An adapter filtered out by id should not appear as a skip — it was
    // never selected, which is a different thing from "selected but starved".
    const a = adapter({ id: 'wanted', requires: [] });
    const b = adapter({ id: 'unwanted', requires: [{ path: 'nope', required: 'always' }] });

    const results = await runPublicationAdapters(cartridgeWith(a, b), {}, ctx, {
      adapterIds: ['wanted'],
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.adapterId).toBe('wanted');
  });

  test('one starved adapter does not stop the others', async () => {
    const good = adapter({ id: 'good', requires: [{ path: 'site', required: 'always' }] });
    const starved = adapter({ id: 'starved', requires: [{ path: 'product.gtin', required: 'always' }] });

    const results = await runPublicationAdapters(
      cartridgeWith(starved, good),
      { site: 'x' },
      ctx,
    );

    expect(results.map((r) => [r.adapterId, r.included])).toEqual([
      ['starved', false],
      ['good', true],
    ]);
    expect(good.generate).toHaveBeenCalledOnce();
    expect(starved.generate).not.toHaveBeenCalled();
  });
});
