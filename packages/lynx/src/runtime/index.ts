/**
 * @airo-js/lynx/runtime — runs on the Lynx main thread. `mountLynx` shows
 * server-rendered pages as Lynx elements and runs the cartridge's hydrate
 * handlers through the bounded DOM facade.
 */

export { mountLynx, type ColorScheme, type LynxMount, type LynxPage, type MountLynxOptions } from './mount.js';
export type { NavigateRequest } from './navigation.js';
export {
  LynxRefusalError,
  UnmappedElementError,
  type LynxErrorInfo,
  type LynxErrorPhase,
} from './errors.js';
export { HtmlParseError } from './tokenize.js';
export { UnsupportedSelectorError } from './matcher.js';
export { LynxEnvironmentError } from './papi.js';
