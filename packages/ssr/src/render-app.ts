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
  type AppConfig,
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
   * Override the entry page selection. When supplied AND the page
   * exists / is enabled / isn't a gate, the runner renders this page
   * instead of finding the first enabled non-parent. Pair with
   * `decodeNavHint` from `@airo-js/core` for deep-link SSR.
   *
   * Invalid / unknown / disabled entryPageId falls back to the
   * default entry selection — keeps SSR safe against tampered or
   * stale deeplinks.
   */
  entryPageId?: string;
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
  // entryPageId override (deeplink target). Validated to be present +
  // enabled + non-parent + non-gate; falls back to the default entry
  // on any mismatch so a stale/tampered URL never crashes the runner.
  const requestedEntry = deps.entryPageId
    ? config.pages.find(
        (p) => p.id === deps.entryPageId && p.enabled && !p.parent && !isGate(p.type),
      )
    : undefined;
  const entry =
    requestedEntry ??
    config.pages.find((p) => p.enabled && !p.parent && !isGate(p.type));
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
    app: deps.appContext,
    events,
    navState: { page: entry.id },
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
