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
 * What this factory doesn't cover (use the raw `PageRenderer` interface):
 *   - `activateSubpage` — for modal-/drawer-style subpages
 *   - `applyPageStyles` / `applyComponentStyles` — for live style edits
 *     from the studio panel
 *   Cartridges that need those can wrap the factory output and add the
 *   methods, or implement `PageRenderer` directly.
 */

import type {
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
}

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
    let cleanup: HydrateCleanup | void = undefined;
    const wireListeners = (
      root: HTMLElement,
      ctx: RenderContext<TPageType, TAppContext>,
    ): void => {
      if (opts.hydrate) cleanup = opts.hydrate(root, ctx);
    };
    return {
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
      },
    };
  };
}
