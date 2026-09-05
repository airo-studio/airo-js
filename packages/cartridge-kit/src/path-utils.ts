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
 * Path grammar: dot-separated segments (`'display.categoryFilter.displayMode'`).
 * Mirrors the dot-path convention used by `cartridge.hotSwapKeys` and the
 * leaf-path diff in `@airo-js/runtime`.
 *
 * ## Array indexing
 *
 * A segment that is a canonical non-negative integer descends into an array
 * (`'display.filters.0.layout'`). Cartridge configs grow ordered lists of
 * authored items — N filter facets, N variant axes — and the values a
 * `globalConfigKey` points at moved inside one; a path that stops at the
 * array cannot name them.
 *
 * "Canonical" is strict on purpose: `0`, `1`, `27` index; `01`, `-1`, `1e2`
 * and `length` do not. Leading zeros are ambiguous (is `01` the string key
 * or index 1?), and refusing `length` keeps array internals off the path
 * grammar. Arrays answer ONLY to index segments — a string key against an
 * array is absent, not a property lookup.
 *
 * This is deliberately NOT a selector grammar. There is no `.first`, no
 * by-id match, no wildcard. Naming "one of N ordered items with stable ids"
 * is a narrow-verb problem, not a path problem — a consumer that needs it
 * owns both ends of its own config surface and should say so there.
 *
 * ## Why `setByPath` refuses some array writes
 *
 * Writing past the end of an array, or through a non-index segment, returns
 * the input unchanged rather than clobbering it. Both alternatives are
 * worse: extending an array leaves holes (`.map` skips them, `JSON.stringify`
 * emits `null`), and replacing an authored array with an object to hold a
 * string key destroys config the author declared. `setByPath`'s contract is
 * "write the leaf, share every sibling" — neither of those is that.
 *
 * The refusal is not the enforcement mechanism. `hasByPath` reports the same
 * paths as absent, and `validateGlobalConfigKeys` rejects them at
 * registration, which is where a bad path should surface.
 *
 * Both helpers are pure: same inputs → same output, no I/O.
 */

/**
 * Canonical non-negative integer. Anchored, no leading zeros (except `'0'`
 * itself), no sign, no exponent — see the "Canonical" note above.
 */
const ARRAY_INDEX = /^(?:0|[1-9]\d*)$/;

function isIndexSegment(key: string): boolean {
  return ARRAY_INDEX.test(key);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Anything a path can descend through — a record or an array. */
function isContainer(v: unknown): v is Record<string, unknown> | unknown[] {
  return typeof v === 'object' && v !== null;
}

/**
 * Read one segment off a container. Arrays answer only to index segments;
 * everything else is a plain key read.
 */
function readSegment(cur: Record<string, unknown> | unknown[], key: string): unknown {
  if (Array.isArray(cur)) {
    return isIndexSegment(key) ? cur[Number(key)] : undefined;
  }
  // OWN properties only. A plain `cur[key]` walks the prototype chain, so
  // `constructor`, `toString` and `valueOf` all read non-nullish off any
  // object — which made `missingRequiredPaths` report full coverage for a
  // completely starved snapshot when a cartridge declared one of those as a
  // required path. Inherited members are never cartridge config.
  return Object.hasOwn(cur, key) ? cur[key] : undefined;
}

/**
 * Read the value at `path` in `obj`, or `undefined` if any segment is
 * missing or traverses a non-container. An empty path returns `undefined`
 * (there is no "whole object" key).
 */
export function getByPath(obj: unknown, path: string): unknown {
  if (!path) return undefined;
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (!isContainer(cur)) return undefined;
    cur = readSegment(cur, key);
  }
  return cur;
}

/**
 * Whether `path` EXISTS in `obj` — every segment is an own/inherited key
 * (`in`) of a record, or an in-range index of an array, at its level.
 * Distinct from `getByPath(...) !== undefined`: a key present with an
 * `undefined` value returns `true` here but `undefined` there. That
 * distinction is the whole job for `validateGlobalConfigKeys` — a typo'd
 * path (key absent → `false`) must be told apart from a real-but-unset
 * global (key present, value `undefined` → `true`).
 *
 * For arrays that means an index within `length`. An out-of-range index and
 * a non-index segment both report `false`, so a `globalConfigKey` naming a
 * position the author never declared is caught at registration.
 */
export function hasByPath(obj: unknown, path: string): boolean {
  if (!path) return false;
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (Array.isArray(cur)) {
      if (!isIndexSegment(key)) return false;
      const idx = Number(key);
      if (idx >= cur.length) return false;
      cur = cur[idx];
      continue;
    }
    if (!isRecord(cur) || !(key in cur)) return false;
    cur = cur[key];
  }
  return true;
}

/**
 * Clone `v` for writing, or create the container the NEXT segment needs.
 * An index next-segment creates an array so `setByPath({}, 'a.0.b', v)`
 * builds `{ a: [{ b: v }] }` rather than `{ a: { '0': { b: v } } }`.
 */
function cloneFor(v: unknown, nextKey: string): Record<string, unknown> | unknown[] {
  if (Array.isArray(v)) return v.slice();
  if (isRecord(v)) return { ...v };
  return isIndexSegment(nextKey) ? [] : {};
}

/**
 * Return a structural copy of `obj` with `value` written at `path`. Only
 * the containers ALONG the path are cloned (copy-on-write spine); every
 * sibling reference is shared with the input. Arrays clone via `slice()`,
 * so an index write leaves sibling elements referentially shared. Missing
 * intermediate containers are created — an array when the next segment is
 * an index, an object otherwise. `obj` is never mutated.
 *
 * This matches the immutable-spread semantics a consumer's `apply` closure
 * implements by hand (`d.categoryFilter = { ...d.categoryFilter, k: v }`):
 * overriding one leaf must not mutate a sibling-shared nested object.
 *
 * Returns `obj` unchanged for an empty path, and for a write that would
 * descend into an existing array through a non-index segment or past its
 * end — see the docblock at the top of this file for why refusing beats
 * clobbering.
 */
export function setByPath<T>(obj: T, path: string, value: unknown): T {
  if (!path) return obj;
  const keys = path.split('.');

  // Pre-flight the spine against the INPUT before allocating any clones.
  // Only existing arrays can veto; a missing or primitive level falls
  // through to the writer, which creates/replaces it as it always has.
  let probe: unknown = obj;
  for (const key of keys) {
    if (Array.isArray(probe)) {
      if (!isIndexSegment(key)) return obj;
      const idx = Number(key);
      if (idx >= probe.length) return obj;
      probe = probe[idx];
      continue;
    }
    if (!isRecord(probe)) break;
    probe = probe[key];
  }

  const root = cloneFor(obj, keys[0]!);
  let cursor = root as Record<string, unknown>;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]!;
    const cloned = cloneFor(cursor[key], keys[i + 1]!);
    cursor[key] = cloned;
    cursor = cloned as Record<string, unknown>;
  }
  cursor[keys[keys.length - 1]!] = value;
  return root as T;
}
