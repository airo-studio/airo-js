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

export interface Template<TConfig> {
  id: string;
  displayName: string;
  description: string;

  /**
   * Pages this template instantiates. Shape matches `@airo-js/core`'s `Page<T>`
   * (subset — full layout/styles get filled by the cartridge's defaultConfig).
   */
  pages: Array<{
    id: string;
    /** Matches a ViewDefinition.pageType. */
    type: string;
    enabled: boolean;
    /** For subpages (e.g. quickview under products). */
    parent?: string;
  }>;

  defaultConfig: TConfig;
}
