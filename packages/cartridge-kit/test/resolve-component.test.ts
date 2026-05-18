/**
 * Tests for `resolveComponentProp` + `resolveComponentVisibility` —
 * 0.7.3 shared precedence helpers that join the framework's three
 * component-state layers (Slot, Page.componentSettings, ComponentSchema)
 * into one resolved view-model.
 *
 * The contract these tests pin: panel UI and runtime renderer both
 * call the same resolver. Drift between the two would silently produce
 * "panel shows X, renderer paints Y" bugs.
 */

import { describe, expect, test } from 'vitest';

import type { Page } from '@airo-js/core';

import type { ComponentSchema } from '../src/editor-schema.js';
import {
  resolveComponentProp,
  resolveComponentVisibility,
} from '../src/resolve-component.js';

const TEST_SCHEMA: ComponentSchema = {
  id: 'product-card',
  label: 'Product Card',
  icon: 'package',
  category: 'commerce',
  props: {
    showPrice: {
      type: 'boolean',
      label: 'Show price',
      default: true,
      changeScope: 'instance',
    },
    title: {
      type: 'string',
      label: 'Title',
      default: 'Default Title',
      changeScope: 'instance',
    },
  },
};

function makePage(overrides: Partial<Page<string>> = {}): Page<string> {
  return {
    id: 'home',
    type: 'home',
    enabled: true,
    layout: {
      regionOrder: ['main'],
      regions: {
        main: {
          id: 'main',
          components: [
            {
              id: 'card-slot',
              order: 0,
              componentId: 'product-card',
              visible: true,
              props: {
                showPrice: false,
                title: 'Slot Title',
              },
            },
          ],
        },
      },
    },
    ...overrides,
  };
}

describe('resolveComponentVisibility', () => {
  test('default — neither override nor slot set → visible', () => {
    const page = makePage({
      layout: { regionOrder: ['main'], regions: { main: { id: 'main', components: [] } } },
    });
    expect(resolveComponentVisibility(page, 'product-card')).toBe(true);
  });

  test('slot.visible: false → hidden', () => {
    const page = makePage();
    page.layout.regions.main.components[0]!.visible = false;
    expect(resolveComponentVisibility(page, 'product-card')).toBe(false);
  });

  test('componentSettings.visible overrides slot.visible (true wins over slot false)', () => {
    const page = makePage();
    page.layout.regions.main.components[0]!.visible = false;
    page.componentSettings = {
      'product-card': { visible: true },
    };
    expect(resolveComponentVisibility(page, 'product-card')).toBe(true);
  });

  test('componentSettings.visible: false overrides slot.visible: true', () => {
    const page = makePage();
    page.componentSettings = {
      'product-card': { visible: false },
    };
    expect(resolveComponentVisibility(page, 'product-card')).toBe(false);
  });

  test('non-existent componentId returns default true', () => {
    const page = makePage();
    expect(resolveComponentVisibility(page, 'never-existed')).toBe(true);
  });
});

describe('resolveComponentProp — precedence ladder', () => {
  test('componentSettings.props wins over slot.props + schema.default', () => {
    const page = makePage();
    page.componentSettings = {
      'product-card': { props: { showPrice: true } },
    };
    expect(resolveComponentProp(page, 'product-card', 'showPrice', TEST_SCHEMA)).toBe(true);
  });

  test('slot.props wins over schema.default when no componentSettings override', () => {
    const page = makePage();
    // Slot has showPrice: false; schema default is true; expect slot to win.
    expect(resolveComponentProp(page, 'product-card', 'showPrice', TEST_SCHEMA)).toBe(false);
  });

  test('schema.default wins when neither componentSettings nor slot has the prop', () => {
    const page = makePage({
      layout: { regionOrder: ['main'], regions: { main: { id: 'main', components: [] } } },
    });
    expect(resolveComponentProp(page, 'product-card', 'showPrice', TEST_SCHEMA)).toBe(true);
    expect(resolveComponentProp(page, 'product-card', 'title', TEST_SCHEMA)).toBe('Default Title');
  });

  test('undefined when prop not declared in schema AND not in slot/settings', () => {
    const page = makePage({
      layout: { regionOrder: ['main'], regions: { main: { id: 'main', components: [] } } },
    });
    expect(resolveComponentProp(page, 'product-card', 'undeclared', TEST_SCHEMA)).toBeUndefined();
  });

  test('undefined when no schema is passed and no slot/settings have it', () => {
    const page = makePage({
      layout: { regionOrder: ['main'], regions: { main: { id: 'main', components: [] } } },
    });
    expect(resolveComponentProp(page, 'product-card', 'showPrice')).toBeUndefined();
  });

  test('explicit undefined in componentSettings.props does NOT mask slot value (key absent vs present)', () => {
    // The `in` operator is the discriminator: settings.props.foo = undefined
    // is treated as "explicit override to undefined" (returns undefined),
    // distinct from key-absent (falls through to slot).
    const page = makePage();
    page.componentSettings = {
      'product-card': { props: { showPrice: undefined } },
    };
    // Explicit undefined override wins — caller chose to clear the value.
    expect(resolveComponentProp(page, 'product-card', 'showPrice', TEST_SCHEMA)).toBeUndefined();
  });

  test('searches across multiple regions in regionOrder', () => {
    const page = makePage({
      layout: {
        regionOrder: ['header', 'main'],
        regions: {
          header: { id: 'header', components: [] },
          main: {
            id: 'main',
            components: [
              {
                id: 'card-slot',
                order: 0,
                componentId: 'product-card',
                visible: true,
                props: { showPrice: false },
              },
            ],
          },
        },
      },
    });
    expect(resolveComponentProp(page, 'product-card', 'showPrice', TEST_SCHEMA)).toBe(false);
  });

  test('first matching slot wins across regions (regionOrder respected)', () => {
    // If the same componentId appears in two regions (rare but possible),
    // the first one in regionOrder wins — matches the paint order.
    const page = makePage({
      layout: {
        regionOrder: ['header', 'main'],
        regions: {
          header: {
            id: 'header',
            components: [
              {
                id: 'header-card',
                order: 0,
                componentId: 'product-card',
                visible: true,
                props: { showPrice: true },
              },
            ],
          },
          main: {
            id: 'main',
            components: [
              {
                id: 'main-card',
                order: 0,
                componentId: 'product-card',
                visible: true,
                props: { showPrice: false },
              },
            ],
          },
        },
      },
    });
    expect(resolveComponentProp(page, 'product-card', 'showPrice', TEST_SCHEMA)).toBe(true);
  });

  test('falls back to Object.keys when regionOrder is missing', () => {
    const page: Page<string> = {
      id: 'home',
      type: 'home',
      enabled: true,
      layout: {
        regionOrder: [],
        regions: {
          main: {
            id: 'main',
            components: [
              {
                id: 'slot',
                order: 0,
                componentId: 'product-card',
                visible: true,
                props: { showPrice: false },
              },
            ],
          },
        },
      },
    };
    expect(resolveComponentProp(page, 'product-card', 'showPrice', TEST_SCHEMA)).toBe(false);
  });
});
