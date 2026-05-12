/**
 * PathRouter — URL pathname ↔ NavigationState bridge for widgets that
 * own their URL space (Campaign Pages, edge-rendered pages, anywhere
 * the host server controls the path).
 *
 *   basePath = '/campaign/xyz'
 *   state    = { page: 'product', productId: 'abc' }
 *   URL      = '/campaign/xyz/product/abc'
 *
 * Same encoding shape as HashRouter (via `stateToFragment` /
 * `fragmentToState` from `nav-encoding.ts`) — only the URL surface
 * differs. State serialised to a fragment, fragment concatenated onto
 * `basePath`, written via History API. PopState event drives navigation
 * back into the framework.
 *
 * Why PathRouter exists (vs HashRouter for everything): hash is stripped
 * by browsers before sending HTTP requests. Servers never see
 * `dotter.me/campaign/xyz#/product/abc` as `#/product/abc` — they see
 * `dotter.me/campaign/xyz` and have to entry-page-only SSR. PathRouter
 * gives the server the full deeplink in `req.url`, enabling zero-flash
 * SSR. The cost is the host server has to register a wildcard route
 * (`/campaign/:widgetId/*`) and call `decodeNavHint` on the path tail.
 *
 * Why HashRouter still exists: customer-page embeds run on someone else's
 * HTML. The widget can't claim path space (the host owns it). Hash is
 * the only URL surface a widget can use without colliding.
 */

import { logger } from '@airo-js/log';
import {
  extractPathTail,
  fragmentToState,
  stateToFragment,
} from './nav-encoding.js';
import type { IRouter, RouterOnNavigate, RouteState } from './router.js';

const log = logger('core');

export interface PathRouterOptions {
  /**
   * URL prefix the widget owns. Everything after `basePath` (separated
   * by `/`) is the encoded navigation fragment. Required — there's no
   * sensible default (widget IDs vary; the caller knows their URL
   * carve-out).
   *
   * Trailing slashes are normalized away — `'/campaign/xyz/'` and
   * `'/campaign/xyz'` behave identically.
   */
  basePath: string;
  validPages?: ReadonlyArray<string>;
  /**
   * Which state key occupies the second path segment after the page id.
   * Default `'productId'`. See HashRouterOptions.pathContextKey.
   */
  pathContextKey?: string;
}

export class PathRouter implements IRouter {
  private onNavigate: RouterOnNavigate;
  private basePath: string;
  private validPages: ReadonlySet<string> | null;
  private pathContextKey: string;
  private boundHandler: () => void;

  constructor(onNavigate: RouterOnNavigate, options: PathRouterOptions) {
    this.onNavigate = onNavigate;
    this.basePath = options.basePath.replace(/\/+$/, '');
    this.validPages = options.validPages ? new Set(options.validPages) : null;
    this.pathContextKey = options.pathContextKey ?? 'productId';
    this.boundHandler = this.handlePopState.bind(this);
  }

  start(): void {
    window.addEventListener('popstate', this.boundHandler);
  }

  stop(): void {
    window.removeEventListener('popstate', this.boundHandler);
  }

  push(state: RouteState): void {
    const url = this.stateToUrl(state);
    if (window.location.pathname + window.location.search !== url) {
      try {
        window.history.pushState(null, '', url);
      } catch (error) {
        log.error('PathRouter pushState failed', error, { phase: 'router', url });
      }
    }
  }

  replace(state: RouteState): void {
    const url = this.stateToUrl(state);
    try {
      window.history.replaceState(null, '', url);
    } catch (error) {
      log.error('PathRouter replaceState failed', error, { phase: 'router', url });
    }
  }

  parseCurrent(): RouteState | null {
    const tail = extractPathTail(window.location.pathname, this.basePath);
    if (tail == null) return null;
    // Concatenate search so query-string state (?filter=foo&sort=price)
    // survives round-trips. stateToUrl emits search alongside the path
    // tail; parseCurrent must read both halves back.
    const fragment = tail + window.location.search;
    return fragmentToState(fragment, {
      pathContextKey: this.pathContextKey,
      validPages: this.validPages,
    });
  }

  private stateToUrl(state: RouteState): string {
    const fragment = stateToFragment(state, { pathContextKey: this.pathContextKey });
    return fragment ? `${this.basePath}/${fragment}` : this.basePath || '/';
  }

  private handlePopState(): void {
    try {
      const state = this.parseCurrent();
      if (state) {
        this.onNavigate(state);
      }
    } catch (error) {
      log.error('PathRouter error handling popstate', error, { phase: 'router' });
    }
  }
}
