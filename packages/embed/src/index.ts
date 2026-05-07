/**
 * @airo-js/embed — browser bootstrap loader.
 *
 * The small script consumers paste into a host page. Provides a custom
 * element (e.g. `<airo-embed data-id="…">`) plus a bootstrap that
 * resolves the layout, fetches chunks, and hands off to `@airo-js/runtime`.
 * Consumers are free to wrap their own custom-element name on top.
 *
 * Intentionally has no dependency on @airo-js/core — this bundle ships
 * separately and lazy-loads core on demand so pages that don't hydrate
 * (bots, pre-interactive snapshots) never pay the runtime cost.
 */

export const PACKAGE_NAME = '@airo-js/embed';
