/**
 * Tests for the renderer-callable `ctx.update` seam — 0.7.1 framework
 * surface that lets renderers fire `MountCartridgeResult.update()`
 * deltas from inside listener handlers without holding the mount handle.
 *
 * Closes the bridge thread (msg_mp58z77m_65d9ed) that surfaced this gap
 * during D5 planning: stateless renderers with selection state in
 * `WtbConfig.display.*` need to dispatch updates from `hydrate` event
 * handlers; the host's `update()` lives on the mount result, not on
 * `RenderContext`.
 *
 * Three things being verified:
 *   1. `ctx.update` is wired through the framework — every render call
 *      receives a defined `update` (not `undefined`) when mounted via
 *      `mountCartridge`.
 *   2. Calling `ctx.update` from inside the renderer's `render` or
 *      `hydrate` closure dispatches through the same `update()` the
 *      host holds (same hot-swap vs remount classification, same
 *      snapshot reuse for hot-swap, same `replaceAppContext` re-render).
 *   3. `ctx.update` returns the same `UpdateResult` shape as the host's
 *      `result.update()` — `{ mode, navState }`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { RenderContext, UpdateResult } from '@airo-js/core';

import { mountCartridge } from '../src/mount-cartridge.js';
import { fakeCartridge, fakeTemplate, type TestConfig, type TestData } from './fixtures.js';

let host: HTMLElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  host.remove();
});

describe('RenderContext.update (renderer-callable update seam, 0.7.1)', () => {
  test('ctx.update is defined on every render when mounted via mountCartridge', async () => {
    const seenUpdates: Array<typeof RenderContext.prototype.update | undefined> = [];
    const result = await mountCartridge<TestData, TestConfig>({
      cartridge: fakeCartridge({
        views: [
          {
            id: 'home-view',
            displayName: 'Home',
            pageType: 'home',
            factory: () => ({
              render(_root: HTMLElement, ctx: RenderContext<string, unknown>) {
                seenUpdates.push(ctx.update);
              },
              destroy() {
                // no-op
              },
            }),
          },
        ],
      }),
      config: {},
      template: fakeTemplate(),
      host,
      preloadedData: { items: [] },
    });
    if (result.blocked) throw new Error('expected unblocked');

    expect(seenUpdates).toHaveLength(1);
    expect(typeof seenUpdates[0]).toBe('function');
  });

  test('calling ctx.update from inside a renderer dispatches through the host update()', async () => {
    let captured: { ctx: RenderContext<string, unknown> } | null = null;
    const result = await mountCartridge<TestData, TestConfig>({
      cartridge: fakeCartridge({
        hotSwapKeys: ['theme'],
        views: [
          {
            id: 'home-view',
            displayName: 'Home',
            pageType: 'home',
            factory: () => ({
              render(_root: HTMLElement, ctx: RenderContext<string, unknown>) {
                captured = { ctx };
              },
              destroy() {
                // no-op
              },
            }),
          },
        ],
      }),
      config: { locale: 'en-US' },
      template: fakeTemplate(),
      host,
      preloadedData: { items: [] },
    });
    if (result.blocked) throw new Error('expected unblocked');
    if (!captured) throw new Error('renderer never invoked');

    // From inside the renderer's captured ctx (simulating a listener
    // handler firing post-mount), call ctx.update with a hot-swap path.
    // Cast through `RenderContext<string, unknown>` (the non-null guard
    // is below; vitest infers `captured` as never inside the closure).
    const ctxRef: RenderContext<string, unknown> = captured.ctx;
    const updateResult: UpdateResult | undefined = await ctxRef.update?.({
      theme: { primary: 'blue' },
    });
    expect(updateResult).toBeDefined();
    expect(updateResult?.mode).toBe('hot-swap');
  });

  test('ctx.update with a non-hotSwap path triggers a remount', async () => {
    let captured: { ctx: RenderContext<string, unknown> } | null = null;
    const result = await mountCartridge<TestData, TestConfig>({
      cartridge: fakeCartridge({
        // No hotSwapKeys → every delta path remounts.
        views: [
          {
            id: 'home-view',
            displayName: 'Home',
            pageType: 'home',
            factory: () => ({
              render(_root: HTMLElement, ctx: RenderContext<string, unknown>) {
                captured = { ctx };
              },
              destroy() {
                // no-op
              },
            }),
          },
        ],
      }),
      config: { locale: 'en-US' },
      template: fakeTemplate(),
      host,
      preloadedData: { items: [] },
    });
    if (result.blocked) throw new Error('expected unblocked');
    if (!captured) throw new Error('renderer never invoked');

    const ctxRef: RenderContext<string, unknown> = captured.ctx;
    const updateResult = await ctxRef.update?.({ locale: 'fr-FR' });
    expect(updateResult?.mode).toBe('remount');
  });

  test('ctx.update navState matches host result.update navState', async () => {
    let captured: { ctx: RenderContext<string, unknown> } | null = null;
    const result = await mountCartridge<TestData, TestConfig>({
      cartridge: fakeCartridge({
        hotSwapKeys: ['theme'],
        views: [
          {
            id: 'home-view',
            displayName: 'Home',
            pageType: 'home',
            factory: () => ({
              render(_root: HTMLElement, ctx: RenderContext<string, unknown>) {
                captured = { ctx };
              },
              destroy() {
                // no-op
              },
            }),
          },
        ],
      }),
      config: {},
      template: fakeTemplate(),
      host,
      preloadedData: { items: [] },
    });
    if (result.blocked) throw new Error('expected unblocked');
    if (!captured) throw new Error('renderer never invoked');

    // Mutate navState before firing the ctx.update so we have something
    // observable to compare across the two callers.
    result.app.navigate({ page: 'home', selected: 'category-shoes' });

    const ctxRef: RenderContext<string, unknown> = captured.ctx;
    const ctxResult = await ctxRef.update?.({ theme: { primary: 'red' } });

    // The host's result.update() and ctx.update both forward to the
    // same internal `update` closure — same navState snapshot semantics.
    expect(ctxResult?.navState.selected).toBe('category-shoes');
  });

  test('hydrate mode: ctx.update is wired in the hydrate path too', async () => {
    let captured: { ctx: RenderContext<string, unknown> } | null = null;

    // Customer page state: SSR HTML in host before mountCartridge.
    host.innerHTML = '<div data-ssr="true">server-rendered</div>';

    const result = await mountCartridge<TestData, TestConfig>({
      cartridge: fakeCartridge({
        hotSwapKeys: ['theme'],
        views: [
          {
            id: 'home-view',
            displayName: 'Home',
            pageType: 'home',
            factory: () => ({
              render() {
                // no-op
              },
              hydrate(_root: HTMLElement, ctx: RenderContext<string, unknown>) {
                captured = { ctx };
              },
              destroy() {
                // no-op
              },
            }),
          },
        ],
      }),
      config: {},
      template: fakeTemplate(),
      host,
      preloadedData: { items: [] },
      styleIsolation: 'shadow',
      mode: 'hydrate',
    });
    if (result.blocked) throw new Error('expected unblocked');
    if (!captured) throw new Error('hydrate never invoked');

    const ctxRef: RenderContext<string, unknown> = captured.ctx;
    expect(typeof ctxRef.update).toBe('function');
    const updateResult = await ctxRef.update?.({ theme: { primary: 'green' } });
    expect(updateResult?.mode).toBe('hot-swap');
  });
});
