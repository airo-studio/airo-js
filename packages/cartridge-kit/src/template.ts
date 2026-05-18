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

/**
 * One entry in a template's page graph. Matches the subset of
 * `@airo-js/core`'s `Page<T>` that templates encode — `id` / `type` /
 * `enabled` / optional `parent`. The richer per-page fields
 * (`layout`, `styles`, `props`, `componentSettings`) get filled by the
 * cartridge's `defaultConfig` at mount time via `templateToAppConfig`.
 *
 * Exported as a named type so consumers (notably
 * `@airo-js/embed`'s `LoadConfigResult.templatePages` per-widget
 * override) can reference the same shape without inlining a duplicate
 * literal that silently freezes when this type grows.
 */
export interface TemplatePage {
  id: string;
  /** Matches a ViewDefinition.pageType. */
  type: string;
  enabled: boolean;
  /** For subpages (e.g. quickview under products). */
  parent?: string;
}

export interface Template<TConfig> {
  id: string;
  displayName: string;
  description: string;

  /**
   * Pages this template instantiates. See `TemplatePage` for the entry
   * shape.
   */
  pages: TemplatePage[];

  defaultConfig: TConfig;
}
