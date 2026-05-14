/**
 * App lifecycle and the public entry — `createApp(config, deps)`.
 *
 * Composes the framework's parts: EventBus + PageManager + an opaque
 * `appContext` bag the consumer fills with whatever its renderers need
 * (theme, feed data, retailer lists, etc.). The framework doesn't
 * inspect appContext.
 */

import type { AppConfig } from './schema.js';
import type { IEventBus } from './events.js';
import { EventBus } from './events.js';
import type {
  PageRendererFactory,
  NavigationState,
  SubpageActivation,
  UpdateResult,
} from './page.js';
import type { RouterOption } from './router.js';
import { PageManager } from './page-manager.js';

/**
 * App lifecycle states. Modelled as an explicit FSM (vs the implicit
 * "everything happens in init()" of older frameworks) so SSR/hydrate can
 * start at `mounted` with adopted DOM, plugins can hook by state name,
 * and transitions become testable.
 */
export type AppLifecycleState =
  | 'idle'
  | 'wiring'
  | 'ready'
  | 'rendering'
  | 'mounted'
  | 'destroyed';

/** Dependencies the kernel needs from outside. */
export interface AppDeps<
  TPageType extends string = string,
  TAppContext = unknown,
> {
  /** The DOM host the app paints into. */
  host: HTMLElement;
  /** Optional pre-built event bus; one is created if absent. */
  events?: IEventBus;
  /**
   * URL routing strategy. Discriminated union (see `RouterOption` in
   * `./router.ts`):
   *   `false` (default) — no router; widget runs in memory only.
   *   `true`            — back-compat alias for `{ mode: 'hash' }`.
   *   `{ mode: 'hash' }`         — HashRouter (embed-friendly).
   *   `{ mode: 'path', basePath }` — PathRouter (owned-URL widgets).
   */
  enableRouter?: RouterOption;
  /**
   * Page-renderer resolver — domain code wires this. Returns undefined
   * when the chunk owning that page type hasn't loaded yet.
   */
  resolveRenderer: (
    pageType: TPageType,
  ) => PageRendererFactory<TPageType, TAppContext> | undefined;
  /** Predicate identifying gate pages (e.g. age verification). */
  isGatePage?: (pageType: TPageType) => boolean;
  /** Opaque app-context the consumer hands through to every renderer. */
  appContext: TAppContext;
  /**
   * When true, the App adopts pre-rendered DOM under `host` instead of
   * painting fresh markup. The active renderer's `hydrate()` runs in
   * place of `render()` — the DOM is already correct, hydrate just
   * wires events and recomputes state. Used when the embed loader
   * received SSR HTML and hands off to the live runtime.
   */
  hydrate?: boolean;
  /**
   * Mount-time navigation state. Threaded into `PageManager`'s
   * constructor so `mountInitial` resolves the entry page from
   * `initialNavState.page` (URL-decoded or host-supplied) before
   * falling back to the default entry. See `PageManagerOptions` for
   * the precedence + contract.
   */
  initialNavState?: Partial<NavigationState>;
  /**
   * Host-supplied live config-delta dispatcher. When provided,
   * `PageManager` threads it into every `RenderContext` as
   * `ctx.update`, letting renderers fire delta updates from inside
   * listener handlers without holding a separate handle. The
   * cartridge runtime (`mountCartridge` in `@airo-js/runtime`) wires
   * this to its `MountCartridgeResult.update()` closure on every
   * mount. Raw `createApp` callers without a cartridge runtime can
   * leave it `undefined`; `ctx.update` will be `undefined` and
   * renderers fall through their `?.()` guard.
   */
  hostUpdate?: (delta: Record<string, unknown>) => Promise<UpdateResult>;
}

/**
 * Public handle returned by `createApp`. Domain code uses this to drive
 * navigation and tear the app down on host unmount.
 */
export interface App {
  navigate(state: Partial<NavigationState>): void;
  showSubpage(subpage: SubpageActivation): void;
  getNavigationState(): NavigationState;
  /**
   * Replace the opaque appContext bag and re-render the active page.
   * Type-erased on the public App handle because TAppContext is opaque
   * here; callers that constructed the App with a typed context cast on
   * the way in (the cartridge runtime in `@airo-js/runtime` does this
   * when delivering `MountCartridgeResult.update()`).
   */
  replaceAppContext(newAppContext: unknown): void;
  destroy(): void;
  readonly state: AppLifecycleState;
  readonly events: IEventBus;
}

/**
 * The framework's only entry point. Domain code calls this once per
 * widget instance with a config and deps, gets back an `App` handle,
 * and drives the rest through events + navigate.
 */
export function createApp<
  TPageType extends string = string,
  TAppContext = unknown,
>(
  config: AppConfig<TPageType>,
  deps: AppDeps<TPageType, TAppContext>,
): App {
  const events: IEventBus = deps.events ?? new EventBus();
  let lifecycle: AppLifecycleState = 'wiring';

  const pageManager = new PageManager<TPageType, TAppContext>({
    container: deps.host,
    pages: config.pages,
    events,
    appContext: deps.appContext,
    resolveRenderer: deps.resolveRenderer,
    isGatePage: deps.isGatePage,
    enableRouter: deps.enableRouter,
    initialNavState: deps.initialNavState,
    hostUpdate: deps.hostUpdate,
  });

  // PageManager owns initial entry resolution from this point — reads
  // `navState.page` (URL > initialNavState > default), validates against
  // the page graph + gate predicate, and either hydrates SSR DOM or
  // renders fresh.
  if (config.pages.some((p) => p.enabled && !p.parent)) {
    lifecycle = 'rendering';
    pageManager.mountInitial({ hydrate: !!deps.hydrate });
    lifecycle = 'mounted';
  } else {
    lifecycle = 'ready';
  }

  return {
    navigate(state) {
      if (lifecycle === 'destroyed') return;
      pageManager.navigate(state);
    },
    showSubpage(subpage) {
      if (lifecycle === 'destroyed') return;
      pageManager.showSubpage(subpage as SubpageActivation<TPageType>);
    },
    getNavigationState() {
      return pageManager.getNavigationState();
    },
    replaceAppContext(newAppContext) {
      if (lifecycle === 'destroyed') return;
      pageManager.replaceAppContext(newAppContext as TAppContext);
    },
    destroy() {
      if (lifecycle === 'destroyed') return;
      pageManager.destroy();
      lifecycle = 'destroyed';
    },
    get state() {
      return lifecycle;
    },
    events,
  };
}
