/**
 * Derive `themeSchema.component` token sections from a cartridge's
 * `componentSchema` + style surface.
 *
 * Cartridge authors declare their style surface once via
 * `defineStyleSurface` (kind + default + options per key) and then list
 * which keys each component honours via `ComponentSchema.styles.allowed`.
 * This helper walks those allowed keys, looks up the surface metadata,
 * and emits one `TokenSection` per component — one less place for the
 * cartridge author to keep in sync, and the studio's component-scope
 * Style panel falls out for free.
 *
 * The helper is pure: same inputs produce the same output, no I/O,
 * deterministic iteration order over `componentSchemas` keys.
 *
 * Skipped silently: any allowed style key that isn't in the surface (the
 * `keyof TStyles` typecheck on `ComponentSchema.styles.allowed` already
 * rejects this at compile time, but the helper is also defensive at
 * runtime so misuse from untyped JS callers doesn't produce a partial
 * token whose `kind`/`default` are undefined).
 */

import type { ComponentSchema, TokenDef, TokenSection } from './editor-schema.js';
import type { StyleSurfaceDef } from './style-surface.js';

/**
 * Map a (componentId, styleKey) pair to a CSS variable name. The
 * cartridge controls naming entirely — common conventions are
 * `--<cartridgeId>-<componentId>-<styleKey>` or a runtime-prefixed
 * scheme. Default if omitted: `--<componentId>-<styleKey>`.
 */
export type CssVarFor = (componentId: string, styleKey: string) => string;

const defaultCssVarFor: CssVarFor = (componentId, styleKey) =>
  `--${componentId}-${styleKey}`;

/**
 * Walk a cartridge's `componentSchema` and produce one `TokenSection`
 * per component. Each section's `displayName` is the component's
 * `label`; tokens come from the style surface's metadata for each
 * allowed key.
 *
 * Iteration order matches `Object.keys(componentSchemas)` — typically
 * the declaration order in the cartridge's source file, which is the
 * order studios will render sections.
 */
export function deriveComponentTokens<TStyles>(
  componentSchemas: Readonly<Record<string, ComponentSchema<TStyles>>>,
  surface: StyleSurfaceDef,
  cssVarFor: CssVarFor = defaultCssVarFor,
): ReadonlyArray<TokenSection> {
  const sections: TokenSection[] = [];

  for (const componentId of Object.keys(componentSchemas)) {
    const schema = componentSchemas[componentId];
    if (!schema) continue;

    const tokens: TokenDef[] = [];
    for (const styleKey of schema.styles.allowed) {
      const surfaceEntry = surface[styleKey];
      if (!surfaceEntry) continue;

      const token: TokenDef = {
        cssVar: cssVarFor(componentId, styleKey),
        kind: surfaceEntry.kind,
        default: surfaceEntry.default,
      };
      if (surfaceEntry.description !== undefined) token.description = surfaceEntry.description;
      if (surfaceEntry.options !== undefined) token.options = surfaceEntry.options;
      if (surfaceEntry.min !== undefined) token.min = surfaceEntry.min;
      if (surfaceEntry.max !== undefined) token.max = surfaceEntry.max;
      if (surfaceEntry.step !== undefined) token.step = surfaceEntry.step;

      tokens.push(token);
    }

    sections.push({
      id: componentId,
      displayName: schema.label,
      tokens,
    });
  }

  return sections;
}
