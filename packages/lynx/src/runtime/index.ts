/**
 * @airo-js/lynx/runtime — runs on the Lynx main thread. `mountLynx` shows
 * server-rendered pages as Lynx elements and runs the cartridge's hydrate
 * handlers through the bounded DOM facade.
 */

export {
  mountLynx,
  type ColorScheme,
  type LynxFetch,
  type LynxFetchInit,
  type LynxMount,
  type LynxPage,
  type LynxResponse,
  type MountLynxOptions,
} from './mount.js';
export type { NavigateRequest } from './navigation.js';
export type { FilePickRequest, PickAnswer, PickOption, PickRequest, SelectPickRequest } from './select.js';
export {
  LynxRefusalError,
  UnmappedElementError,
  type LynxErrorInfo,
  type LynxErrorPhase,
} from './errors.js';
export { HtmlParseError } from './tokenize.js';
export { UnsupportedSelectorError } from './matcher.js';
export { LynxEnvironmentError } from './papi.js';
