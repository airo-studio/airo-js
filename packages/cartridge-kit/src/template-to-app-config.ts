/**
 * templateToAppConfig — translate a `Template<TConfig>` into the
 * `AppConfig<TPageType>` shape the framework consumes.
 *
 * The same translation `mountCartridge` does internally, exported so
 * server-side SSR callers (`renderAppWithPublication`, `renderAppToHTML`)
 * can build the SAME `AppConfig` from the SAME `Template` without
 * re-implementing the mapping. Single source of truth.
 *
 *   import { templateToAppConfig } from '@airo-js/cartridge-kit';
 *   import { renderAppWithPublication } from '@airo-js/ssr';
 *
 *   const appConfig = templateToAppConfig(template, widgetId);
 *   const result = await renderAppWithPublication({
 *     cartridge,
 *     appConfig,
 *     snapshot,
 *     publicationCtx,
 *   });
 *
 * Round-tripped fields: structural (`id` / `type` / `enabled` /
 * `parent`) plus the optional rich-field set (`layout` / `props` /
 * `styles` / `componentSettings`) widened on `TemplatePage` in 0.8.0.
 * Cartridges that omit the rich fields still produce the same empty-
 * layout `AppConfig.pages[]` they did pre-0.8 — page renderers that
 * paint into `RenderContext.targetEl` directly continue working with
 * `layout: { regionOrder: [], regions: {} }` as the default.
 *
 * The 0.8.0 widening closed a contract gap: pre-0.8 the helper
 * hard-coded the four-field subset, so `page.componentSettings` was
 * `undefined` on every page reaching the runtime and
 * `resolveComponentProp` fell through to schema defaults regardless of
 * what the host had written. Hosts that drive a per-page editor (prop /
 * visibility / style overrides) now thread the overrides through
 * `template.pages[i].componentSettings` and the runtime sees them.
 */

import type { AppConfig } from '@airo-js/core';

import type { Template } from './template.js';

/**
 * Build an `AppConfig` from a `Template`. Maps `template.pages` →
 * `appConfig.pages` 1:1, populates `appId`, and round-trips every
 * `TemplatePage` field — structural (`id` / `type` / `enabled` /
 * `parent`) plus the optional rich-field set (`layout` / `props` /
 * `styles` / `componentSettings`) widened in 0.8.0. `layout` falls back
 * to `{ regionOrder: [], regions: {} }` when the template entry omits
 * it, matching pre-0.8 behaviour for cartridges that paint via
 * `RenderContext.targetEl` directly rather than the region/slot system.
 *
 * Preserves the `TConfig` generic on input (for typecheck symmetry with
 * the cartridge) and the `TPageType` narrow on output (for downstream
 * renderer dispatch).
 *
 * The rich fields are the only path that lands `componentSettings` on
 * `ctx.page` — `mountCartridge` and the SSR runners both translate via
 * this helper. Anything dropped here disappears from the runtime's
 * `Page<T>` view and `resolveComponentProp` will fall through to schema
 * defaults. Add fields to the round-trip when widening `TemplatePage`.
 */
export function templateToAppConfig<TConfig, TPageType extends string = string>(
  template: Template<TConfig, TPageType>,
  appId: string,
): AppConfig<TPageType> {
  return {
    appId,
    pages: template.pages.map((p) => {
      const page: AppConfig<TPageType>['pages'][number] = {
        id: p.id,
        type: p.type as TPageType,
        enabled: p.enabled,
        layout: p.layout ?? { regionOrder: [], regions: {} },
      };
      if (p.parent !== undefined) page.parent = p.parent;
      if (p.props !== undefined) page.props = p.props;
      if (p.styles !== undefined) page.styles = p.styles;
      if (p.componentSettings !== undefined) {
        page.componentSettings = p.componentSettings;
      }
      return page;
    }),
  };
}
