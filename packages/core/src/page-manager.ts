/**
 * PageManager — the Mediator at the framework's core.
 *
 * Owns navigation state and is the only module that talks to: the renderer
 * registry (resolve), the active renderer (mount/destroy), the router
 * (push/parse), and the event bus (emit navigation:changed). Every other
 * module talks to PageManager, never to its peers.
 *
 * Headless: PageManager never paints DOM beyond delegating to the active
 * renderer. Anything visual (breadcrumbs, chrome) subscribes to events on
 * the bus and renders itself.
 *
 * **Emits:**
 *   - `'navigation:changed'` — payload: `NavigationState`. Fires after
 *     every successful `navigate()` and `hydrateEntry()`. Subscribe for
 *     breadcrumbs, chrome, analytics.
 *   - `'renderer:missing'` — payload:
 *     `{ pageType: string; pageId: string; phase: 'navigate' | 'hydrate' }`.
 *     Fires when `resolveRenderer(pageType)` returns `undefined` and
 *     PageManager soft-fails the paint (warns + returns without rendering).
 *     Studios that lazy-load page chunks subscribe to this to render a
 *     skeleton / spinner / "loading…" UI while the chunk fetch is in
 *     flight, then re-navigate to the page once `pushToMailbox` registers
 *     the factory. The event fires once per missing-resolve attempt; it
 *     does NOT retry on its own.
 *
 * Generic over `TPageType` (a string narrowing — domain apps narrow this
 * to their own enum) and over `TAppContext` (the opaque bag of app-level
 * data the renderers receive).
 */

import { logger } from '@airo-js/log';

import type { Page, PageId } from './schema.js';
import type {
  NavigateOptions,
  NavigationState,
  PageRenderer,
  PageRendererFactory,
  RenderContext,
  SubpageActivation,
  UpdateResult,
} from './page.js';
import type { IEventBus } from './events.js';
import type { IRouter, RouteState, RouterOption } from './router.js';
import { findEntryPage, resolveEntryPage } from './entry-resolution.js';
import type { NavDefaults } from './mount-entry.js';
import { createRouter, resolveMountEntry, validPagesFor, withNavDefaults } from './mount-entry.js';

const log = logger('core');

/**
 * How many queued navigations one top-level call applies before it gives
 * up. Each one may render, and a render may queue another; a renderer that
 * navigates to a new state on every render would otherwise never stop.
 */
const MAX_DEFERRED_NAVIGATIONS = 16;

/** How a navigation is written to the router. `'none'` when the router started it. */
type RouterWrite = 'push' | 'replace' | 'none';

// Entry resolution lives in `./entry-resolution.ts` (0.11.0) so the mount
// ladder in `./mount-entry.ts` can share it without a module cycle; the
// package barrel exports it from there.

/**
 * Post-render side-effect hook. Receives the three things only PageManager
 * holds — the live container, the current nav state, and the event bus —
 * and returns an optional teardown.
 *
 * Deliberately NOT generic over cartridge data: this is the mechanism half
 * of the seam. The caller closes over whatever else it needs.
 */
export type PostRenderHook = (ctx: {
  container: HTMLElement;
  navState: NavigationState;
  events: IEventBus;
}) => (() => void) | void;

export interface PageManagerOptions<
  TPageType extends string = string,
  TAppContext = unknown,
> {
  /** The element renderers paint into. Provided by the App shell. */
  container: HTMLElement;
  pages: Page<TPageType>[];
  events: IEventBus;
  /** Opaque app-context bag passed through to every renderer. */
  appContext: TAppContext;
  /**
   * Resolve a renderer factory by page type. Returns undefined when the
   * matching chunk hasn't loaded yet — caller can re-navigate after the
   * chunk registers.
   */
  resolveRenderer: (
    pageType: TPageType,
  ) => PageRendererFactory<TPageType, TAppContext> | undefined;
  /**
   * Predicate identifying pages that should NOT be treated as the entry
   * (e.g. an age-gate page type). Defaults to "no page is a gate".
   */
  isGatePage?: (pageType: TPageType) => boolean;
  /**
   * URL routing strategy. Three forms:
   *   `false` (default) — no router; widget runs in memory only.
   *   `true`            — back-compat alias for `{ mode: 'hash' }`.
   *   `{ mode: 'hash' }`         — HashRouter (`#fragment`); embed-friendly.
   *   `{ mode: 'path', basePath: string }` — PathRouter; widgets that own
   *                                          the URL space (Campaign Pages).
   *
   * See `RouterOption` in `./router.ts` for the full discriminated union.
   */
  enableRouter?: RouterOption;
  /**
   * Mount-time navigation state. The host (or `decodeNavHint`) supplies
   * this; PageManager seeds `#navState` with it BEFORE the router parses
   * the URL. Precedence ladder: URL > `initialNavState` > default entry.
   *
   * Three legitimate sources:
   *   - URL-derived (`decodeNavHint(hint, validPages)` on the server-side
   *     SSR path, the existing PathRouter/HashRouter on the client).
   *   - Host-page programmatic (popup picker, product-page commerce button).
   *   - Future (postMessage from parent frame, storage rehydration).
   *
   * Contract: derivable on BOTH server and client from the same inputs.
   * Never a "server preload bag" — state is recomputed client-side, never
   * serialised into SSR HTML.
   */
  initialNavState?: Partial<NavigationState>;
  /**
   * The value each listed context key holds whenever nothing names it,
   * kept out of the URL while the key holds that value. For state the host
   * derives rather than the visitor chooses, such as a region from the
   * visitor's location: seeded through `initialNavState` it is written
   * into every URL, so a shared link carries the sharer's region and
   * overrides the recipient's. Listed here, the URL carries it only once
   * the visitor changes it.
   *
   * - Mount: fills keys the URL and `initialNavState` leave empty.
   * - Back/Forward: an entry that does not name the key restores its
   *   default.
   * - `navigate({ key: '' })` restores the default too: a key listed here
   *   always has a value.
   *
   * `page` is ignored; the entry page is the default page. A server render
   * gets the same state by laying these under `initialNavState`.
   */
  navDefaults?: NavDefaults;
  /**
   * Host-supplied live config-delta dispatcher (forwarded from
   * `AppDeps.hostUpdate`). When set, every `RenderContext` built by
   * `#swapRenderer` / `hydrateEntry` includes `ctx.update` wired to
   * this function. Renderers fire delta updates from listeners
   * without holding the host's mount handle.
   *
   * Type-loose by design — `RenderContext` is generic over
   * `TAppContext` but not over the cartridge's `TConfig`, so the
   * delta shape stays `Record<string, unknown>` at this layer.
   * Cartridge consumers narrow via `CartridgeRenderContext` from
   * `@airo-js/cartridge-kit`.
   */
  hostUpdate?: (delta: Record<string, unknown>) => Promise<UpdateResult>;
  /**
   * Side-effect hook invoked after EVERY successful render — fresh mount,
   * navigation swap, hydrate, and appContext re-render alike. Returns an
   * optional teardown, which PageManager fires before the next render and
   * on `destroy()`.
   *
   * Pure mechanism: PageManager knows nothing about pipelines or
   * cartridges. `@airo-js/runtime` supplies a closure that forwards to
   * `RuntimePipeline.runPostProcessors`, adding the `config` and `data`
   * halves of `PostProcessorContext` that only it holds.
   *
   * Per RENDER, not per mount, because that is the only cadence a
   * DOM-owning hook can be written against: a swap or a re-render
   * destroys the subtree the previous invocation decorated, so a
   * mount-scoped hook silently stops applying the moment anyone
   * navigates. Teardown fires BEFORE the DOM it owns is torn down, so a
   * hook can observe its own nodes while unwinding.
   */
  postRender?: PostRenderHook;
}

export class PageManager<
  TPageType extends string = string,
  TAppContext = unknown,
> {
  // Every member below is `#private`, not TypeScript `private` (core
  // 0.11.3). A minifier may shorten a `#name` but must keep a property name
  // whole, and this class is on the path every mount pays for: the switch
  // took about 165 B gzip off core for builds at es2022 or modern browser
  // targets. A build that lowers to es2020 turns each field into helper code
  // and pays about 270 B instead, so target es2022 or later. Keep new members
  // `#private` for the same reason.
  readonly #opts: PageManagerOptions<TPageType, TAppContext>;
  readonly #isGatePage: (pageType: TPageType) => boolean;
  /**
   * The active page graph. Mirrors `opts.pages` at construction time so
   * `replacePages` can swap the reference without forcing every read site
   * back through `#opts`. The runtime's `MountCartridgeResult.updatePages()`
   * drives this — hot-swapping per-page state (componentSettings / styles /
   * slot props) without a full mount cycle.
   */
  #pages: Page<TPageType>[];
  #navState: NavigationState;
  #appContext: TAppContext;
  #activeRenderer: PageRenderer<TPageType, TAppContext> | null = null;
  #activeRendererPageId: PageId | null = null;
  /**
   * The `RenderContext` the active renderer was handed. An in-place apply
   * (`applyNavState` returned `true`) sets its `navState`, so the renderer
   * reads the state it is now showing.
   */
  #activeCtx: RenderContext<TPageType, TAppContext> | null = null;
  #router: IRouter | null = null;
  /**
   * Renderer calls in progress: `render`, `hydrate`, `applyNavState`. A
   * `navigate` requested inside one is a redirect, so it defaults to
   * `history: 'replace'` (see `navigate`).
   */
  #rendererCallDepth = 0;
  /**
   * Navigations in progress (`#runNavigation`). A `navigate` requested
   * while this is above zero, from a renderer, a subpage activation, a
   * `postRender` hook or a `navigation:changed` listener, is queued in
   * `#deferred` and applied in order once the current one completes.
   * Applying it re-entrantly ran before `#activeRendererPageId` was
   * recorded, so a renderer that navigated to its own page from `render`
   * was rendered again without bound, and a later request could be
   * overtaken by an earlier queued one.
   */
  #navigationDepth = 0;
  /**
   * Queued navigations. `state` is copied when queued, so a caller that
   * reuses or mutates its object does not change what runs. `history:
   * 'none'` marks a router-driven entry, which replaces the state instead
   * of merging into it.
   */
  #deferred: Array<{ state: Partial<NavigationState>; history: RouterWrite }> = [];
  #draining = false;
  #destroyed = false;
  /**
   * The last render or hydrate found no renderer for its page type: the
   * page is waiting for its chunk, and `'renderer:missing'` has gone out
   * for it. The router's echo of that navigation must not ask again (see
   * `onRouterNavigate`); the recovery that follows the chunk paints it.
   */
  #awaitingChunk = false;
  /** Teardown returned by the most recent `postRender` invocation, if any. */
  #postRenderTeardown: (() => void) | null = null;

  constructor(opts: PageManagerOptions<TPageType, TAppContext>) {
    this.#opts = opts;
    this.#pages = opts.pages;
    this.#appContext = opts.appContext;
    this.#isGatePage = opts.isGatePage ?? (() => false);
    // Seed precedence: default entry → host-supplied initialNavState → URL
    // state. Last write wins, so URL beats host config beats default —
    // matches the v3 contract. One implementation (`resolveMountEntry`),
    // shared with the runtime's gate phase, so the page the gates were
    // scoped against is the page that mounts.
    this.#navState = resolveMountEntry({
      pages: this.#pages,
      isGatePage: this.#isGatePage,
      enableRouter: opts.enableRouter,
      initialNavState: opts.initialNavState,
      navDefaults: opts.navDefaults,
    }).navState;

    if (opts.enableRouter) {
      this.#initRouter();
    }
  }

  /**
   * Unwind the previous post-render effects. Idempotent — safe to call at
   * every point a render is about to be replaced, and again from
   * `destroy()`. Throwing teardowns are logged and swallowed: a hook that
   * fails while unwinding must not abort the render that follows it.
   */
  #firePostRenderTeardown(): void {
    const teardown = this.#postRenderTeardown;
    if (!teardown) return;
    this.#postRenderTeardown = null;
    try {
      teardown();
    } catch (err) {
      log.error('postRender teardown threw; continuing.', err, {
        phase: 'post-render-teardown',
      });
    }
  }

  /**
   * Run the post-render hook for the render that just completed. Called
   * from every path that puts a renderer on screen.
   *
   * A throwing hook is logged and swallowed — post-render effects are
   * decoration (analytics, ARIA live regions, focus, scroll). Letting one
   * escape would unwind a render that already succeeded and leave the DOM
   * on screen with `#activeRenderer` bookkeeping half-applied.
   */
  #runPostRender(): void {
    if (!this.#opts.postRender) return;
    this.#firePostRenderTeardown();
    try {
      const teardown = this.#opts.postRender({
        container: this.#opts.container,
        navState: this.#navState,
        events: this.#opts.events,
      });
      this.#postRenderTeardown = typeof teardown === 'function' ? teardown : null;
    } catch (err) {
      log.error('postRender hook threw; render is unaffected.', err, {
        phase: 'post-render',
      });
      this.#postRenderTeardown = null;
    }
  }

  getNavigationState(): NavigationState {
    return { ...this.#navState };
  }

  setNavigationState(state: NavigationState): void {
    this.navigate(state);
  }

  /**
   * Command pattern entry point for programmatic navigation: a click
   * handler (`ctx.navigate`), the host (`app.navigate`), postMessage. The
   * state is merged over the current state, so callers pass only what
   * changes. Updates state, swaps or re-renders the renderer (or lets it
   * apply the change in place, see `PageRenderer.applyNavState`), writes
   * the URL, fires the event.
   *
   * Back/Forward does not come through here: a history entry is the whole
   * state, so the router path replaces rather than merges (`#initRouter`).
   *
   * Called while another navigation is in progress (from a renderer, a
   * subpage activation, a `postRender` hook or a `navigation:changed`
   * listener), the navigation is queued and applied once that one
   * completes, in the order requested, through this same path. One
   * requested from inside `render`, `hydrate` or `applyNavState` is a
   * redirect, so its default history write is `'replace'`: the entry the
   * render was for is rewritten rather than left behind for Back to
   * return to and redirect again.
   */
  navigate(state: Partial<NavigationState>, opts?: NavigateOptions): void {
    if (this.#destroyed) return;
    if (this.#navigationDepth > 0) {
      this.#deferred.push({
        state: { ...state },
        history: opts?.history ?? (this.#rendererCallDepth > 0 ? 'replace' : 'push'),
      });
      log.debug('navigate: queued', { phase: 'navigate' });
      return;
    }
    const history = opts?.history ?? 'push';
    this.#runNavigation(() => this.#applyNavigation({ ...this.#navState, ...state }, history));
  }

  /**
   * One navigation step. If it throws, what was queued is dropped: a
   * navigation requested by a step that failed must not be applied after
   * an unrelated later one.
   */
  #step(run: () => void): void {
    this.#navigationDepth++;
    try {
      run();
    } catch (err) {
      this.#deferred.length = 0;
      throw err;
    } finally {
      this.#navigationDepth--;
    }
  }

  /**
   * Run one top-level navigation, then apply what was queued during it, in
   * order. Each queued navigation is a step of its own, so what it queues
   * runs after it. Bounded: see `MAX_DEFERRED_NAVIGATIONS`.
   */
  #runNavigation(run: () => void): void {
    this.#step(run);
    if (this.#draining || this.#navigationDepth > 0) return;
    this.#draining = true;
    try {
      for (let n = 0; this.#deferred.length > 0 && !this.#destroyed; n++) {
        if (n === MAX_DEFERRED_NAVIGATIONS) {
          // A renderer that navigates to a new state on every render.
          log.error(`navigate: ${n} queued in a row; dropping the rest`, undefined, {
            phase: 'navigate',
          });
          this.#deferred.length = 0;
          break;
        }
        const { state, history } = this.#deferred.shift()!;
        this.#step(() =>
          this.#applyNavigation(
            (history === 'none' ? state : { ...this.#navState, ...state }) as NavigationState,
            history,
          ),
        );
      }
    } finally {
      this.#draining = false;
    }
  }

  /**
   * Resolve `next` to a page and put it on screen. Shared by programmatic
   * navigation (merged state) and the router (replaced state); `history`
   * says whether and how to write the URL.
   */
  #applyNavigation(next: NavigationState, history: RouterWrite): void {
    next = withNavDefaults(next, this.#opts.navDefaults);
    let targetPage = next.page
      ? this.#pages.find((p) => p.id === next.page)
      : undefined;

    if (next.page && !targetPage) {
      log.warn(`navigate: unknown page "${next.page}"; showing the entry page`, {
        pageId: next.page,
        phase: 'navigate',
      });
    }

    if (!targetPage?.enabled || this.#isGatePage(targetPage.type)) {
      const entry = findEntryPage(this.#pages, this.#isGatePage);
      if (!entry) return;
      targetPage = entry;
      next.page = entry.id;
    }

    if (targetPage.parent) {
      const parent = this.#pages.find((p) => p.id === targetPage!.parent);
      if (!parent) return;
      if (parent.id !== this.#activeRendererPageId) {
        this.#applyNavigation({ ...next, page: parent.id }, history);
      } else {
        this.#navState = next;
      }
      const subpage: SubpageActivation<TPageType> = {
        type: targetPage.type,
        id: targetPage.id,
        parent: parent.id,
        page: targetPage,
        ...this.#contextOnly(next),
      };
      this.#activeRenderer?.activateSubpage?.(subpage);
      log.debug(`navigation: subpage "${targetPage.id}" on "${parent.id}" (subpage)`, {
        pageId: targetPage.id,
        pageType: targetPage.type,
        phase: 'subpage',
      });
      this.#opts.events.emit('navigation:changed', this.#navState);
      return;
    }

    const anchor = targetPage;
    const samePage = anchor.id === this.#activeRendererPageId;
    const sameContext = this.#contextEqual(this.#navState, next);

    const previous = this.#navState;
    this.#navState = next;

    let inPlace = false;
    if (!samePage) {
      this.#swapRenderer(anchor);
    } else if (!sameContext && this.#activeRenderer) {
      inPlace = this.#applyInPlace(this.#activeRenderer, previous);
      // swapRenderer unwinds post-render effects, then destroys the
      // active renderer, in that order.
      if (!inPlace) this.#swapRenderer(anchor);
    }

    if (this.#router && history !== 'none') {
      try {
        this.#router[history](this.#urlState());
      } catch (err) {
        log.warn(`PageManager router.${history} failed`, { err, phase: 'router' });
      }
    }

    // Navigation narration (0.8.8): the trigger kind is the one thing
    // the `navigation:changed` bus payload doesn't carry.
    log.debug(`navigation: page "${anchor.id}" (${inPlace ? 'in place' : 'navigate'})`, {
      pageId: anchor.id,
      pageType: anchor.type,
      phase: 'navigate',
    });
    this.#opts.events.emit('navigation:changed', this.#navState);
  }

  showSubpage(subpage: SubpageActivation<TPageType>): void {
    if (this.#destroyed) return;
    this.#runNavigation(() => this.#activeRenderer?.activateSubpage?.(subpage));
  }

  /**
   * Mount the initial page based on current `#navState` + page config.
   *
   * This is the single entry-resolution site for the App. Reads from
   * `this.#navState.page` (URL-decoded, host-supplied, or default-seeded
   * at construction), validates that the page is enabled and not a
   * subpage / gate, and either hydrates SSR DOM (`hydrate: true`) or
   * renders fresh (`hydrate: false`). Falls back to the default entry
   * via `findEntryPage` on any validation miss.
   *
   * Replaces the pre-v3 `createApp` entry-resolution block that didn't
   * consult `#navState`, leaving URL-deeplinked pages stranded.
   */
  mountInitial(opts: { hydrate: boolean }): void {
    if (this.#destroyed) return;
    const entry = resolveEntryPage(
      this.#pages,
      this.#isGatePage,
      this.#navState.page,
    );
    if (!entry) return;
    if (opts.hydrate) {
      this.hydrateEntry(entry.id);
    } else {
      this.navigate({ page: entry.id });
    }
  }

  /**
   * Adopt SSR-rendered DOM for a specific page. Called by
   * `mountInitial({ hydrate: true })`. The renderer wires events
   * against the existing tree rather than blowing it away and
   * re-rendering.
   */
  hydrateEntry(pageId: PageId): void {
    if (this.#destroyed) return;
    this.#runNavigation(() => this.#hydrateNow(pageId));
  }

  #hydrateNow(pageId: PageId): void {
    const targetPage = this.#pages.find((p) => p.id === pageId);
    if (!targetPage?.enabled || this.#isGatePage(targetPage.type)) return;

    // Idempotency contract — repeat calls for the same already-hydrated
    // page are a no-op. Without this guard, a recovery path that races
    // itself (two consumer paths firing `app.hydratePage(activePageId)`
    // off the same chunk-load event) calls `factory()` twice and stacks
    // a fresh renderer over the live one. The previous renderer is
    // never `destroy()`-ed, so its hydrate cleanup never runs and its
    // event-bus listeners + component instances orphan — visible as
    // duplicated DOM, double-fired handlers, "ghost" subscribers.
    if (this.#activeRenderer && this.#activeRendererPageId === pageId) {
      return;
    }

    const factory = this.#opts.resolveRenderer(targetPage.type);
    this.#awaitingChunk = !factory;
    if (!factory) {
      emitRendererMissing(this.#opts.events, {
        pageType: targetPage.type,
        pageId: targetPage.id,
        phase: 'hydrate',
        missingHint: 'Hydrate skipped.',
        deferredHint: 'Hydrate resumes when the chunk registers.',
      });
      return;
    }

    // Same ordering rule as swapRenderer: unwind before the incoming
    // render touches the tree.
    this.#firePostRenderTeardown();

    const renderer = factory();
    const ctx: RenderContext<TPageType, TAppContext> = {
      page: targetPage,
      pages: this.#pages,
      app: this.#appContext,
      events: this.#opts.events,
      navState: this.#navState,
      navigate: (s, o) => this.navigate(s, o),
      update: this.#opts.hostUpdate,
    };

    this.#inRenderer(() => {
      if (typeof renderer.hydrate === 'function') {
        renderer.hydrate(this.#opts.container, ctx);
      } else {
        log.warn(
          `renderer for "${targetPage.type}" does not implement hydrate(). Falling back to render() — the SSR HTML is being regenerated client-side.`,
          { pageType: targetPage.type, phase: 'hydrate' },
        );
        renderer.render(this.#opts.container, ctx);
      }
    });

    this.#activeRenderer = renderer;
    this.#activeCtx = ctx;
    this.#activeRendererPageId = targetPage.id;
    this.#navState = { ...this.#navState, page: targetPage.id };
    log.debug(`navigation: page "${targetPage.id}" (hydrate)`, {
      pageId: targetPage.id,
      pageType: targetPage.type,
      phase: 'hydrate',
    });
    this.#runPostRender();
    this.#opts.events.emit('navigation:changed', this.#navState);
  }

  applyPageStyles(pageId: PageId, styles: Record<string, string | number>): void {
    if (pageId !== this.#activeRendererPageId) return;
    this.#activeRenderer?.applyPageStyles?.(styles);
  }

  applyComponentStyles(
    pageId: PageId,
    componentId: string,
    styles: Record<string, string | number>,
  ): void {
    if (pageId !== this.#activeRendererPageId) return;
    this.#activeRenderer?.applyComponentStyles?.(componentId, styles);
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#deferred.length = 0;
    this.#firePostRenderTeardown();
    if (this.#activeRenderer) {
      this.#activeRenderer.destroy();
      this.#activeRenderer = null;
      this.#activeCtx = null;
      this.#activeRendererPageId = null;
    }
    if (this.#router) {
      this.#router.stop();
      this.#router = null;
    }
  }

  #contextOnly(state: NavigationState): Record<string, string | undefined> {
    const out: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(state)) {
      if (k !== 'page') out[k] = v;
    }
    return out;
  }

  #contextEqual(a: NavigationState, b: NavigationState): boolean {
    const ac = this.#contextOnly(a);
    const bc = this.#contextOnly(b);
    const keys = new Set([...Object.keys(ac), ...Object.keys(bc)]);
    for (const k of keys) {
      if (ac[k] !== bc[k]) return false;
    }
    return true;
  }

  #initRouter(): void {
    const opt = this.#opts.enableRouter;
    if (!opt) return;

    const validPages = validPagesFor(this.#pages, this.#isGatePage);
    const mode: 'hash' | 'path' | 'query' = opt === true ? 'hash' : opt.mode;

    const onRouterNavigate = (state: RouteState): void => {
      if (this.#destroyed) return;
      // Nothing to do when the URL names the state already showing. That is
      // every hash-mode `push`: assigning `location.hash` fires
      // `hashchange`, which came back here and fired `navigation:changed` a
      // second time for one navigation. "Showing" is a mounted renderer, or
      // a page waiting for its chunk: the miss has been announced and the
      // recovery paints it, so asking again only announced it twice and ran
      // the recovery twice. After a render threw, though, the state names a
      // page that is neither, and a router event to that URL is how it gets
      // another try.
      // A key the URL leaves out because it holds its default is compared,
      // and restored, as that default (`navDefaults`).
      const entry = withNavDefaults({ ...state } as NavigationState, this.#opts.navDefaults);
      if ((this.#activeRenderer || this.#awaitingChunk) && sameRouteState(entry, this.#navState)) {
        return;
      }
      // A history entry is the whole state at that point, so restoring it
      // REPLACES the current state with the entry's, never merging into it
      // and never laying it over `initialNavState`: a key the entry does not
      // name must not survive from the state being left. That holds because
      // every entry is complete: each write is the whole state less its
      // `navDefaults` values, and the mount rewrites its own entry to
      // include what `initialNavState` added (`#initRouter`). A base of
      // `initialNavState` here would also replay a runtime remount's
      // snapshot, which arrives as `initialNavState`, on every later Back;
      // `navDefaults` is the base that is meant to hold on every entry.
      if (this.#navigationDepth > 0) {
        this.#deferred.push({ state: entry, history: 'none' });
        return;
      }
      this.#runNavigation(() => this.#applyNavigation(entry, 'none'));
    };

    try {
      // One router factory, shared with `resolveMountEntry`'s parse-only
      // use, so the URL the constructor folded into `#navState` is decoded
      // by the same code that will drive navigation from here on.
      this.#router = createRouter(opt, onRouterNavigate, validPages);
      this.#router.start();
      // The constructor already applied the URL via `resolveMountEntry`.
      // Unless the URL already names exactly the state showing, rewrite the
      // current entry with it: when the URL named no state, so the address
      // bar reflects the entry page; and when `initialNavState` added keys
      // the URL lacks, so this entry carries them. Every history entry then
      // holds the whole state, which is what lets Back/Forward restore an
      // entry exactly (see `onRouterNavigate`). Keys at their `navDefaults`
      // value are left out of it.
      const fromUrl = this.#router.parseCurrent();
      const own = this.#urlState();
      if (!fromUrl || !sameRouteState(fromUrl as NavigationState, own as NavigationState)) {
        this.#router.replace(own);
      }
    } catch (err) {
      log.warn(`Router (${mode}) init failed; URL routing disabled.`, { err, phase: 'router' });
      this.#router?.stop();
      this.#router = null;
    }
  }

  #swapRenderer(targetPage: Page<TPageType>): void {
    // Unwind post-render effects BEFORE the subtree they decorate is
    // destroyed, so a hook holding DOM can still see its own nodes.
    this.#firePostRenderTeardown();
    if (this.#activeRenderer) {
      this.#activeRenderer.destroy();
      this.#activeRenderer = null;
      this.#activeRendererPageId = null;
    }

    const factory = this.#opts.resolveRenderer(targetPage.type);
    this.#awaitingChunk = !factory;
    if (!factory) {
      emitRendererMissing(this.#opts.events, {
        pageType: targetPage.type,
        pageId: targetPage.id,
        phase: 'navigate',
        missingHint: 'The matching chunk may not have loaded yet.',
        deferredHint: 'Render resumes when the chunk registers.',
      });
      return;
    }

    const renderer = factory();
    const ctx: RenderContext<TPageType, TAppContext> = {
      page: targetPage,
      pages: this.#pages,
      app: this.#appContext,
      events: this.#opts.events,
      navState: this.#navState,
      navigate: (s, o) => this.navigate(s, o),
      update: this.#opts.hostUpdate,
    };
    this.#inRenderer(() => renderer.render(this.#opts.container, ctx));

    this.#activeRenderer = renderer;
    this.#activeCtx = ctx;
    this.#activeRendererPageId = targetPage.id;
    this.#runPostRender();
  }

  /**
   * Run a renderer call (`render`, `hydrate`, `applyNavState`). A
   * `navigate` from inside one is a redirect (see `navigate`).
   */
  #inRenderer<T>(call: () => T): T {
    this.#rendererCallDepth++;
    try {
      return call();
    } finally {
      this.#rendererCallDepth--;
    }
  }

  /** The state as the URL carries it: keys at their `navDefaults` value left out. */
  #urlState(): RouteState {
    const out: RouteState = { ...this.#navState };
    const defaults = this.#opts.navDefaults;
    for (const k in defaults) if (k !== 'page' && out[k] === defaults[k]) delete out[k];
    return out;
  }

  /**
   * Offer a same-page context change to the active renderer
   * (`PageRenderer.applyNavState`). True when it applied it; false when it
   * has no such method, declined, or threw, and the page must be rendered
   * again. `this.#navState` is already `next`.
   */
  #applyInPlace(
    renderer: PageRenderer<TPageType, TAppContext>,
    previous: NavigationState,
  ): boolean {
    const apply = renderer.applyNavState;
    if (typeof apply !== 'function') return false;
    let applied = false;
    try {
      applied =
        this.#inRenderer(() => apply.call(renderer, { ...this.#navState }, { ...previous })) === true;
    } catch (err) {
      // The page is rendered again, so the throw goes no further, but what
      // the failed call queued is dropped all the same.
      this.#deferred.length = 0;
      log.error('applyNavState threw; rendering again', err, { phase: 'navigate' });
    }
    if (applied && this.#activeCtx) this.#activeCtx.navState = this.#navState;
    return applied;
  }

  /**
   * Replace the opaque appContext bag and re-render the active page with
   * a fresh RenderContext. Used for live config / data updates that don't
   * require a full app remount.
   *
   * Destroys and re-instantiates the active page renderer with the new
   * appContext threaded through `ctx.app`. NavigationState is preserved
   * (no URL push, no `navigation:changed` emission — this is a config
   * delta, not a navigation event).
   *
   * No-op when destroyed, no active page mounted, or the active page id
   * no longer resolves in the page graph. Subpages re-activate naturally
   * on the next navigate() — the active page's renderer is the only one
   * with state to refresh.
   */
  replaceAppContext(newAppContext: TAppContext): void {
    if (this.#destroyed) return;
    this.#appContext = newAppContext;
    if (!this.#activeRendererPageId) return;
    const activePage = this.#pages.find((p) => p.id === this.#activeRendererPageId);
    if (!activePage) return;
    this.#runNavigation(() => this.#swapRenderer(activePage));
  }

  /**
   * Replace the active page graph and re-render the active page in place
   * with the new `Page<T>` reference. The runtime calls this from
   * `MountCartridgeResult.updatePages()` when the diff is fully covered
   * by `cartridge.pageHotSwapKeys` — page-graph structure stays the same
   * but per-page state (componentSettings / styles / slot props) changes.
   *
   * Contract:
   * - Replaces, does not merge — caller owns the canonical array.
   * - Looks up the active page in the new array by `id`. Active page id
   *   must still exist; if it doesn't, the runtime should have classified
   *   the diff as structural and routed to remount instead.
   * - Destroys + re-instantiates the active renderer with a fresh
   *   `RenderContext` whose `page` and `pages` reflect the new graph.
   * - NavigationState preserved; no `navigation:changed` emission and no
   *   router push (this is a cosmetic delta, not a navigation event).
   *
   * No-op when destroyed, when no active page is mounted, or when the
   * active page id no longer resolves in the new graph (defensive — the
   * runtime classifier prevents this case under correct use).
   */
  replacePages(newPages: Page<TPageType>[]): void {
    if (this.#destroyed) return;
    this.#pages = newPages;
    if (!this.#activeRendererPageId) return;
    const activePage = newPages.find((p) => p.id === this.#activeRendererPageId);
    if (!activePage) {
      // Defensive — runtime should have classified this as structural.
      // Tear down the stranded renderer rather than leaving stale DOM up.
      this.#activeRenderer?.destroy();
      this.#activeRenderer = null;
      this.#activeCtx = null;
      this.#activeRendererPageId = null;
      return;
    }
    this.#runNavigation(() => this.#swapRenderer(activePage));
  }
}

/**
 * Two states as a URL carries them: equal page and context, with `''` and
 * `undefined` both meaning absent, because every router drops empty values
 * when it encodes. Used to recognise a router event that names the state
 * already showing.
 */
function sameRouteState(a: NavigationState, b: NavigationState): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if ((a[k] || undefined) !== (b[k] || undefined)) return false;
  }
  return true;
}

/**
 * Emit the `'renderer:missing'` event and log at the appropriate level,
 * with wording matched to what the miss actually means.
 *
 * Chunked-client cartridges (`docs/best-practices.md` §2.5b) catch this
 * event to drive their lazy-chunk recovery flow — so when a subscriber
 * is wired, the missing-factory case is a documented *happy-path*
 * recovery signal, not a misconfiguration. We log at `info` with
 * deferred-not-failed wording ("not loaded yet — recovery in flight")
 * so DevTools reads it as lifecycle, not error. When nobody's
 * listening, the log stays at `warn` with the original wording because
 * the missing factory IS a real misconfiguration the host needs to
 * notice.
 *
 * The event itself always emits — it is the trigger the recovery engine
 * (`mountCartridge`'s `resolveView` seam) reacts to, never just a
 * diagnostic. Core cannot know whether a chunk will arrive; only the
 * subscriber can, so suppression decisions live one layer up.
 */
function emitRendererMissing(
  events: IEventBus,
  payload: {
    pageType: string;
    pageId: string;
    phase: 'navigate' | 'hydrate';
    /** Phase-specific suffix when nobody is listening (e.g. "Hydrate skipped."). */
    missingHint: string;
    /** Phase-specific suffix when a recovery subscriber is wired (e.g. "Hydrate resumes when the chunk registers."). */
    deferredHint: string;
  },
): void {
  const wired = events.listenerCount('renderer:missing') > 0;
  const meta = { pageType: payload.pageType, phase: payload.phase };
  if (wired) {
    log.info(
      `page chunk for "${payload.pageType}" not loaded yet — recovery in flight. ${payload.deferredHint}`,
      meta,
    );
  } else {
    log.warn(
      `no renderer registered for page type "${payload.pageType}". ${payload.missingHint}`,
      meta,
    );
  }
  events.emit('renderer:missing', {
    pageType: payload.pageType,
    pageId: payload.pageId,
    phase: payload.phase,
  });
}
