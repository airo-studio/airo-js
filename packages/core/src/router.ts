/**
 * Router primitives — URL ↔ NavigationState bridges. Two implementations
 * share the encoding (`stateToFragment` / `fragmentToState` in
 * `nav-encoding.ts`); they differ only in which URL surface they read
 * from and write to.
 *
 *   HashRouter   — `#fragment` (default; embed-friendly, works on any
 *                  host page)
 *   PathRouter   — `/basePath/fragment` via History API (when the widget
 *                  owns the URL space — Campaign Pages, edge-rendered
 *                  pages, anywhere the host server controls the path)
 *
 * Both implement the `IRouter` interface. `IHashRouter` is kept as a
 * deprecated alias for back-compat — pre-0.5.0 callers wrote against
 * the hash-specific name when there was only one router.
 *
 * `RouterOption` is the discriminated union consumers pass to
 * `mountCartridge.enableRouter` (or `createApp.deps.enableRouter`).
 * The runtime branches on the variant and instantiates the matching
 * router.
 */

export interface RouteState {
  page: string;
  [key: string]: string | undefined;
}

import { logger } from '@airo-js/log';
import { fragmentToState, stateToFragment } from './nav-encoding.js';

const log = logger('core');

export type RouterOnNavigate = (state: RouteState) => void;

/**
 * Shape every router implements. Callers (PageManager) drive lifecycle
 * via this interface — no router-class-specific calls leak out.
 */
export interface IRouter {
  start(): void;
  stop(): void;
  push(state: RouteState): void;
  replace(state: RouteState): void;
  /** Read current URL state. Returns null when URL doesn't decode to a valid page. */
  parseCurrent(): RouteState | null;
}

/**
 * @deprecated 0.5.0 — renamed to `IRouter` (multiple router implementations
 * now exist). Type alias kept for back-compat; will be removed in a future
 * major version.
 */
export type IHashRouter = IRouter;

/**
 * Discriminated union for `enableRouter`. Three variants:
 *
 *   `false`               — no router (default; widget runs in memory only)
 *   `true`                — back-compat alias for `{ mode: 'hash' }`
 *   `{ mode: 'hash' }`    — HashRouter (`#fragment`)
 *   `{ mode: 'path', basePath: string }` — PathRouter (`/basePath/fragment`)
 *
 * Picked: `mode: 'hash'` for customer-page embeds (widget can claim
 * `#fragment` without colliding with host's path/query routing);
 * `mode: 'path'` when the widget owns the URL space (Campaign Pages
 * etc. — `basePath` carves out the URL prefix, fragment fills the rest).
 */
export type RouterOption =
  | false
  | true
  | { mode: 'hash'; pathContextKey?: string }
  | { mode: 'path'; basePath: string; pathContextKey?: string };

export interface HashRouterOptions {
  validPages?: ReadonlyArray<string>;
  /**
   * Which state key occupies the second path segment. Default `'productId'`
   * matches existing widget conventions; rename when an app's nav model
   * uses different terminology (e.g. `'menuId'` for restaurant menus).
   */
  pathContextKey?: string;
}

export class HashRouter implements IRouter {
  private onNavigate: RouterOnNavigate;
  private boundHandler: () => void;
  private validPages: ReadonlySet<string> | null;
  private pathContextKey: string;

  constructor(onNavigate: RouterOnNavigate, options: HashRouterOptions = {}) {
    this.onNavigate = onNavigate;
    this.boundHandler = this.handleHashChange.bind(this);
    this.validPages = options.validPages ? new Set(options.validPages) : null;
    this.pathContextKey = options.pathContextKey ?? 'productId';
  }

  start(): void {
    window.addEventListener('hashchange', this.boundHandler);
  }

  stop(): void {
    window.removeEventListener('hashchange', this.boundHandler);
  }

  push(state: RouteState): void {
    const hash = '#' + stateToFragment(state, { pathContextKey: this.pathContextKey });
    if (window.location.hash !== hash) {
      window.location.hash = hash;
    }
  }

  /**
   * Replace current state without adding a history entry. Falls back to
   * direct hash assignment in srcDoc iframes where History API access is
   * cross-origin-restricted.
   */
  replace(state: RouteState): void {
    const hash = '#' + stateToFragment(state, { pathContextKey: this.pathContextKey });
    try {
      const url = window.location.pathname + window.location.search + hash;
      window.history.replaceState(null, '', url);
    } catch {
      if (window.location.hash !== hash) {
        window.location.hash = hash;
      }
    }
  }

  parseCurrent(): RouteState | null {
    const hash = window.location.hash;
    if (!hash.startsWith('#')) return null;
    return fragmentToState(hash.slice(1), {
      pathContextKey: this.pathContextKey,
      validPages: this.validPages,
    });
  }

  /**
   * @deprecated 0.5.0 — renamed to `parseCurrent()`. Multiple router
   * implementations now exist; the generic name reflects the contract.
   * This alias delegates to `parseCurrent()` for back-compat.
   */
  parseCurrentHash(): RouteState | null {
    return this.parseCurrent();
  }

  private handleHashChange(): void {
    try {
      const state = this.parseCurrent();
      if (state) {
        this.onNavigate(state);
      }
    } catch (error) {
      log.error('HashRouter error handling hash change', error, { phase: 'router' });
    }
  }
}
