/**
 * Derive the global-options surface from a cartridge's `componentSchema`.
 *
 * The inverse of the per-component prop declaration: cartridge authors mark
 * a prop with `globalConfigKey` (a dot-path into `TConfig`) once on the
 * component that owns it, and this helper walks every component's props,
 * collects the ones that declare a key, and emits one `GlobalOption` per
 * DISTINCT key — the editor's global ("App Settings") panel for that key
 * falls out for free, the same way `deriveComponentTokens` derives the
 * component-scope Style panel from `styles.allowed`.
 *
 * The helper is pure: same input produces the same output, no I/O,
 * deterministic iteration order over `componentSchemas` keys then each
 * component's `props` insertion order.
 *
 * Note on output shape: a global option is PROP-shaped (a boolean / enum /
 * string control over `TConfig`), NOT token-shaped — these are feature
 * flags and editable settings, not CSS variables. So this emits
 * `GlobalOption` (carrying the prop's `PropSchema` as `field`), distinct
 * from `deriveComponentTokens`' `TokenSection[]` output.
 *
 * Dedupe semantics: the FIRST component (in iteration order) to declare a
 * key supplies the option's `field`; later components binding the same key
 * are recorded in `componentIds` but do not override the field. Authors
 * SHOULD declare matching `PropSchema` metadata across components sharing a
 * key — the shared key means one global control drives them all, so a
 * divergent label/type on a later component would be ignored here anyway.
 */

import type { ComponentSchema, PropSchema } from './editor-schema.js';

/**
 * One global setting derived from one or more component props that share a
 * `globalConfigKey`. Studios render a single control per `GlobalOption`;
 * editing it writes the `key` dot-path in `TConfig`, cascading to every
 * component in `componentIds` (minus any with a per-instance override).
 */
export interface GlobalOption {
  /** Dot-path into `TConfig` this option reads/writes (the `globalConfigKey`). */
  key: string;
  /**
   * Editor metadata for the global control — the `PropSchema` of the first
   * prop that declared this key. Note: the prop's `changeScope` describes
   * the per-instance OVERRIDE edit; a global-level edit is config-bound
   * (`'app'`-scope) and the studio treats it accordingly.
   */
  field: PropSchema;
  /** Components whose props bind to this key (for "affects N components" UI). */
  componentIds: ReadonlyArray<string>;
}

/**
 * Walk a cartridge's `componentSchema` and produce one `GlobalOption` per
 * distinct `globalConfigKey` declared across all component props.
 *
 * Iteration order matches `Object.keys(componentSchemas)` then each
 * component's `props` insertion order — typically declaration order in the
 * cartridge source, which is the order studios will render the options.
 */
export function deriveGlobalOptions<TStyles>(
  componentSchemas: Readonly<Record<string, ComponentSchema<TStyles>>>,
): ReadonlyArray<GlobalOption> {
  const byKey = new Map<string, { field: PropSchema; componentIds: string[] }>();

  for (const componentId of Object.keys(componentSchemas)) {
    const schema = componentSchemas[componentId];
    if (!schema) continue;

    for (const prop of Object.values(schema.props)) {
      const key = prop.globalConfigKey;
      if (!key) continue;

      const existing = byKey.get(key);
      if (existing) {
        if (!existing.componentIds.includes(componentId)) {
          existing.componentIds.push(componentId);
        }
      } else {
        byKey.set(key, { field: prop, componentIds: [componentId] });
      }
    }
  }

  return Array.from(byKey, ([key, { field, componentIds }]) => ({
    key,
    field,
    componentIds,
  }));
}
