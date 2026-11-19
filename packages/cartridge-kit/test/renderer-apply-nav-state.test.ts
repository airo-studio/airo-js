/**
 * `applyNavState` on the two renderer factories (`defineSSRSafeRenderer`,
 * `defineHydrateOnlyRenderer`): the option is handed the root and context
 * the factory holds, which a method added to the factory's output
 * afterwards could not reach.
 *
 * PageManager's side (when it asks, what a `true` skips) is tested in
 * `@airo-js/runtime`'s `navigation-in-place.test.ts`.
 */

import { describe, expect, test, vi } from 'vitest';

import type { NavigationState, PageRendererFactory, RenderContext } from '@airo-js/core';

import { defineHydrateOnlyRenderer } from '../src/define-hydrate-only-renderer.js';
import {
  type ApplyNavStateHandler,
  defineSSRSafeRenderer,
} from '../src/define-ssr-safe-renderer.js';

type PageType = 'product';
type Handler = ApplyNavStateHandler<PageType, unknown>;

function ctx(): RenderContext<PageType, unknown> {
  return {
    page: { id: 'product', type: 'product', enabled: true },
    pages: [],
    app: {},
    events: { emit: () => undefined, on: () => () => undefined, off: () => undefined },
    navState: { page: 'product', item: 'a' },
    navigate: () => undefined,
  } as unknown as RenderContext<PageType, unknown>;
}

function root(): HTMLElement {
  return { innerHTML: '' } as unknown as HTMLElement;
}

const NEXT: NavigationState = { page: 'product', item: 'b' };
const PREV: NavigationState = { page: 'product', item: 'a' };

/** Each factory, as a function of the handler it is given. */
const BUILDERS: Array<{
  name: string;
  build: (applyNavState?: Handler) => PageRendererFactory<PageType, unknown>;
}> = [
  {
    name: 'defineSSRSafeRenderer',
    build: (applyNavState) =>
      defineSSRSafeRenderer<PageType, unknown>({
        template: (c) => `<p>${c.navState.item}</p>`,
        hydrate: () => undefined,
        applyNavState,
      }),
  },
  {
    name: 'defineHydrateOnlyRenderer',
    build: (applyNavState) =>
      defineHydrateOnlyRenderer<PageType, unknown>({
        hydrate: () => undefined,
        applyNavState,
      }),
  },
];

describe.each(BUILDERS)('$name with applyNavState', ({ build }) => {
  test('after hydrate: called with that root, next, previous and that ctx', () => {
    const handler = vi.fn<Handler>(() => true);
    const renderer = build(handler)();
    const el = root();
    const c = ctx();

    renderer.hydrate?.(el, c);

    expect(renderer.applyNavState?.(NEXT, PREV)).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(el, NEXT, PREV, c);
  });

  test('a decline is passed through as false', () => {
    const renderer = build(() => false)();
    renderer.hydrate?.(root(), ctx());
    expect(renderer.applyNavState?.(NEXT, PREV)).toBe(false);
  });

  test('only true counts: a truthy non-boolean is a decline', () => {
    const renderer = build((() => 1) as unknown as Handler)();
    renderer.hydrate?.(root(), ctx());
    expect(renderer.applyNavState?.(NEXT, PREV)).toBe(false);
  });

  test('before the renderer is on the page: false, and the handler is not called', () => {
    const handler = vi.fn<Handler>(() => true);
    expect(build(handler)().applyNavState?.(NEXT, PREV)).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  test('after destroy: false, and the handler is not called', () => {
    const handler = vi.fn<Handler>(() => true);
    const renderer = build(handler)();
    renderer.hydrate?.(root(), ctx());
    renderer.destroy();
    expect(renderer.applyNavState?.(NEXT, PREV)).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  test('each renderer from the factory holds its own root', () => {
    const roots: HTMLElement[] = [];
    const factory = build((r) => {
      roots.push(r);
      return true;
    });
    const a = factory();
    const b = factory();
    const elA = root();
    const elB = root();
    a.hydrate?.(elA, ctx());
    b.hydrate?.(elB, ctx());

    b.applyNavState?.(NEXT, PREV);
    a.applyNavState?.(NEXT, PREV);

    expect(roots).toEqual([elB, elA]);
  });
});

describe.each(BUILDERS)('$name without applyNavState', ({ build }) => {
  test('has no applyNavState, so every context change renders as before', () => {
    expect(build()().applyNavState).toBeUndefined();
  });
});

describe('defineSSRSafeRenderer — which paints arm it', () => {
  test('render arms it, with the root it painted', () => {
    const handler = vi.fn<Handler>(() => true);
    const renderer = defineSSRSafeRenderer<PageType, unknown>({
      template: () => '<p></p>',
      applyNavState: handler,
    })();
    const el = root();
    renderer.render(el, ctx());

    renderer.applyNavState?.(NEXT, PREV);

    expect(handler.mock.calls[0]?.[0]).toBe(el);
  });

  test('renderSSR does not: a server render is never navigated', () => {
    const handler = vi.fn<Handler>(() => true);
    const renderer = defineSSRSafeRenderer<PageType, unknown>({
      template: () => '<p></p>',
      applyNavState: handler,
    })();
    renderer.renderSSR?.(root(), ctx());

    expect(renderer.applyNavState?.(NEXT, PREV)).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });
});
