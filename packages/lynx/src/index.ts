/**
 * @airo-js/lynx — native render adapter for airo-js cartridges over Lynx.
 *
 * The root entry carries the package identity only. Each part has its own
 * entry because they run in different places and must never share a bundle:
 *
 *   - `@airo-js/lynx/build`   — Node, inside the native build: an rsbuild
 *     plugin that normalises the cartridge's CSS for the Lynx encoder,
 *     switches on CSS inheritance, and writes a per-cartridge report.
 *   - `@airo-js/lynx/runtime` — the Lynx main thread: `mountLynx`, which turns
 *     server-rendered HTML into Lynx elements and runs the cartridge's
 *     existing hydrate handlers through a bounded DOM facade.
 *   - `@airo-js/lynx/device` — the bundle half of the manual device check;
 *     only in cards built for one.
 *
 * This package has its own version line, like `@airo-js/log`: it is not
 * part of the framework surface that freezes at 1.0.
 */

export const PACKAGE_NAME = '@airo-js/lynx';

export const VERSION = '0.1.0';
