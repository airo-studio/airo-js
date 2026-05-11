/**
 * Breadcrumb — data-only navigation trail helper.
 *
 * Walks the pages array in order and asks a label resolver for each page:
 *   - return a string  → include this page in the trail with that label
 *   - return null      → skip this page (e.g. doesn't contribute)
 *   - return undefined → fall back to the page id
 *
 * The framework doesn't know which page types contribute or what their
 * labels should be — that's domain knowledge owned by the resolver. The
 * framework also doesn't render anything: cartridges consume the `Crumb[]`
 * output and paint their own HTML / class names / event wiring.
 */

import type { Page, PageId } from './schema.js';
import type { NavigationState } from './page.js';

export interface Crumb {
  pageId?: PageId;
  label: string;
  isCurrent: boolean;
}

/**
 * Resolve the breadcrumb label for a page. Return null to skip the page,
 * undefined to fall back to the page id, or a string to use as the label.
 */
export type LabelResolver<TPageType extends string = string> = (
  page: Page<TPageType>,
  navState: NavigationState,
) => string | null | undefined;

export function buildCrumbs<TPageType extends string>(
  pages: ReadonlyArray<Page<TPageType>>,
  activePageId: PageId,
  navState: NavigationState,
  labelResolver?: LabelResolver<TPageType>,
  isGatePage?: (pageType: TPageType) => boolean,
): Crumb[] {
  if (!pages?.length) return [];

  const active = pages.find((p) => p.id === activePageId);
  const anchorId = active?.parent ?? activePageId;
  const isGate = isGatePage ?? (() => false);

  const trail: Crumb[] = [];
  for (const page of pages) {
    if (page.parent) continue;
    if (!page.enabled) continue;
    if (isGate(page.type)) continue;

    const isCurrent = page.id === anchorId;
    const resolved = labelResolver?.(page, navState);
    if (resolved === null) {
      if (isCurrent) break;
      continue;
    }
    const label = typeof resolved === 'string' ? resolved : page.id;

    trail.push({ pageId: page.id, label, isCurrent });
    if (isCurrent) break;
  }

  return trail;
}
