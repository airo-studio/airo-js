/**
 * Server-side render of an App's entry page.
 *
 * `renderAppToHTML(config, deps)` produces an HTML string for the entry
 * page. No EventBus subscriptions are kept, no router is wired, no
 * listeners attached — the result is safe to inline in the host page's
 * initial HTML response.
 *
 * Document handling: the function uses a provided document if given,
 * otherwise falls back to `globalThis.document`. Server-side environments
 * (Edge Functions, Node) without a global document MUST pass one (e.g.
 * from linkedom or deno-dom).
 *
 * Security: state is NEVER serialised into the output. The client-side
 * `createApp({ hydrate: true })` recomputes everything from `(config,
 * appContext)` on hydrate. This removes the entire class of tampering
 * bugs that come from trusting a state blob round-tripped through the
 * host page.
 */

import {
  EventBus,
  resolveEntryPage,
  type AppConfig,
  type NavigationState,
  type PageRendererFactory,
  type RenderContext,
} from '@airo-js/core';
import { logger } from '@airo-js/log';

const log = logger('ssr');

export interface RenderToHTMLDeps<
  TPageType extends string = string,
  TAppContext = unknown,
> {
  /**
   * Optional Document to use for DOM construction. Defaults to
   * `globalThis.document`. Pass a document from `linkedom` (or deno-dom)
   * when running in environments without a global document.
   */
  document?: Document;
  /**
   * Page-renderer resolver. Same shape as `createApp.deps.resolveRenderer`.
   * Returns undefined when no factory is registered for the page type.
   */
  resolveRenderer: (
    pageType: TPageType,
  ) => PageRendererFactory<TPageType, TAppContext> | undefined;
  /** Predicate identifying gate pages (e.g. age verification). */
  isGatePage?: (pageType: TPageType) => boolean;
  /**
   * Mount-time navigation state. The runner derives the entry page
   * from `initialNavState.page` (validated: must exist, be enabled,
   * not be a subpage, not be a gate page; otherwise falls back to
   * the default entry). All other fields flow into `ctx.navState`
   * verbatim so the renderer reads context-specific keys.
   *
   * Typical pairing with `decodeNavHint`:
   *
   *   const initialNavState = decodeNavHint(req.query.nav, validPages);
   *   await renderAppToHTML(config, {
   *     ...,
   *     initialNavState,
   *   });
   *
   * Contract: state must be derivable on both server and client from
   * the same inputs (URL fragment, host-page config). Never a server-
   * preload bag — state is never serialised into the SSR HTML; the
   * client recomputes from the same `(config, snapshot, initialNavState)`
   * the server saw.
   */
  initialNavState?: Partial<NavigationState>;
  /** Opaque app-context the consumer hands through to the renderer. */
  appContext: TAppContext;
}

export interface RenderToHTMLResult {
  /** The serialised HTML of the rendered entry page. */
  html: string;
}

/**
 * Render the App's entry page to an HTML string.
 *
 * The renderer must implement `renderSSR()` — a renderer with only
 * `render()` would attach event listeners which can't be serialised.
 * Falls back to `render()` with a console.warn when SSR mode isn't
 * implemented; HTML still comes back, but the listeners attached during
 * render are orphaned (the host element is discarded after innerHTML
 * is read).
 */
export function renderAppToHTML<
  TPageType extends string = string,
  TAppContext = unknown,
>(
  config: AppConfig<TPageType>,
  deps: RenderToHTMLDeps<TPageType, TAppContext>,
): RenderToHTMLResult {
  const doc = deps.document ?? (globalThis as { document?: Document }).document;
  if (!doc) {
    throw new Error(
      '[@airo-js/ssr] renderAppToHTML: no Document available. Pass deps.document or run in an environment with a global document.',
    );
  }

  const isGate = deps.isGatePage ?? (() => false);
  // Entry resolution via the shared core helper — same gate-aware logic
  // PageManager uses, so SSR and CSR pick the same page for any given
  // `initialNavState.page`. Invalid / unknown / disabled / gate /
  // subpage ids fall back to the default entry — keeps SSR safe against
  // tampered or stale deeplinks.
  const entry = resolveEntryPage(
    config.pages,
    isGate,
    deps.initialNavState?.page,
  );
  if (!entry) {
    return { html: '' };
  }

  const factory = deps.resolveRenderer(entry.type);
  if (!factory) {
    throw new Error(
      `[@airo-js/ssr] renderAppToHTML: no renderer registered for page type "${entry.type}". Ensure the layout chunk is loaded before calling.`,
    );
  }

  const container = doc.createElement('div') as unknown as HTMLElement;
  // Pure pub/sub — no DOM dependency. Server-side it accepts subscriptions
  // that never fire; SSR renderers don't subscribe anyway.
  const events = new EventBus();
  const renderer = factory();

  const ctx: RenderContext<TPageType, TAppContext> = {
    page: entry,
    pages: config.pages,
    app: deps.appContext,
    events,
    // Spread order: initialNavState first (context fields like productId,
    // category, query params), then `page: entry.id` last so the
    // framework-validated entry id always wins against a tampered or
    // disagreeing `initialNavState.page`.
    navState: { ...(deps.initialNavState ?? {}), page: entry.id },
    navigate: () => undefined, // no-op server-side
  };

  if (typeof renderer.renderSSR === 'function') {
    renderer.renderSSR(container, ctx);
  } else {
    log.warn(
      `renderAppToHTML: renderer for "${entry.type}" doesn't implement renderSSR(). Falling back to render() — listeners attached will be orphaned.`,
      { pageType: entry.type, phase: 'ssr' },
    );
    renderer.render(container, ctx);
  }

  return { html: container.innerHTML };
}
