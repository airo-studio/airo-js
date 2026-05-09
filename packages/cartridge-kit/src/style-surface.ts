/**
 * Style surface — a cartridge's curated set of editable style keys.
 *
 * One declaration drives three things:
 *   1. Compile-time `keyof TStyles` typechecking on
 *      `ComponentSchema.styles.allowed` (so cartridges can't misspell
 *      style keys, and removing a key from the surface fails the schema).
 *   2. Runtime metadata for `deriveComponentTokens` so studios can render
 *      the right input control per key (color picker, length input,
 *      enum dropdown, code textarea).
 *   3. Default values surfaced by the inspector when the user clears an
 *      override — the "this is what would render with no override" baseline.
 *
 * Authoring pattern:
 *
 * ```ts
 * import { defineStyleSurface, type StyleValuesOf } from '@airo-js/cartridge-kit';
 *
 * export const appStyles = defineStyleSurface({
 *   background: { kind: 'color', default: '#ffffff' },
 *   fontWeight: {
 *     kind: 'enum',
 *     default: '400',
 *     options: [
 *       { value: '400', label: 'Regular' },
 *       { value: '700', label: 'Bold' },
 *     ],
 *   },
 * } as const);
 *
 * export type AppStyles = StyleValuesOf<typeof appStyles>;
 * // → { background?: string; fontWeight?: string }
 * ```
 *
 * The cartridge then ties them together via
 * `Cartridge<TData, TConfig, AppStyles>`.
 */

import type { FieldType } from './editor-schema.js';

/**
 * One key's editor metadata. Mirrors `TokenDef` semantically — same
 * `kind`/`default`/`description`/`options`/`min`/`max`/`step` fields —
 * but lives in the surface declaration so cartridge authors can write
 * the kind table once and have everything else derive.
 */
export interface StyleKindDef {
  kind: FieldType | (string & {});
  default: string;
  description?: string;
  options?: ReadonlyArray<{ value: string; label: string }>;
  min?: number;
  max?: number;
  step?: number;
}

/**
 * Shape of a style surface declaration. Authors typically pass a
 * literal-typed object via `defineStyleSurface(... as const)` so the
 * concrete keys narrow into the result type.
 */
export type StyleSurfaceDef = Readonly<Record<string, Readonly<StyleKindDef>>>;

/**
 * Identity-for-inference helper. Returns the input unchanged; its only
 * purpose is to constrain the argument type so TypeScript narrows literal
 * keys without authors writing an explicit `satisfies` clause.
 *
 * Use with `as const` to lock literal types end-to-end:
 *
 * ```ts
 * const surface = defineStyleSurface({
 *   background: { kind: 'color', default: '#fff' },
 * } as const);
 * type Values = StyleValuesOf<typeof surface>;
 * ```
 */
export function defineStyleSurface<const T extends StyleSurfaceDef>(surface: T): T {
  return surface;
}

/**
 * Derive the runtime value shape from a surface declaration:
 *
 *   `StyleValuesOf<typeof surface>` ≡ `{ [K in keys]?: string }`
 *
 * Cartridges use this as their `TStyles` type parameter on
 * `Cartridge<TData, TConfig, TStyles>` and on `ComponentSchema<TStyles>`.
 *
 * Values are typed as `string` because every CSS-bound style serialises
 * to a string at the DOM boundary (colours, lengths, enum tokens). The
 * runtime kind from the surface declaration tells studios how to validate
 * + render the value.
 */
export type StyleValuesOf<T extends StyleSurfaceDef> = {
  [K in keyof T]?: string;
};
