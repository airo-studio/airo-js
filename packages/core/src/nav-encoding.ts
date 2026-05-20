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

function normalizeValidPages(
  validPages: ReadonlySet<string> | ReadonlyArray<string> | null | undefined,
): ReadonlySet<string> | null {
  if (validPages == null) return null;
  if (validPages instanceof Set) return validPages;
  return new Set(validPages);
}
