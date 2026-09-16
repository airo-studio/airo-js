/**
 * A remount never hydrates (reported against 0.11.0, `msg_mu412dxm_2c08d3`).
 *
 * Hydration adopts markup the server painted. That markup exists only on
 * the initial mount: `update()` and `updatePages()` destroy the App first,
 * so by the time the new App is built the render root holds the destroyed
 * app's DOM, or nothing at all. Building it in hydrate mode ran the
 * renderer's `hydrate()` over an emptied root — which paints nothing, so
 * the widget went blank with no error while `update()` resolved
 * `{ mode: 'remount' }`. CSR mounts were never affected.
 *
 * The renderer below is the shape the SSR-safe contract asks for (`render`
 * paints, `hydrate` only adopts and wires), which is exactly the shape that
 * goes blank when asked to hydrate an empty root.
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { PageRenderer } from '@airo-js/core';

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

function ssrSafeRenderer(record: string[]): PageRenderer {
  return {
    render(container) {
      record.push('render');
      container.innerHTML = '<div data-painted="csr">painted</div>';
    },
    hydrate() {
      // Adopts what the server left and wires listeners. Paints nothing.
      record.push('hydrate');
    },
    destroy() {
      record.push('destroy');
    },
  };
}

function hydrateMount(record: string[], styleIsolation: 'shadow' | 'light' = 'shadow') {
  host.innerHTML = '<div data-ssr="yes">server-rendered content</div>';
  return mountCartridge<TestData, TestConfig>({
    cartridge: fakeCartridge({
      views: [
        {
          id: 'home-view',
          displayName: 'Home',
          pageType: 'home',
          factory: () => ssrSafeRenderer(record),
        },
      ],
    }),
    config: {},
    template: fakeTemplate(),
    host,
    preloadedData: { items: [] },
    styleIsolation,
    mode: 'hydrate',
  });
}

describe('a remount of a hydrate-mode mount repaints', () => {
  test('update(): the remounted App renders, and the render root is not left blank', async () => {
    const record: string[] = [];
    const result = await hydrateMount(record);
    if (result.blocked) throw new Error('expected an unblocked mount');

    // The initial mount adopts the server's markup — hydrate, no repaint.
    expect(record).toEqual(['hydrate']);
    expect(result.shell.renderRoot.innerHTML).toContain('server-rendered content');

    // `locale` is not a hot-swap key, so this remounts. The destroyed app's
    // DOM is gone and nothing of the server's is left to adopt.
    const outcome = await result.update({ locale: 'fr' });

    expect(outcome.mode).toBe('remount');
    expect(record).toEqual(['hydrate', 'destroy', 'render']);
    expect(result.shell.renderRoot.innerHTML).toContain('data-painted="csr"');
  });

  test('updatePages(): a structural page-graph change repaints too', async () => {
    const record: string[] = [];
    const result = await hydrateMount(record);
    if (result.blocked) throw new Error('expected an unblocked mount');
    expect(record).toEqual(['hydrate']);

    // Adding a page is structural, so this skips the hot-swap classifier.
    const outcome = await result.updatePages([
      { id: 'home', type: 'home', enabled: true },
      { id: 'extra', type: 'home', enabled: true },
    ]);

    expect(outcome.mode).toBe('remount');
    expect(record).toEqual(['hydrate', 'destroy', 'render']);
    expect(result.shell.renderRoot.innerHTML).toContain('data-painted="csr"');
  });

  test("styleIsolation: 'light' — a remount repaints rather than adopting the destroyed app's DOM", async () => {
    // The explicit `renderRoot.innerHTML = ''` on the remount path only runs
    // under an isolated root, so in light mode the root is whatever destroy()
    // left. Hydrating that would adopt stale DOM instead of blank DOM — the
    // same wrong answer, quieter.
    const record: string[] = [];
    const result = await hydrateMount(record, 'light');
    if (result.blocked) throw new Error('expected an unblocked mount');
    expect(record).toEqual(['hydrate']);

    const outcome = await result.update({ locale: 'fr' });

    expect(outcome.mode).toBe('remount');
    expect(record).toEqual(['hydrate', 'destroy', 'render']);
    expect(result.shell.renderRoot.innerHTML).toContain('data-painted="csr"');
  });
});
