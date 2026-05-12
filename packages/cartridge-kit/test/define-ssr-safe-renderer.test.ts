/**
 * Tests for `defineSSRSafeRenderer` — the factory that derives `render`,
 * `renderSSR`, and `hydrate` from one pure template function + one
 * optional hydrate handler.
 *
 * Discipline under test:
 *   - render → paint template + wire listeners
 *   - renderSSR → paint template, NO listener wiring (server has no client)
 *   - hydrate → NO template call (would clobber DOM + listeners) + wire listeners
 *   - destroy → cleanup callback from hydrate handler fires once
 *   - ctx is threaded through to both template and hydrate
 *   - drift impossible: render + renderSSR paint identical HTML by construction
 */

import { describe, expect, test, vi } from 'vitest';

import { EventBus } from '@airo-js/core';
import type { Page, RenderContext } from '@airo-js/core';

import { defineSSRSafeRenderer } from '../src/define-ssr-safe-renderer.js';

// Cartridge-kit's vitest env is `node`, no DOM. defineSSRSafeRenderer only
// touches `target.innerHTML` — a plain object satisfies the structural
// requirement. Keeps the package's test deps node-only.
function makeTarget(): HTMLElement {
  return { innerHTML: '' } as unknown as HTMLElement;
}

interface TestCtx {
  count: number;
}

function buildCtx(count = 3): RenderContext<string, TestCtx> {
  const page: Page<string> = { id: 'home', type: 'home', enabled: true };
  return {
    page,
    app: { count },
    events: new EventBus(),
    navState: { page: 'home' },
    navigate: () => undefined,
  };
}

describe('defineSSRSafeRenderer', () => {
  test('render() paints template AND wires hydrate listeners', () => {
    const hydrateSpy = vi.fn();
    const factory = defineSSRSafeRenderer<string, TestCtx>({
      template: (ctx) => `<div data-count="${ctx.app.count}">root</div>`,
      hydrate: hydrateSpy,
    });
    const renderer = factory();
    const target = makeTarget();
    const ctx = buildCtx();

    renderer.render(target, ctx);

    expect(target.innerHTML).toBe('<div data-count="3">root</div>');
    expect(hydrateSpy).toHaveBeenCalledTimes(1);
    expect(hydrateSpy.mock.calls[0][0]).toBe(target);
    expect(hydrateSpy.mock.calls[0][1]).toBe(ctx);
  });

  test('renderSSR() paints template but does NOT wire listeners', () => {
    const hydrateSpy = vi.fn();
    const factory = defineSSRSafeRenderer<string, TestCtx>({
      template: (ctx) => `<div data-count="${ctx.app.count}">root</div>`,
      hydrate: hydrateSpy,
    });
    const renderer = factory();
    const target = makeTarget();

    renderer.renderSSR!(target, buildCtx(5));

    expect(target.innerHTML).toBe('<div data-count="5">root</div>');
    expect(hydrateSpy).not.toHaveBeenCalled();
  });

  test('hydrate() does NOT call template but DOES wire listeners', () => {
    const templateSpy = vi.fn(() => '<div>should-not-paint</div>');
    const hydrateSpy = vi.fn();
    const factory = defineSSRSafeRenderer<string, TestCtx>({
      template: templateSpy,
      hydrate: hydrateSpy,
    });
    const renderer = factory();
    const target = makeTarget();
    // Pre-existing DOM (the SSR HTML that hydrate adopts).
    (target as { innerHTML: string }).innerHTML = '<div data-server="yes">pre-rendered</div>';

    renderer.hydrate!(target, buildCtx());

    expect(target.innerHTML).toBe('<div data-server="yes">pre-rendered</div>');
    expect(templateSpy).not.toHaveBeenCalled();
    expect(hydrateSpy).toHaveBeenCalledTimes(1);
  });

  test('destroy() invokes the cleanup returned by hydrate', () => {
    const cleanupSpy = vi.fn();
    const factory = defineSSRSafeRenderer<string, TestCtx>({
      template: () => '<div>x</div>',
      hydrate: () => cleanupSpy,
    });
    const renderer = factory();
    renderer.render(makeTarget(), buildCtx());

    expect(cleanupSpy).not.toHaveBeenCalled();
    renderer.destroy();
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  });

  test('destroy() is a no-op when hydrate returned void', () => {
    const factory = defineSSRSafeRenderer<string, TestCtx>({
      template: () => '<div>x</div>',
      hydrate: () => undefined,
    });
    const renderer = factory();
    renderer.render(makeTarget(), buildCtx());

    // Should not throw.
    expect(() => renderer.destroy()).not.toThrow();
  });

  test('render and renderSSR produce identical HTML for the same ctx (drift impossible by construction)', () => {
    const factory = defineSSRSafeRenderer<string, TestCtx>({
      template: (ctx) => `<section><h1>n=${ctx.app.count}</h1></section>`,
      hydrate: () => undefined,
    });
    const csrRenderer = factory();
    const ssrRenderer = factory();
    const csrTarget = makeTarget();
    const ssrTarget = makeTarget();
    const ctx = buildCtx(7);

    csrRenderer.render(csrTarget, ctx);
    ssrRenderer.renderSSR!(ssrTarget, ctx);

    expect(csrTarget.innerHTML).toBe(ssrTarget.innerHTML);
  });

  test('factory yields fresh renderer instances per call (cleanup state is per-instance)', () => {
    const cleanups: number[] = [];
    let counter = 0;
    const factory = defineSSRSafeRenderer<string, TestCtx>({
      template: () => '<div>x</div>',
      hydrate: () => {
        const id = ++counter;
        return () => cleanups.push(id);
      },
    });

    const a = factory();
    const b = factory();
    a.render(makeTarget(), buildCtx());
    b.render(makeTarget(), buildCtx());

    a.destroy();
    expect(cleanups).toEqual([1]);
    b.destroy();
    expect(cleanups).toEqual([1, 2]);
  });

  test('hydrate handler is optional — render still paints', () => {
    const factory = defineSSRSafeRenderer<string, TestCtx>({
      template: () => '<div>no-hydrate</div>',
    });
    const renderer = factory();
    const target = makeTarget();
    renderer.render(target, buildCtx());
    expect(target.innerHTML).toBe('<div>no-hydrate</div>');
    expect(() => renderer.destroy()).not.toThrow();
  });
});
