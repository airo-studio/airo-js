/**
 * Shallow-aware deep merge. Recurses into plain objects so nested
 * deltas don't clobber sibling fields:
 *
 *   deepMerge({ display: { a: 1, b: 2 } }, { display: { a: 9 } })
 *     → { display: { a: 9, b: 2 } }
 *
 * Arrays are replaced wholesale — merging arrays is ambiguous (index
 * align? key align? concat?) and cartridge config shapes don't need it.
 * Primitives + null are also wholesale replacements.
 *
 * Its own module (0.11.2) so the editor entry can merge an overlay without
 * importing `mount-cartridge.ts`. Re-exported from there for its tests.
 */
export function deepMerge<T>(base: T, delta: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(delta)) {
    return delta as T;
  }
  const result: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(delta)) {
    if (isPlainObject(v) && isPlainObject(result[k])) {
      result[k] = deepMerge(result[k], v);
    } else {
      result[k] = v;
    }
  }
  return result as T;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
