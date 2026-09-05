// @vitest-environment node
/**
 * buildCrumbs — the data-only navigation trail.
 *
 * A pure function with four filters and a three-way resolver contract, and no
 * test until 1.0. The subtle parts, all of which are easy to regress:
 *
 *   - the trail STOPS at the anchor page; pages after it never appear
 *   - a subpage anchors to its `parent`, so a modal shows its parent's trail
 *   - the resolver's three returns mean three different things, and `null`
 *     at the anchor breaks rather than skips
 */

import { describe, expect, test } from 'vitest';

import { buildCrumbs } from '../src/breadcrumb.js';
import type { Page } from '../src/schema.js';
import type { NavigationState } from '../src/page.js';

type PageType = 'home' | 'products' | 'product' | 'gate';

const nav: NavigationState = { page: 'home' } as NavigationState;

function page(over: Partial<Page<PageType>> & { id: string }): Page<PageType> {
  return {
    type: 'home',
    enabled: true,
    ...over,
  } as Page<PageType>;
}

const PAGES: Page<PageType>[] = [
  page({ id: 'home', type: 'home' }),
  page({ id: 'products', type: 'products' }),
  page({ id: 'product', type: 'product' }),
];

describe('buildCrumbs', () => {
  test('builds the trail up to and including the active page', () => {
    expect(buildCrumbs(PAGES, 'products', nav)).toEqual([
      { pageId: 'home', label: 'home', isCurrent: false },
      { pageId: 'products', label: 'products', isCurrent: true },
    ]);
  });

  test('STOPS at the active page — later pages are not in the trail', () => {
    const crumbs = buildCrumbs(PAGES, 'products', nav);
    expect(crumbs.map((c) => c.pageId)).not.toContain('product');
  });

  test('the first page alone when it is active', () => {
    expect(buildCrumbs(PAGES, 'home', nav)).toEqual([
      { pageId: 'home', label: 'home', isCurrent: true },
    ]);
  });

  test('exactly one crumb is ever current', () => {
    const crumbs = buildCrumbs(PAGES, 'product', nav);
    expect(crumbs.filter((c) => c.isCurrent)).toHaveLength(1);
  });

  describe('empty and unknown input', () => {
    test('no pages yields no crumbs', () => {
      expect(buildCrumbs([], 'home', nav)).toEqual([]);
    });

    test('an unknown active id walks the whole enabled top level, none current', () => {
      const crumbs = buildCrumbs(PAGES, 'does-not-exist', nav);
      expect(crumbs.map((c) => c.pageId)).toEqual(['home', 'products', 'product']);
      expect(crumbs.every((c) => !c.isCurrent)).toBe(true);
    });
  });

  describe('filters', () => {
    test('subpages never appear in the trail', () => {
      const pages = [...PAGES, page({ id: 'quickview', type: 'product', parent: 'product' })];
      expect(buildCrumbs(pages, 'product', nav).map((c) => c.pageId)).not.toContain('quickview');
    });

    test('disabled pages are skipped', () => {
      const pages = [
        page({ id: 'home' }),
        page({ id: 'hidden', enabled: false }),
        page({ id: 'products', type: 'products' }),
      ];
      expect(buildCrumbs(pages, 'products', nav).map((c) => c.pageId)).toEqual([
        'home',
        'products',
      ]);
    });

    test('gate pages are skipped when isGatePage says so', () => {
      const pages = [page({ id: 'gate', type: 'gate' }), ...PAGES];
      const crumbs = buildCrumbs(pages, 'home', nav, undefined, (t) => t === 'gate');
      expect(crumbs.map((c) => c.pageId)).toEqual(['home']);
    });

    test('without isGatePage, nothing is treated as a gate', () => {
      const pages = [page({ id: 'gate', type: 'gate' }), ...PAGES];
      expect(buildCrumbs(pages, 'home', nav).map((c) => c.pageId)).toEqual(['gate', 'home']);
    });
  });

  describe('anchoring', () => {
    test('an active SUBPAGE anchors to its parent', () => {
      // A modal open over the product page shows the product page's trail,
      // with the parent marked current — not an empty trail.
      const pages = [...PAGES, page({ id: 'quickview', type: 'product', parent: 'product' })];
      const crumbs = buildCrumbs(pages, 'quickview', nav);

      expect(crumbs.map((c) => c.pageId)).toEqual(['home', 'products', 'product']);
      expect(crumbs.at(-1)).toEqual({ pageId: 'product', label: 'product', isCurrent: true });
    });
  });

  describe('the label resolver has three distinct returns', () => {
    test('a string is used as the label', () => {
      const crumbs = buildCrumbs(PAGES, 'products', nav, (p) => `Label:${p.id}`);
      expect(crumbs.map((c) => c.label)).toEqual(['Label:home', 'Label:products']);
    });

    test('undefined falls back to the page id', () => {
      const crumbs = buildCrumbs(PAGES, 'products', nav, (p) =>
        p.id === 'home' ? undefined : 'Shop',
      );
      expect(crumbs.map((c) => c.label)).toEqual(['home', 'Shop']);
    });

    test('null SKIPS a non-current page', () => {
      const crumbs = buildCrumbs(PAGES, 'products', nav, (p) => (p.id === 'home' ? null : p.id));
      expect(crumbs.map((c) => c.pageId)).toEqual(['products']);
    });

    test('null at the CURRENT page breaks the trail rather than skipping it', () => {
      // The distinction matters: skipping would keep walking and could emit
      // pages that come after the active one.
      const crumbs = buildCrumbs(PAGES, 'products', nav, (p) =>
        p.id === 'products' ? null : p.id,
      );
      expect(crumbs.map((c) => c.pageId)).toEqual(['home']);
      expect(crumbs.every((c) => !c.isCurrent)).toBe(true);
    });

    test('an empty string is a real label, not a falsy fallback', () => {
      const crumbs = buildCrumbs(PAGES, 'home', nav, () => '');
      expect(crumbs).toEqual([{ pageId: 'home', label: '', isCurrent: true }]);
    });

    test('the resolver receives the page and the nav state', () => {
      const seen: Array<[string, NavigationState]> = [];
      buildCrumbs(PAGES, 'home', nav, (p, n) => {
        seen.push([p.id, n]);
        return p.id;
      });
      expect(seen).toEqual([['home', nav]]);
    });
  });
});
