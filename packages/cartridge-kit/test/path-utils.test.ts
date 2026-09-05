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

  test('reads the array itself', () => {
    expect(getByPath({ items: ['a', 'b'] }, 'items')).toEqual(['a', 'b']);
  });

  test('descends into an array by index', () => {
    const cfg = { display: { filters: [{ layout: 'grid' }, { layout: 'list' }] } };
    expect(getByPath(cfg, 'display.filters.0.layout')).toBe('grid');
    expect(getByPath(cfg, 'display.filters.1.layout')).toBe('list');
    expect(getByPath(cfg, 'display.filters.1')).toEqual({ layout: 'list' });
  });

  test('out-of-range index → undefined', () => {
    expect(getByPath({ items: ['a'] }, 'items.5')).toBeUndefined();
  });

  test('non-canonical index segments do not index an array', () => {
    const obj = { items: ['a', 'b'] };
    expect(getByPath(obj, 'items.01')).toBeUndefined(); // leading zero is ambiguous
    expect(getByPath(obj, 'items.-1')).toBeUndefined();
    expect(getByPath(obj, 'items.1e0')).toBeUndefined();
  });

  test('array internals stay off the path grammar', () => {
    expect(getByPath({ items: ['a', 'b'] }, 'items.length')).toBeUndefined();
    expect(getByPath({ items: ['a'] }, 'items.constructor')).toBeUndefined();
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

  test('in-range index → true', () => {
    const cfg = { display: { filters: [{ layout: 'grid' }] } };
    expect(hasByPath(cfg, 'display.filters.0')).toBe(true);
    expect(hasByPath(cfg, 'display.filters.0.layout')).toBe(true);
  });

  test('index present with undefined value → true (unset, not absent)', () => {
    expect(hasByPath({ filters: [{ layout: undefined }] }, 'filters.0.layout')).toBe(true);
  });

  test('out-of-range index → false (the position-never-declared case)', () => {
    expect(hasByPath({ filters: [{ layout: 'grid' }] }, 'filters.1.layout')).toBe(false);
    expect(hasByPath({ filters: [] }, 'filters.0')).toBe(false);
  });

  test('non-index segment against an array → false', () => {
    expect(hasByPath({ filters: [{ layout: 'grid' }] }, 'filters.layout')).toBe(false);
    expect(hasByPath({ filters: ['a'] }, 'filters.length')).toBe(false);
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

  test('writes through an array index', () => {
    const obj = { display: { filters: [{ layout: 'grid' }, { layout: 'list' }] } };
    const next = setByPath(obj, 'display.filters.1.layout', 'carousel');
    expect(next.display.filters[1]!.layout).toBe('carousel');
    expect(obj.display.filters[1]!.layout).toBe('list'); // input untouched
  });

  test('array copy-on-write — sibling elements stay referentially shared', () => {
    const sibling = { layout: 'grid' };
    const obj = { filters: [sibling, { layout: 'list' }] };
    const next = setByPath(obj, 'filters.1.layout', 'carousel');
    expect(next.filters).not.toBe(obj.filters); // spine cloned
    expect(next.filters[0]).toBe(sibling); // untouched element shared
    expect(next.filters[1]).not.toBe(obj.filters[1]); // written element cloned
    expect(Array.isArray(next.filters)).toBe(true); // still an array, not an object
  });

  test('replaces a whole element when the index is the last segment', () => {
    const obj = { filters: [{ layout: 'grid' }] };
    const next = setByPath(obj, 'filters.0', { layout: 'list' });
    expect(next.filters[0]).toEqual({ layout: 'list' });
    expect(obj.filters[0]).toEqual({ layout: 'grid' });
  });

  test('creates an array when the next segment is an index', () => {
    const next = setByPath({}, 'display.filters.0.layout', 'grid') as {
      display: { filters: { layout: string }[] };
    };
    expect(Array.isArray(next.display.filters)).toBe(true);
    expect(next.display.filters[0]!.layout).toBe('grid');
  });

  test('refuses an out-of-range index rather than leaving holes', () => {
    const obj = { filters: [{ layout: 'grid' }] };
    expect(setByPath(obj, 'filters.2.layout', 'list')).toBe(obj);
    expect(obj.filters).toHaveLength(1);
  });

  test('refuses a non-index segment rather than clobbering the array', () => {
    const obj = { filters: [{ layout: 'grid' }] };
    expect(setByPath(obj, 'filters.layout', 'list')).toBe(obj);
    expect(Array.isArray(obj.filters)).toBe(true);
  });
});
