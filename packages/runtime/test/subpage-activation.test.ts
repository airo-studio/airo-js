/**
 * Tests for `SubpageActivation<T>.page` — Finding 3 from CLAUDE.md §3.
 *
 * PageManager now populates `page` on every subpage activation so the
 * parent renderer's `activateSubpage(subpage)` handler can apply the
 * subpage's own `componentSettings` / `styles` without re-walking the
 * page graph. Backward-compatible: existing consumers ignoring the
 * field continue to work; only the type widens.
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { SubpageActivation } from '@airo-js/core';

import { mountCartridge } from '../src/mount-cartridge.js';
import {
  fakeCartridge,
  fakeTemplate,
  subpageCapturingRenderer,
  type TestConfig,
  type TestData,
} from './fixtures.js';

let host: HTMLElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  host.remove();
});

describe('SubpageActivation.page (Finding 3)', () => {
  test('parent renderer receives the full Page<T> for the subpage', async () => {
    const activations: unknown[] = [];

    const result = await mountCartridge<TestData, TestConfig>({
      cartridge: fakeCartridge({
        views: [
          {
            id: 'home-view',
            displayName: 'Home',
            pageType: 'home',
            factory: () => subpageCapturingRenderer(activations),
          },
        ],
      }),
      config: {},
      template: {
        ...fakeTemplate(),
        pages: [
          { id: 'home', type: 'home', enabled: true },
          { id: 'product-modal', type: 'product-modal', enabled: true, parent: 'home' },
        ],
      },
      host,
      preloadedData: { items: [] },
    });
    if (result.blocked) throw new Error('expected unblocked');

    // Navigate to the subpage; PageManager dispatches an activation to
    // the parent's renderer with the new `page` field populated.
    result.app.navigate({ page: 'product-modal' });

    expect(activations).toHaveLength(1);
    const activation = activations[0] as SubpageActivation;
    expect(activation.type).toBe('product-modal');
    expect(activation.id).toBe('product-modal');
    expect(activation.parent).toBe('home');
    // The new `page` field — Finding 3's recommended shape. Carries the
    // full Page<T> entry from AppConfig so the parent renderer can read
    // `page.componentSettings` / `page.styles` / `page.props` directly.
    // The empty layout reflects templateToAppConfig's placeholder; richer
    // page-config flows in when callers build AppConfig with populated
    // layouts (studios do this for slot-rendered pages).
    expect(activation.page).toBeDefined();
    expect(activation.page?.id).toBe('product-modal');
    expect(activation.page?.type).toBe('product-modal');
    expect(activation.page?.parent).toBe('home');
    expect(activation.page?.enabled).toBe(true);
  });

  test('navContext fields still spread onto the activation alongside page', async () => {
    const activations: unknown[] = [];

    const result = await mountCartridge<TestData, TestConfig>({
      cartridge: fakeCartridge({
        views: [
          {
            id: 'home-view',
            displayName: 'Home',
            pageType: 'home',
            factory: () => subpageCapturingRenderer(activations),
          },
        ],
      }),
      config: {},
      template: {
        ...fakeTemplate(),
        pages: [
          { id: 'home', type: 'home', enabled: true },
          { id: 'cart', type: 'cart', enabled: true, parent: 'home' },
        ],
      },
      host,
      preloadedData: { items: [] },
    });
    if (result.blocked) throw new Error('expected unblocked');

    // Navigate with a non-empty navContext (locale + selected).
    result.app.navigate({
      page: 'cart',
      locale: 'en-US',
      selectedSku: 'SKU-123',
    });

    expect(activations).toHaveLength(1);
    const activation = activations[0] as SubpageActivation;
    expect(activation.page?.id).toBe('cart');
    // navContext fields are still spread on the activation per legacy contract.
    expect(activation.locale).toBe('en-US');
    expect(activation.selectedSku).toBe('SKU-123');
  });
});
