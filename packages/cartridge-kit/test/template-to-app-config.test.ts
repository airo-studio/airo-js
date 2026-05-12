/**
 * Tests for `templateToAppConfig` — the single-source-of-truth helper
 * for translating a Template into an AppConfig. Both `mountCartridge`
 * (runtime) and SSR callers (`renderAppWithPublication`,
 * `renderAppToHTML`) consume this same helper.
 *
 * Covers: appId pass-through, page-shape mapping (id/type/enabled/
 * parent → page), empty-layout placeholder, subpage preservation,
 * empty-pages edge case, type narrowing on TPageType.
 */

import { describe, expect, test } from 'vitest';

import type { Template } from '../src/template.js';
import { templateToAppConfig } from '../src/template-to-app-config.js';

interface TestConfig {
  locale?: string;
}

function buildTemplate(): Template<TestConfig> {
  return {
    id: 'storefront',
    displayName: 'Storefront',
    description: 'Multi-page storefront template.',
    defaultConfig: { locale: 'en-GB' },
    pages: [
      { id: 'categories', type: 'categories', enabled: true },
      { id: 'products',   type: 'products',   enabled: true },
      { id: 'product',    type: 'product',    enabled: true },
      { id: 'quickview',  type: 'quickview',  enabled: true, parent: 'product' },
      { id: 'storeFinder', type: 'storeFinder', enabled: false },
    ],
  };
}

describe('templateToAppConfig', () => {
  test('appId is passed through to the AppConfig', () => {
    const template = buildTemplate();
    const appConfig = templateToAppConfig(template, 'wgt_abc123');
    expect(appConfig.appId).toBe('wgt_abc123');
  });

  test('pages array length matches the template', () => {
    const template = buildTemplate();
    const appConfig = templateToAppConfig(template, 'wgt_x');
    expect(appConfig.pages).toHaveLength(template.pages.length);
  });

  test('each page maps id/type/enabled/parent correctly', () => {
    const template = buildTemplate();
    const appConfig = templateToAppConfig(template, 'wgt_x');

    const quickview = appConfig.pages.find((p) => p.id === 'quickview');
    expect(quickview).toBeDefined();
    expect(quickview!.type).toBe('quickview');
    expect(quickview!.enabled).toBe(true);
    expect(quickview!.parent).toBe('product');

    const disabledFinder = appConfig.pages.find((p) => p.id === 'storeFinder');
    expect(disabledFinder).toBeDefined();
    expect(disabledFinder!.enabled).toBe(false);
    expect(disabledFinder!.parent).toBeUndefined();
  });

  test('each page gets an empty layout placeholder', () => {
    const template = buildTemplate();
    const appConfig = templateToAppConfig(template, 'wgt_x');

    for (const page of appConfig.pages) {
      expect(page.layout).toEqual({ regionOrder: [], regions: {} });
    }
  });

  test('subpages preserve their parent reference', () => {
    const template = buildTemplate();
    const appConfig = templateToAppConfig(template, 'wgt_x');

    const subpages = appConfig.pages.filter((p) => p.parent !== undefined);
    expect(subpages).toHaveLength(1);
    expect(subpages[0]?.id).toBe('quickview');
    expect(subpages[0]?.parent).toBe('product');
  });

  test('empty template.pages produces empty appConfig.pages', () => {
    const template: Template<TestConfig> = {
      id: 'empty',
      displayName: 'Empty',
      description: 'No pages.',
      defaultConfig: {},
      pages: [],
    };
    const appConfig = templateToAppConfig(template, 'wgt_empty');
    expect(appConfig.pages).toEqual([]);
    expect(appConfig.appId).toBe('wgt_empty');
  });

  test('does not mutate the input template', () => {
    const template = buildTemplate();
    const pagesBefore = template.pages.slice();
    templateToAppConfig(template, 'wgt_x');
    expect(template.pages).toEqual(pagesBefore);
    // The translated pages are fresh objects, not the same references.
    const appConfig = templateToAppConfig(template, 'wgt_x');
    expect(appConfig.pages[0]).not.toBe(template.pages[0]);
  });

  test('TPageType narrowing — typed page-type union flows through', () => {
    type ShopPageType = 'home' | 'product';
    const template: Template<TestConfig> = {
      id: 'shop',
      displayName: 'Shop',
      description: 'Typed.',
      defaultConfig: {},
      pages: [
        { id: 'home', type: 'home', enabled: true },
        { id: 'product', type: 'product', enabled: true },
      ],
    };
    const appConfig = templateToAppConfig<TestConfig, ShopPageType>(template, 'wgt_typed');
    // Compile-time check: appConfig.pages[0].type is ShopPageType, not string
    const t: ShopPageType = appConfig.pages[0]!.type;
    expect(t).toBe('home');
  });
});
