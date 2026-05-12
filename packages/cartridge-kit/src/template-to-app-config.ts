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
 * Empty-layout placeholder: each translated page gets
 * `layout: { regionOrder: [], regions: {} }` because `Template`'s page
 * entries are a subset of `Page<T>` (id / type / enabled / parent only)
 * — the framework's region/slot layout shape isn't carried on the
 * template. Page renderers paint into `RenderContext.targetEl` directly;
 * the empty layout is correct for that path.
 *
 * Cartridges that use the region/slot system populate `Page.layout` on
 * their template entries via a richer downstream type and skip this
 * helper — they build `AppConfig` themselves with the populated layout.
 */

import type { AppConfig } from '@airo-js/core';

import type { Template } from './template.js';

/**
 * Build an `AppConfig` from a `Template`. Maps `template.pages` →
 * `appConfig.pages` 1:1, populates `appId`, and fills each page's
 * `layout` with an empty placeholder. Preserves the `TConfig` generic
 * on input (for typecheck symmetry with the cartridge) and the
 * `TPageType` narrow on output (for downstream renderer dispatch).
 */
export function templateToAppConfig<TConfig, TPageType extends string = string>(
  template: Template<TConfig>,
  appId: string,
): AppConfig<TPageType> {
  return {
    appId,
    pages: template.pages.map((p) => ({
      id: p.id,
      type: p.type as TPageType,
      enabled: p.enabled,
      parent: p.parent,
      layout: { regionOrder: [], regions: {} },
    })),
  };
}
