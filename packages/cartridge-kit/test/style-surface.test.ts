/**
 * Tests for `defineStyleSurface` + `StyleValuesOf`.
 *
 * The helper is an identity function for type inference. Runtime asserts
 * are minimal (it returns its input unchanged). The type-level asserts
 * verify that:
 *   - Literal-narrowed keys flow through to the result type.
 *   - `StyleValuesOf<T>` produces `{ [K in keyof T]?: string }`.
 *
 * Type assertions use `expectTypeOf` from vitest so the testfile itself
 * fails compilation if the inference breaks.
 */

import { describe, expect, expectTypeOf, test } from 'vitest';

import {
  defineStyleSurface,
  type StyleSurfaceDef,
  type StyleValuesOf,
} from '../src/style-surface.js';

describe('defineStyleSurface', () => {
  test('returns its input unchanged (identity)', () => {
    const surface = {
      background: { kind: 'color', default: '#ffffff' },
      padding: { kind: 'cssLength', default: '0' },
    } as const;

    const result = defineStyleSurface(surface);

    expect(result).toBe(surface);
  });

  test('accepts a surface with all metadata fields', () => {
    const surface = defineStyleSurface({
      fontWeight: {
        kind: 'enum',
        default: '400',
        description: 'Font weight',
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

    expect(surface.fontWeight.options).toHaveLength(2);
    expect(surface.borderWidth.min).toBe(0);
  });

  test('preserves literal narrowing on keys', () => {
    const surface = defineStyleSurface({
      background: { kind: 'color', default: '#fff' },
      textColor: { kind: 'color', default: '#000' },
    } as const);

    // Type-level assertion: the result has literal keys, not just `string`.
    expectTypeOf(surface).toHaveProperty('background');
    expectTypeOf(surface).toHaveProperty('textColor');
  });
});

describe('StyleValuesOf', () => {
  test('derives an optional-string record from the surface keys', () => {
    const surface = defineStyleSurface({
      background: { kind: 'color', default: '#fff' },
      padding: { kind: 'cssLength', default: '0' },
    } as const);

    type Values = StyleValuesOf<typeof surface>;

    // Type-level: the derived type accepts partial records of string values.
    const a: Values = {};
    const b: Values = { background: '#000' };
    const c: Values = { background: '#000', padding: '16px' };

    expect(a).toBeDefined();
    expect(b.background).toBe('#000');
    expect(c.padding).toBe('16px');
  });

  test('rejects keys not in the surface (compile-time guard)', () => {
    const surface = defineStyleSurface({
      background: { kind: 'color', default: '#fff' },
    } as const);

    type Values = StyleValuesOf<typeof surface>;

    // @ts-expect-error — `fontSize` is not a key on the surface.
    const _bad: Values = { fontSize: '16px' };

    // The runtime expectation is just that the typecheck above fired —
    // if the @ts-expect-error directive is unused, the test fails to compile.
    expect(true).toBe(true);
  });

  test('StyleSurfaceDef accepts arbitrary kind strings (cartridge-specific kinds)', () => {
    // Cartridge-specific kinds (e.g., 'attribute', 'reference') are
    // first-class extensions — the surface declaration shouldn't reject them.
    const surface: StyleSurfaceDef = {
      customField: { kind: 'attribute', default: 'attributes.name' },
    };

    expect(surface.customField?.kind).toBe('attribute');
  });
});
