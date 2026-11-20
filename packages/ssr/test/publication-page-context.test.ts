/**
 * Publication adapters are told which page the render resolved.
 *
 * The case this exists for: one multi-page app over ONE snapshot (a whole
 * catalogue), deep-linked to a product. The widget HTML opened on that
 * product, and the JSON-LD inlined beside it described every product, on
 * every page — an adapter was handed `(snapshot, ctx)` and `ctx` said
 * nothing about the page. The widget was a function of
 * `(config, snapshot, navState)` and the output beside it a function of
 * `(config, snapshot)`.
 *
 * `renderAppWithPublication` now puts the entry it resolved on the context
 * as `page` and `navState`. Four things are pinned here:
 *
 *   1. it is the RESOLVED page, after any fallback, and the renderer is
 *      handed the same one;
 *   2. off the render path nothing is added — a direct
 *      `runPublicationAdapters` call forwards the context it was given;
 *   3. end to end, two product pages over one snapshot inline two
 *      different `Product` blocks;
 *   4. an adapter that has nothing to say returns `null`, and nothing is
 *      inlined for it (it used to be a script whose whole body was `null`).
 */

import { describe, expect, test } from 'vitest';

import type { AppConfig, NavigationState, Page, PageRenderer } from '@airo-js/core';
import type {
  Cartridge,
  PublicationAdapter,
  PublicationContext,
  ValidationResult,
} from '@airo-js/cartridge-kit';

import { renderAppWithPublication } from '../src/render-with-publication.js';
import { runPublicationAdapters } from '../src/run-publication.js';

interface Product {
  id: string;
  name: string;
}
interface D {
  products: Product[];
}
type C = Record<string, never>;

interface ProductLd {
  '@context': 'https://schema.org';
  '@type': 'Product';
  sku: string;
  name: string;
}
interface ListLd {
  '@context': 'https://schema.org';
  '@type': 'ItemList';
  itemListElement: ProductLd[];
}

const snapshot: D = {
  products: [
    { id: 'p1', name: 'Tea' },
    { id: 'p2', name: 'Coffee' },
    { id: 'p3', name: 'Cocoa' },
  ],
};

const toProduct = (p: Product): ProductLd => ({
  '@context': 'https://schema.org',
  '@type': 'Product',
  sku: p.id,
  name: p.name,
});

const VALID: ValidationResult = { valid: true, errors: [], warnings: [] };

const layout = { regionOrder: [], regions: {} };
const page = (id: string, type: string, extra: Partial<Page> = {}): Page => ({
  id,
  type,
  enabled: true,
  layout,
  ...extra,
});

// One of everything entry resolution can reject, plus a csr-only view and
// a private page.
const HOME = page('home', 'home');
const PRODUCT = page('product', 'product');
const graph: AppConfig = {
  appId: 'app',
  pages: [
    HOME,
    PRODUCT,
    page('off', 'product', { enabled: false }),
    page('quick', 'quick', { parent: 'home' }),
    page('age', 'age-gate'),
    page('map', 'map'),
    page('members', 'members', { private: true }),
  ],
};
const isGatePage = (type: string): boolean => type === 'age-gate';

const hostCtx: PublicationContext<C> = { config: {}, locale: 'en-GB', country: 'GB', currency: 'GBP' };

interface Rendered {
  page: Page;
  navState: NavigationState;
}

/**
 * A view that records what it was handed and draws from the same snapshot
 * the adapter reads: the product page shows the product `navState` names,
 * or its missing state.
 */
function view(rendered: Rendered[]): PageRenderer {
  return {
    render() {
      // SSR uses renderSSR.
    },
    renderSSR(container, ctx) {
      rendered.push({ page: ctx.page, navState: ctx.navState });
      const { products } = (ctx.app as { data: D }).data;
      if (ctx.page.type !== 'product') {
        container.innerHTML = `<ul data-page="${ctx.page.id}" data-count="${products.length}"></ul>`;
        return;
      }
      const shown = products.find((p) => p.id === ctx.navState.productId);
      container.innerHTML = shown
        ? `<article data-sku="${shown.id}">${shown.name}</article>`
        : '<p data-missing="product"></p>';
    },
    destroy() {
      // nothing to tear down
    },
  };
}

/**
 * The adapter a multi-page cartridge writes: page type FIRST, then the
 * context key that page type owns. On any other page (and with no page at
 * all) it emits the list.
 */
function pageAwareAdapter(
  seen: PublicationContext<C>[],
): PublicationAdapter<D, ProductLd | ListLd | null, C> {
  return {
    id: 'products-json-ld',
    displayName: 'Products',
    description: 'One Product on a product page, the list elsewhere.',
    format: 'json-ld',
    delivery: 'inline-in-host',
    requires: [{ path: 'products', required: 'always' }],
    refreshCadence: { min: { ms: 0 }, max: { ms: 0 } },
    generate(data, ctx) {
      seen.push(ctx);
      if (ctx.page?.type === 'product') {
        const shown = data.products.find((p) => p.id === ctx.navState?.productId);
        return Promise.resolve(shown ? toProduct(shown) : null);
      }
      return Promise.resolve({
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        itemListElement: data.products.map(toProduct),
      });
    },
    validate: () => VALID,
  };
}

interface Fixture {
  cartridge: Cartridge<D, C>;
  /** Every context an adapter's `generate` received, in call order. */
  seen: PublicationContext<C>[];
  /** Every `(page, navState)` a view's `renderSSR` received. */
  rendered: Rendered[];
}

// The default renderer resolver keys a global chunk mailbox on this name;
// unique per fixture so tests stay hermetic regardless of order.
let mailboxCounter = 0;

function fixture(adapter?: PublicationAdapter<D, unknown, C>): Fixture {
  const seen: PublicationContext<C>[] = [];
  const rendered: Rendered[] = [];
  const cartridge: Cartridge<D, C> = {
    id: 'catalogue',
    mailboxName: `__AIRO_PUBLICATION_PAGE_TEST_${mailboxCounter++}__`,
    industry: 'test',
    displayName: 'Catalogue',
    description: 'One snapshot, several pages.',
    version: '0.0.0',
    schema: {
      parse: (input) => input as D,
      safeParse: (input) => ({ success: true as const, data: input as D }),
    },
    dataSources: [],
    views: [
      { id: 'home-view', displayName: 'Home', pageType: 'home', factory: () => view(rendered) },
      { id: 'product-view', displayName: 'Product', pageType: 'product', factory: () => view(rendered) },
      { id: 'members-view', displayName: 'Members', pageType: 'members', factory: () => view(rendered) },
      {
        id: 'map-view',
        displayName: 'Map',
        pageType: 'map',
        factory: () => view(rendered),
        capabilities: ['csr-only'],
      },
    ],
    templates: [],
    defaultConfig: {},
    defaultTemplateId: 'main',
    publicationAdapters: [adapter ?? pageAwareAdapter(seen)],
  };
  return { cartridge, seen, rendered };
}

function render(
  f: Fixture,
  initialNavState?: Partial<NavigationState>,
  extra: { appConfig?: AppConfig; publicationCtx?: PublicationContext<C>; renderPrivate?: boolean } = {},
) {
  return renderAppWithPublication<D, C>({
    cartridge: f.cartridge,
    appConfig: extra.appConfig ?? graph,
    snapshot,
    publicationCtx: extra.publicationCtx ?? hostCtx,
    document: globalThis.document,
    isGatePage,
    ...(initialNavState ? { initialNavState } : {}),
    ...(extra.renderPrivate ? { renderPrivate: true } : {}),
  });
}

/** Every inlined JSON-LD block in a fragment, parsed. */
function jsonLdIn(html: string): unknown[] {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(
    (match) => JSON.parse(match[1] ?? 'null') as unknown,
  );
}

describe('an adapter is told the page the render resolved', () => {
  test('a deep link: `page` is the resolved Page and `navState` carries its context keys', async () => {
    const f = fixture();
    await render(f, { page: 'product', productId: 'p2' });

    expect(f.seen).toHaveLength(1);
    // The object the page graph holds — not a copy, not an `{ id, type }`.
    expect(f.seen[0]?.page).toBe(PRODUCT);
    expect(f.seen[0]?.navState).toEqual({ page: 'product', productId: 'p2' });
    // What the host supplied is still there, untouched.
    expect(f.seen[0]).toMatchObject(hostCtx);
  });

  test('no page requested: the default entry, and a navState that names it', async () => {
    const f = fixture();
    await render(f);

    expect(f.seen[0]?.page).toBe(HOME);
    expect(f.seen[0]?.navState).toEqual({ page: 'home' });
  });

  test('the renderer is handed the same page and an equal navState', async () => {
    const f = fixture();
    await render(f, { page: 'product', productId: 'p2', category: 'Hot drinks' });

    expect(f.rendered).toHaveLength(1);
    expect(f.rendered[0]?.page).toBe(f.seen[0]?.page);
    expect(f.rendered[0]?.navState).toEqual(f.seen[0]?.navState);
  });

  test("the adapter's navState is frozen; the renderer keeps the plain object it always had", async () => {
    const f = fixture();
    await render(f, { page: 'product', productId: 'p2' });

    // `Object.isFrozen(undefined)` is true, so assert there is one first.
    expect(f.seen[0]?.navState).toBeDefined();
    expect(Object.isFrozen(f.seen[0]?.navState)).toBe(true);
    expect(Object.isFrozen(f.rendered[0]?.navState)).toBe(false);
    expect(f.rendered[0]?.navState).not.toBe(f.seen[0]?.navState);
  });

  // The rule an adapter author needs: after a fallback the page is the
  // default entry, but the request's other keys are still there — exactly
  // as the view is handed them. An adapter keyed on `productId` alone
  // would describe a product beside a rendered listing.
  test.each([
    ['unknown-page', 'nope'],
    ['disabled', 'off'],
    ['subpage', 'quick'],
    ['gate-page', 'age'],
  ])('fallback (%s): the default entry, with the rejected request\'s other keys kept', async (reason, requested) => {
    const f = fixture();
    const result = await render(f, { page: requested, productId: 'p2' });

    expect(result.fellBack).toEqual({ requested, reason });
    expect(f.seen[0]?.page).toBe(HOME);
    expect(f.seen[0]?.navState).toEqual({ page: 'home', productId: 'p2' });
    expect(f.rendered[0]?.navState).toEqual({ page: 'home', productId: 'p2' });
    // The adapter branches on page type first, so it published the list
    // that rendered — not the product the stale key names.
    expect(jsonLdIn(result.html)).toEqual([expect.objectContaining({ '@type': 'ItemList' })]);
  });

  test('a csr-only entry: no widget HTML, and the adapter is still told the page', async () => {
    const f = fixture();
    const result = await render(f, { page: 'map' });

    expect(result.skipped).toEqual({ pageType: 'map', reason: 'csr-only' });
    expect(f.rendered).toHaveLength(0);
    expect(f.seen[0]?.page?.id).toBe('map');
    expect(f.seen[0]?.navState).toEqual({ page: 'map' });
  });

  test('no enabled page: there is no entry, so `page` and `navState` are undefined', async () => {
    const f = fixture();
    await render(f, undefined, {
      appConfig: { appId: 'app', pages: [page('home', 'home', { enabled: false })] },
    });

    expect(f.seen).toHaveLength(1);
    expect(f.seen[0]?.page).toBeUndefined();
    expect(f.seen[0]?.navState).toBeUndefined();
  });

  test('a value the host put on `publicationCtx` never reaches an adapter from here', async () => {
    const claimed: PublicationContext<C> = {
      ...hostCtx,
      page: page('claimed', 'product'),
      navState: { page: 'claimed', productId: 'p1' },
    };

    // An entry resolved: the runner's replaces the host's.
    const withEntry = fixture();
    await render(withEntry, { page: 'product', productId: 'p2' }, { publicationCtx: claimed });
    expect(withEntry.seen[0]?.page).toBe(PRODUCT);
    expect(withEntry.seen[0]?.navState).toEqual({ page: 'product', productId: 'p2' });

    // No entry resolved: nothing rendered, so there is no page to claim.
    const noEntry = fixture();
    await render(noEntry, undefined, {
      appConfig: { appId: 'app', pages: [page('home', 'home', { enabled: false })] },
      publicationCtx: claimed,
    });
    expect(noEntry.seen[0]?.page).toBeUndefined();
    expect(noEntry.seen[0]?.navState).toBeUndefined();
    // The host's own object is not written to.
    expect(claimed.page?.id).toBe('claimed');
  });

  test('on this path an adapter is never told a private page — none runs for one', async () => {
    const f = fixture();
    for (const id of ['home', 'product', 'map', 'members']) {
      await render(f, { page: id }, { renderPrivate: true });
    }

    // Three public renders ran the adapter; the private one did not.
    expect(f.seen.map((ctx) => ctx.page?.id)).toEqual(['home', 'product', 'map']);
    expect(f.seen.some((ctx) => ctx.page?.private === true)).toBe(false);
  });
});

describe('off the render path the context is the caller\'s', () => {
  test('a direct runPublicationAdapters call adds no page: the adapter emits its page-less output', async () => {
    const f = fixture();
    const results = await runPublicationAdapters(f.cartridge, snapshot, hostCtx);

    expect(f.seen[0]).toBe(hostCtx);
    expect('page' in (f.seen[0] ?? {})).toBe(false);
    expect('navState' in (f.seen[0] ?? {})).toBe(false);
    expect(results[0]?.output).toEqual({
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      itemListElement: snapshot.products.map(toProduct),
    } satisfies ListLd);
  });

  test('a page the caller sets is forwarded as given — that agreement is the caller\'s to keep', async () => {
    const f = fixture();
    const results = await runPublicationAdapters(f.cartridge, snapshot, {
      ...hostCtx,
      page: PRODUCT,
      navState: { page: 'product', productId: 'p3' },
    });

    expect(results[0]?.output).toEqual(toProduct({ id: 'p3', name: 'Cocoa' }));
  });
});

describe('one snapshot, several pages: the inlined JSON-LD describes the page that rendered', () => {
  test('two product deep links inline two different Product blocks, each matching its HTML', async () => {
    const blocks: unknown[] = [];
    for (const product of [snapshot.products[0], snapshot.products[1]]) {
      if (!product) throw new Error('fixture has two products');
      const result = await render(fixture(), { page: 'product', productId: product.id });

      expect(result.html).toContain(`<article data-sku="${product.id}">${product.name}</article>`);
      expect(jsonLdIn(result.html)).toEqual([toProduct(product)]);
      blocks.push(...jsonLdIn(result.html));
    }
    expect(blocks[0]).not.toEqual(blocks[1]);
  });

  test('the listing page still inlines the whole list', async () => {
    const result = await render(fixture(), { page: 'home' });

    expect(result.html).toContain('data-count="3"');
    expect(jsonLdIn(result.html)).toEqual([
      { '@context': 'https://schema.org', '@type': 'ItemList', itemListElement: snapshot.products.map(toProduct) },
    ]);
  });

  test('a productId that names nothing: the view shows its missing state and nothing is inlined', async () => {
    const result = await render(fixture(), { page: 'product', productId: 'ghost' });

    expect(result.html).toBe('<p data-missing="product"></p>');
    // The adapter ran, validated its `null`, and is reported.
    expect(result.adapterResults).toEqual([
      expect.objectContaining({ adapterId: 'products-json-ld', output: null, included: true }),
    ]);
  });
});

describe('an adapter that publishes nothing', () => {
  function fixed(
    output: unknown,
    validate: (output: unknown) => ValidationResult = () => VALID,
  ): PublicationAdapter<D, unknown, C> {
    return {
      id: 'fixed',
      displayName: 'Fixed',
      description: 'Returns what the test gives it.',
      format: 'json-ld',
      delivery: 'inline-in-host',
      requires: [],
      refreshCadence: { min: { ms: 0 }, max: { ms: 0 } },
      generate: () => Promise.resolve(output),
      validate,
    };
  }

  // REGRESSION. Before this, the fragment began with
  // `<script type="application/ld+json">null</script>`.
  test('`null` that validate() accepts is reported and NOT inlined', async () => {
    const result = await render(fixture(fixed(null)), { page: 'home' });

    expect(result.html).not.toContain('application/ld+json');
    expect(result.html).toContain('data-page="home"');
    expect(result.adapterResults).toEqual([
      expect.objectContaining({ adapterId: 'fixed', output: null, included: true }),
    ]);
  });

  test('`null` still goes through validate(): an adapter that rejects it is blocked like any invalid output', async () => {
    const rejectsNull = (output: unknown): ValidationResult =>
      output === null
        ? { valid: false, errors: [{ code: 'empty', message: 'this adapter must always emit' }], warnings: [] }
        : VALID;
    const result = await render(fixture(fixed(null, rejectsNull)), { page: 'home' });

    expect(result.html).not.toContain('application/ld+json');
    expect(result.adapterResults[0]).toMatchObject({ included: false, validation: { valid: false } });
  });

  // Before this, `JSON.stringify(undefined)` reached `.replace` and threw.
  test('`undefined` does not throw and is not inlined', async () => {
    const result = await render(fixture(fixed(undefined)), { page: 'home' });

    expect(result.html).not.toContain('application/ld+json');
    expect(result.html).toContain('data-page="home"');
  });

  test('a real output beside an empty one is inlined alone', async () => {
    const f = fixture(fixed(null));
    f.cartridge.publicationAdapters = [fixed(null), pageAwareAdapter(f.seen)];
    const result = await render(f, { page: 'product', productId: 'p1' });

    expect(jsonLdIn(result.html)).toEqual([toProduct({ id: 'p1', name: 'Tea' })]);
  });
});
