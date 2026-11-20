/**
 * What each view does once its markup is on the page. Browser-safe: no
 * templates, no copy, nothing the server alone needs.
 *
 * Both halves of a view import these. The browser cartridge
 * (`cartridge.ts`) builds its views with `defineHydrateOnlyRenderer`, the
 * server cartridge (`cartridge.server.ts`) with `defineSSRSafeRenderer`, and
 * each is handed the same function from here, so the listeners on a
 * server-rendered page and the ones the browser expects cannot drift apart.
 *
 * Keep this file free of imports from `markup.server.ts`: importing a
 * template here would put it back in `client.js`, which is the whole reason
 * for the split.
 */

/**
 * An example listener, attached identically wherever the page was rendered.
 * It records which card was clicked; replace it with your own behaviour.
 */
export function hydrateHome(root: HTMLElement): void {
  root.addEventListener('click', (e) => {
    const link = (e.target as Element).closest('a.site-card__link');
    if (link) root.setAttribute('data-last-click', link.textContent ?? '');
  });
}

/** Plain links, nothing to attach. Keeping the handler keeps both halves symmetric. */
export function hydratePost(): void {}
