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
 * Discriminated union for `enableRouter`. Four router variants plus the
 * memory-only default:
 *
 *   `false`               — no router (default; widget runs in memory only)
 *   `true`                — back-compat alias for `{ mode: 'hash' }`
 *   `{ mode: 'hash' }`    — HashRouter (`#fragment`)
 *   `{ mode: 'path', basePath: string }` — PathRouter (`/basePath/fragment`)
 *   `{ mode: 'query', paramPrefix? }`    — QueryRouter (discrete prefix-
 *                                          namespaced params)
 *
 * Picked:
 *   - `mode: 'hash'`  — customer-page embeds (widget claims `#fragment`
 *     without colliding with host's path/query routing).
 *   - `mode: 'path'`  — widget owns the URL space (Campaign Pages,
 *     framework-controlled SSR routes — `basePath` carves out the prefix).
 *   - `mode: 'query'` — customer-edge SSR (the worker SEES
 *     `?<prefix>nav=...&<prefix><field>=...` because the HTTP spec sends
 *     query strings to the server but never the URL fragment). Discrete-
 *     param shape, not an opaque blob — preserves SEO + AI-agent
 *     discoverability of individual filter dimensions. `pathContextKey`
 *     doesn't apply (there are no path segments; every state field maps
 *     to its own top-level URL param), so it's omitted from this variant.
 */
export type RouterOption =
  | false
  | true
  | { mode: 'hash'; pathContextKey?: string }
  | { mode: 'path'; basePath: string; pathContextKey?: string }
  | { mode: 'query'; paramPrefix?: string };

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

export interface QueryRouterOptions {
  /**
   * Prefix applied to every URL search-param this router emits. The
   * page selector lands at `<prefix>nav`; every other RouteState field
   * lands at `<prefix><fieldName>` (1:1 — no case conversion). Default
   * `'airo_'`. Override with a widget-namespaced prefix (`'airo_'`,
   * `'mywidget_'`) when running on a host page whose own query string
   * the widget shouldn't collide with.
   *
   * Prefix should normally include its own separator character
   * (`'airo_'`, `'commerce-'`) — otherwise `dtr` would match `dtractually`
   * during the prefix-scan decode and produce a stray state field. The
   * framework does no separator enforcement; pick a prefix that ends
   * with a non-identifier character.
   */
  paramPrefix?: string;
  /**
   * Page-id allowlist for tampering protection. Same shape + intent as
   * `HashRouterOptions.validPages` — URLs targeting unknown pages
   * decode to `null` so a hand-edited URL can't push the runtime into
   * an unintended page.
   */
  validPages?: ReadonlyArray<string>;
}

/**
 * QueryRouter — URL search-params ↔ NavigationState bridge for widgets
 * that need deep-link state to be visible to the server (customer-edge
 * SSR, crawlers, social link unfurls).
 *
 * Discrete-param encoding (not a single opaque blob): each RouteState
 * field maps to its own top-level URL param under the configured
 * prefix. The page selector lands at `<prefix>nav`:
 *
 *   { page: 'quickshop', category: 'Tennessee Whiskey', retailer: 'walmart' }
 *     → ?airo_nav=quickshop&airo_category=Tennessee+Whiskey&airo_retailer=walmart
 *
 * Why discrete params vs a single encoded blob: search-engine crawlers
 * (Google, Bing) treat individual query params as meaningful filter
 * dimensions and surface those URLs in search results. An opaque
 * `?nav=quickshop%3Fcategory%3D...` blob looks like a tracking
 * parameter to crawlers and isn't indexed. AI shopping agents read URL
 * structure the same way. Customer-side JS (driving the widget from
 * the host page's own UI) wants `pushState('?airo_category=' + value)`
 * not "serialize through the framework's encoding format then escape."
 * Shareable URLs land readable instead of as a wall of `%3F`/`%26`
 * escapes.
 *
 * Trade-off: this router does NOT share the `stateToFragment` /
 * `fragmentToState` encoding with HashRouter / PathRouter. Cross-mode
 * round-trips (decoding a hash URL with QueryRouter or vice versa)
 * won't work. Each widget picks one router mode for its lifetime;
 * cross-mode preservation isn't a real use case.
 *
 * Why query strings vs hash: HTTP sends the query string to the
 * server; it strips the URL fragment client-side before the request
 * is built. A customer-edge worker (Cloudflare Workers / Lambda@Edge /
 * Shopify Oxygen) running SSR for a widget on the customer's domain
 * reads `?airo_*` from `request.url`, decodes via `decodeNavParams`,
 * and renders the deep-linked view on first byte. Hash routers leave
 * the worker blind to deep-link state — visible flicker for users,
 * zero deep-link content for crawlers / agents.
 *
 * Why not path-mode: PathRouter assumes the widget owns the URL space.
 * On a customer's domain (`coolretailer.com/products/whiskey`) the
 * path is the customer's; widgets can't claim path segments.
 * QueryRouter carves out namespaced query params that survive the
 * customer's path routing.
 *
 * URL surface:
 *   - Reads from `window.location.search` via `URLSearchParams`.
 *   - Writes via `history.pushState` / `history.replaceState` so the
 *     URL bar updates without a navigation reload. Other host-page
 *     params (`utm_source`, `ref`, customer's own filters that DON'T
 *     match the prefix) are preserved across pushes — we only
 *     rewrite our prefixed slots.
 *   - Listens for `popstate` (back / forward button) — `hashchange`
 *     doesn't fire for search-only URL changes.
 *
 * Encoding scope: string field values only (matches `RouteState`'s
 * existing typing — `{ page: string; [key: string]: string | undefined }`).
 * Arrays / nested objects aren't part of `RouteState`'s contract; if
 * a cartridge wants array filter values, join/split at the cartridge
 * layer (`?airo_brands=walmart,target` → `'walmart,target'.split(',')`).
 */
export class QueryRouter implements IRouter {
  private onNavigate: RouterOnNavigate;
  private boundHandler: () => void;
  private paramPrefix: string;
  private validPages: ReadonlySet<string> | null;

  constructor(onNavigate: RouterOnNavigate, options: QueryRouterOptions = {}) {
    this.onNavigate = onNavigate;
    this.boundHandler = this.handlePopState.bind(this);
    this.paramPrefix = options.paramPrefix ?? 'airo_';
    this.validPages = options.validPages ? new Set(options.validPages) : null;
  }

  start(): void {
    window.addEventListener('popstate', this.boundHandler);
  }

  stop(): void {
    window.removeEventListener('popstate', this.boundHandler);
  }

  push(state: RouteState): void {
    const url = this.buildUrl(state);
    if (this.currentUrl() !== url) {
      window.history.pushState(null, '', url);
    }
  }

  replace(state: RouteState): void {
    const url = this.buildUrl(state);
    if (this.currentUrl() !== url) {
      window.history.replaceState(null, '', url);
    }
  }

  parseCurrent(): RouteState | null {
    const params = new URLSearchParams(window.location.search);
    return paramsToState(params, this.paramPrefix, this.validPages);
  }

  /**
   * Build a full pathname + search + hash URL with our prefixed slots
   * updated to encode `state`. Other search params on the current URL
   * are preserved — we delete only the OLD prefixed slots (the
   * previous state's), then set the new ones. Host-page params that
   * don't match the prefix (utm_*, ref, customer filters) survive.
   */
  private buildUrl(state: RouteState): string {
    const params = new URLSearchParams(window.location.search);
    // Drop any existing prefixed slots from the prior state — we'll
    // re-set the current state's slots below. Without this, removing
    // a field from state would leave its stale URL slot behind.
    for (const key of Array.from(params.keys())) {
      if (key.startsWith(this.paramPrefix)) params.delete(key);
    }
    writeStateToParams(state, this.paramPrefix, params);
    const search = params.toString();
    return (
      window.location.pathname +
      (search ? '?' + search : '') +
      window.location.hash
    );
  }

  private currentUrl(): string {
    return window.location.pathname + window.location.search + window.location.hash;
  }

  private handlePopState(): void {
    try {
      const state = this.parseCurrent();
      if (state) {
        this.onNavigate(state);
      }
    } catch (error) {
      log.error('QueryRouter error handling popstate', error, { phase: 'router' });
    }
  }
}

/**
 * Reserved sub-key under `paramPrefix` that carries the page selector.
 * `<prefix>nav` was picked over `<prefix>page` to match the pre-pivot
 * convention (a `<prefix>_nav` param lineage) so consumers migrating
 * from single-blob query mode don't have to relearn the page-selector
 * URL key.
 */
const PAGE_PARAM_SUFFIX = 'nav';

/**
 * Write every field of `state` into `params` under `prefix`. The `page`
 * field maps to `<prefix>nav`; other fields preserve their RouteState
 * key name verbatim under the prefix (1:1, no case conversion). Empty
 * / undefined values are skipped — they'd serialize as empty URL slots
 * which create ambiguity between "absent" and "explicitly empty."
 *
 * Module-private — exposed via `QueryRouter.buildUrl` and the
 * `routerHrefFor` query case. If a use case appears for explicit empty
 * encoding (rare), graduate to the public surface.
 */
function writeStateToParams(
  state: RouteState,
  prefix: string,
  params: URLSearchParams,
): void {
  for (const [key, value] of Object.entries(state)) {
    if (value === undefined || value === '') continue;
    const paramKey = key === 'page' ? prefix + PAGE_PARAM_SUFFIX : prefix + key;
    params.set(paramKey, value);
  }
}

/**
 * Decode prefix-namespaced URL params into a RouteState. Reads every
 * param whose key starts with `prefix`, strips the prefix, and
 * assembles the state. The reserved `<prefix>nav` slot becomes
 * `state.page`; every other matching key becomes a same-named state
 * field. Non-matching params are ignored — host-page params
 * (`utm_source`, `ref`) coexist freely.
 *
 * Returns `null` when no `<prefix>nav` is present (no page selector =
 * no widget-driving URL state). Also `null` when `validPages` is set
 * and the decoded page id isn't in the allowlist — same fail-closed
 * semantic as `fragmentToState`.
 *
 * Module-private — the public surface is `decodeNavParams` (server-
 * side) and `QueryRouter.parseCurrent` (client-side), which both
 * delegate here. Keep the two entry points consistent: they're the
 * symmetric trust-gate that makes SSR-then-hydrate honest.
 */
function paramsToState(
  params: URLSearchParams,
  prefix: string,
  validPages: ReadonlySet<string> | null,
): RouteState | null {
  const pageParam = params.get(prefix + PAGE_PARAM_SUFFIX);
  if (!pageParam) return null;
  if (validPages && !validPages.has(pageParam)) return null;

  const state: RouteState = { page: pageParam };
  const pageKey = prefix + PAGE_PARAM_SUFFIX;
  for (const [key, value] of params.entries()) {
    if (!key.startsWith(prefix)) continue;
    if (key === pageKey) continue;
    const stateKey = key.slice(prefix.length);
    if (!stateKey) continue; // skip the bare prefix itself (no field name)
    state[stateKey] = value;
  }
  return state;
}

/**
 * Server-side decoder for query-mode routing. Worker / SSR runner
 * pattern:
 *
 *   import { decodeNavParams } from '@airo-js/core';
 *
 *   const url = new URL(request.url);
 *   const navState = decodeNavParams(url.searchParams, {
 *     paramPrefix: 'airo_',
 *     validPages: appConfig.pages.map((p) => p.id),
 *   });
 *   // → { page: 'quickshop', category: '...', retailer: '...' } or null
 *
 * Pure URL parsing — no DOM, no Node-specific imports. Symmetric with
 * `QueryRouter.parseCurrent` on the client; the same `(searchParams,
 * paramPrefix, validPages)` triplet yields the same `RouteState` on
 * both sides of the SSR-then-hydrate boundary.
 *
 * `validPages` is mandatory because nav params are untrusted URL data
 * crossing into the framework. The allowlist gate fails closed by
 * default; pass the cartridge's known page-id set or the active
 * cartridge's `template.pages.map(p => p.id)`.
 */
export interface DecodeNavParamsOptions {
  paramPrefix?: string;
  validPages: ReadonlyArray<string>;
}

export function decodeNavParams(
  searchParams: URLSearchParams,
  options: DecodeNavParamsOptions,
): RouteState | null {
  const prefix = options.paramPrefix ?? 'airo_';
  const validSet = new Set(options.validPages);
  return paramsToState(searchParams, prefix, validSet);
}

/**
 * Build an anchor href that matches the active router's URL shape.
 * Cartridges call this from inside `template(ctx)` to produce links
 * that work with whatever router the host configured at mount time:
 *
 *   routerHrefFor(false, { page: 'quickshop' })
 *     → '#'   (no router — memory-only nav; href is a no-op anchor)
 *   routerHrefFor({ mode: 'hash' }, { page: 'quickshop', category: 'whiskey' })
 *     → '#quickshop?category=whiskey'
 *   routerHrefFor({ mode: 'path', basePath: '/c/xyz' }, { page: 'quickshop' })
 *     → '/c/xyz/quickshop'
 *   routerHrefFor({ mode: 'query', paramPrefix: 'airo_' },
 *                 { page: 'quickshop', category: 'whiskey' })
 *     → '?airo_nav=quickshop&airo_category=whiskey'
 *
 * Pure function — no DOM, no globals. Cartridges pass the same
 * `RouterOption` they configured at mount time; no need to thread the
 * router instance through `RenderContext`.
 *
 * Query-mode caveat: the href only includes the router's own prefixed
 * slots — it doesn't carry forward host-page params (`utm_source`,
 * `ref`, etc.). The browser's anchor-navigation default REPLACES the
 * current query string with the href's at click time, so any host-page
 * params on the current URL get dropped unless the cartridge captures
 * them. If the cartridge needs to preserve them, it can either: (a)
 * use `QueryRouter.push(state)` from a click handler instead of an
 * anchor href (push preserves non-prefixed params), or (b) read
 * `window.location.search` in the renderer and concatenate.
 *
 * Encoding contract: query-mode hrefs go through `URLSearchParams` so
 * the serialization matches what `QueryRouter.push` writes byte-for-
 * byte. Without this alignment, anchor click + programmatic push of
 * the same state would produce different URL strings (`%20` vs `+` for
 * space, etc.) and trip the push idempotency check.
 */
export function routerHrefFor(
  option: RouterOption,
  state: RouteState,
): string {
  if (option === false) {
    // Memory-only nav. Anchor needs *some* href; '#' is the conventional
    // "no-op link" shape that doesn't trigger a page reload.
    return '#';
  }
  const normalized = option === true ? { mode: 'hash' as const } : option;
  switch (normalized.mode) {
    case 'hash': {
      const fragment = stateToFragment(state, {
        pathContextKey: normalized.pathContextKey,
      });
      return '#' + fragment;
    }
    case 'path': {
      const fragment = stateToFragment(state, {
        pathContextKey: normalized.pathContextKey,
      });
      const base = normalized.basePath.replace(/\/+$/, '');
      return base + '/' + fragment;
    }
    case 'query': {
      const prefix = normalized.paramPrefix ?? 'airo_';
      const params = new URLSearchParams();
      writeStateToParams(state, prefix, params);
      const search = params.toString();
      return search ? '?' + search : '';
    }
  }
}
