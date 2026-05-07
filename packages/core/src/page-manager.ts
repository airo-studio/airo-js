/**
 * PageManager — the Mediator at the framework's core.
 *
 * Owns navigation state and is the only module that talks to: the renderer
 * registry (resolve), the active renderer (mount/destroy), the breadcrumb
 * (update), the router (push/parse), and the event bus (emit
 * navigation:changed). Every other module talks to PageManager, never to
 * its peers.
 *
 * Generic over `TPageType` (a string narrowing — domain apps narrow this
 * to their own enum) and over `TAppContext` (the opaque bag of app-level
 * data the renderers receive).
 */

import type { Page, PageId } from './schema.js';
import type {
  NavigationState,
  PageRenderer,
  PageRendererFactory,
  RenderContext,
  SubpageActivation,
} from './page.js';
import type { IEventBus } from './events.js';
import type { IHashRouter, RouteState } from './router.js';
import { HashRouter } from './router.js';
import { mountBreadcrumb, type BreadcrumbHandle, type LabelResolver } from './breadcrumb.js';

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
  /** Optional element the breadcrumb mounts into. Single-page apps skip this. */
  breadcrumbMount?: HTMLElement;
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
  /** Optional crumb separator. Defaults to `'›'`. */
  breadcrumbSeparator?: string;
  /**
   * Resolve a breadcrumb label for a page given the current nav state.
   * Return null to skip the page entirely (don't add a crumb), undefined
   * to use the page id as the label fallback, or a string to override.
   */
  breadcrumbLabel?: LabelResolver<TPageType>;
  /**
   * Enable hash-based URL routing. When true, navigate() pushes the
   * navState into the URL hash and external hashchange events drive
   * navigate().
   */
  enableRouter?: boolean;
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
  private breadcrumb: BreadcrumbHandle | null = null;
  private router: IHashRouter | null = null;
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

    if (opts.breadcrumbMount) {
      this.breadcrumb = mountBreadcrumb<TPageType>({
        targetEl: opts.breadcrumbMount,
        pages: opts.pages,
        activePageId: this.navState.page,
        navState: this.navState,
        labelResolver: opts.breadcrumbLabel,
        separator: opts.breadcrumbSeparator,
        onNavigate: (pageId) => this.navigate({ page: pageId }),
        isGatePage: this.isGatePage,
      });
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

    this.breadcrumb?.update(anchor.id, this.navState);

    if (this.router && !this.suppressRouterPush) {
      try {
        this.router.push(this.navState as RouteState);
      } catch (err) {
        console.warn('[@airo-js/core] PageManager router.push failed:', err);
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
      console.warn(
        `[@airo-js/core] PageManager: no renderer registered for page type "${targetPage.type}". Hydrate skipped.`,
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

    if (typeof renderer.hydrate === 'function') {
      renderer.hydrate(this.opts.container, ctx);
    } else {
      console.warn(
        `[@airo-js/core] PageManager: renderer for "${targetPage.type}" does not implement hydrate(). Falling back to render() — the SSR HTML is being regenerated client-side.`,
      );
      renderer.render(this.opts.container, ctx);
    }

    this.activeRenderer = renderer;
    this.activeRendererPageId = targetPage.id;
    this.navState = { ...this.navState, page: targetPage.id };
    this.breadcrumb?.update(targetPage.id, this.navState);
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
    if (this.breadcrumb) {
      this.breadcrumb.destroy();
      this.breadcrumb = null;
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
    const validPages = this.opts.pages
      .filter((p) => !p.parent && !this.isGatePage(p.type))
      .map((p) => p.id);
    try {
      this.router = new HashRouter(
        (state) => {
          this.suppressRouterPush = true;
          try {
            this.navigate(state);
          } finally {
            this.suppressRouterPush = false;
          }
        },
        { validPages },
      );
      this.router.start();
      const initial = this.router.parseCurrentHash();
      if (initial) {
        this.navState = { ...this.navState, ...initial };
      } else {
        this.router.replace(this.navState as RouteState);
      }
    } catch (err) {
      console.warn('[@airo-js/core] HashRouter init failed; URL routing disabled.', err);
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
      console.warn(
        `[@airo-js/core] PageManager: no renderer registered for page type "${targetPage.type}". The matching chunk may not have loaded yet.`,
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
