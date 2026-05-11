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

export const PACKAGE_NAME = '@airo-js/runtime';
