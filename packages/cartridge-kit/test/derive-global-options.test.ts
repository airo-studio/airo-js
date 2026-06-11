/**
 * Tests for `deriveGlobalOptions` — the inverse of the per-component
 * `globalConfigKey` declaration. Walks component schemas, collects props
 * that declare a global key, and emits one `GlobalOption` per DISTINCT key
 * (dedup-by-key, accumulating the components that bind it).
 */

import { describe, expect, test } from 'vitest';

import type { ComponentSchema, PropSchema } from '../src/editor-schema.js';
import { deriveGlobalOptions } from '../src/derive-global-options.js';

function comp(
  id: string,
  props: Record<string, PropSchema>,
): ComponentSchema {
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

describe('deriveGlobalOptions', () => {
  test('emits one option per global-keyed prop', () => {
    const schemas = {
      productImage: comp('productImage', { removeBackground: removeBg, showDots: localOnly }),
    };
    const opts = deriveGlobalOptions(schemas);
    expect(opts).toHaveLength(1);
    expect(opts[0]).toMatchObject({
      key: 'display.removeProductBackground',
      componentIds: ['productImage'],
    });
    expect(opts[0]!.field).toBe(removeBg);
  });

  test('props without globalConfigKey are ignored', () => {
    const schemas = { card: comp('card', { showDots: localOnly }) };
    expect(deriveGlobalOptions(schemas)).toEqual([]);
  });

  test('shared key across components dedupes to one option, accumulating componentIds', () => {
    const schemas = {
      filters: comp('filters', { displayMode }),
      categoryFilter: comp('categoryFilter', { displayMode }),
    };
    const opts = deriveGlobalOptions(schemas);
    expect(opts).toHaveLength(1);
    expect(opts[0]!.key).toBe('display.categoryFilter.displayMode');
    expect(opts[0]!.componentIds).toEqual(['filters', 'categoryFilter']);
  });

  test('first declarer supplies the field on a shared key', () => {
    const firstField: PropSchema = { ...displayMode, label: 'First' };
    const secondField: PropSchema = { ...displayMode, label: 'Second' };
    const schemas = {
      filters: comp('filters', { displayMode: firstField }),
      categoryFilter: comp('categoryFilter', { displayMode: secondField }),
    };
    const opts = deriveGlobalOptions(schemas);
    expect(opts[0]!.field).toBe(firstField);
  });

  test('deterministic order — component key order then prop insertion order', () => {
    const schemas = {
      productImage: comp('productImage', { removeBackground: removeBg }),
      filters: comp('filters', { displayMode }),
    };
    const opts = deriveGlobalOptions(schemas);
    expect(opts.map((o) => o.key)).toEqual([
      'display.removeProductBackground',
      'display.categoryFilter.displayMode',
    ]);
  });

  test('empty schema set → empty options', () => {
    expect(deriveGlobalOptions({})).toEqual([]);
  });
});
