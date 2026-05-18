/**
 * Tests for `RenderContext.pages` — 0.7.2 surface that exposes the full
 * page graph to renderers so they can drive breadcrumbs, sitemaps,
 * "next page" controls, etc. without re-deriving from `template.pages`
 * via host-side wiring.
 *
 * Closes [msg_mpbfwheu_350d52] — dotter-studio's WeakMap-on-event-bus
 * workaround retires once their breadcrumb component reads `ctx.pages`
 * directly. See CHANGELOG @airo-js/core 0.7.2 entry.
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { Page, RenderContext } from '@airo-js/core';

import { mountCartridge } from '../src/mount-cartridge.js';
import {
  fakeCartridge,
  fakeTemplate,
  type TestConfig,
  type TestData,
} from './fixtures.js';

let host: HTMLElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  host.remove();
});

describe('RenderContext.pages (renderer-readable page graph, 0.7.2)', () => {
  test('renderer receives the full page graph at every render', async () => {
    const capturedPages: Array<ReadonlyArray<Page<string>>> = [];

    const result = await mountCartridge<TestData, TestConfig>({
      cartridge: fakeCartridge({
        views: [
          {
            id: 'home-view',
            displayName: 'Home',
            pageType: 'home',
            factory: () => ({
              render(_root: HTMLElement, ctx: RenderContext<string, unknown>) {
                capturedPages.push(ctx.pages);
              },
              destroy() {
                // no-op
              },
            }),
          },
        ],
      }),
      config: {},
      template: {
        ...fakeTemplate(),
        pages: [
          { id: 'home', type: 'home', enabled: true },
          { id: 'product-modal', type: 'product-modal', enabled: true, parent: 'home' },
          { id: 'archived', type: 'home', enabled: false },
        ],
      },
      host,
      preloadedData: { items: [] },
    });
    if (result.blocked) throw new Error('expected unblocked');

    expect(capturedPages).toHaveLength(1);
    const pages = capturedPages[0];
    expect(pages.map((p) => p.id)).toEqual(['home', 'product-modal', 'archived']);
  });

  test('ctx.pages includes disabled pages (consumer-side filtering)', async () => {
    let captured: ReadonlyArray<Page<string>> | null = null;

    const result = await mountCartridge<TestData, TestConfig>({
      cartridge: fakeCartridge({
        views: [
          {
            id: 'home-view',
            displayName: 'Home',
            pageType: 'home',
            factory: () => ({
              render(_root: HTMLElement, ctx: RenderContext<string, unknown>) {
                captured = ctx.pages;
              },
              destroy() {
                // no-op
              },
            }),
          },
        ],
      }),
      config: {},
      template: {
        ...fakeTemplate(),
        pages: [
          { id: 'home', type: 'home', enabled: true },
          { id: 'feature-off', type: 'home', enabled: false },
        ],
      },
      host,
      preloadedData: { items: [] },
    });
    if (result.blocked) throw new Error('expected unblocked');
    if (!captured) throw new Error('renderer never invoked');

    // Sanity narrow then check
    const pages: ReadonlyArray<Page<string>> = captured;
    const disabled = pages.find((p) => p.id === 'feature-off');
    expect(disabled).toBeDefined();
    expect(disabled?.enabled).toBe(false);
  });

  test('ctx.pages includes subpages with parent links', async () => {
    let captured: ReadonlyArray<Page<string>> | null = null;

    const result = await mountCartridge<TestData, TestConfig>({
      cartridge: fakeCartridge({
        views: [
          {
            id: 'home-view',
            displayName: 'Home',
            pageType: 'home',
            factory: () => ({
              render(_root: HTMLElement, ctx: RenderContext<string, unknown>) {
                captured = ctx.pages;
              },
              destroy() {
                // no-op
              },
            }),
          },
        ],
      }),
      config: {},
      template: {
        ...fakeTemplate(),
        pages: [
          { id: 'home', type: 'home', enabled: true },
          { id: 'product-quickview', type: 'product-modal', enabled: true, parent: 'home' },
        ],
      },
      host,
      preloadedData: { items: [] },
    });
    if (result.blocked) throw new Error('expected unblocked');
    if (!captured) throw new Error('renderer never invoked');

    const pages: ReadonlyArray<Page<string>> = captured;
    const subpage = pages.find((p) => p.id === 'product-quickview');
    expect(subpage?.parent).toBe('home');
  });

  test('ctx.pages survives a hot-swap update (same reference)', async () => {
    const capturedPagesByRender: Array<ReadonlyArray<Page<string>>> = [];

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
                capturedPagesByRender.push(ctx.pages);
              },
              destroy() {
                // no-op
              },
            }),
          },
        ],
      }),
      config: { theme: { primary: 'red' } },
      template: fakeTemplate(),
      host,
      preloadedData: { items: [] },
    });
    if (result.blocked) throw new Error('expected unblocked');

    expect(capturedPagesByRender).toHaveLength(1);

    // Hot-swap re-renders the active page (destroy + render with fresh ctx).
    // Pages array reference is from PageManager's opts.pages — stable.
    await result.update({ theme: { primary: 'blue' } });

    expect(capturedPagesByRender).toHaveLength(2);
    expect(capturedPagesByRender[1]).toBe(capturedPagesByRender[0]);
  });

  test('hydrate path also receives ctx.pages', async () => {
    let captured: ReadonlyArray<Page<string>> | null = null;

    host.innerHTML = '<div data-ssr="true">server-rendered</div>';

    const result = await mountCartridge<TestData, TestConfig>({
      cartridge: fakeCartridge({
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
                captured = ctx.pages;
              },
              destroy() {
                // no-op
              },
            }),
          },
        ],
      }),
      config: {},
      template: {
        ...fakeTemplate(),
        pages: [{ id: 'home', type: 'home', enabled: true }],
      },
      host,
      preloadedData: { items: [] },
      styleIsolation: 'shadow',
      mode: 'hydrate',
    });
    if (result.blocked) throw new Error('expected unblocked');
    if (!captured) throw new Error('hydrate never invoked');

    const pages: ReadonlyArray<Page<string>> = captured;
    expect(pages.map((p) => p.id)).toEqual(['home']);
  });
});
