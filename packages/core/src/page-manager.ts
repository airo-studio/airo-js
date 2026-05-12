/**
 * PageManager — the Mediator at the framework's core.
 *
 * Owns navigation state and is the only module that talks to: the renderer
 * registry (resolve), the active renderer (mount/destroy), the router
 * (push/parse), and the event bus (emit navigation:changed). Every other
 * module talks to PageManager, never to its peers.
 *
 * Headless: PageManager never paints DOM beyond delegating to the active
 * renderer. Anything visual (breadcrumbs, chrome) subscribes to
 * `navigation:changed` on the event bus and renders itself.
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
} from './page.js';
import type { IEventBus } from './events.js';
import type { IRouter, RouteState, RouterOption } from './router.js';
import { HashRouter } from './router.js';
import { PathRouter } from './path-router.js';

const log = logger('core');

function findEntryPage<TPageType extends string>(
  pages: ReadonlyArray<Page<TPageType>>,
  isGate: (type: TPageType) => boolean,
): Page<TPageType> | undefined {
  return pages.find((p) => p.enabled && !isGate(p.type) && !p.parent);
}

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
}

export class PageManager<
  TPageType extends string = string,
  TAppContext = unknown,
> {
  private readonly opts: PageManagerOptions<TPageType, TAppContext>;
  private readonly isGatePage: (pageType: TPageType) => boolean;
  private navState: NavigationState;
  private activeRenderer: PageRenderer<TPageType, TAppContext> | null = null;
  private activeRendererPageId: PageId | null = null;
  private router: IRouter | null = null;
  private suppressRouterPush = false;
  private destroyed = false;

  constructor(opts: PageManagerOptions<TPageType, TAppContext>) {
    this.opts = opts;
    this.isGatePage = opts.isGatePage ?? (() => false);
    const entry = findEntryPage(opts.pages, this.isGatePage);
    this.navState = { page: entry?.id ?? '' };

    if (opts.enableRouter) {
      this.initRouter();
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
      ? this.opts.pages.find((p) => p.id === next.page)
      : undefined;

    if (!targetPage || !targetPage.enabled || this.isGatePage(targetPage.type)) {
      const entry = findEntryPage(this.opts.pages, this.isGatePage);
      if (!entry) return;
      targetPage = entry;
      next.page = entry.id;
    }

    if (targetPage.parent) {
      const parent = this.opts.pages.find((p) => p.id === targetPage!.parent);
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
        ...this.contextOnly(next),
      };
      this.activeRenderer?.activateSubpage?.(subpage);
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

    this.opts.events.emit('navigation:changed', this.navState);
  }

  showSubpage(subpage: SubpageActivation<TPageType>): void {
    if (this.destroyed) return;
    this.activeRenderer?.activateSubpage?.(subpage);
  }

  /**
   * Adopt SSR-rendered DOM for a specific page. Called by `createApp`
   * with `{ hydrate: true }` instead of the normal `navigate()` path,
   * so the renderer wires events against the existing tree rather than
   * blowing it away and re-rendering.
   */
  hydrateEntry(pageId: PageId): void {
    if (this.destroyed) return;
    const targetPage = this.opts.pages.find((p) => p.id === pageId);
    if (!targetPage || !targetPage.enabled || this.isGatePage(targetPage.type)) return;

    const factory = this.opts.resolveRenderer(targetPage.type);
    if (!factory) {
      log.warn(`no renderer registered for page type "${targetPage.type}". Hydrate skipped.`, {
        pageType: targetPage.type,
        phase: 'hydrate',
      });
      return;
    }

    const renderer = factory();
    const ctx: RenderContext<TPageType, TAppContext> = {
      page: targetPage,
      app: this.opts.appContext,
      events: this.opts.events,
      navState: this.navState,
      navigate: (s) => this.navigate(s),
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

    const validPages = this.opts.pages
      .filter((p) => !p.parent && !this.isGatePage(p.type))
      .map((p) => p.id);

    // Discriminated-union branch on the opt shape. `true` is the
    // back-compat alias for `{ mode: 'hash' }`.
    const mode: 'hash' | 'path' = opt === true ? 'hash' : opt.mode;
    const pathContextKey = opt === true ? undefined : opt.pathContextKey;

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
        this.router = new HashRouter(onRouterNavigate, { validPages, pathContextKey });
      } else {
        // mode === 'path' — TS narrows `opt` to the path variant here.
        const pathOpt = opt as { mode: 'path'; basePath: string; pathContextKey?: string };
        this.router = new PathRouter(onRouterNavigate, {
          basePath: pathOpt.basePath,
          validPages,
          pathContextKey,
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
    if (this.activeRenderer) {
      this.activeRenderer.destroy();
      this.activeRenderer = null;
      this.activeRendererPageId = null;
    }

    const factory = this.opts.resolveRenderer(targetPage.type);
    if (!factory) {
      log.warn(
        `no renderer registered for page type "${targetPage.type}". The matching chunk may not have loaded yet.`,
        { pageType: targetPage.type, phase: 'navigate' },
      );
      return;
    }

    const renderer = factory();
    const ctx: RenderContext<TPageType, TAppContext> = {
      page: targetPage,
      app: this.opts.appContext,
      events: this.opts.events,
      navState: this.navState,
      navigate: (s) => this.navigate(s),
    };
    renderer.render(this.opts.container, ctx);

    this.activeRenderer = renderer;
    this.activeRendererPageId = targetPage.id;
  }
}
