/**
 * Entry resolution — which page a mount starts on, and why a requested
 * one was rejected.
 *
 * Shared by `PageManager` (client), the SSR runner and the runtime's gate
 * phase (via `resolveMountEntry`), so every side agrees on what "default
 * entry" means. Lives in its own module (0.11.0) so `mount-entry.ts` can
 * import it without a cycle through `page-manager.ts`; the page manager
 * re-exports these for its existing callers.
 */

import type { Page } from './schema.js';

/**
 * Default entry-page selection. First enabled, non-gate, non-subpage page
 * in the configured order. Shared by PageManager + SSR runner so both
 * agree on what "default entry" means.
 */
export function findEntryPage<TPageType extends string>(
  pages: ReadonlyArray<Page<TPageType>>,
  isGate: (type: TPageType) => boolean,
): Page<TPageType> | undefined {
  return pages.find((p) => p.enabled && !isGate(p.type) && !p.parent);
}

/**
 * Resolve the entry page given an optional preferred id. Used by
 * `PageManager.mountInitial` and the SSR runner. The preferred id wins
 * only when it points to an enabled, non-subpage, non-gate page in the
 * config; otherwise falls back to `findEntryPage` so tampered or stale
 * deeplinks never crash the runtime.
 */
export function resolveEntryPage<TPageType extends string>(
  pages: ReadonlyArray<Page<TPageType>>,
  isGate: (type: TPageType) => boolean,
  preferredId?: string,
): Page<TPageType> | undefined {
  return describeEntryResolution(pages, isGate, preferredId).page;
}

/** Why a requested entry id was rejected in favour of the default entry. */
export type EntryFallbackReason =
  /** No page in the graph has this id. */
  | 'unknown-page'
  /** The page exists but `enabled` is false. */
  | 'disabled'
  /** The page exists but is a subpage — subpages activate through their parent. */
  | 'subpage'
  /** The page exists but `isGatePage` claims its type. */
  | 'gate-page';

export interface EntryResolution<TPageType extends string> {
  page: Page<TPageType> | undefined;
  /**
   * Present ONLY when a preferred id was supplied and rejected. Absent
   * when no id was requested (a bare `basePath`, the legitimate entry
   * case) and when the requested id resolved.
   */
  fellBack?: { requested: string; reason: EntryFallbackReason };
}

/**
 * `resolveEntryPage`, plus WHY it fell back.
 *
 * The resolver already validates a requested id against the page graph
 * and silently substitutes the default entry — deliberately, so a
 * tampered or stale deeplink can never crash a render. Taken literally
 * that serves the home page at `/does-not-exist` with a 200 and a
 * canonical of `/`: a soft 404, which search engines penalise, and which
 * nothing errors or warns about. Two independent consumers shipped it
 * without noticing.
 *
 * The right answer is PER SURFACE, not per consumer — the same codebase
 * routinely serves several. On its own crawlable domain an unknown tail
 * is a 404. On a customer's page, where the URL belongs to the customer's
 * router and the tail may have nothing to do with this widget at all,
 * falling back is mandatory: a widget that refused to render because it
 * did not recognise a path segment would be a vendor breaking a
 * customer's page. That is why the fallback will never be reversed, and
 * why the framework cannot pick.
 *
 * So the fallback stays and the DECISION stops being thrown away. The
 * runner is the only party that knows the decode failed; the host is the
 * only party that knows what that means. HTTP status stays entirely
 * host-side — this reports what it did and has no opinion about the
 * response code.
 *
 * Callers should branch on `reason`, not on the presence of `fellBack`:
 * only `'unknown-page'` is a 404. `'disabled'` is a publisher config
 * state and `'gate-page'` is a real page in the template — both are
 * legitimate 200s that happened to resolve elsewhere.
 */
export function describeEntryResolution<TPageType extends string>(
  pages: ReadonlyArray<Page<TPageType>>,
  isGate: (type: TPageType) => boolean,
  preferredId?: string,
): EntryResolution<TPageType> {
  if (!preferredId) return { page: findEntryPage(pages, isGate) };

  const match = pages.find((p) => p.id === preferredId);
  const reason: EntryFallbackReason | undefined = !match
    ? 'unknown-page'
    : !match.enabled
      ? 'disabled'
      : match.parent
        ? 'subpage'
        : isGate(match.type)
          ? 'gate-page'
          : undefined;

  if (!reason) return { page: match };
  return {
    page: findEntryPage(pages, isGate),
    fellBack: { requested: preferredId, reason },
  };
}
