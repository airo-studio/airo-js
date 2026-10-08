/**
 * @airo-js/lynx/build — Node only. The rsbuild plugin for a native build,
 * and the pieces it is made of for a build script that wants them directly.
 */

export { PLUGIN_NAME, pluginAiroLynx, type AiroLynxPluginOptions } from './plugin.js';
export {
  NormaliseError,
  normaliseCss,
  type EmittedDeclaration,
  type NormaliseOptions,
  type NormaliseReport,
  type NormaliseResult,
  type RewriteKind,
  type SourceLocation,
  type UnresolvedValue,
  type UnsupportedSelector,
} from './normalise.js';
export {
  assertInheritanceInBundles,
  InheritanceTapError,
  TEMPLATE_PLUGIN_PREFIX,
  tapCssInheritance,
  type InheritanceOptions,
} from './inheritance-tap.js';
export { buildReport, formatReport, removedProperties, type CartridgeReport, type RemovedProperty } from './report.js';
