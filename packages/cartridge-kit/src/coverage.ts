/**
 * Coverage gating — the shared predicate behind contract guarantee #2.
 *
 * Two surfaces gate on `requires`: `runPublicationAdapters` in `@airo-js/ssr`
 * skips a starved adapter before it generates, and `dispatchTool` in
 * `@airo-js/mcp` refuses a starved tool before it answers. Both must agree on
 * what "required" and "present" mean, or the same snapshot publishes a feed
 * and denies the agent question that reads the same field. That is precisely
 * the drift the snapshot-fidelity guarantee exists to prevent, so the
 * predicate lives here rather than once per consumer.
 *
 * Two rules, both deliberate:
 *
 * **Only `required: 'always'` gates.** `'preferred'` and `'optional'` are
 * metadata for the host app's coverage UI. Whether a missing `'preferred'`
 * field should stop the work is a judgment the adapter or tool makes for
 * itself — an adapter in `validate()`, where it can see the output it
 * produced; a tool in its handler, where it can answer partially.
 *
 * **Present means non-nullish.** `''`, `0`, `false` and `[]` all count as
 * present. This is NOT `hasByPath`'s semantic, which reports a declared key
 * holding `undefined` as present in order to tell a typo'd path from an unset
 * global. That distinction is right for `validateGlobalConfigKeys` and wrong
 * here: neither a feed nor an agent answer can carry `undefined`, so a
 * declared-but-empty key is absent for this purpose. A surface that considers
 * `''` unusable says so in its own validation, where it has the context to
 * judge.
 */

import { getByPath } from './path-utils.js';
import type { SchemaFieldRef } from './publication-adapter.js';

/**
 * The `required: 'always'` paths in `requires` that hold no value in
 * `snapshot`, in declaration order. Empty array means fully covered — which
 * is also the answer for an empty or omitted `requires`.
 *
 * The parameter is the bare `SchemaFieldRef` (`path: string`). A typed
 * `SchemaFieldRef<T>[]` widens to it structurally for any `T` — see the
 * variance note in `snapshot-path.ts` — so callers pass `adapter.requires`
 * straight through.
 *
 * Pure: same inputs → same output, no I/O.
 */
export function missingRequiredPaths(
  requires: readonly SchemaFieldRef[] | undefined,
  snapshot: unknown,
): string[] {
  if (!requires || requires.length === 0) return [];
  const missing: string[] = [];
  for (const ref of requires) {
    if (ref.required !== 'always') continue;
    if (getByPath(snapshot, ref.path) == null) missing.push(ref.path);
  }
  return missing;
}
