/**
 * defineHydrateOnlyRenderer — the browser half of a view: its listeners,
 * without its template.
 *
 * ## The bytes this exists to remove
 *
 * `defineSSRSafeRenderer` takes `template` as a plain field and closes over
 * it, so every bundle that builds a view with it holds that template and
 * everything the template imports — the markup helpers, the UI components,
 * the copy. On a site whose pages are rendered by the server and only
 * hydrated in the browser, none of that code is ever called there:
 * `PageManager.hydrateEntry` calls `renderer.hydrate()` and never
 * `renderer.render()`.
 *
 * A consumer measured it on a real site: two-thirds of their entry bundle
 * was markup machinery that never ran, and chunking could not remove it,
 * because reaching `hydrate()` means resolving the view, which means
 * fetching the chunk the template sits in. The template has to be absent
 * from the browser's module graph, not merely deferred inside it.
 *
 * So: build the SERVER cartridge's views with `defineSSRSafeRenderer`, and
 * the BROWSER cartridge's views with this. Both sides import the same
 * `hydrate` handler, so the listeners cannot drift; only the server side
 * imports the template. This is the two-envelope pattern (best-practices
 * §2.5) applied to a view instead of to a cartridge.
 *
 *   // hydrate.ts — imported by both halves
 *   export function hydrateProduct(root: HTMLElement, ctx: Ctx) { … }
 *
 *   // cartridge.server.ts
 *   factory: defineSSRSafeRenderer({ template: productTemplate, hydrate: hydrateProduct })
 *
 *   // cartridge.browser.ts — no template import anywhere in its graph
 *   factory: defineHydrateOnlyRenderer({ hydrate: hydrateProduct })
 *
 * Declare `capabilities: ['hydrate-only']` on the browser view to say so in
 * the page graph.
 *
 * ## When a render is demanded anyway
 *
 * `render` and `renderSSR` throw, naming the page and what to do. They are
 * reachable only on paths a server-rendered page does not take:
 *
 *   - a `mode: 'csr'` mount (a host shell that paints from scratch),
 *   - a remount — `update()` / `updatePages()` outside `hotSwapKeys`, where
 *     the runtime repaints rather than hydrates,
 *   - a client-side navigation to another page,
 *   - a navigation that stays on this page but changes its context
 *     (`ctx.navigate({ item })`, or Back to such an entry) and that
 *     `applyNavState` did not take,
 *   - a view whose SSR was skipped (`capabilities: ['csr-only']`),
 *   - this cartridge handed to the SSR runner by mistake (`renderSSR`).
 *
 * If your site takes one of those paths, that page needs a real renderer in
 * the browser: give it `defineSSRSafeRenderer` here too, or leave it out of
 * `views[]` and load it on demand through `resolveView` / the chunk mailbox.
 * Throwing is deliberate — the alternative is a page that silently paints
 * nothing.
 *
 * The same-page case has a third answer: `applyNavState`, the same option
 * `defineSSRSafeRenderer` takes. A view that changes in place (a carousel,
 * a variant picker) applies the new state to the markup it hydrated, and is
 * never rendered. Share the handler between the two halves, as for
 * `hydrate`.
 */

import type {
  PageRenderer,
  PageRendererFactory,
  RenderContext,
} from '@airo-js/core';

import type { ApplyNavStateHandler, HydrateCleanup } from './define-ssr-safe-renderer.js';

export interface HydrateOnlyRendererOptions<
  TPageType extends string,
  TAppContext,
> {
  /**
   * Attach listeners to markup that is already on the page. Same handler,
   * same signature, as `SSRSafeRendererOptions.hydrate` — share one function
   * between the two halves rather than writing it twice. Return a cleanup
   * and it runs on `destroy()`.
   */
  hydrate: (
    root: HTMLElement,
    ctx: RenderContext<TPageType, TAppContext>,
  ) => HydrateCleanup | void;

  /**
   * Apply a same-page navigation to the hydrated markup in place. Same
   * handler, same contract, as `SSRSafeRendererOptions.applyNavState`.
   * Optional, but on a hydrate-only view it is the only way to take such a
   * navigation: without it, or when it returns anything but `true`, the
   * page is rendered again, and `render` here throws.
   */
  applyNavState?: ApplyNavStateHandler<TPageType, TAppContext>;
}

/**
 * One short message, because it ships in every browser bundle that uses
 * this factory — the long version, with the table of paths that reach it
 * and what to do about each, is best-practices §5.4a. It names the page,
 * the method and the package, which is what a stack trace in a stranger's
 * app needs.
 */
function refuse(
  method: 'render' | 'renderSSR',
  ctx: RenderContext<string, unknown>,
): never {
  throw new Error(
    `[@airo-js/cartridge-kit] ${method}() on a hydrate-only view: page "${ctx.page.id}" (pageType "${ctx.page.type}") holds listeners, not a template. Give it a full renderer here, or load one through resolveView. See best-practices §5.4a.`,
  );
}

/**
 * Build a `PageRendererFactory` that can hydrate server-rendered markup and
 * nothing else. A fresh renderer per call, like `defineSSRSafeRenderer`.
 */
export function defineHydrateOnlyRenderer<
  TPageType extends string,
  TAppContext,
>(
  opts: HydrateOnlyRendererOptions<TPageType, TAppContext>,
): PageRendererFactory<TPageType, TAppContext> {
  return (): PageRenderer<TPageType, TAppContext> => {
    let cleanup: HydrateCleanup | void;
    // The root and context `hydrate` was given, for `applyNavState`.
    let mounted:
      | { root: HTMLElement; ctx: RenderContext<TPageType, TAppContext> }
      | undefined;
    const applyNavState = opts.applyNavState;
    const renderer: PageRenderer<TPageType, TAppContext> = {
      render(_targetEl, ctx) {
        refuse('render', ctx as RenderContext<string, unknown>);
      },
      renderSSR(_targetEl, ctx) {
        refuse('renderSSR', ctx as RenderContext<string, unknown>);
      },
      hydrate(targetEl, ctx) {
        mounted = { root: targetEl, ctx };
        cleanup = opts.hydrate(targetEl, ctx);
      },
      destroy() {
        if (typeof cleanup === 'function') cleanup();
        cleanup = undefined;
        mounted = undefined;
      },
    };
    if (applyNavState) {
      renderer.applyNavState = (next, previous) =>
        mounted !== undefined &&
        applyNavState(mounted.root, next, previous, mounted.ctx) === true;
    }
    return renderer;
  };
}
