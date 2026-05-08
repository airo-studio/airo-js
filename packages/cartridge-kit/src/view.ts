/**
 * ViewDefinition — cartridge-shaped wrapper around the framework's
 * existing PageRenderer. The host app uses the metadata for the template
 * picker; the framework uses the factory at render time.
 *
 * The view's `pageType` matches `Page.type` — what the framework dispatches
 * on. Multiple views can share a `pageType` (e.g. two product-grid layouts);
 * the cartridge picks which factory wins via its template.
 */

import type { PageRendererFactory } from '@airo-js/core';

/**
 * The shape `RenderContext.app` carries in a cartridge-aware host app.
 * This is THE consumer-side constraint the cartridge contract adds:
 * when a cartridge view renders, `app` is `CartridgeAppContext` (config +
 * post-transformer data + cartridge id), not arbitrary.
 */
export interface CartridgeAppContext<TData, TConfig> {
  cartridgeId: string;
  config: TConfig;
  /** POST-transformer — same data MCP tools and publication adapters see. */
  data: TData;
}

export interface ViewDefinition<TData, TConfig> {
  id: string;
  displayName: string;
  /** Matches Page.type — what the framework dispatches on. */
  pageType: string;

  /**
   * PageRendererFactory from @airo-js/core — unchanged from the framework's
   * existing contract. Cartridge views are PageRenderers with the typed
   * `RenderContext.app` constraint above.
   */
  factory: PageRendererFactory<string, CartridgeAppContext<TData, TConfig>>;

  /** Host-app template picker affordance. Optional. */
  preview?: { thumbnail: string; description: string };

  /** Capabilities the host app cares about for filtering / SSR routing. */
  capabilities?: ('responsive' | 'ssr-safe' | 'hydratable' | 'csr-only')[];
}
