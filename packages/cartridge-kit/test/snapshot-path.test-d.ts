/**
 * SnapshotPath / SchemaFieldRef<TData> — compile-time contract.
 *
 * This file is TYPECHECKED, not executed (vitest `typecheck`). Every
 * `@ts-expect-error` is an assertion that a declaration is rejected; if the
 * type ever loosens so one of those lines compiles, tsc reports the unused
 * directive and the suite fails.
 *
 * The first two suites are the two consumer findings against 0.10.0,
 * reproduced on their own snapshot shapes. All eleven of their declared
 * paths must be errors, and their corrected declarations must pass.
 */

import { describe, expectTypeOf, test } from 'vitest';

import type { PublicationAdapter, SchemaFieldRef } from '../src/publication-adapter.js';
import type { SnapshotPath } from '../src/snapshot-path.js';
import { missingRequiredPaths } from '../src/coverage.js';

// ── The first consumer's snapshot: a catalogue, `products` plural ────────────

interface Sku {
  id: string;
  retailerId: string;
  price?: number;
  currency?: string;
  productURL?: string;
}
interface Product {
  id: string;
  name: string;
  brand?: string;
  images: { main?: string; gallery?: string[] };
  rating?: number;
  reviewCount?: number;
  attributes?: Record<string, { value: string }>;
  skus: Sku[];
}
interface Retailer {
  id: string;
  name: string;
}
interface CatalogueData {
  id: string;
  brandName: string;
  products: Product[];
  retailers: Record<string, Retailer>;
  brands?: Array<{ id: string; name: string; logoURL?: string }>;
  categories?: string[];
}

describe('a singular key the snapshot never had', () => {
  test('every path the shipped declaration named is rejected', () => {
    const shipped: SchemaFieldRef<CatalogueData>[] = [
      // @ts-expect-error `product` is not a key; the field is `products`
      { path: 'product.name', required: 'always' },
      // @ts-expect-error
      { path: 'product.skus', required: 'always' },
      // @ts-expect-error
      { path: 'product.skus.price', required: 'preferred' },
      // @ts-expect-error
      { path: 'product.skus.productURL', required: 'preferred' },
      // @ts-expect-error
      { path: 'product.images.main', required: 'preferred' },
      // @ts-expect-error
      { path: 'product.brand', required: 'optional' },
      // @ts-expect-error
      { path: 'product.rating', required: 'optional' },
      // @ts-expect-error
      { path: 'product.reviewCount', required: 'optional' },
    ];
    expectTypeOf(shipped).toBeArray();
  });

  test('the corrected declaration, and the index forms, all pass', () => {
    const corrected: SchemaFieldRef<CatalogueData>[] = [
      { path: 'products', required: 'always' },
      { path: 'products.0.name', required: 'preferred' },
      { path: 'products.0.skus.0.price', required: 'preferred' },
      { path: 'products.0.images.main', required: 'preferred' },
      { path: 'brandName', required: 'always' },
      { path: 'retailers', required: 'always' },
      // Record<string, Retailer>: any key, then Retailer's shape
      { path: 'retailers.anything.name', required: 'preferred' },
      { path: 'brands', required: 'optional' },
      { path: 'brands.3.logoURL', required: 'optional' },
      { path: 'categories.0', required: 'optional' },
      { path: 'products.0.attributes.colour.value', required: 'optional' },
    ];
    expectTypeOf(corrected).toBeArray();
  });
});

// ── The second consumer's snapshot: a name where an index belongs ──────────

interface LabelData {
  label: { name: string; tagline?: string };
  artists: Array<{ name: string; bio?: string }>;
  releases: Array<{ title: string }>;
}

describe('a segment after an array must be an index', () => {
  test('`artists.name` is rejected — it reads an own property off the array', () => {
    const shipped: SchemaFieldRef<LabelData>[] = [
      // @ts-expect-error
      { path: 'artists.name', required: 'always' },
      // @ts-expect-error
      { path: 'artists.bio', required: 'preferred' },
      // @ts-expect-error
      { path: 'releases.title', required: 'optional' },
    ];
    expectTypeOf(shipped).toBeArray();
  });

  test('declare the array, or index into it', () => {
    const corrected: SchemaFieldRef<LabelData>[] = [
      { path: 'label.name', required: 'always' },
      { path: 'label.tagline', required: 'preferred' },
      { path: 'artists', required: 'preferred' },
      { path: 'artists.0.name', required: 'optional' },
      { path: 'artists.27.bio', required: 'optional' },
    ];
    expectTypeOf(corrected).toBeArray();
  });

  test('the type is LOOSER than the runtime on non-canonical numerics — documented, not asserted away', () => {
    // `getByPath` indexes only on canonical non-negative integers. These
    // typecheck and resolve absent at runtime; the gate then names the
    // path. If TypeScript ever gains a way to say "canonical integer" this
    // test is where to tighten it.
    const loose: SnapshotPath<LabelData>[] = [
      'artists.01.name',
      'artists.-1.name',
      'artists.1e2.name',
      'artists.1.5.name',
    ];
    expectTypeOf(loose).toBeArray();
  });
});

// ── Untyped stays open; typed widens to untyped but never to another type ──

describe('unknown and any are open', () => {
  test('bare SchemaFieldRef has string paths', () => {
    const ref: SchemaFieldRef = { path: 'whatever.you.like', required: 'always' };
    expectTypeOf(ref.path).toBeString();
    expectTypeOf<SnapshotPath<unknown>>().toBeString();
    // biome-ignore lint/suspicious/noExplicitAny: the escape hatch under test
    expectTypeOf<SnapshotPath<any>>().toBeString();
  });

  test('an untyped list is NOT assignable where a typed one is expected', () => {
    // This is the hoisted-constant pattern. `SchemaFieldRef[]` is `string`
    // paths, so it must be re-typed `SchemaFieldRef<MyData>[]` at 1.0.
    const untyped: SchemaFieldRef[] = [{ path: 'products', required: 'always' }];
    // @ts-expect-error string is wider than the path union of CatalogueData
    const typed: SchemaFieldRef<CatalogueData>[] = untyped;
    expectTypeOf(typed).toBeArray();
  });
});

describe('variance — the reason the unknown case is the LAST branch of SnapshotPath', () => {
  test('a typed ref widens to the bare ref (erasure to unknown keeps working)', () => {
    const typed: SchemaFieldRef<CatalogueData> = { path: 'products', required: 'always' };
    const bare: SchemaFieldRef = typed;
    const list: SchemaFieldRef[] = [typed];
    expectTypeOf(bare.path).toBeString();
    expectTypeOf(list).toBeArray();
  });

  test('so a typed list passes straight into the shared predicate', () => {
    const typed: SchemaFieldRef<CatalogueData>[] = [{ path: 'products', required: 'always' }];
    const ro: readonly SchemaFieldRef<LabelData>[] = [{ path: 'label.name', required: 'always' }];
    expectTypeOf(missingRequiredPaths(typed, {})).toEqualTypeOf<string[]>();
    expectTypeOf(missingRequiredPaths(ro, {})).toEqualTypeOf<string[]>();
    expectTypeOf(missingRequiredPaths(undefined, {})).toEqualTypeOf<string[]>();
  });

  test('and a typed adapter erases to PublicationAdapter<unknown, …> — the registry / embed seam', () => {
    const typed = {} as PublicationAdapter<CatalogueData, unknown, unknown>;
    const erased: PublicationAdapter<unknown, unknown, unknown> = typed;
    const resolve: () => Promise<PublicationAdapter<unknown, unknown, unknown>> = async () => typed;
    expectTypeOf(erased.requires).toBeArray();
    expectTypeOf(resolve).toBeFunction();
  });

  test('but two UNRELATED snapshot types never assign to each other', () => {
    // @ts-expect-error
    const a: SchemaFieldRef<CatalogueData> = {} as SchemaFieldRef<LabelData>;
    // @ts-expect-error
    const b: SchemaFieldRef<LabelData> = {} as SchemaFieldRef<CatalogueData>;
    expectTypeOf(a).toBeObject();
    expectTypeOf(b).toBeObject();
  });

  test('the paths of { a } are paths of { a; b } — and not the reverse', () => {
    interface AB {
      a: string;
      b: string;
    }
    interface A {
      a: string;
    }
    // A ref typed for A declares only paths that exist on A; every one of
    // them exists on AB too, so widening to AB is sound — the declaration
    // still resolves. AB's `'b'` is not a path of A, so narrowing is refused.
    // Structural comparison gets this right where a variance annotation
    // could not: `out` was rejected by the compiler, and would have allowed
    // the unsound direction.
    const widen: SchemaFieldRef<AB> = {} as SchemaFieldRef<A>;
    // @ts-expect-error `'b'` is not a path of A
    const narrow: SchemaFieldRef<A> = {} as SchemaFieldRef<AB>;
    expectTypeOf(widen).toBeObject();
    expectTypeOf(narrow).toBeObject();
  });
});

// ── Depth ──────────────────────────────────────────────────────────────────

interface Deep {
  a: { b: { c: { d: { e: { f: { g: { h: string } } } } } } };
}

describe('six segments are checked exactly; deeper is accepted as string', () => {
  test('inside the checked depth a typo is still a typo', () => {
    const ok: SnapshotPath<Deep>[] = ['a', 'a.b.c', 'a.b.c.d.e.f'];
    // @ts-expect-error sixth segment does not exist
    const typo: SnapshotPath<Deep> = 'a.b.c.d.e.zz';
    expectTypeOf(ok).toBeArray();
    expectTypeOf(typo).toBeString();
  });

  test('past the checked depth anything goes', () => {
    const deep: SnapshotPath<Deep>[] = ['a.b.c.d.e.f.g', 'a.b.c.d.e.f.g.h', 'a.b.c.d.e.f.g.nonsense.more'];
    expectTypeOf(deep).toBeArray();
  });
});

// ── Leaves, unions, recursion, root arrays ─────────────────────────────────

interface Noisy {
  when: Date;
  re: RegExp;
  fn: () => void;
  n: number | null;
  u: string | undefined;
  either: { x: number } | { y: string };
  meta: unknown;
  bag: Record<string, unknown>;
}

describe('leaves and shapes', () => {
  test('Date and RegExp are leaves; function-valued keys are dropped', () => {
    const leaves: SnapshotPath<Noisy>[] = ['when', 're'];
    // @ts-expect-error Date contributes no method paths
    const method: SnapshotPath<Noisy> = 'when.getTime';
    // @ts-expect-error a function is never snapshot data
    const fn: SnapshotPath<Noisy> = 'fn';
    expectTypeOf(leaves).toBeArray();
    expectTypeOf(method).toBeString();
    expectTypeOf(fn).toBeString();
  });

  test('nullable and optional fields path like required ones', () => {
    const p: SnapshotPath<Noisy>[] = ['n', 'u'];
    expectTypeOf(p).toBeArray();
  });

  test('a union of shapes contributes both sides', () => {
    const p: SnapshotPath<Noisy>[] = ['either', 'either.x', 'either.y'];
    expectTypeOf(p).toBeArray();
  });

  test('a nested unknown, and a Record<string, unknown>, are open below the key', () => {
    const p: SnapshotPath<Noisy>[] = ['meta', 'meta.anything.at.all', 'bag', 'bag.some.key'];
    // @ts-expect-error the root key itself is still checked
    const typo: SnapshotPath<Noisy> = 'whenn';
    expectTypeOf(p).toBeArray();
    expectTypeOf(typo).toBeString();
  });

  test('a recursive type terminates at the depth cap', () => {
    interface TreeNode {
      id: string;
      children: TreeNode[];
    }
    const p: SnapshotPath<TreeNode> = 'children.0.children.0.id';
    expectTypeOf(p).toBeString();
  });

  test('a root-level array snapshot paths by index', () => {
    const p: SnapshotPath<Array<{ id: string }>> = '0.id';
    // @ts-expect-error no key without an index first
    const bare: SnapshotPath<Array<{ id: string }>> = 'id';
    expectTypeOf(p).toBeString();
    expectTypeOf(bare).toBeString();
  });
});
