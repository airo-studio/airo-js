/**
 * Author-time validation of `PropSchema.globalConfigKey` dot-paths against a
 * representative cartridge config.
 *
 * `globalConfigKey` is an open dot-path string, so a typo
 * (`display.removeProductBakground`) is SILENT at runtime: the resolver's
 * global tier reads `undefined`, indistinguishable from "the brand simply
 * hasn't set that global," and falls through to the schema default. That's
 * correct hot-path behaviour (a per-paint `console.warn` would false-positive
 * on every legitimately-unset global) — but it means a typo'd key looks
 * identical to an unset one in production paint.
 *
 * These helpers catch that at AUTHORING/TEST time instead. Run once — at
 * registry load and in a unit test — over a cartridge's component schemas plus
 * a representative config (the cartridge's DEFAULT config is ideal: every real
 * global path is present there, even if its value is a falsy default, so only a
 * genuinely-absent path reports). The distinction is `hasByPath`, not
 * `getByPath`: "key present, value `undefined`" (unset → fine) is NOT reported;
 * "key absent from the config shape" (typo → bug) is.
 *
 * Pure: no I/O, no side effects, deterministic order.
 */

import type { ComponentSchema } from './editor-schema.js';
import { hasByPath } from './path-utils.js';

/** One `globalConfigKey` whose dot-path is absent from the validated config. */
export interface InvalidGlobalConfigKey {
  componentId: string;
  propKey: string;
  globalConfigKey: string;
}

/**
 * Return every `globalConfigKey` declared across `componentSchemas` whose
 * dot-path is NOT present on `config` (typo or stale key). An empty array means
 * every declared global path resolves on the given config shape.
 *
 * Validate against a config where all real globals are PRESENT (the cartridge
 * default config), so an unset-but-valid global — key present, value `undefined`
 * or a falsy default — is not mistaken for a typo.
 *
 * Iteration order: `Object.keys(componentSchemas)` then each component's `props`
 * insertion order.
 */
export function validateGlobalConfigKeys<TStyles>(
  componentSchemas: Readonly<Record<string, ComponentSchema<TStyles>>>,
  config: unknown,
): InvalidGlobalConfigKey[] {
  const invalid: InvalidGlobalConfigKey[] = [];
  for (const componentId of Object.keys(componentSchemas)) {
    const schema = componentSchemas[componentId];
    if (!schema) continue;
    for (const [propKey, prop] of Object.entries(schema.props)) {
      const key = prop.globalConfigKey;
      if (key && !hasByPath(config, key)) {
        invalid.push({ componentId, propKey, globalConfigKey: key });
      }
    }
  }
  return invalid;
}

/**
 * Throwing variant of {@link validateGlobalConfigKeys} for test gates and
 * registry-load assertions — throws an `Error` listing every bad path, or
 * returns silently when all paths resolve.
 */
export function assertGlobalConfigKeys<TStyles>(
  componentSchemas: Readonly<Record<string, ComponentSchema<TStyles>>>,
  config: unknown,
): void {
  const invalid = validateGlobalConfigKeys(componentSchemas, config);
  if (invalid.length === 0) return;
  const lines = invalid.map(
    (i) => `  - ${i.componentId}.${i.propKey} → globalConfigKey "${i.globalConfigKey}" not present on config`,
  );
  throw new Error(
    `Invalid globalConfigKey path(s) — not present on the provided config shape:\n${lines.join('\n')}`,
  );
}
