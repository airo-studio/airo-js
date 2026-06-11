/**
 * Tests for `getByPath` / `setByPath` — the dot-path read/write pair that
 * backs the global-config tier in `resolveComponentProp` and the
 * fold-back-into-config-draft path a consumer's `withComponentOverrides`
 * uses. The load-bearing guarantee for `setByPath` is immutability:
 * overriding one leaf must not mutate a sibling-shared nested object.
 */

import { describe, expect, test } from 'vitest';

import { getByPath, hasByPath, setByPath } from '../src/path-utils.js';

describe('getByPath', () => {
  const obj = { display: { categoryFilter: { displayMode: 'image' }, showPrices: true } };

  test('reads a nested leaf', () => {
    expect(getByPath(obj, 'display.categoryFilter.displayMode')).toBe('image');
  });

  test('reads a top-level leaf', () => {
    expect(getByPath(obj, 'display.showPrices')).toBe(true);
  });

  test('missing segment → undefined', () => {
    expect(getByPath(obj, 'display.categoryFilter.nope')).toBeUndefined();
    expect(getByPath(obj, 'missing.path')).toBeUndefined();
  });

  test('traversing through a non-object → undefined', () => {
    expect(getByPath(obj, 'display.showPrices.deeper')).toBeUndefined();
  });

  test('empty path → undefined', () => {
    expect(getByPath(obj, '')).toBeUndefined();
  });

  test('null / non-object root → undefined', () => {
    expect(getByPath(null, 'a')).toBeUndefined();
    expect(getByPath(42, 'a')).toBeUndefined();
  });

  test('arrays are opaque leaves (no index paths)', () => {
    expect(getByPath({ items: ['a', 'b'] }, 'items')).toEqual(['a', 'b']);
    expect(getByPath({ items: ['a', 'b'] }, 'items.0')).toBeUndefined();
  });
});

describe('hasByPath', () => {
  test('present leaf → true', () => {
    expect(hasByPath({ display: { showPrices: true } }, 'display.showPrices')).toBe(true);
  });

  test('present leaf with undefined value → true (unset, not absent)', () => {
    expect(hasByPath({ display: { removeBg: undefined } }, 'display.removeBg')).toBe(true);
  });

  test('absent leaf → false (the typo case)', () => {
    expect(hasByPath({ display: { showPrices: true } }, 'display.showPrice')).toBe(false);
  });

  test('absent intermediate → false', () => {
    expect(hasByPath({ display: {} }, 'display.categoryFilter.displayMode')).toBe(false);
  });

  test('traversing through a non-object → false', () => {
    expect(hasByPath({ display: { showPrices: true } }, 'display.showPrices.deeper')).toBe(false);
  });

  test('empty path / non-object root → false', () => {
    expect(hasByPath({ a: 1 }, '')).toBe(false);
    expect(hasByPath(null, 'a')).toBe(false);
  });
});

describe('setByPath', () => {
  test('writes a nested leaf and returns a new root', () => {
    const obj = { display: { categoryFilter: { displayMode: 'text' } } };
    const next = setByPath(obj, 'display.categoryFilter.displayMode', 'image');
    expect(next.display.categoryFilter.displayMode).toBe('image');
    expect(obj.display.categoryFilter.displayMode).toBe('text'); // input untouched
  });

  test('copy-on-write spine — siblings stay referentially shared', () => {
    const sibling = { keep: 1 };
    const obj = {
      display: { categoryFilter: { displayMode: 'text' }, other: sibling },
    };
    const next = setByPath(obj, 'display.categoryFilter.displayMode', 'image');
    // Sibling on the SAME parent is shared (not cloned)…
    expect(next.display.other).toBe(sibling);
    // …but the path spine is cloned (new refs along the way).
    expect(next).not.toBe(obj);
    expect(next.display).not.toBe(obj.display);
    expect(next.display.categoryFilter).not.toBe(obj.display.categoryFilter);
  });

  test('does not mutate a sibling-shared nested object (the apply footgun)', () => {
    const shared = { displayMode: 'text', filterAttribute: 'category' };
    const obj = { display: { categoryFilter: shared } };
    const next = setByPath(obj, 'display.categoryFilter.displayMode', 'dropdown');
    expect(next.display.categoryFilter.displayMode).toBe('dropdown');
    expect(shared.displayMode).toBe('text'); // original nested object untouched
  });

  test('creates missing intermediate objects', () => {
    const next = setByPath({}, 'display.categoryFilter.displayMode', 'image') as {
      display: { categoryFilter: { displayMode: string } };
    };
    expect(next.display.categoryFilter.displayMode).toBe('image');
  });

  test('top-level write', () => {
    expect(setByPath({ a: 1 }, 'b', 2)).toEqual({ a: 1, b: 2 });
  });

  test('empty path → returns input unchanged', () => {
    const obj = { a: 1 };
    expect(setByPath(obj, '', 9)).toBe(obj);
  });
});
