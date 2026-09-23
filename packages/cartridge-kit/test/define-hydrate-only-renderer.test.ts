/**
 * `defineHydrateOnlyRenderer` — the browser half of a view.
 *
 * Its whole purpose is what it does NOT hold: the template, and everything
 * the template imports. So the tests that matter are (1) hydrate still runs
 * and still cleans up, exactly as the SSR-safe factory does, and (2) the
 * paths that would need a template fail loudly and say what to do, rather
 * than painting nothing.
 */

import { describe, expect, test, vi } from 'vitest';

import type { RenderContext } from '@airo-js/core';

import { defineHydrateOnlyRenderer } from '../src/define-hydrate-only-renderer.js';
import { defineSSRSafeRenderer } from '../src/define-ssr-safe-renderer.js';

type PageType = 'home' | 'product';

function ctx(id = 'home', type: PageType = 'home'): RenderContext<PageType, unknown> {
  return {
    page: { id, type, enabled: true },
    pages: [{ id, type, enabled: true }],
    app: {},
    events: { emit: () => undefined, on: () => () => undefined, off: () => undefined },
    navState: { page: id },
    navigate: () => undefined,
  } as unknown as RenderContext<PageType, unknown>;
}

function root(): HTMLElement {
  return { addEventListener: () => undefined } as unknown as HTMLElement;
}

describe('hydrate', () => {
  test('runs against the markup already on the page, with the render context', () => {
    const hydrate = vi.fn();
    const renderer = defineHydrateOnlyRenderer<PageType, unknown>({ hydrate })();
    const el = root();
    const c = ctx('product', 'product');

    renderer.hydrate?.(el, c);

    expect(hydrate).toHaveBeenCalledWith(el, c);
  });

  test('a returned cleanup runs on destroy, once', () => {
    const cleanup = vi.fn();
    const renderer = defineHydrateOnlyRenderer<PageType, unknown>({ hydrate: () => cleanup })();

    renderer.hydrate?.(root(), ctx());
    renderer.destroy();
    renderer.destroy();

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  test('destroy before hydrate is harmless', () => {
    const renderer = defineHydrateOnlyRenderer<PageType, unknown>({ hydrate: () => undefined })();
    expect(() => renderer.destroy()).not.toThrow();
  });

  test('each renderer from the factory keeps its own cleanup', () => {
    const first = vi.fn();
    const second = vi.fn();
    const queue = [first, second];
    const factory = defineHydrateOnlyRenderer<PageType, unknown>({
      hydrate: () => queue.shift(),
    });

    const a = factory();
    const b = factory();
    a.hydrate?.(root(), ctx());
    b.hydrate?.(root(), ctx());
    a.destroy();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });
});

describe('the paths that would need a template', () => {
  const renderer = () => defineHydrateOnlyRenderer<PageType, unknown>({ hydrate: () => undefined })();

  test('render() throws, naming the page and the ways out', () => {
    expect(() => renderer().render(root(), ctx('product', 'product'))).toThrow(
      /hydrate-only view.*page "product" \(pageType "product"\)/s,
    );
    expect(() => renderer().render(root(), ctx())).toThrow(/resolveView/);
  });

  test('renderSSR() throws, saying this is the browser half', () => {
    expect(() => renderer().renderSSR?.(root(), ctx())).toThrow(/renderSSR\(\).*browser half/s);
  });

  test('the error names this package, so a stack in a consumer app is placeable', () => {
    expect(() => renderer().render(root(), ctx())).toThrow(/@airo-js\/cartridge-kit/);
  });
});

describe('the two halves stay swappable', () => {
  // The point of the split is that the server builds the same page type
  // with a template and the browser without one. Both must satisfy the same
  // `PageRenderer` shape, or a cartridge cannot hold one of each.
  test('both factories produce render, renderSSR, hydrate and destroy', () => {
    const full = defineSSRSafeRenderer<PageType, unknown>({ template: () => '<p>x</p>', hydrate: () => undefined })();
    const half = defineHydrateOnlyRenderer<PageType, unknown>({ hydrate: () => undefined })();

    for (const r of [full, half]) {
      expect(typeof r.render).toBe('function');
      expect(typeof r.renderSSR).toBe('function');
      expect(typeof r.hydrate).toBe('function');
      expect(typeof r.destroy).toBe('function');
    }
  });

  test('the full renderer still paints — the halves differ only there', () => {
    const el = { innerHTML: '' } as HTMLElement;
    const full = defineSSRSafeRenderer<PageType, unknown>({ template: () => '<p>x</p>' })();
    full.renderSSR?.(el, ctx());
    expect(el.innerHTML).toBe('<p>x</p>');
  });
});
