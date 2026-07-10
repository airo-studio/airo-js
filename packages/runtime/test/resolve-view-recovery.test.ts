/**
 * Tests for the 0.8.7 chunk-recovery engine on `mountCartridge` — the
 * Decision-1 seam, previously embed-only (0.8.5 Phase 6.5). Corners:
 *
 *   1. Basic recovery — missing renderer at mount → `resolveView` loads
 *      the chunk (mailbox self-registration) → runtime re-dispatches and
 *      the page paints. Covers the mount-ready gate implicitly: the load
 *      settles on a microtask DURING mount, so dispatch must wait.
 *   2. Singleflight — concurrent misses for the same view collapse to
 *      one `resolveView` call.
 *   3. Delete-on-reject — a failed load surfaces via
 *      `onError('resolve-view')` and the NEXT miss retries instead of
 *      replaying the cached rejection.
 *   4. Hydrate-vs-navigate dispatch — a hydrate-phase miss recovers via
 *      `hydratePage` (SSR DOM preserved), never `render`.
 *   5. Blocked mount releases the gate — queued recoveries return
 *      instead of stranding (the M-L4 corner) and never paint.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { pushToMailbox } from '@airo-js/core';

import { mountCartridge, type MountPhase } from '../src/mount-cartridge.js';
import {
  blockingGate,
  fakeCartridge,
  fakeTemplate,
  recordingRenderer,
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

/**
 * Cartridge that declares `home` in its template but ships NO static
 * renderer for it — the chunked-client `renderer:missing` case. Unique
 * id + mailbox per test: the default render resolver's chunk registry is
 * keyed module-globally by cartridge id.
 */
function chunkedCartridge(id: string) {
  return fakeCartridge({
    id,
    mailboxName: `__AIRO_${id.toUpperCase().replace(/-/g, '_')}_PAGES__`,
    views: [],
  });
}

describe('mountCartridge resolveView recovery (0.8.7)', () => {
  test('missing renderer → chunk load → recovery paints, gated on mount-ready', async () => {
    const sink: string[] = [];
    const cartridge = chunkedCartridge('rt-rv-basic');
    // Resolves on a microtask — the preloaded-chunk case. The miss emits
    // DURING mount, so the load settles before mountCartridge returns;
    // dispatch must wait for the live app instead of no-oping on null.
    const resolveView = vi.fn(async (_cid: string, pageType: string) => {
      pushToMailbox(cartridge.mailboxName, {
        key: pageType,
        factory: () => recordingRenderer(sink),
      });
    });

    const result = await mountCartridge<TestData, TestConfig>({
      cartridge,
      config: {},
      template: fakeTemplate(),
      host,
      preloadedData: { items: [] },
      resolveView,
    });
    if (result.blocked) throw new Error('expected unblocked');

    await vi.waitFor(() => expect(sink).toContain('render'));
    expect(resolveView).toHaveBeenCalledWith('rt-rv-basic', 'home');
    expect(resolveView).toHaveBeenCalledTimes(1);
    expect(result.app.state).toBe('mounted');
  });

  test('singleflight: concurrent misses for one view collapse to one load', async () => {
    const sink: string[] = [];
    const cartridge = chunkedCartridge('rt-rv-single');
    let releaseLoad: () => void = () => {};
    const gate = new Promise<void>((res) => {
      releaseLoad = res;
    });
    const resolveView = vi.fn(async (_cid: string, pageType: string) => {
      await gate;
      pushToMailbox(cartridge.mailboxName, {
        key: pageType,
        factory: () => recordingRenderer(sink),
      });
    });

    const result = await mountCartridge<TestData, TestConfig>({
      cartridge,
      config: {},
      template: fakeTemplate(),
      host,
      preloadedData: { items: [] },
      resolveView,
    });
    if (result.blocked) throw new Error('expected unblocked');

    // Second miss for the same view while the first load is in flight.
    result.app.navigate({ page: 'home' });
    expect(resolveView).toHaveBeenCalledTimes(1);

    releaseLoad();
    await vi.waitFor(() => expect(sink).toContain('render'));
    expect(resolveView).toHaveBeenCalledTimes(1);
  });

  test('delete-on-reject: failed load fires onError(resolve-view), next miss retries', async () => {
    const sink: string[] = [];
    const errors: MountPhase[] = [];
    const cartridge = chunkedCartridge('rt-rv-retry');
    const resolveView = vi.fn(async (_cid: string, pageType: string) => {
      if (resolveView.mock.calls.length === 1) {
        throw new Error('chunk 404');
      }
      pushToMailbox(cartridge.mailboxName, {
        key: pageType,
        factory: () => recordingRenderer(sink),
      });
    });

    const result = await mountCartridge<TestData, TestConfig>({
      cartridge,
      config: {},
      template: fakeTemplate(),
      host,
      preloadedData: { items: [] },
      resolveView,
      onError: (phase) => {
        errors.push(phase);
      },
    });
    if (result.blocked) throw new Error('expected unblocked');

    await vi.waitFor(() => expect(errors).toContain('resolve-view'));
    expect(sink).not.toContain('render');

    // Next miss must call resolveView again — a cached rejection would
    // permanently brick the chunk (the D19 corner).
    result.app.navigate({ page: 'home' });
    await vi.waitFor(() => expect(sink).toContain('render'));
    expect(resolveView).toHaveBeenCalledTimes(2);
  });

  test('hydrate-phase miss recovers via hydratePage — SSR DOM path, no repaint', async () => {
    const sink: string[] = [];
    const cartridge = chunkedCartridge('rt-rv-hydrate');
    host.innerHTML = '<div data-ssr>server markup</div>';
    const resolveView = vi.fn(async (_cid: string, pageType: string) => {
      pushToMailbox(cartridge.mailboxName, {
        key: pageType,
        factory: () => recordingRenderer(sink),
      });
    });

    const result = await mountCartridge<TestData, TestConfig>({
      cartridge,
      config: {},
      template: fakeTemplate(),
      host,
      mode: 'hydrate',
      preloadedData: { items: [] },
      resolveView,
    });
    if (result.blocked) throw new Error('expected unblocked');

    await vi.waitFor(() => expect(sink).toContain('hydrate'));
    // The dispatch split is the point: hydrate, not render — a navigate
    // here would wipe the SSR DOM.
    expect(sink).not.toContain('render');
  });

  test('blocked mount releases the gate — queued recovery returns, never paints', async () => {
    const sink: string[] = [];
    const cartridge = fakeCartridge({
      id: 'rt-rv-blocked',
      mailboxName: '__AIRO_RT_RV_BLOCKED_PAGES__',
      views: [],
      gates: [blockingGate()],
    });
    let loads = 0;
    const resolveView = async (_cid: string, pageType: string) => {
      loads++;
      pushToMailbox(cartridge.mailboxName, {
        key: pageType,
        factory: () => recordingRenderer(sink),
      });
    };

    const result = await mountCartridge<TestData, TestConfig>({
      cartridge,
      config: {},
      template: fakeTemplate(),
      host,
      preloadedData: { items: [] },
      resolveView,
    });
    expect(result.blocked).toBe(true);

    // Give any queued recovery a full tick to (incorrectly) dispatch.
    await new Promise((r) => setTimeout(r, 20));
    expect(sink).not.toContain('render');
    // Whether a miss even emitted before the gate blocked is fine either
    // way — the invariant is that a queued recovery can't strand or paint.
    expect(loads).toBeLessThanOrEqual(1);
  });
});
