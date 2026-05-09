/**
 * HashRouter — URL hash ↔ NavigationState bridge.
 *
 * Hash format: `#{page}/{contextValue}?key=value&...`
 *
 * Examples:
 *   #products
 *   #products?filter=Electronics
 *   #product/prod-123
 *   #product/prod-123?filter=Electronics
 *
 * The router is shape-agnostic: `RouteState` is a plain key/value bag the
 * caller narrows to its app's nav schema. The first key in the URL path is
 * always `page`; everything else is encoded as query params.
 *
 * Apps narrow `RouteState` to declare which keys they actually use; the
 * `pathContextKey` option lets the host pick which key occupies the
 * second path segment.
 */

export interface RouteState {
  page: string;
  [key: string]: string | undefined;
}

import { logger } from '@airo-js/log';

const log = logger('core');

export type RouterOnNavigate = (state: RouteState) => void;

export interface IHashRouter {
  start(): void;
  stop(): void;
  push(state: RouteState): void;
  replace(state: RouteState): void;
  parseCurrentHash(): RouteState | null;
}

export interface HashRouterOptions {
  validPages?: ReadonlyArray<string>;
  /**
   * Which state key occupies the second path segment. Default `'productId'`
   * matches existing widget conventions; rename when an app's nav model
   * uses different terminology (e.g. `'menuId'` for restaurant menus).
   */
  pathContextKey?: string;
}

export class HashRouter implements IHashRouter {
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
    const hash = this.stateToHash(state);
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
    const hash = this.stateToHash(state);
    try {
      const url = window.location.pathname + window.location.search + hash;
      window.history.replaceState(null, '', url);
    } catch {
      if (window.location.hash !== hash) {
        window.location.hash = hash;
      }
    }
  }

  parseCurrentHash(): RouteState | null {
    return this.hashToState(window.location.hash);
  }

  private stateToHash(state: RouteState): string {
    let path = state.page;
    const ctx = state[this.pathContextKey];
    if (ctx) {
      path += '/' + encodeURIComponent(ctx);
    }
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(state)) {
      if (key === 'page' || key === this.pathContextKey) continue;
      if (value !== undefined && value !== '') params.set(key, value);
    }
    const queryString = params.toString();
    return '#' + path + (queryString ? '?' + queryString : '');
  }

  private hashToState(hash: string): RouteState | null {
    if (!hash.startsWith('#')) return null;
    const hashContent = hash.slice(1);
    if (!hashContent) return null;

    const [pathPart, queryPart] = hashContent.split('?');
    if (!pathPart) return null;
    const pathSegments = pathPart.split('/').filter(Boolean);
    if (pathSegments.length === 0) return null;

    const page = pathSegments[0];
    if (!page) return null;
    if (this.validPages && !this.validPages.has(page)) return null;

    const state: RouteState = { page };
    if (pathSegments[1]) {
      state[this.pathContextKey] = decodeURIComponent(pathSegments[1]);
    }

    const params = new URLSearchParams(queryPart || '');
    for (const [key, value] of params.entries()) {
      state[key] = value;
    }
    return state;
  }

  private handleHashChange(): void {
    try {
      const state = this.parseCurrentHash();
      if (state) {
        this.onNavigate(state);
      }
    } catch (error) {
      log.error('HashRouter error handling hash change', error, { phase: 'router' });
    }
  }
}
