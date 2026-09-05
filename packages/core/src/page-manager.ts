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
  NavigationState,
  PageRenderer,
  PageRendererFactory,
  RenderContext,
  SubpageActivation,
  UpdateResult,
} from './page.js';
import type { IEventBus } from './events.js';
import type { IRouter, RouteState, RouterOption } from './router.js';
import { HashRouter, QueryRouter } from './router.js';
import { PathRouter } from './path-router.js';

const log = logger('core');

/**
 * Default entry-page selection. First enabled, non-gate, non-subpage page
 * in the configured order. Shared by PageManager + SSR runner so both
 * agree on what "default entry" means.
 */
export function findEntryPage<TPageType extends string>(
  pages: ReadonlyArray<Page<TPageType>>,
  isGate: (type: TPageType) => boolean,
): Page<TPageType> | undefined {
  return pages.find((p) => p.enabled && !isGate(p.type) && !p.parent);
}

/**
 * Resolve the entry page given an optional preferred id. Used by
 * `PageManager.mountInitial` and the SSR runner. The preferred id wins
 * only when it points to an enabled, non-subpage, non-gate page in the
 * config; otherwise falls back to `findEntryPage` so tampered or stale
 * deeplinks never crash the runtime.
 */
export function resolveEntryPage<TPageType extends string>(
  pages: ReadonlyArray<Page<TPageType>>,
  isGate: (type: TPageType) => boolean,
  preferredId?: string,
): Page<TPageType> | undefined {
  return describeEntryResolution(pages, isGate, preferredId).page;
}

/** Why a requested entry id was rejected in favour of the default entry. */
export type EntryFallbackReason =
  /** No page in the graph has this id. */
  | 'unknown-page'
  /** The page exists but `enabled` is false. */
  | 'disabled'
  /** The page exists but is a subpage — subpages activate through their parent. */
  | 'subpage'
  /** The page exists but `isGatePage` claims its type. */
  | 'gate-page';

export interface EntryResolution<TPageType extends string> {
  page: Page<TPageType> | undefined;
  /**
   * Present ONLY when a preferred id was supplied and rejected. Absent
   * when no id was requested (a bare `basePath`, the legitimate entry
   * case) and when the requested id resolved.
   */
  fellBack?: { requested: string; reason: EntryFallbackReason };
}

/**
 * `resolveEntryPage`, plus WHY it fell back.
 *
 * The resolver already validates a requested id against the page graph
 * and silently substitutes the default entry — deliberately, so a
 * tampered or stale deeplink can never crash a render. Taken literally
 * that serves the home page at `/does-not-exist` with a 200 and a
 * canonical of `/`: a soft 404, which search engines penalise, and which
 * nothing errors or warns about. Two independent consumers shipped it
 * without noticing.
 *
 * The right answer is PER SURFACE, not per consumer — the same codebase
 * routinely serves several. On its own crawlable domain an unknown tail
 * is a 404. On a customer's page, where the URL belongs to the customer's
 * router and the tail may have nothing to do with this widget at all,
 * falling back is mandatory: a widget that refused to render because it
 * did not recognise a path segment would be a vendor breaking a
 * customer's page. That is why the fallback will never be reversed, and
 * why the framework cannot pick.
 *
 * So the fallback stays and the DECISION stops being thrown away. The
 * runner is the only party that knows the decode failed; the host is the
 * only party that knows what that means. HTTP status stays entirely
 * host-side — this reports what it did and has no opinion about the
 * response code.
 *
 * Callers should branch on `reason`, not on the presence of `fellBack`:
 * only `'unknown-page'` is a 404. `'disabled'` is a publisher config
 * state and `'gate-page'` is a real page in the template — both are
 * legitimate 200s that happened to resolve elsewhere.
 */
export function describeEntryResolution<TPageType extends string>(
  pages: ReadonlyArray<Page<TPageType>>,
  isGate: (type: TPageType) => boolean,
  preferredId?: string,
): EntryResolution<TPageType> {
  if (!preferredId) return { page: findEntryPage(pages, isGate) };

  const match = pages.find((p) => p.id === preferredId);
  const reason: EntryFallbackReason | undefined = !match
    ? 'unknown-page'
    : !match.enabled
      ? 'disabled'
      : match.parent
        ? 'subpage'
        : isGate(match.type)
          ? 'gate-page'
          : undefined;

  if (!reason) return { page: match };
  return {
    page: findEntryPage(pages, isGate),
    fellBack: { requested: preferredId, reason },
  };
}

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
   * this; PageManager seeds `navState` with it BEFORE the router parses
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
   * Host-supplied live config-delta dispatcher (forwarded from
   * `AppDeps.hostUpdate`). When set, every `RenderContext` built by
   * `swapRenderer` / `hydrateEntry` includes `ctx.update` wired to
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
  private readonly opts: PageManagerOptions<TPageType, TAppContext>;
  private readonly isGatePage: (pageType: TPageType) => boolean;
  /**
   * The active page graph. Mirrors `opts.pages` at construction time so
   * `replacePages` can swap the reference without forcing every read site
   * back through `opts`. The runtime's `MountCartridgeResult.updatePages()`
   * drives this — hot-swapping per-page state (componentSettings / styles /
   * slot props) without a full mount cycle.
   */
  private pages: Page<TPageType>[];
  private navState: NavigationState;
  private appContext: TAppContext;
  private activeRenderer: PageRenderer<TPageType, TAppContext> | null = null;
  private activeRendererPageId: PageId | null = null;
  private router: IRouter | null = null;
  private suppressRouterPush = false;
  private destroyed = false;
  /** Teardown returned by the most recent `postRender` invocation, if any. */
  private postRenderTeardown: (() => void) | null = null;

  constructor(opts: PageManagerOptions<TPageType, TAppContext>) {
    this.opts = opts;
    this.pages = opts.pages;
    this.appContext = opts.appContext;
    this.isGatePage = opts.isGatePage ?? (() => false);
    const entry = findEntryPage(this.pages, this.isGatePage);
    // Seed precedence: default entry → host-supplied initialNavState →
    // (initRouter below) URL state. Last write wins, so URL beats host
    // config beats default — matches the v3 contract.
    this.navState = {
      page: entry?.id ?? '',
      ...(opts.initialNavState ?? {}),
    };

    if (opts.enableRouter) {
      this.initRouter();
    }
  }

  /**
   * Unwind the previous post-render effects. Idempotent — safe to call at
   * every point a render is about to be replaced, and again from
   * `destroy()`. Throwing teardowns are logged and swallowed: a hook that
   * fails while unwinding must not abort the render that follows it.
   */
  private firePostRenderTeardown(): void {
    const teardown = this.postRenderTeardown;
    if (!teardown) return;
    this.postRenderTeardown = null;
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
   * on screen with `activeRenderer` bookkeeping half-applied.
   */
  private runPostRender(): void {
    if (!this.opts.postRender) return;
    this.firePostRenderTeardown();
    try {
      const teardown = this.opts.postRender({
        container: this.opts.container,
        navState: this.navState,
        events: this.opts.events,
      });
      this.postRenderTeardown = typeof teardown === 'function' ? teardown : null;
    } catch (err) {
      log.error('postRender hook threw; render is unaffected.', err, {
        phase: 'post-render',
      });
      this.postRenderTeardown = null;
    }
  }

  getNavigationState(): NavigationState {
    return { ...this.navState };
  }

  setNavigationState(state: NavigationState): void {
    this.navigate(state);
  }

  /**
   * Command pattern entry point. URL hashchange, click handler, postMessage,
   * programmatic call — every source builds the same `Partial<NavigationState>`
   * and hands it here. Dedupes (same anchor + same context = no-op),
   * updates state, swaps the renderer, syncs the URL, fires the event.
   */
  navigate(state: Partial<NavigationState>): void {
    if (this.destroyed) return;

    const next: NavigationState = { ...this.navState, ...state };
    let targetPage = next.page
      ? this.pages.find((p) => p.id === next.page)
      : undefined;

    if (!targetPage?.enabled || this.isGatePage(targetPage.type)) {
      const entry = findEntryPage(this.pages, this.isGatePage);
      if (!entry) return;
      targetPage = entry;
      next.page = entry.id;
    }

    if (targetPage.parent) {
      const parent = this.pages.find((p) => p.id === targetPage!.parent);
      if (!parent) return;
      if (parent.id !== this.activeRendererPageId) {
        this.navigate({ ...next, page: parent.id });
      } else {
        this.navState = next;
      }
      const subpage: SubpageActivation<TPageType> = {
        type: targetPage.type,
        id: targetPage.id,
        parent: parent.id,
        page: targetPage,
        ...this.contextOnly(next),
      };
      this.activeRenderer?.activateSubpage?.(subpage);
      log.debug(`navigation: subpage "${targetPage.id}" on "${parent.id}" (subpage)`, {
        pageId: targetPage.id,
        pageType: targetPage.type,
        phase: 'subpage',
      });
      this.opts.events.emit('navigation:changed', this.navState);
      return;
    }

    const anchor = targetPage;
    const samePage = anchor.id === this.activeRendererPageId;
    const sameContext = this.contextEqual(this.navState, next);

    this.navState = next;

    if (!samePage) {
      this.swapRenderer(anchor);
    } else if (!sameContext) {
      if (this.activeRenderer) {
        this.activeRenderer.destroy();
        this.activeRenderer = null;
        this.swapRenderer(anchor);
      }
    }

    if (this.router && !this.suppressRouterPush) {
      try {
        this.router.push(this.navState as RouteState);
      } catch (err) {
        log.warn('PageManager router.push failed', { err, phase: 'router' });
      }
    }

    // Navigation narration (0.8.8): the trigger kind is the one thing
    // the `navigation:changed` bus payload doesn't carry.
    log.debug(`navigation: page "${anchor.id}" (navigate)`, {
      pageId: anchor.id,
      pageType: anchor.type,
      phase: 'navigate',
    });
    this.opts.events.emit('navigation:changed', this.navState);
  }

  showSubpage(subpage: SubpageActivation<TPageType>): void {
    if (this.destroyed) return;
    this.activeRenderer?.activateSubpage?.(subpage);
  }

  /**
   * Mount the initial page based on current `navState` + page config.
   *
   * This is the single entry-resolution site for the App. Reads from
   * `this.navState.page` (URL-decoded, host-supplied, or default-seeded
   * at construction), validates that the page is enabled and not a
   * subpage / gate, and either hydrates SSR DOM (`hydrate: true`) or
   * renders fresh (`hydrate: false`). Falls back to the default entry
   * via `findEntryPage` on any validation miss.
   *
   * Replaces the pre-v3 `createApp` entry-resolution block that didn't
   * consult `navState`, leaving URL-deeplinked pages stranded.
   */
  mountInitial(opts: { hydrate: boolean }): void {
    if (this.destroyed) return;
    const entry = resolveEntryPage(
      this.pages,
      this.isGatePage,
      this.navState.page,
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
    if (this.destroyed) return;
    const targetPage = this.pages.find((p) => p.id === pageId);
    if (!targetPage?.enabled || this.isGatePage(targetPage.type)) return;

    // Idempotency contract — repeat calls for the same already-hydrated
    // page are a no-op. Without this guard, a recovery path that races
    // itself (two consumer paths firing `app.hydratePage(activePageId)`
    // off the same chunk-load event) calls `factory()` twice and stacks
    // a fresh renderer over the live one. The previous renderer is
    // never `destroy()`-ed, so its hydrate cleanup never runs and its
    // event-bus listeners + component instances orphan — visible as
    // duplicated DOM, double-fired handlers, "ghost" subscribers.
    if (this.activeRenderer && this.activeRendererPageId === pageId) {
      return;
    }

    const factory = this.opts.resolveRenderer(targetPage.type);
    if (!factory) {
      emitRendererMissing(this.opts.events, {
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
    this.firePostRenderTeardown();

    const renderer = factory();
    const ctx: RenderContext<TPageType, TAppContext> = {
      page: targetPage,
      pages: this.pages,
      app: this.appContext,
      events: this.opts.events,
      navState: this.navState,
      navigate: (s) => this.navigate(s),
      update: this.opts.hostUpdate,
    };

    if (typeof renderer.hydrate === 'function') {
      renderer.hydrate(this.opts.container, ctx);
    } else {
      log.warn(
        `renderer for "${targetPage.type}" does not implement hydrate(). Falling back to render() — the SSR HTML is being regenerated client-side.`,
        { pageType: targetPage.type, phase: 'hydrate' },
      );
      renderer.render(this.opts.container, ctx);
    }

    this.activeRenderer = renderer;
    this.activeRendererPageId = targetPage.id;
    this.navState = { ...this.navState, page: targetPage.id };
    log.debug(`navigation: page "${targetPage.id}" (hydrate)`, {
      pageId: targetPage.id,
      pageType: targetPage.type,
      phase: 'hydrate',
    });
    this.runPostRender();
    this.opts.events.emit('navigation:changed', this.navState);
  }

  applyPageStyles(pageId: PageId, styles: Record<string, string | number>): void {
    if (pageId !== this.activeRendererPageId) return;
    this.activeRenderer?.applyPageStyles?.(styles);
  }

  applyComponentStyles(
    pageId: PageId,
    componentId: string,
    styles: Record<string, string | number>,
  ): void {
    if (pageId !== this.activeRendererPageId) return;
    this.activeRenderer?.applyComponentStyles?.(componentId, styles);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.firePostRenderTeardown();
    if (this.activeRenderer) {
      this.activeRenderer.destroy();
      this.activeRenderer = null;
      this.activeRendererPageId = null;
    }
    if (this.router) {
      this.router.stop();
      this.router = null;
    }
  }

  private contextOnly(state: NavigationState): Record<string, string | undefined> {
    const out: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(state)) {
      if (k !== 'page') out[k] = v;
    }
    return out;
  }

  private contextEqual(a: NavigationState, b: NavigationState): boolean {
    const ac = this.contextOnly(a);
    const bc = this.contextOnly(b);
    const keys = new Set([...Object.keys(ac), ...Object.keys(bc)]);
    for (const k of keys) {
      if (ac[k] !== bc[k]) return false;
    }
    return true;
  }

  private initRouter(): void {
    const opt = this.opts.enableRouter;
    if (!opt) return;

    const validPages = this.pages
      .filter((p) => !p.parent && !this.isGatePage(p.type))
      .map((p) => p.id);

    // Discriminated-union branch on the opt shape. `true` is the
    // back-compat alias for `{ mode: 'hash' }`.
    const mode: 'hash' | 'path' | 'query' = opt === true ? 'hash' : opt.mode;

    const onRouterNavigate = (state: RouteState): void => {
      this.suppressRouterPush = true;
      try {
        this.navigate(state);
      } finally {
        this.suppressRouterPush = false;
      }
    };

    try {
      if (mode === 'hash') {
        // Hash variant — `pathContextKey` belongs to the hash/path
        // family; the `true` alias has no pathContextKey override.
        const hashOpt = opt === true ? {} : (opt as { pathContextKey?: string });
        this.router = new HashRouter(onRouterNavigate, {
          validPages,
          pathContextKey: hashOpt.pathContextKey,
        });
      } else if (mode === 'path') {
        // TS narrows `opt` to the path variant here.
        const pathOpt = opt as {
          mode: 'path';
          basePath: string;
          pathContextKey?: string;
          entryPageId?: string;
        };
        this.router = new PathRouter(onRouterNavigate, {
          basePath: pathOpt.basePath,
          validPages,
          pathContextKey: pathOpt.pathContextKey,
          // Opt-in, NOT defaulted to the template's entry page. Turning it
          // on changes which url the entry page canonicalises to, which is
          // an SEO event for anyone with `basePath/<entryPageId>` already
          // indexed — their call to make, not a side effect of upgrading.
          entryPageId: pathOpt.entryPageId,
        });
      } else {
        // mode === 'query' — `paramPrefix` optional, defaults inside
        // QueryRouter. `pathContextKey` isn't honored in query mode
        // (discrete-param shape has no path segments).
        const queryOpt = opt as { mode: 'query'; paramPrefix?: string };
        this.router = new QueryRouter(onRouterNavigate, {
          paramPrefix: queryOpt.paramPrefix,
          validPages,
        });
      }
      this.router.start();
      const initial = this.router.parseCurrent();
      if (initial) {
        this.navState = { ...this.navState, ...initial };
      } else {
        this.router.replace(this.navState as RouteState);
      }
    } catch (err) {
      log.warn(`Router (${mode}) init failed; URL routing disabled.`, { err, phase: 'router' });
      this.router?.stop();
      this.router = null;
    }
  }

  private swapRenderer(targetPage: Page<TPageType>): void {
    // Unwind post-render effects BEFORE the subtree they decorate is
    // destroyed, so a hook holding DOM can still see its own nodes.
    this.firePostRenderTeardown();
    if (this.activeRenderer) {
      this.activeRenderer.destroy();
      this.activeRenderer = null;
      this.activeRendererPageId = null;
    }

    const factory = this.opts.resolveRenderer(targetPage.type);
    if (!factory) {
      emitRendererMissing(this.opts.events, {
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
      pages: this.pages,
      app: this.appContext,
      events: this.opts.events,
      navState: this.navState,
      navigate: (s) => this.navigate(s),
      update: this.opts.hostUpdate,
    };
    renderer.render(this.opts.container, ctx);

    this.activeRenderer = renderer;
    this.activeRendererPageId = targetPage.id;
    this.runPostRender();
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
    if (this.destroyed) return;
    this.appContext = newAppContext;
    if (!this.activeRendererPageId) return;
    const activePage = this.pages.find((p) => p.id === this.activeRendererPageId);
    if (!activePage) return;
    this.swapRenderer(activePage);
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
    if (this.destroyed) return;
    this.pages = newPages;
    if (!this.activeRendererPageId) return;
    const activePage = newPages.find((p) => p.id === this.activeRendererPageId);
    if (!activePage) {
      // Defensive — runtime should have classified this as structural.
      // Tear down the stranded renderer rather than leaving stale DOM up.
      this.activeRenderer?.destroy();
      this.activeRenderer = null;
      this.activeRendererPageId = null;
      return;
    }
    this.swapRenderer(activePage);
  }
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
