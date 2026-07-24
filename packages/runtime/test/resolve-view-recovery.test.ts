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
 *   6. Log story (0.8.8) — success `info` once the recovered page paints;
 *      `error` when the load rejects; `error` (once, no infinite loop)
 *      when the load resolves without registering the renderer.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { pushToMailbox } from '@airo-js/core';
import type { AiroEvent } from '@airo-js/log';
import { resetLogLevels, resetSink, setLogLevel, setSink } from '@airo-js/log';

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
  resetSink();
  resetLogLevels();
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

  test('successful recovery logs a runtime info — the "mounted after chunk load" closure signal', async () => {
    const captured: AiroEvent[] = [];
    setSink({ emit: (e) => captured.push(e) });
    setLogLevel('debug'); // default threshold is 'error' — open the tap for the info capture

    const sink: string[] = [];
    const cartridge = chunkedCartridge('rt-rv-log-ok');
    const resolveView = async (_cid: string, pageType: string) => {
      pushToMailbox(cartridge.mailboxName, {
        key: pageType,
        factory: () => recordingRenderer(sink),
      });
    };

    await mountCartridge<TestData, TestConfig>({
      cartridge,
      config: {},
      template: fakeTemplate(),
      host,
      preloadedData: { items: [] },
      resolveView,
    });
    await vi.waitFor(() => expect(sink).toContain('render'));

    const successLogs = captured.filter(
      (e) => e.channel === 'runtime' && e.msg.startsWith('chunk loaded'),
    );
    expect(successLogs).toHaveLength(1);
    expect(successLogs[0]?.level).toBe('info');
    expect(successLogs[0]?.msg).toContain('"home"');
    expect(successLogs[0]?.data).toMatchObject({
      pageType: 'home',
      cartridgeId: 'rt-rv-log-ok',
    });
    // No error logs on the happy path.
    expect(captured.filter((e) => e.level === 'error')).toHaveLength(0);
  });

  test('rejected load logs a runtime error alongside onError(resolve-view)', async () => {
    const captured: AiroEvent[] = [];
    setSink({ emit: (e) => captured.push(e) });

    const errors: MountPhase[] = [];
    const cartridge = chunkedCartridge('rt-rv-log-fail');
    const resolveView = async () => {
      throw new Error('chunk 404');
    };

    await mountCartridge<TestData, TestConfig>({
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

    await vi.waitFor(() => expect(errors).toContain('resolve-view'));
    const errorLogs = captured.filter(
      (e) => e.channel === 'runtime' && e.level === 'error',
    );
    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0]?.msg).toContain('chunk load failed');
    expect(errorLogs[0]?.err?.message).toBe('chunk 404');
  });

  test('load that resolves WITHOUT registering the renderer: one genuine error, no infinite loop, no success log', async () => {
    // The registration-failure corner: resolveView resolves (chunk
    // fetched + executed) but the chunk pushed under the wrong key /
    // mailbox, so the re-dispatch misses again. Pre-0.8.8 this looped
    // forever on the cached resolved load — miss → dispatch → miss —
    // with nothing above `info` ever logged. Now: exactly one
    // re-dispatch, then a hard error + onError('resolve-view'), and the
    // singleflight entry resets so a later miss starts a fresh load.
    const captured: AiroEvent[] = [];
    setSink({ emit: (e) => captured.push(e) });
    setLogLevel('debug'); // capture the (absence of the) info success log too

    const errors: MountPhase[] = [];
    const cartridge = chunkedCartridge('rt-rv-log-noreg');
    const resolveView = vi.fn(async (_cid: string, _pageType: string) => {
      // Resolves, but never calls pushToMailbox.
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

    await vi.waitFor(() => expect(errors).toContain('resolve-view'));
    // Settle any residual microtask churn — a loop would keep appending.
    await new Promise((r) => setTimeout(r, 20));

    const errorLogs = captured.filter(
      (e) => e.channel === 'runtime' && e.level === 'error',
    );
    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0]?.msg).toContain('registered no renderer');
    expect(errors).toEqual(['resolve-view']);
    // One initial load + no cached-replay loop.
    expect(resolveView).toHaveBeenCalledTimes(1);
    // Never claims success.
    expect(
      captured.filter(
        (e) => e.channel === 'runtime' && e.msg.startsWith('chunk loaded'),
      ),
    ).toHaveLength(0);

    // A later, fixed attempt starts fresh: the error path reset the
    // singleflight entry, so the next miss reloads instead of replaying
    // the stale resolved promise — and this time the chunk registers.
    if (result.blocked) throw new Error('expected unblocked');
    const sink: string[] = [];
    resolveView.mockImplementation(async (_cid: string, pageType: string) => {
      pushToMailbox(cartridge.mailboxName, {
        key: pageType,
        factory: () => recordingRenderer(sink),
      });
    });
    result.app.navigate({ page: 'home' });
    await vi.waitFor(() => expect(sink).toContain('render'));
    expect(resolveView).toHaveBeenCalledTimes(2);
  });
});
