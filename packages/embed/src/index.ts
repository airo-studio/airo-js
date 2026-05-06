/**
 * @ai-ro/embed — browser bootstrap loader.
 *
 * Phase 0 destination for `src/embed/index.ts` from dotter-widget-studio
 * (the `<dotter-app dtr-id="...">` custom element + `dotter-embed.js`).
 * Renamed `airo-embed.js` on output. The runtime fork (legacy v1 vs airo)
 * stays — the studio's existing v1 chunks keep loading from `/widgets/v1/`
 * until Phase 2 sunset.
 *
 * Intentionally has no dependency on @ai-ro/core — this bundle ships
 * separately and lazy-loads core on demand so pages that don't hydrate
 * (bots, pre-interactive snapshots) never pay the runtime cost.
 */

export const PACKAGE_NAME = '@ai-ro/embed';
