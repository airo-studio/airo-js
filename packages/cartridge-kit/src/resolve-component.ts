/**
 * `resolveComponentProp` + `resolveComponentVisibility` — shared
 * precedence helpers for joining the framework's three component-state
 * layers into one resolved view-model.
 *
 * The framework owns each layer:
 *
 *   - `Slot.props` / `Slot.visible` — from `@airo-js/core` schema:
 *     the per-placement defaults a cartridge author wrote into the
 *     `PageLayout.regions.<region>.components[i]` array.
 *   - `Page.componentSettings.<componentId>.props` / `.visible` —
 *     also from `@airo-js/core`: sparse override map a host
 *     (studio editor) writes per-page to layer overrides on top of
 *     slot defaults.
 *   - `ComponentSchema.props[k].default` — from `editor-schema.ts`
 *     here: the cartridge's declared fallback when neither the slot
 *     nor the page-config provides a value.
 *
 * Two consumers exist within any studio that drives a schema-aware
 * editor:
 *
 *   1. The runtime renderer (rendering the cartridge view), which
 *      asks "what prop value does this component see right now?"
 *   2. The studio panel UI (editor), which asks the same thing to
 *      show the user the effective value + the source it resolved from.
 *
 * If those two callers implement the precedence rule independently,
 * they will drift — the panel will show one value and the renderer
 * will paint another, and the framework's "schema-driven editor"
 * story becomes fictional. Centralizing the rule here makes the
 * precedence a single source of truth.
 *
 * **Precedence (highest priority first)**:
 *
 *   visible:
 *     1. `page.componentSettings[componentId].visible`
 *     2. `slot.visible`
 *     3. `true` (default: components are visible unless told otherwise)
 *
 *   prop value:
 *     1. `page.componentSettings[componentId].props[propKey]`
 *     2. `slot.props[propKey]`
 *     3. `schema.props[propKey].default`
 *     4. `undefined` (when no schema entry exists for the key)
 *
 * **Scope**: these helpers resolve framework-defined precedence on
 * framework-owned schema. They do NOT execute cartridge-specific
 * computed logic (e.g., "show this prop only if the parent flag is on")
 * — that belongs to consumer code that wraps the resolved value.
 *
 * Both helpers are pure. No DOM, no event bus, no async.
 */

import type { ComponentSettings, Page, Slot } from '@airo-js/core';

import type { ComponentSchema } from './editor-schema.js';

/**
 * Walk `page.layout.regions` to find the slot whose `componentId`
 * matches. Pages encode multiple region buckets; we search all of
 * them in declared `regionOrder` so the first match wins (same order
 * the runtime paints).
 *
 * Returns `undefined` when no slot in the page references that
 * `componentId`. Callers (the resolvers below) treat that as "no slot
 * defaults available — fall through to schema."
 */
function findSlot<TPageType extends string>(
  page: Page<TPageType>,
  componentId: string,
): Slot | undefined {
  const regions = page.layout?.regions ?? {};
  const declaredOrder = page.layout?.regionOrder;
  // Empty `regionOrder` is treated the same as missing — "regions exist
  // but no order yet" should still search the regions rather than skip
  // them all (which would silently miss every slot and return the schema
  // default for every prop). Falls back to declaration order via
  // `Object.keys`.
  const order =
    declaredOrder && declaredOrder.length > 0 ? declaredOrder : Object.keys(regions);
  for (const regionId of order) {
    const region = regions[regionId];
    if (!region) continue;
    const slot = region.components.find((s) => s.componentId === componentId);
    if (slot) return slot;
  }
  return undefined;
}

/**
 * Resolve whether a component is visible on a given page, applying the
 * precedence rule documented at the top of this file.
 *
 * Default behavior: components are visible. Both `componentSettings`
 * and slot-level `visible` are explicit opt-outs — neither one set
 * means "show it." This matches the runtime's existing default at the
 * `PageManager.applyComponentStyles` call site (the renderer paints
 * components unless explicitly hidden).
 */
export function resolveComponentVisibility<TPageType extends string>(
  page: Page<TPageType>,
  componentId: string,
): boolean {
  const override = page.componentSettings?.[componentId]?.visible;
  if (typeof override === 'boolean') return override;
  const slot = findSlot(page, componentId);
  if (slot && typeof slot.visible === 'boolean') return slot.visible;
  return true;
}

/**
 * Resolve the effective value of a single prop on a component, applying
 * the precedence rule documented at the top of this file.
 *
 * Returns `undefined` when:
 *   - No `componentSettings` override exists for the prop, AND
 *   - No slot has a `props[propKey]` value, AND
 *   - The schema has no entry for `propKey` (or no `default`)
 *
 * Studios use `undefined` to render a "no value" indicator on the
 * inspector; renderers typically guard against it before painting
 * (or the cartridge declares a sensible `default` in its
 * `ComponentSchema` and renderers trust the resolved value).
 */
export function resolveComponentProp<TPageType extends string, TStyles = unknown>(
  page: Page<TPageType>,
  componentId: string,
  propKey: string,
  schema?: ComponentSchema<TStyles>,
): unknown {
  const settings: ComponentSettings | undefined =
    page.componentSettings?.[componentId];
  if (settings?.props && propKey in settings.props) {
    return settings.props[propKey];
  }
  const slot = findSlot(page, componentId);
  if (slot?.props && propKey in slot.props) {
    return slot.props[propKey];
  }
  return schema?.props?.[propKey]?.default;
}
