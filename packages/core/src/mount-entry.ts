/**
 * resolveMountEntry — the one implementation of "which page does this
 * mount start on".
 *
 * The precedence ladder is: **URL** (when a router option is set and a
 * `window` exists) **> `initialNavState` > default entry**. Until 0.11.0
 * that ladder lived only inside `PageManager`'s constructor, which runs
 * inside `createApp` — after the runtime's gate phase. A gate scoped to
 * private entries (`Gate.appliesTo: 'private'`) needs the answer BEFORE
 * `createApp`, so the ladder is a function both call; the page the gates
 * are scoped against is, by construction, the page that mounts.
 *
 * `createRouter` is the other half: the single place a `RouterOption` is
 * turned into a router instance, shared by `PageManager.initRouter` and
 * the parse-only use here. Router constructors are side-effect free —
 * listeners attach in `start()`, which this module never calls.
 */

import type { NavigationState } from './page.js';
import type { Page } from './schema.js';
import type { IRouter, RouteState, RouterOnNavigate, RouterOption } from './router.js';
import { HashRouter, QueryRouter } from './router.js';
import { PathRouter } from './path-router.js';
import {
  describeEntryResolution,
  findEntryPage,
  type EntryResolution,
} from './entry-resolution.js';

/** The page ids a router may decode to: top-level, non-gate pages. */
export function validPagesFor<TPageType extends string>(
  pages: ReadonlyArray<Page<TPageType>>,
  isGate: (type: TPageType) => boolean,
): string[] {
  return pages.filter((p) => !p.parent && !isGate(p.type)).map((p) => p.id);
}

/**
 * Build the router a `RouterOption` names. `true` is the back-compat
 * alias for `{ mode: 'hash' }`. Pure construction — call `start()` to
 * attach listeners.
 */
export function createRouter(
  option: Exclude<RouterOption, false>,
  onNavigate: RouterOnNavigate,
  validPages: ReadonlyArray<string>,
): IRouter {
  const mode: 'hash' | 'path' | 'query' = option === true ? 'hash' : option.mode;
  if (mode === 'hash') {
    // `pathContextKey` belongs to the hash/path family; the `true` alias
    // has no override.
    const hashOpt = option === true ? {} : (option as { pathContextKey?: string });
    return new HashRouter(onNavigate, { validPages, pathContextKey: hashOpt.pathContextKey });
  }
  if (mode === 'path') {
    const pathOpt = option as {
      mode: 'path';
      basePath: string;
      pathContextKey?: string;
      entryPageId?: string;
    };
    return new PathRouter(onNavigate, {
      basePath: pathOpt.basePath,
      validPages,
      pathContextKey: pathOpt.pathContextKey,
      // Opt-in, NOT defaulted to the template's entry page. Turning it on
      // changes which url the entry page canonicalises to, which is an SEO
      // event for anyone with `basePath/<entryPageId>` already indexed —
      // their call to make, not a side effect of upgrading.
      entryPageId: pathOpt.entryPageId,
    });
  }
  // `mode === 'query'` — `paramPrefix` optional, defaults inside QueryRouter.
  const queryOpt = option as { mode: 'query'; paramPrefix?: string };
  return new QueryRouter(onNavigate, { paramPrefix: queryOpt.paramPrefix, validPages });
}

/**
 * What the current URL names, or `null` when there is no router option,
 * no `window` (server, node tests), the URL carries no state, or the
 * router cannot be built. Never throws — a broken router disables URL
 * routing, it does not stop a mount.
 */
export function parseRouterUrl(
  option: RouterOption | undefined,
  validPages: ReadonlyArray<string>,
): RouteState | null {
  if (!option || typeof window === 'undefined') return null;
  try {
    return createRouter(option, () => {}, validPages).parseCurrent();
  } catch {
    return null;
  }
}

export interface ResolveMountEntryOptions<TPageType extends string> {
  pages: ReadonlyArray<Page<TPageType>>;
  /** Predicate identifying pages that are gate UI, never an entry. Default: none. */
  isGatePage?: (pageType: TPageType) => boolean;
  /** The mount's router option; the URL is consulted only when set and a `window` exists. */
  enableRouter?: RouterOption;
  /** Host-supplied mount-time state; outranks the default entry, outranked by the URL. */
  initialNavState?: Partial<NavigationState>;
}

export interface MountEntry<TPageType extends string> {
  /** The seeded navigation state after the ladder. `page` is an id. */
  navState: NavigationState;
  /** The resolution of `navState.page` against the graph, with `fellBack` when it was rejected. */
  resolution: EntryResolution<TPageType>;
  /** `resolution.page` — the page this mount starts on, or `undefined` when the graph has no entry. */
  page: Page<TPageType> | undefined;
}

/**
 * Run the ladder. Deterministic given the same inputs and the same URL,
 * so the runtime (before gates) and `PageManager` (at construction) reach
 * the same page — provided the URL did not change in between. The gate
 * phase is async (network, user input), so it can: the runtime compares
 * the page it scoped the gates against with the page the App actually
 * mounted and narrates a disagreement (`log.warn`) rather than pretend
 * the two are one by construction.
 */
export function resolveMountEntry<TPageType extends string>(
  opts: ResolveMountEntryOptions<TPageType>,
): MountEntry<TPageType> {
  const isGate = opts.isGatePage ?? (() => false);
  const entry = findEntryPage(opts.pages, isGate);
  // Seed precedence: default entry → host-supplied initialNavState → URL
  // state. Last write wins, so URL beats host config beats default.
  let navState: NavigationState = {
    page: entry?.id ?? '',
    ...(opts.initialNavState ?? {}),
  };
  const parsed = parseRouterUrl(opts.enableRouter, validPagesFor(opts.pages, isGate));
  if (parsed) navState = { ...navState, ...parsed };
  const resolution = describeEntryResolution(opts.pages, isGate, navState.page);
  return { navState, resolution, page: resolution.page };
}
