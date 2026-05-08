/**
 * Breadcrumb — data-driven navigation trail.
 *
 * Walks the pages array in order and asks a label resolver for each page:
 *   - return a string  → include this page in the trail with that label
 *   - return null      → skip this page (e.g. doesn't contribute)
 *   - return undefined → fall back to the page id
 *
 * The framework doesn't know which page types contribute or what their
 * labels should be — that's domain knowledge owned by the resolver.
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

export interface BreadcrumbHandle {
  update(activePageId: PageId, navState: NavigationState): void;
  destroy(): void;
}

export interface MountBreadcrumbOptions<TPageType extends string = string> {
  targetEl: HTMLElement;
  pages: ReadonlyArray<Page<TPageType>>;
  activePageId: PageId;
  navState: NavigationState;
  onNavigate: (pageId: PageId) => void;
  labelResolver?: LabelResolver<TPageType>;
  separator?: string;
  isGatePage?: (pageType: TPageType) => boolean;
}

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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderCrumbsHtml(
  crumbs: ReadonlyArray<Crumb>,
  separator = '›',
): string {
  if (crumbs.length === 0) return '';
  const sep = `<span class="airo-breadcrumb-sep">${escapeHtml(separator)}</span>`;
  return crumbs
    .map((c, i) => {
      const segHtml = c.isCurrent
        ? `<span class="airo-breadcrumb-current">${escapeHtml(c.label)}</span>`
        : `<button type="button" class="airo-breadcrumb-link" data-airo-breadcrumb-page="${escapeHtml(c.pageId ?? '')}">${escapeHtml(c.label)}</button>`;
      return i === 0 ? segHtml : `${sep}${segHtml}`;
    })
    .join('');
}

export function attachClickHandlers(
  containerEl: HTMLElement,
  onNavigate: (pageId: PageId) => void,
): () => void {
  const cleanups: Array<() => void> = [];
  containerEl
    .querySelectorAll<HTMLButtonElement>('.airo-breadcrumb-link')
    .forEach((btn) => {
      const pageId = btn.dataset['airoBreadcrumbPage'];
      if (!pageId) return;
      const handler = (e: Event) => {
        e.preventDefault();
        onNavigate(pageId);
      };
      btn.addEventListener('click', handler);
      cleanups.push(() => btn.removeEventListener('click', handler));
    });
  return () => cleanups.forEach((fn) => fn());
}

export function mountBreadcrumb<TPageType extends string = string>(
  opts: MountBreadcrumbOptions<TPageType>,
): BreadcrumbHandle {
  let detach: () => void = () => undefined;
  const separator = opts.separator ?? '›';

  const paint = (activePageId: PageId, navState: NavigationState) => {
    detach();
    const crumbs = buildCrumbs(
      opts.pages,
      activePageId,
      navState,
      opts.labelResolver,
      opts.isGatePage,
    );
    opts.targetEl.innerHTML = renderCrumbsHtml(crumbs, separator);
    opts.targetEl.setAttribute('data-airo-component', 'breadcrumb');
    detach = attachClickHandlers(opts.targetEl, opts.onNavigate);
  };

  paint(opts.activePageId, opts.navState);

  return {
    update: paint,
    destroy: () => {
      detach();
      opts.targetEl.innerHTML = '';
    },
  };
}
