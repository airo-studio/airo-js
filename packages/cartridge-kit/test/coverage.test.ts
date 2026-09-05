// @vitest-environment node
/**
 * missingRequiredPaths — the shared coverage predicate.
 *
 * This function was extracted precisely so `runPublicationAdapters` and
 * `dispatchTool` cannot disagree about which snapshots are answerable. Until
 * now every assertion about it arrived indirectly, through one of those two
 * callers — which means the thing they were extracted to share had no test at
 * its own definition site, and its docstring made guarantees (declaration
 * order, the `undefined` early return) that nothing checked.
 *
 * Array-index paths matter here and are not reachable from either caller's
 * own suite: `getByPath` grew index support in 0.9.0, so `products.0.gtin` is
 * a legal `requires` path the moment a cartridge author writes one.
 */

import { describe, expect, test } from 'vitest';

import { missingRequiredPaths } from '../src/coverage.js';
import type { SchemaFieldRef } from '../src/publication-adapter.js';

const always = (path: string): SchemaFieldRef => ({ path, required: 'always' });

describe('missingRequiredPaths', () => {
  test('returns [] when every always-path holds a value', () => {
    expect(
      missingRequiredPaths([always('product.gtin'), always('offer.price')], {
        product: { gtin: '1' },
        offer: { price: 10 },
      }),
    ).toEqual([]);
  });

  test('names the absent always-paths', () => {
    expect(missingRequiredPaths([always('a'), always('b')], { a: 1 })).toEqual(['b']);
  });

  describe('only "always" gates', () => {
    test("'preferred' and 'optional' are never reported", () => {
      const refs: SchemaFieldRef[] = [
        { path: 'p', required: 'preferred' },
        { path: 'o', required: 'optional' },
      ];
      expect(missingRequiredPaths(refs, {})).toEqual([]);
    });

    test('a mixed list reports only the always ones', () => {
      const refs: SchemaFieldRef[] = [
        { path: 'p', required: 'preferred' },
        { path: 'a', required: 'always' },
        { path: 'o', required: 'optional' },
      ];
      expect(missingRequiredPaths(refs, {})).toEqual(['a']);
    });
  });

  describe('presence is non-nullish, NOT hasByPath', () => {
    test('falsy-but-real values are present', () => {
      const refs = [always('s'), always('n'), always('b'), always('arr')];
      expect(missingRequiredPaths(refs, { s: '', n: 0, b: false, arr: [] })).toEqual([]);
    });

    test('a declared key holding undefined is ABSENT', () => {
      // `hasByPath` would call this present — that semantic exists to tell a
      // typo'd path from an unset global, and is wrong here.
      expect(missingRequiredPaths([always('k')], { k: undefined })).toEqual(['k']);
    });

    test('an explicit null is ABSENT', () => {
      expect(missingRequiredPaths([always('k')], { k: null })).toEqual(['k']);
    });
  });

  describe('empty and absent inputs', () => {
    test('undefined requires yields []', () => {
      expect(missingRequiredPaths(undefined, {})).toEqual([]);
    });

    test('an empty requires yields []', () => {
      expect(missingRequiredPaths([], {})).toEqual([]);
    });

    test('a nullish snapshot makes every always-path absent, without throwing', () => {
      expect(missingRequiredPaths([always('a.b')], undefined)).toEqual(['a.b']);
      expect(missingRequiredPaths([always('a.b')], null)).toEqual(['a.b']);
    });

    test('a primitive snapshot does not throw', () => {
      expect(missingRequiredPaths([always('a')], 42)).toEqual(['a']);
    });
  });

  describe('path traversal', () => {
    test('a missing intermediate is absent, not a crash', () => {
      expect(missingRequiredPaths([always('a.b.c')], {})).toEqual(['a.b.c']);
    });

    test('descends into arrays by index', () => {
      const snapshot = { products: [{ gtin: 'x' }, {}] };
      expect(missingRequiredPaths([always('products.0.gtin')], snapshot)).toEqual([]);
      expect(missingRequiredPaths([always('products.1.gtin')], snapshot)).toEqual([
        'products.1.gtin',
      ]);
    });

    test('an out-of-range index is absent', () => {
      expect(missingRequiredPaths([always('products.5.gtin')], { products: [] })).toEqual([
        'products.5.gtin',
      ]);
    });
  });

  describe('the guarantees the docstring makes', () => {
    test('reports in DECLARATION order, not sorted', () => {
      const refs = [always('zebra'), always('apple'), always('mango')];
      expect(missingRequiredPaths(refs, {})).toEqual(['zebra', 'apple', 'mango']);
    });

    test('is pure — it does not mutate the snapshot or the refs', () => {
      const refs = [always('a'), always('b')];
      const snapshot = { a: 1 };
      const refsCopy = JSON.parse(JSON.stringify(refs));
      const snapCopy = JSON.parse(JSON.stringify(snapshot));

      missingRequiredPaths(refs, snapshot);

      expect(refs).toEqual(refsCopy);
      expect(snapshot).toEqual(snapCopy);
    });

    test('a duplicate always-path is reported once per declaration', () => {
      // Not deduplicated: the list mirrors what the author declared, and
      // collapsing it would hide a copy-paste slip in their own `requires`.
      expect(missingRequiredPaths([always('a'), always('a')], {})).toEqual(['a', 'a']);
    });
  });
});
