/**
 * defineSSRSafeRenderer — factory that builds an SSR-safe PageRenderer
 * from a pure template function and an optional hydrate handler.
 *
 * Why it exists: the v1 cartridge runtime taught us that the three
 * lifecycle methods (`render`, `renderSSR`, `hydrate`) must produce
 * byte-identical DOM or hydration mismatches (silent listener loss,
 * client-side re-paint flash). The factory derives all three from
 * ONE pure template + ONE optional hydrate handler:
 *
 *   - `render`     — paint the template, then run hydrate
 *   - `renderSSR`  — paint the template, skip hydrate (no listeners on server)
 *   - `hydrate`    — DOM already painted (SSR or host-injected light DOM);
 *                    run hydrate only — no template call, no re-paint
 *
 * Discipline by construction: drift between the three paths is structurally
 * impossible because they all consume the same `template` function. The
 * `hydrate` handler is the *only* place listeners attach, shared by the
 * CSR fresh-mount path and the SSR-hydrate path.
 *
 * Authoring rules:
 *   - `template(ctx)` MUST be a pure function of `ctx`. No DOM reads,
 *     no `Date.now()` / `Math.random()` / `crypto.randomUUID()` during
 *     render. Reproducibility is what makes hydration work.
 *   - `hydrate(root, ctx)` attaches listeners only. Don't read/write
 *     DOM structure here — the template is the source of truth.
 *   - Return a cleanup function from `hydrate` if listeners need
 *     manual removal on destroy. The factory tracks the cleanup and
 *     calls it on `destroy()`.
 *
 * Optional `applyNavState(root, next, previous, ctx)`: apply a same-page
 * navigation in place instead of being rendered again (see
 * `PageRenderer.applyNavState` in `@airo-js/core`). It is an option, not a
 * method to add to the factory output afterwards, because it needs the
 * root and the context the factory holds.
 *
 * What this factory doesn't cover (use the raw `PageRenderer` interface):
 *   - `activateSubpage` — for modal-/drawer-style subpages
 *   - `applyPageStyles` / `applyComponentStyles` — for live style edits
 *     from the studio panel
 *   Cartridges that need those can wrap the factory output and add the
 *   methods, or implement `PageRenderer` directly.
 */

import type {
  NavigationState,
  PageRenderer,
  PageRendererFactory,
  RenderContext,
} from '@airo-js/core';

/** Cleanup function returned by a hydrate handler; called on destroy(). */
export type HydrateCleanup = () => void;

export interface SSRSafeRendererOptions<
  TPageType extends string,
  TAppContext,
> {
  /**
   * Pure render — given the RenderContext, produce the HTML string.
   * Must be deterministic: same `ctx` → same output. No DOM mutation,
   * no global state reads, no side effects. Called on both server
   * (renderSSR) and client (render fresh-mount) paths — output is
   * expected to match byte-for-byte across environments.
   */
  template: (ctx: RenderContext<TPageType, TAppContext>) => string;

  /**
   * Event wiring — given the rendered DOM root and ctx, attach listeners.
   * Optional. Return a cleanup function or `void`. The cleanup runs on
   * `destroy()`.
   *
   * Runs on BOTH:
   *   - CSR fresh-mount path (after `template` paints the DOM)
   *   - SSR-hydrate path (against pre-existing DOM — same listeners,
   *     no re-paint)
   *
   * Listener-attachment code is shared by construction; no chance for
   * drift between CSR + hydrate paths.
   */
  hydrate?: (
    root: HTMLElement,
    ctx: RenderContext<TPageType, TAppContext>,
  ) => HydrateCleanup | void;

  /**
   * Apply a same-page navigation in place: `PageRenderer.applyNavState`
   * with the root this renderer painted or hydrated, and its live context.
   * Optional. Without it, the renderer has no `applyNavState` and every
   * context change renders the page again, as before.
   *
   * Return `true` when the DOM shows `next`; anything else renders the page
   * again from `template`. Called only after `render` or `hydrate`: before
   * either, or after `destroy`, the factory returns `false` without calling
   * it. During the call `ctx.navState` is still `previous`.
   *
   * Leave the DOM as `template` would paint it for `next`. A reload at the
   * new URL is rendered from `template`, on the server or the client, so a
   * view that applies `next` differently shows the shopper two pages for
   * one URL. Listeners attached by `hydrate` stay; it does not run again.
   *
   * On Back/Forward `next` is decoded from the URL: look its keys up in
   * your data, never write one into `root` as markup. This path skips the
   * template, and with it the template's escaping.
   */
  applyNavState?: ApplyNavStateHandler<TPageType, TAppContext>;
}

/**
 * The in-place navigation handler both renderer factories take
 * (`defineSSRSafeRenderer`, `defineHydrateOnlyRenderer`). Like the
 * `hydrate` handler, write it once and give the same function to both
 * halves of a view.
 */
export type ApplyNavStateHandler<TPageType extends string, TAppContext> = (
  root: HTMLElement,
  next: NavigationState,
  previous: NavigationState,
  ctx: RenderContext<TPageType, TAppContext>,
) => boolean;

/**
 * Build a `PageRendererFactory` that satisfies the SSR + hydrate
 * contract without the cartridge author writing three method bodies.
 *
 * Returned factory yields a fresh renderer instance on each call,
 * matching the framework's "one renderer per mount" lifetime.
 */
export function defineSSRSafeRenderer<
  TPageType extends string,
  TAppContext,
>(
  opts: SSRSafeRendererOptions<TPageType, TAppContext>,
): PageRendererFactory<TPageType, TAppContext> {
  return (): PageRenderer<TPageType, TAppContext> => {
    let cleanup: HydrateCleanup | void;
    // The root and context of the last client paint or hydrate, for
    // `applyNavState`. `renderSSR` never sets it: a server render is not
    // navigated.
    let mounted:
      | { root: HTMLElement; ctx: RenderContext<TPageType, TAppContext> }
      | undefined;
    const wireListeners = (
      root: HTMLElement,
      ctx: RenderContext<TPageType, TAppContext>,
    ): void => {
      mounted = { root, ctx };
      if (opts.hydrate) cleanup = opts.hydrate(root, ctx);
    };
    const applyNavState = opts.applyNavState;
    const renderer: PageRenderer<TPageType, TAppContext> = {
      render(targetEl, ctx) {
        targetEl.innerHTML = opts.template(ctx);
        wireListeners(targetEl, ctx);
      },
      renderSSR(targetEl, ctx) {
        // No listeners — SSR output is data only. Listeners go on at
        // hydrate-time on the client.
        targetEl.innerHTML = opts.template(ctx);
      },
      hydrate(targetEl, ctx) {
        // DOM already painted (by SSR HTML or host-injected light DOM);
        // calling `template` here would clobber existing listeners. Just
        // wire events against the existing tree.
        wireListeners(targetEl, ctx);
      },
      destroy() {
        if (typeof cleanup === 'function') cleanup();
        cleanup = undefined;
        mounted = undefined;
      },
    };
    // Only when the cartridge supplied one: a renderer without the method
    // is re-rendered on every context change, which is the default.
    if (applyNavState) {
      renderer.applyNavState = (next, previous) =>
        mounted !== undefined &&
        applyNavState(mounted.root, next, previous, mounted.ctx) === true;
    }
    return renderer;
  };
}
