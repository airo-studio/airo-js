/**
 * `DeepPartial<T>` — recursive partial type for cartridge config deltas.
 *
 * Every property at every depth becomes optional. Used as the delta
 * type for `MountCartridgeResult.update()` and `el.update()` so callers
 * can pass `{ display: { showPrices: true } }` without TypeScript
 * demanding the entire `display` sub-tree. Matches the runtime contract,
 * which walks the delta via `leafPaths()` and merges via `deepMerge()` —
 * the runtime has always accepted nested partials; this type makes the
 * static type match.
 *
 * Arrays are NOT recursed into (treated as leaves) because cartridge
 * config shapes don't need partial-array semantics — replacing an array
 * wholesale is the contract.
 *
 * Naming: this is the standard utility-type shape used widely in the
 * TypeScript ecosystem (utility-types, type-fest, etc.). Cartridge
 * authors importing this from `@airo-js/cartridge-kit` get the same
 * mental model.
 */
export type DeepPartial<T> = T extends Array<infer U>
  ? Array<U>
  : T extends ReadonlyArray<infer U>
    ? ReadonlyArray<U>
    : T extends object
      ? { [K in keyof T]?: DeepPartial<T[K]> }
      : T;
