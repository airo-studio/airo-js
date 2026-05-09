/**
 * Tests for `deriveComponentTokens` — pure transformation from
 * `componentSchema` + style surface to `themeSchema.component` token
 * sections.
 *
 * Covers: section-per-component shape, surface metadata propagation
 * (kind/default/options/description/min/max/step), `cssVarFor` callback,
 * default-naming convention, defensive skip on unknown style keys, and
 * deterministic iteration order.
 */

import { describe, expect, test } from 'vitest';

import type { ComponentSchema } from '../src/editor-schema.js';
import {
  defineStyleSurface,
  type StyleValuesOf,
} from '../src/style-surface.js';
import { deriveComponentTokens } from '../src/derive-component-tokens.js';

const appStyles = defineStyleSurface({
  background: {
    kind: 'color',
    default: '#ffffff',
    description: 'Component background colour',
  },
  fontWeight: {
    kind: 'enum',
    default: '400',
    options: [
      { value: '400', label: 'Regular' },
      { value: '700', label: 'Bold' },
    ],
  },
  borderWidth: {
    kind: 'cssLength',
    default: '1px',
    min: 0,
    max: 8,
    step: 1,
  },
} as const);
type AppStyles = StyleValuesOf<typeof appStyles>;

function buildSchema(
  id: string,
  label: string,
  allowed: ReadonlyArray<keyof AppStyles & string>,
): ComponentSchema<AppStyles> {
  return {
    id,
    label,
    icon: 'Box',
    category: 'content',
    props: {},
    styles: { allowed },
  };
}

describe('deriveComponentTokens', () => {
  test('emits one section per component, ordered by Object.keys', () => {
    const schemas = {
      productTitle: buildSchema('productTitle', 'Product Title', ['fontWeight']),
      productImage: buildSchema('productImage', 'Product Image', ['background']),
    };
    const sections = deriveComponentTokens(schemas, appStyles);

    expect(sections).toHaveLength(2);
    expect(sections[0]?.id).toBe('productTitle');
    expect(sections[0]?.displayName).toBe('Product Title');
    expect(sections[1]?.id).toBe('productImage');
  });

  test('propagates surface metadata onto each token', () => {
    const schemas = {
      productImage: buildSchema('productImage', 'Product Image', [
        'background',
        'fontWeight',
        'borderWidth',
      ]),
    };
    const [section] = deriveComponentTokens(schemas, appStyles);

    expect(section?.tokens).toHaveLength(3);

    const bg = section!.tokens[0]!;
    expect(bg.cssVar).toBe('--productImage-background');
    expect(bg.kind).toBe('color');
    expect(bg.default).toBe('#ffffff');
    expect(bg.description).toBe('Component background colour');
    expect(bg.options).toBeUndefined();

    const fw = section!.tokens[1]!;
    expect(fw.kind).toBe('enum');
    expect(fw.options).toHaveLength(2);
    expect(fw.options?.[0]).toEqual({ value: '400', label: 'Regular' });

    const bw = section!.tokens[2]!;
    expect(bw.kind).toBe('cssLength');
    expect(bw.min).toBe(0);
    expect(bw.max).toBe(8);
    expect(bw.step).toBe(1);
  });

  test('honours a custom cssVarFor callback', () => {
    const schemas = {
      productTitle: buildSchema('productTitle', 'Product Title', ['fontWeight']),
    };
    const [section] = deriveComponentTokens(
      schemas,
      appStyles,
      (componentId, styleKey) => `--demo-${componentId}-${styleKey}`,
    );
    expect(section?.tokens[0]?.cssVar).toBe('--demo-productTitle-fontWeight');
  });

  test('default cssVarFor produces --<componentId>-<styleKey>', () => {
    const schemas = {
      foo: buildSchema('foo', 'Foo', ['background']),
    };
    const [section] = deriveComponentTokens(schemas, appStyles);
    expect(section?.tokens[0]?.cssVar).toBe('--foo-background');
  });

  test('silently skips style keys not in the surface (defensive runtime guard)', () => {
    // Bypass the typecheck — simulate misuse from untyped JS callers.
    const schemas: Record<string, ComponentSchema<AppStyles>> = {
      mystery: {
        id: 'mystery',
        label: 'Mystery',
        icon: 'Box',
        category: 'content',
        props: {},
        styles: {
          allowed: ['background', 'notInSurface' as keyof AppStyles & string],
        },
      },
    };
    const [section] = deriveComponentTokens(schemas, appStyles);
    expect(section?.tokens).toHaveLength(1);
    expect(section?.tokens[0]?.cssVar).toBe('--mystery-background');
  });

  test('emits an empty tokens array for components with no allowed styles', () => {
    const schemas = {
      naked: buildSchema('naked', 'Naked', []),
    };
    const [section] = deriveComponentTokens(schemas, appStyles);
    expect(section?.id).toBe('naked');
    expect(section?.tokens).toHaveLength(0);
  });

  test('produces deterministic output across calls (pure transformation)', () => {
    const schemas = {
      productTitle: buildSchema('productTitle', 'Product Title', ['fontWeight']),
      productImage: buildSchema('productImage', 'Product Image', ['background']),
    };
    const a = deriveComponentTokens(schemas, appStyles);
    const b = deriveComponentTokens(schemas, appStyles);
    expect(a).toEqual(b);
  });
});
