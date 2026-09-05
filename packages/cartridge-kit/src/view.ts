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

  /**
   * Optional raw CSS string the view declares for its own markup. The
   * cartridge author scopes selectors to their own BEM classes (no
   * leaking into the host).
   *
   * **The framework never injects it.** Declaring `stylesheet` styles
   * nothing on its own — it is metadata the HOST collects and inlines.
   * The framework is headless: it owns the shadow-boundary mechanism and
   * authors zero CSS, so every rule that lands inside the boundary comes
   * from the cartridge by way of the host. Client mount: read this and
   * inject into `resolveStyleRoot(host)` (`@airo-js/core`), which returns
   * the shadow root or the light-DOM root as the isolation mode requires.
   * String-building SSR: collect `cartridge.views[].stylesheet` and pass
   * the concatenation to `renderDocument`'s `head.inlineStyles`.
   *
   * NOTE the SSR path is document-scoped, so those styles do NOT cross a
   * shadow boundary — a view rendered into declarative shadow DOM needs
   * its CSS inside the template, not in `<head>`.
   *
   * Use design-token CSS custom properties (`--airo-*`) so host apps can
   * theme by overriding tokens at the document root. Cartridges that
   * embed Shadow DOM internally don't need this — Lit elements ship
   * their own styles via `static styles`. This field is for cartridges
   * whose View emits regular Light DOM HTML (the common case for
   * SSR-friendly content cartridges).
   */
  stylesheet?: string;
}
