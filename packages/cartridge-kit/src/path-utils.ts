/**
 * Dot-path read/write utilities for cartridge config.
 *
 * `getByPath` backs the global-config tier in `resolveComponentProp` — a
 * prop's `globalConfigKey` is a dot-path into the cartridge's `TConfig`,
 * and the resolver reads the global default through it. `setByPath` is its
 * immutable inverse: copy-on-write along the path spine, so a caller can
 * fold a resolved value back into a config draft WITHOUT mutating shared
 * nested references. This is the framework-side replacement for the
 * hand-rolled `get`/`apply` closure pair a consumer would otherwise write
 * per global↔component link.
 *
 * Path grammar: dot-separated keys (`'display.categoryFilter.displayMode'`).
 * Mirrors the dot-path convention used by `cartridge.hotSwapKeys` and the
 * leaf-path diff in `@airo-js/runtime`. Arrays are opaque leaves —
 * index-into-array paths are not supported (no cartridge config needs them
 * today; add only when one does).
 *
 * Both helpers are pure: same inputs → same output, no I/O.
 */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Read the value at `path` in `obj`, or `undefined` if any segment is
 * missing or traverses a non-object. An empty path returns `undefined`
 * (there is no "whole object" key).
 */
export function getByPath(obj: unknown, path: string): unknown {
  if (!path) return undefined;
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (!isRecord(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/**
 * Whether `path` EXISTS in `obj` — every segment is an own/inherited key
 * (`in`) of a record at its level. Distinct from `getByPath(...) !== undefined`:
 * a key present with an `undefined` value returns `true` here but `undefined`
 * there. That distinction is the whole job for `validateGlobalConfigKeys` — a
 * typo'd path (key absent → `false`) must be told apart from a real-but-unset
 * global (key present, value `undefined` → `true`).
 *
 * Arrays are opaque leaves, same as `getByPath` — a path cannot descend into
 * one (the segment after an array reports `false`).
 */
export function hasByPath(obj: unknown, path: string): boolean {
  if (!path) return false;
  let cur: unknown = obj;
  const keys = path.split('.');
  for (let i = 0; i < keys.length; i++) {
    if (!isRecord(cur) || !(keys[i]! in cur)) return false;
    cur = cur[keys[i]!];
  }
  return true;
}

/**
 * Return a structural copy of `obj` with `value` written at `path`. Only
 * the objects ALONG the path are cloned (copy-on-write spine); every
 * sibling reference is shared with the input. Missing intermediate
 * objects are created. `obj` is never mutated.
 *
 * This matches the immutable-spread semantics a consumer's `apply` closure
 * implements by hand (`d.categoryFilter = { ...d.categoryFilter, k: v }`):
 * overriding one leaf must not mutate a sibling-shared nested object.
 *
 * An empty path returns `obj` unchanged.
 */
export function setByPath<T>(obj: T, path: string, value: unknown): T {
  if (!path) return obj;
  const keys = path.split('.');
  const root: Record<string, unknown> = isRecord(obj) ? { ...obj } : {};
  let cursor = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]!;
    const child = cursor[key];
    cursor[key] = isRecord(child) ? { ...child } : {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[keys[keys.length - 1]!] = value;
  return root as T;
}
