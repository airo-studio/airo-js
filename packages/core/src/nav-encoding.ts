/**
 * Nav-state ↔ URL-fragment encoding. Pure functions shared across every
 * router implementation (HashRouter, PathRouter, future QueryRouter or
 * SearchParamsRouter). Single source of truth for the encoding shape;
 * routers wrap it with their URL surface (hash, path, search).
 *
 * Fragment shape: `{page}/{contextValue}?key1=value1&key2=value2`
 *   - First path segment is always the page id.
 *   - Optional second path segment encodes one "context" key (default
 *     `'productId'` — apps narrow `RouteState` to declare otherwise).
 *   - Everything else rides as URL-encoded query params.
 *
 * The fragment is what lives inside `#...` for HashRouter, inside
 * `/basePath/...` for PathRouter, and inside `?nav=...` for any future
 * query-mode router. Same encoding, different wrappings.
 *
 * Also exports two server-facing helpers:
 *   - `decodeNavHint(hint, validPages)` — server-side SSR primitive.
 *     Takes a bare fragment (`'products/abc'` — no `#`, no `?`, no `/`)
 *     and returns the decoded RouteState, gated on validPages so
 *     malicious / typo'd deeplinks fail closed.
 *   - `extractPathTail(pathname, basePath)` — strips the basePath
 *     prefix from a full URL pathname, returning the bare fragment.
 *     Handles trailing-slash variants and the basePath boundary
 *     ambiguity (e.g. `/campaign/xyz` vs `/campaign/xyzabc`).
 */

import type { RouteState } from './router.js';

export interface NavEncodingOptions {
  /**
   * Which state key occupies the second path segment. Default `'productId'`
   * matches existing widget conventions; rename when an app's nav model
   * uses different terminology (e.g. `'menuId'` for restaurant menus).
   */
  pathContextKey?: string;
}

export interface NavDecodeOptions extends NavEncodingOptions {
  /**
   * Gate decoded states by allowed page id. When provided, fragments
   * targeting unknown pages decode to `null` — closes the
   * tamper-from-customer-page surface that any client-readable URL
   * would otherwise expose.
   */
  validPages?: ReadonlySet<string> | ReadonlyArray<string> | null;
}

const DEFAULT_PATH_CONTEXT_KEY = 'productId';

/**
 * Encode RouteState into a bare URL fragment (no `#` prefix, no `?` prefix,
 * no leading `/`). Caller wraps with their URL surface (hash, path, search).
 */
export function stateToFragment(
  state: RouteState,
  options: NavEncodingOptions = {},
): string {
  const pathContextKey = options.pathContextKey ?? DEFAULT_PATH_CONTEXT_KEY;
  let path = state.page;
  const ctx = state[pathContextKey];
  if (ctx) {
    path += '/' + encodeURIComponent(ctx);
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(state)) {
    if (key === 'page' || key === pathContextKey) continue;
    if (value !== undefined && value !== '') params.set(key, value);
  }
  const queryString = params.toString();
  return path + (queryString ? '?' + queryString : '');
}

/**
 * Decode a bare URL fragment into RouteState. Returns null on malformed
 * input, empty input, or — when `validPages` is supplied — when the
 * decoded `page` isn't in the allowlist.
 */
export function fragmentToState(
  fragment: string,
  options: NavDecodeOptions = {},
): RouteState | null {
  if (!fragment) return null;

  const pathContextKey = options.pathContextKey ?? DEFAULT_PATH_CONTEXT_KEY;
  const validSet = normalizeValidPages(options.validPages);

  const [pathPart, queryPart] = fragment.split('?');
  if (!pathPart) return null;
  const pathSegments = pathPart.split('/').filter(Boolean);
  if (pathSegments.length === 0) return null;

  const page = pathSegments[0];
  if (!page) return null;
  if (validSet && !validSet.has(page)) return null;

  const state: RouteState = { page };
  if (pathSegments[1]) {
    state[pathContextKey] = decodeURIComponent(pathSegments[1]);
  }

  const params = new URLSearchParams(queryPart || '');
  for (const [key, value] of params.entries()) {
    state[key] = value;
  }
  return state;
}

/**
 * URL nav-hint decoder. Used by BOTH sides of the SSR-then-hydrate
 * boundary to derive an entry page from a URL-encoded hint:
 *
 *   - **Server (SSR runner)** — decode the hint forwarded by the embed
 *     loader (`?nav=...` query param, or a path tail from
 *     `extractPathTail`) into a `RouteState` the SSR runner passes as
 *     `entryPageId` to `renderAppWithPublication`.
 *   - **Browser (runtime bootstrap)** — decode the same hint (the slice
 *     of `window.location.hash` after `#`, or whatever the embed shim
 *     hands through) so the client mounts the SAME entry page the
 *     server rendered. Symmetric trust gate using the same
 *     `validPages` allowlist on both sides keeps hydration honest.
 *
 * Pure string/URL parsing — no DOM, no Node-specific imports. Safe to
 * call from anywhere.
 *
 * `validPages` is mandatory because navHint is untrusted URL data
 * crossing into the framework. The allowlist gate fails closed by
 * default; pass the cartridge's known page-id set or the active
 * cartridge's `template.pages.map(p => p.id)`.
 *
 * ## When NOT to use this — surfaces that own their urls
 *
 * The allowlist makes this decoder fail closed by returning `null`, and
 * a `null` hint is indistinguishable from "no page was requested". On a
 * surface that owns its urls that distinction is the whole ballgame:
 * `/does-not-exist` and `/` both arrive as "nothing requested", the SSR
 * runner renders the entry page for both, and the unknown url answers
 * `200` with a canonical pointing elsewhere — a soft 404.
 *
 * Two gates in series, and the outer one silences the inner one. The
 * runner ALREADY validates the entry page (exists, enabled, not a
 * subpage, not a gate) and re-derives `navState.page` from the page it
 * actually resolved, so a page id it rejects can never reach a renderer.
 * The allowlist here is belt-and-braces over that check — valuable when
 * the host cannot act on the difference, harmful when it can.
 *
 * So on a root-mounted or otherwise owned-url path surface, decode with
 * `fragmentToState(tail, { pathContextKey })` and let the runner gate.
 * The requested id then reaches the runner, which reports its judgement
 * as `fellBack` on the SSR result, and the host answers 404 on
 * `reason: 'unknown-page'`. See best-practices §5.10a.
 *
 * Keep `decodeNavHint` for the embed and query surfaces, where the url
 * belongs to the customer's page rather than to you: there falling back
 * silently is mandatory (a widget must not break a host page over an
 * unrecognised path segment), so failing closed in the decoder is
 * exactly right and there is nothing for a host to act on.
 */
export function decodeNavHint(
  hint: string | null | undefined,
  validPages: ReadonlyArray<string>,
  options: NavEncodingOptions = {},
): RouteState | null {
  if (!hint) return null;
  return fragmentToState(hint, {
    pathContextKey: options.pathContextKey,
    validPages,
  });
}

/**
 * Strip a `basePath` prefix from a full URL pathname, returning the bare
 * fragment (or null when the pathname doesn't belong to this basePath).
 *
 * Verified behaviour for the three URL shapes that surface in deep-link
 * scenarios:
 *
 *   basePath = '/campaign/xyz'
 *   ┌──────────────────────────────────┬──────────────────┐
 *   │ pathname                         │ returns          │
 *   ├──────────────────────────────────┼──────────────────┤
 *   │ '/campaign/xyz'                  │ null             │
 *   │ '/campaign/xyz/'                 │ null             │
 *   │ '/campaign/xyz/products/abc'     │ 'products/abc'   │
 *   │ '/campaign/xyzabc/foo'           │ null  (boundary) │
 *   │ '/other/path'                    │ null             │
 *   └──────────────────────────────────┴──────────────────┘
 *
 * The boundary check (third row from bottom) is the subtle correctness
 * win — naive `pathname.startsWith(basePath)` returns `true` for
 * `/campaign/xyzabc` when basePath is `/campaign/xyz`, then strips
 * incorrectly. We require the next char after `basePath` to be `/` or
 * end-of-string so adjacent widget ids don't collide.
 */
export function extractPathTail(pathname: string, basePath: string): string | null {
  const normalizedBase = basePath.replace(/\/+$/, '');  // strip trailing slashes
  if (!pathname.startsWith(normalizedBase)) return null;

  const rest = pathname.slice(normalizedBase.length);
  // Boundary: empty rest is fine (exact basePath match); otherwise the
  // next char must be '/' so '/campaign/xyzabc' doesn't pass for
  // basePath = '/campaign/xyz'.
  if (rest.length > 0 && !rest.startsWith('/')) return null;

  const tail = rest.replace(/^\/+/, '');  // strip leading slashes
  return tail.length > 0 ? tail : null;
}

/**
 * Join a `basePath` and an encoded fragment into a path-mode URL — the
 * single encoder shared by `PathRouter.stateToUrl` and `routerHrefFor`, so
 * the two can never disagree about what URL a `RouteState` has.
 *
 * ## Why `entryPageId` exists
 *
 * `extractPathTail` returns `null` for a bare `basePath` (rows 1-2 of the
 * table above), and the SSR runner treats a null nav hint as "render the
 * default entry page". So the DECODER already accepts `basePath` as the
 * entry page. Without `entryPageId` the ENCODER never emits it — it emits
 * `basePath + '/' + entryPageId` — and the same page answers on two URLs:
 *
 *   basePath = '/'              → '/' AND '/home'
 *   basePath = '/campaign/xyz'  → '/campaign/xyz' AND '/campaign/xyz/home'
 *
 * Both 200, byte-identical. Since `routerHrefFor` is what the docs tell you
 * to build hrefs, canonicals and sitemap entries with, that asymmetry ships
 * as duplicate content with nothing erroring or warning. Passing
 * `entryPageId` collapses the bare entry state onto `basePath`, making the
 * encoder agree with the decoder.
 *
 * It also stops the entry URL being rewritten on load: `PageManager.initRouter`
 * calls `router.replace(navState)` when `parseCurrent()` returns null, which
 * is exactly the bare-`basePath` case — so a visitor landing on `/` used to
 * watch it silently become `/home`.
 *
 * ## Collapse only a BARE entry state
 *
 * The fragment must equal `entryPageId` exactly. `{ page: 'home', filter: 'x' }`
 * encodes to `home?filter=x` and stays `/home?filter=x`, because `/?filter=x`
 * would decode to a null tail and lose the filter — the collapse has to be
 * round-trip-safe, not merely shorter.
 *
 * Path mode only. Hash never reaches a server so there is no duplicate-content
 * harm, and query mode has the same shape but no consumer has hit it.
 */
export function joinPathFragment(
  basePath: string,
  fragment: string,
  entryPageId?: string,
): string {
  const normalizedBase = basePath.replace(/\/+$/, '');
  if (!fragment || fragment === entryPageId) return normalizedBase || '/';
  return `${normalizedBase}/${fragment}`;
}

function normalizeValidPages(
  validPages: ReadonlySet<string> | ReadonlyArray<string> | null | undefined,
): ReadonlySet<string> | null {
  if (validPages == null) return null;
  if (validPages instanceof Set) return validPages;
  return new Set(validPages);
}
