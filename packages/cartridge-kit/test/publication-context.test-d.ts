/**
 * PublicationContext.page / .navState — compile-time contract.
 *
 * This file is TYPECHECKED, not executed (vitest `typecheck`). Every
 * `@ts-expect-error` is an assertion that a line is rejected; if the type
 * ever loosens so one compiles, tsc reports the unused directive and the
 * suite fails.
 *
 * What it pins: the two fields are OPTIONAL (every context written before
 * they existed still compiles, and an adapter must handle their absence),
 * they are read-only to an adapter, and `page` is the full `Page` the view
 * receives rather than an `{ id, type }` summary.
 */

import { describe, expectTypeOf, test } from 'vitest';

import type { ComponentSettings, NavigationState, Page } from '@airo-js/core';

import type { PublicationAdapter, PublicationContext } from '../src/publication-adapter.js';

interface Config {
  siteUrl: string;
}

describe('PublicationContext — the page a render resolved', () => {
  test('a context written before the fields existed still compiles', () => {
    const ctx: PublicationContext<Config> = {
      config: { siteUrl: 'https://x.test' },
      locale: 'en-GB',
      country: 'GB',
    };
    expectTypeOf(ctx.page).toEqualTypeOf<Readonly<Page> | undefined>();
    expectTypeOf(ctx.navState).toEqualTypeOf<Readonly<NavigationState> | undefined>();
  });

  test('both are optional, so an adapter has to handle a page-less run', () => {
    const generate: PublicationAdapter<unknown, string | null, Config>['generate'] = (_snapshot, ctx) => {
      // @ts-expect-error — `page` may be undefined: off the render path there is none.
      const type: string = ctx.page.type;
      // @ts-expect-error — and so may `navState`.
      const id: string | undefined = ctx.navState.productId;
      return Promise.resolve(type + String(id));
    };
    expectTypeOf(generate).toBeFunction();
  });

  test('`page` is the full Page: the settings the view read are there', () => {
    const read = (ctx: PublicationContext<Config>) => ({
      type: ctx.page?.type,
      settings: ctx.page?.componentSettings,
      isPrivate: ctx.page?.private,
      productId: ctx.navState?.productId,
      pageId: ctx.navState?.page,
    });
    expectTypeOf(read).returns.toEqualTypeOf<{
      type: string | undefined;
      settings: Record<string, ComponentSettings> | undefined;
      isPrivate: boolean | undefined;
      productId: string | undefined;
      pageId: string | undefined;
    }>();
  });

  test('an adapter cannot write to either', () => {
    const write = (ctx: PublicationContext<Config>) => {
      if (!ctx.page || !ctx.navState) return;
      // @ts-expect-error — `page` is the object the renderer is about to be given.
      ctx.page.enabled = false;
      // @ts-expect-error — `navState` is frozen at run time, and read-only here.
      ctx.navState.page = 'elsewhere';
    };
    expectTypeOf(write).toBeFunction();
  });
});
