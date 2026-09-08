/**
 * SnapshotPath — every dot-path `getByPath` can resolve against a value of
 * type `T`, as a string-literal union.
 *
 * ## Why a type, not a lint
 *
 * 0.10.0 made `requires` load-bearing: a `required: 'always'` path that
 * holds no value skips the adapter before `generate()`, and
 * `renderAppWithPublication` then drops its JSON-LD from the `<head>` with
 * no throw and no warning. The first two consumers to audit against it found
 * that EVERY adapter they shipped would have gone quiet, and three of the
 * five adapters in this repo's own examples had the same defect. The
 * declarations were not subtly wrong; they named keys the snapshot never
 * had — `product.name` against `products: Product[]`, `artists.name`
 * against `artists: Artist[]`. That is a typo-class error, and no amount of
 * prose in an upgrade note prevents a typo. A type does: with
 * `SchemaFieldRef<ProductData>`, `'product.name'` is a compile error at the
 * line that wrote it, before any gate runs.
 *
 * ## Grammar — mirrors `getByPath`, on purpose
 *
 * Dot-separated segments. A record contributes its own string keys; a
 * `Record<string, X>` contributes `${string}` and then `X`'s paths. An array
 * contributes `${number}` — **a segment after an array is an index**, so
 * `products.0.name` is a path and `products.name` is not. If you mean
 * "every product has a name", declare `products` and check names in
 * `validate()`; there is no wildcard here, matching `path-utils.ts`.
 *
 * Primitives, `Date`, `RegExp` and functions are leaves. Function-valued
 * keys are dropped entirely — they are never snapshot data. `null` and
 * `undefined` members of a union vanish under distribution, so an optional
 * field paths exactly like a required one. `unknown` and `any` — as the
 * whole snapshot or as one field — have no shape to check and stay open as
 * `string`; that is what keeps the bare `SchemaFieldRef` at `path: string`.
 *
 * ## Two deliberate limits
 *
 * **Six segments are checked exactly; deeper paths are accepted as
 * `${string}`.** The cap keeps the union finite on wide, deeply nested
 * snapshot types (a generated storefront type can nest ten levels), and
 * letting the overflow through unchecked rather than rejecting it means no
 * legitimate deep path becomes unwritable. The deepest `requires` path any
 * consumer has declared is three segments. Measured against a real
 * consumer snapshot (~30 fields across five interfaces, arrays and
 * `Record`s two levels down), the whole check adds well under a second.
 *
 * **`${number}` is looser than the runtime index grammar.** `getByPath`
 * indexes only on canonical non-negative integers; `${number}` also
 * matches `'01'`, `'-1'`, `'1e2'` and `'1.5'`, which resolve as absent at
 * runtime. TypeScript cannot express "canonical integer" in a template
 * literal, so the runtime grammar stays authoritative for that edge and the
 * type catches the class that actually shipped: a key that does not exist,
 * or a name where an index belongs.
 *
 * ## Variance — why the `unknown` case is the LAST branch
 *
 * `SchemaFieldRef<TData>` rides on `PublicationAdapter<TData>`, which rides
 * on `Cartridge<TData>`, and the framework erases cartridges to
 * `Cartridge<unknown, unknown>` in several places — the registry, embed's
 * `resolveCartridge`, the default-resolver memo. Those erasures must keep
 * compiling.
 *
 * TypeScript cannot measure the variance of `T` through this type, so it
 * compares two instantiations structurally, and structural is exactly the
 * right answer for a requires-declaration. The paths of any concrete
 * snapshot widen to `string`, so `SchemaFieldRef<ProductData>` IS
 * assignable to `SchemaFieldRef<unknown>` and erasure works. The paths of
 * `{ a }` are all paths of `{ a; b }`, so `SchemaFieldRef<{ a }>` assigns
 * to `SchemaFieldRef<{ a; b }>` — every declared path still resolves —
 * while the reverse is refused because `'b'` is not a path of `{ a }`. Two
 * unrelated snapshot types never assign in either direction. An explicit
 * `out` annotation was tried and rejected by the compiler (TS2636); it
 * would also have allowed the unsound direction.
 *
 * The trap: a leading `unknown extends T ? string : …` clause reads better
 * but puts `T` in a conditional's EXTENDS position, which TypeScript
 * measures as reliably invariant. With that shape `Cartridge<ProductData>`
 * stopped assigning to `Cartridge<unknown>` and cartridge-kit itself no
 * longer built. Handling `unknown` as the fall-through of the final
 * `T extends object` test gives the same result for `unknown` and `any`
 * without the invariance. The type test pins both the erasure and the
 * two-concrete-types refusal, so a future rewrite cannot quietly regress
 * either.
 */

type AnyFunction = (...args: never[]) => unknown;

/** Types a path never descends into. */
type Leaf =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  | Date
  | RegExp
  | AnyFunction;

/**
 * Depth countdown for the recursion. `Prev[0]` is `never`, which is the
 * signal to stop checking and accept the remainder as `${string}`. With the
 * default `Depth = 5` that is six exactly-checked segments.
 */
type Prev = [never, 0, 1, 2, 3, 4, 5];

type Values<O> = O[keyof O];

/**
 * The dot-paths of `T`, as a string-literal union. Pair with
 * `SchemaFieldRef<T>`; rarely needed directly.
 *
 * Distributes over unions, so `{ x } | { y }` yields `'x' | 'y'`.
 */
export type SnapshotPath<T, Depth extends number = 5> =
  // Checked depth exhausted: accept anything below this point.
  [Depth] extends [never]
    ? string
    : T extends Leaf
      ? never
      : T extends readonly (infer E)[]
        ? // A segment after an array is an INDEX.
          `${number}` | `${number}.${SnapshotPath<E, Prev[Depth]>}`
        : T extends object
          ? Values<{
              [K in keyof T & string as T[K] extends AnyFunction ? never : K]:
                | K
                | `${K}.${SnapshotPath<T[K], Prev[Depth]>}`;
            }>
          : // `unknown` and `any` land here — no shape to check, stay open.
            // Deliberately the LAST branch; see "Variance" above.
            string;
