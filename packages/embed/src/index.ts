/**
 * @airo-js/embed — browser bootstrap loader.
 *
 * Customer pastes `<airo-app airo-id="…">` into their HTML; this bundle
 * registers the custom element, fetches the widget config from the
 * studio backend (host-app hook), resolves the cartridge module
 * (host-app hook), lazy-imports `@airo-js/runtime`, and mounts.
 *
 * Bundle target: ~5 KB minified / ~2.5 KB gzip. Runtime + cartridge
 * load on demand via dynamic import.
 *
 * @airo-js/runtime is a peer dependency — it loads dynamically when an
 * element mounts, so the embed bundle stays small and customer pages
 * with multiple widgets pay the runtime cost once.
 */

export type {
  LoadConfigResult,
  DefineAiroAppOptions,
  EmbedPhase,
} from './define-airo-app.js';
export { defineAiroApp } from './define-airo-app.js';

export const PACKAGE_NAME = '@airo-js/embed';
