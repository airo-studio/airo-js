/**
 * Tests for `validateGlobalConfigKeys` / `assertGlobalConfigKeys` — the
 * author-time typo-catcher for `PropSchema.globalConfigKey` dot-paths.
 *
 * The load-bearing distinction: a key PRESENT-but-undefined on the config
 * (a real global the brand hasn't set) must NOT report; a key ABSENT from
 * the config shape (a typo) must report.
 */

import { describe, expect, test } from 'vitest';

import type { ComponentSchema, PropSchema } from '../src/editor-schema.js';
import {
  assertGlobalConfigKeys,
  validateGlobalConfigKeys,
} from '../src/validate-global-config-keys.js';

function comp(id: string, props: Record<string, PropSchema>): ComponentSchema {
  return { id, label: id, icon: 'box', category: 'content', props };
}

const removeBg: PropSchema = {
  type: 'boolean',
  label: 'Remove background',
  default: false,
  changeScope: 'page',
  globalConfigKey: 'display.removeProductBackground',
};
const displayMode: PropSchema = {
  type: 'enum',
  label: 'Filter style',
  default: 'text',
  changeScope: 'page',
  globalConfigKey: 'display.categoryFilter.displayMode',
};
const localOnly: PropSchema = {
  type: 'boolean',
  label: 'Show dots',
  default: true,
  changeScope: 'instance',
};

// Representative (default) config — every real global path is present.
const DEFAULT_CONFIG = {
  display: {
    removeProductBackground: false,
    categoryFilter: { displayMode: 'text' },
  },
};

describe('validateGlobalConfigKeys', () => {
  test('all keys present → no invalids', () => {
    const schemas = {
      productImage: comp('productImage', { removeBackground: removeBg }),
      filters: comp('filters', { displayMode }),
    };
    expect(validateGlobalConfigKeys(schemas, DEFAULT_CONFIG)).toEqual([]);
  });

  test('present-but-undefined value is NOT reported (unset global)', () => {
    const schemas = { productImage: comp('productImage', { removeBackground: removeBg }) };
    const config = { display: { removeProductBackground: undefined } };
    expect(validateGlobalConfigKeys(schemas, config)).toEqual([]);
  });

  test('typo in leaf → reported', () => {
    const typo: PropSchema = { ...removeBg, globalConfigKey: 'display.removeProductBakground' };
    const schemas = { productImage: comp('productImage', { removeBackground: typo }) };
    expect(validateGlobalConfigKeys(schemas, DEFAULT_CONFIG)).toEqual([
      {
        componentId: 'productImage',
        propKey: 'removeBackground',
        globalConfigKey: 'display.removeProductBakground',
      },
    ]);
  });

  test('typo in intermediate segment → reported', () => {
    const typo: PropSchema = { ...displayMode, globalConfigKey: 'display.catFilter.displayMode' };
    const schemas = { filters: comp('filters', { displayMode: typo }) };
    expect(validateGlobalConfigKeys(schemas, DEFAULT_CONFIG)).toHaveLength(1);
  });

  test('props without globalConfigKey are ignored', () => {
    const schemas = { card: comp('card', { showDots: localOnly }) };
    expect(validateGlobalConfigKeys(schemas, DEFAULT_CONFIG)).toEqual([]);
  });
});

describe('assertGlobalConfigKeys', () => {
  test('passes silently when all keys resolve', () => {
    const schemas = { filters: comp('filters', { displayMode }) };
    expect(() => assertGlobalConfigKeys(schemas, DEFAULT_CONFIG)).not.toThrow();
  });

  test('throws listing the bad keys', () => {
    const typo: PropSchema = { ...removeBg, globalConfigKey: 'display.nope' };
    const schemas = { productImage: comp('productImage', { removeBackground: typo }) };
    expect(() => assertGlobalConfigKeys(schemas, DEFAULT_CONFIG)).toThrow(/display\.nope/);
  });
});
