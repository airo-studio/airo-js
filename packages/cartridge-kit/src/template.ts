/**
 * Template — pre-composed (view-set, default config) bundle.
 *
 * Host apps render one card per template in the picker. The user picks
 * a template, the host app instantiates the cartridge's defaultConfig
 * with any template-specific overrides, and the framework builds the
 * AppConfig from `pages[]`. Maps cleanly to `@airo-js/core`'s `Page<T>`
 * shape — see AppConfig there.
 *
 * Templates configure pages + a config envelope; they don't carry data
 * shape — so the type parameter is only `TConfig`. Cartridges that need
 * the data shape thread it through via the `Cartridge<TData, TConfig>`
 * parent.
 */

import type { ComponentSettings, PageLayout } from '@airo-js/core';

/**
 * One entry in a template's page graph. The four structural fields
 * (`id` / `type` / `enabled` / optional `parent`) are required; the
 * richer per-page fields (`layout` / `props` / `styles` /
 * `componentSettings`) are optional carriers that round-trip through
 * `templateToAppConfig` onto `AppConfig.pages[]` so cartridge-authored
 * per-page defaults and host-authored per-instance overrides both reach
 * `ctx.page` (and the `resolveComponentProp` / `resolveComponentVisibility`
 * helpers that read it).
 *
 * The rich-field set widened in 0.8.0. Before that the helper dropped
 * the fields silently — see the 0.8.0 patch in `template-to-app-config.ts`
 * for the round-trip detail. Cartridges that only set the four
 * structural fields still produce the same empty-layout `AppConfig` they
 * did pre-0.8 (additive, non-breaking).
 *
 * Exported as a named type so consumers (notably
 * `@airo-js/embed`'s `LoadConfigResult.templatePages` per-widget
 * override) can reference the same shape without inlining a duplicate
 * literal that silently freezes when this type grows.
 *
 * Generic over `TPageType` so cartridges that narrow page types to an
 * enum keep the narrowing through `template.pages[]` → `AppConfig.pages[]`.
 * Defaults to `string` for backward compatibility — existing
 * `TemplatePage` references continue to resolve.
 */
export interface TemplatePage<TPageType extends string = string> {
  id: string;
  /** Matches a ViewDefinition.pageType. */
  type: TPageType;
  enabled: boolean;
  /** For subpages (e.g. quickview under products). */
  parent?: string;
  /**
   * Page-level layout (regions + region order + slot tree). When omitted,
   * `templateToAppConfig` substitutes `{ regionOrder: [], regions: {} }`.
   * Cartridges that use the region/slot system populate this directly.
   */
  layout?: PageLayout;
  /** Page-level prop bag exposed via `ctx.page.props`. */
  props?: Record<string, unknown>;
  /** Page-level inline styles applied via `applyPageStyles`. */
  styles?: Record<string, string | number>;
  /**
   * Per-component override map (visibility + props + styles), keyed by
   * `componentId`. The studio-editor write target: a host that exposes
   * a Component panel writes here and the runtime resolves precedence
   * via `resolveComponentProp` / `resolveComponentVisibility`.
   */
  componentSettings?: Record<string, ComponentSettings>;
}

export interface Template<TConfig, TPageType extends string = string> {
  id: string;
  displayName: string;
  description: string;

  /**
   * Pages this template instantiates. See `TemplatePage` for the entry
   * shape.
   */
  pages: TemplatePage<TPageType>[];

  defaultConfig: TConfig;
}
