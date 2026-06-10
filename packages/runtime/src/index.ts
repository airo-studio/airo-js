/**
 * @airo-js/runtime — cartridge mount orchestration.
 *
 * The runtime-agnostic mount layer: every host app that runs a cartridge
 * needs the same shell-setup → fetch → pipeline → mount sequence.
 * `mountCartridge` ships that sequence as a single call and exposes
 * studio-specific extensions via hooks (`onShellReady`, `onError`).
 *
 * v0.2 (deferred): chunk loading + CDN deployment, SSR-hydrate fork,
 * live `update()` for studio chrome. All additive — v0.1 callers keep
 * working unchanged.
 */

export type {
  ShellHandle,
  MountPhase,
  SharedLifecycleHooks,
  MountCartridgeOptions,
  MountCartridgeResult,
} from './mount-cartridge.js';
export { mountCartridge } from './mount-cartridge.js';

/**
 * Re-exported from `@airo-js/core` so lazy consumers (notably
 * `@airo-js/embed`) can construct a pre-mount event bus from the same
 * dynamic `import('@airo-js/runtime')` they already pay for — without a
 * static `@airo-js/core` import inflating their entry bundle. The runtime
 * already bundles `EventBus` (it constructs one when none is passed), so
 * this re-export adds nothing to the runtime chunk.
 */
export { EventBus } from '@airo-js/core';

export const PACKAGE_NAME = '@airo-js/runtime';
