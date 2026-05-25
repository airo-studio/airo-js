/**
 * Tests for the `'renderer:missing'` event landed in 0.8.1.
 *
 * Studios that lazy-load page chunks subscribe to this event to render
 * a skeleton / spinner while the chunk fetch is in flight, then
 * re-navigate once the factory registers via `pushToMailbox`. The
 * event fires once per missing-resolve attempt; PageManager does not
 * retry on its own.
 *
 * Coverage:
 *   - Fires on the CSR `navigate` path with phase: 'navigate'.
 *   - Fires on the SSR-hydrate path with phase: 'hydrate'.
 *   - Payload carries pageType + pageId.
 *   - Does NOT fire when a factory resolves cleanly.
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { EventBus, pushToMailbox } from '@airo-js/core';
import type { PageRendererFactory } from '@airo-js/core';
import type { AiroEvent } from '@airo-js/log';
import {
  resetLogLevels,
  resetSink,
  setChannelLevel,
  setLogLevel,
  setSink,
} from '@airo-js/log';

import { mountCartridge } from '../src/mount-cartridge.js';
import {
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
  // Drop the mailbox proxy installed by createRegistry so test order
  // doesn't matter — each test starts with a clean global slot for
  // `__AIRO_FAKE_PAGES__`.
  delete (globalThis as Record<string, unknown>).__AIRO_FAKE_PAGES__;
  // Tests that install a capturing sink reset here to avoid log
  // pollution leaking between tests.
  resetSink();
  resetLogLevels();
});

interface MissingPayload {
  pageType: string;
  pageId: string;
  phase: 'navigate' | 'hydrate';
}

describe("'renderer:missing' event", () => {
  test('fires on CSR navigate path with phase: navigate when no factory resolves', async () => {
    const events = new EventBus();
    const received: MissingPayload[] = [];
    events.on('renderer:missing', (payload) => {
      received.push(payload as MissingPayload);
    });

    // Cartridge with no views — resolver returns undefined for any pageType.
    // Template still has an enabled entry page, so PageManager attempts to
    // resolve + swap, hits the missing-factory branch, soft-fails.
    await mountCartridge<TestData, TestConfig>({
      cartridge: fakeCartridge({ views: [] }),
      config: {},
      template: fakeTemplate(),
      host,
      events,
      preloadedData: { items: [] },
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      pageType: 'home',
      pageId: 'home',
      phase: 'navigate',
    });
  });

  test('fires on SSR-hydrate path with phase: hydrate when no factory resolves', async () => {
    const events = new EventBus();
    const received: MissingPayload[] = [];
    events.on('renderer:missing', (payload) => {
      received.push(payload as MissingPayload);
    });

    // Pre-paint some SSR HTML so the runtime takes the hydrate path.
    host.innerHTML = '<div data-airo-ssr="1">pre-rendered</div>';

    await mountCartridge<TestData, TestConfig>({
      cartridge: fakeCartridge({ views: [] }),
      config: {},
      template: fakeTemplate(),
      host,
      events,
      mode: 'hydrate',
      preloadedData: { items: [] },
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      pageType: 'home',
      pageId: 'home',
      phase: 'hydrate',
    });
  });

  test('app.hydratePage() recovers the SSR-hydrate path after the chunk arrives', async () => {
    // The chunk-race scenario this method exists to close:
    //   1. Mount with mode: 'hydrate' before the page chunk has executed.
    //      `views: []` + empty mailbox → resolver returns undefined →
    //      `renderer:missing { phase: 'hydrate' }` fires; SSR DOM stays
    //      untouched (the renderer never ran).
    //   2. The chunk arrives later and calls `pushToMailbox` to register
    //      its factory. The cartridge-level mailbox set up at register-
    //      time captures the late push.
    //   3. The host catches `renderer:missing`, waits for the chunk, then
    //      calls `app.hydratePage(pageId)`. The framework re-runs the
    //      SSR-hydrate path: resolver hits, `renderer.hydrate(...)` wires
    //      listeners against the existing SSR DOM, no repaint.
    //
    // The alternative (`app.navigate({ page })`) would route through the
    // CSR `swapRenderer` path and repaint, wiping the SSR markup — which
    // is exactly the no-flicker invariant `hydratePage` preserves.
    const events = new EventBus();
    const received: MissingPayload[] = [];
    events.on('renderer:missing', (payload) => {
      received.push(payload as MissingPayload);
    });

    // Pre-paint SSR HTML so the runtime takes the hydrate path.
    host.innerHTML = '<div data-airo-ssr="1">pre-rendered</div>';

    const record: string[] = [];
    const result = await mountCartridge<TestData, TestConfig>({
      cartridge: fakeCartridge({ views: [] }),
      config: {},
      template: fakeTemplate(),
      host,
      events,
      mode: 'hydrate',
      preloadedData: { items: [] },
    });

    // Phase-5 hydrate missed; one emission with phase: 'hydrate'.
    expect(received).toHaveLength(1);
    expect(received[0]?.phase).toBe('hydrate');
    expect(record).toEqual([]); // renderer never ran

    if (result.blocked) throw new Error('expected unblocked mount');

    // Simulate the chunk arriving — same shape as a real per-page chunk
    // calling pushToMailbox in its module-level entry.
    const homeFactory: PageRendererFactory = () => recordingRenderer(record);
    pushToMailbox('__AIRO_FAKE_PAGES__', { key: 'home', factory: homeFactory });

    // Re-attempt hydrate. Resolver now hits, hydrate runs against the
    // existing SSR DOM.
    result.app.hydratePage('home');

    expect(record).toContain('hydrate');
    expect(record).not.toContain('render');
    // No second renderer:missing — the recovery completed cleanly.
    expect(received).toHaveLength(1);
  });

  test('app.hydratePage() is idempotent for an already-hydrated pageId — second call is a no-op', async () => {
    // Regression guard for the bug consumers hit when two parallel
    // recovery paths both call `app.hydratePage(activePageId)` after a
    // chunk-load event (e.g. a pre-mount `renderer:missing` subscriber
    // AND a `chunkPromise.then(...)` block). Before the fix, the second
    // call would invoke factory() a second time, build a fresh renderer
    // instance, hydrate it against the same DOM, and never destroy the
    // first — causing duplicate listeners + component instances. After
    // the fix, the second call returns immediately when activeRenderer
    // is already set for that pageId.
    const events = new EventBus();
    host.innerHTML = '<div data-airo-ssr="1">pre-rendered</div>';

    const record: string[] = [];
    let factoryCalls = 0;
    const homeFactory: PageRendererFactory = () => {
      factoryCalls++;
      return recordingRenderer(record);
    };

    const result = await mountCartridge<TestData, TestConfig>({
      cartridge: fakeCartridge({ views: [] }),
      config: {},
      template: fakeTemplate(),
      host,
      events,
      mode: 'hydrate',
      preloadedData: { items: [] },
    });
    if (result.blocked) throw new Error('expected unblocked mount');

    pushToMailbox('__AIRO_FAKE_PAGES__', { key: 'home', factory: homeFactory });

    // First call — proceeds, factory invoked, hydrate runs.
    result.app.hydratePage('home');
    expect(factoryCalls).toBe(1);
    expect(record).toEqual(['hydrate']);

    // Second call with the same pageId — must be a no-op. No second
    // factory() invocation, no second hydrate() call, no orphaned
    // renderer (would manifest as a second 'hydrate' in record).
    result.app.hydratePage('home');
    expect(factoryCalls).toBe(1);
    expect(record).toEqual(['hydrate']);

    // Third call too, for good measure (idempotent means n calls = 1
    // effect, not just 2 calls = 1 effect).
    result.app.hydratePage('home');
    expect(factoryCalls).toBe(1);
    expect(record).toEqual(['hydrate']);
  });

  test("logs renderer:missing at 'warn' when no subscriber is wired", async () => {
    const captured: AiroEvent[] = [];
    setSink({ emit: (e) => captured.push(e) });

    // Note: NO events subscriber on renderer:missing — the warn signal
    // exists exactly for hosts that haven't wired the recovery seam.
    host.innerHTML = '<div data-airo-ssr="1">pre-rendered</div>';

    await mountCartridge<TestData, TestConfig>({
      cartridge: fakeCartridge({ views: [] }),
      config: {},
      template: fakeTemplate(),
      host,
      mode: 'hydrate',
      preloadedData: { items: [] },
    });

    const rendererMissingLogs = captured.filter(
      (e) => e.msg.startsWith('no renderer registered'),
    );
    expect(rendererMissingLogs).toHaveLength(1);
    expect(rendererMissingLogs[0]?.level).toBe('warn');
  });

  test("logs renderer:missing at 'info' when a subscriber IS wired (recoverable path)", async () => {
    const captured: AiroEvent[] = [];
    setSink({ emit: (e) => captured.push(e) });

    // Subscriber wired BEFORE mount — same shape consumers use for
    // chunk-load recovery. The presence of a subscriber means the
    // missing-factory case is a documented recovery flow, not a
    // misconfiguration; log demotes from warn to info.
    const events = new EventBus();
    events.on('renderer:missing', () => {
      /* recovery handler */
    });

    host.innerHTML = '<div data-airo-ssr="1">pre-rendered</div>';

    await mountCartridge<TestData, TestConfig>({
      cartridge: fakeCartridge({ views: [] }),
      config: {},
      template: fakeTemplate(),
      host,
      events,
      mode: 'hydrate',
      preloadedData: { items: [] },
    });

    const rendererMissingLogs = captured.filter(
      (e) => e.msg.startsWith('no renderer registered'),
    );
    expect(rendererMissingLogs).toHaveLength(1);
    expect(rendererMissingLogs[0]?.level).toBe('info');
  });

  test('setLogLevel("warn") drops the info-level recoverable-renderer:missing log entirely', async () => {
    // End-to-end check that the @airo-js/log threshold filter composes
    // with the renderer-missing demotion: when a subscriber IS wired,
    // the log is at 'info'; bumping the global threshold to 'warn'
    // means the info-level log never reaches the sink. Confirms apps
    // can tighten log noise in prod without losing the 'renderer:missing'
    // event itself (the event still emits — only the log is filtered).
    const captured: AiroEvent[] = [];
    setSink({ emit: (e) => captured.push(e) });
    setLogLevel('warn');

    const events = new EventBus();
    const eventPayloads: unknown[] = [];
    events.on('renderer:missing', (p) => eventPayloads.push(p));

    host.innerHTML = '<div data-airo-ssr="1">pre-rendered</div>';

    await mountCartridge<TestData, TestConfig>({
      cartridge: fakeCartridge({ views: [] }),
      config: {},
      template: fakeTemplate(),
      host,
      events,
      mode: 'hydrate',
      preloadedData: { items: [] },
    });

    const rendererMissingLogs = captured.filter(
      (e) => e.msg.startsWith('no renderer registered'),
    );
    // Log dropped by the threshold filter.
    expect(rendererMissingLogs).toHaveLength(0);
    // Event still emits — log filtering is purely cosmetic.
    expect(eventPayloads).toHaveLength(1);
  });

  test('setChannelLevel("core", "silent") drops core logs but leaves the event bus untouched', async () => {
    const captured: AiroEvent[] = [];
    setSink({ emit: (e) => captured.push(e) });
    setChannelLevel('core', 'silent');

    const events = new EventBus();
    const eventPayloads: unknown[] = [];
    events.on('renderer:missing', (p) => eventPayloads.push(p));

    host.innerHTML = '<div data-airo-ssr="1">pre-rendered</div>';

    await mountCartridge<TestData, TestConfig>({
      cartridge: fakeCartridge({ views: [] }),
      config: {},
      template: fakeTemplate(),
      host,
      events,
      mode: 'hydrate',
      preloadedData: { items: [] },
    });

    const coreLogs = captured.filter((e) => e.channel === 'core');
    expect(coreLogs).toHaveLength(0);
    expect(eventPayloads).toHaveLength(1);
  });

  test('does NOT fire when the cartridge declares a matching view', async () => {
    const events = new EventBus();
    const received: MissingPayload[] = [];
    events.on('renderer:missing', (payload) => {
      received.push(payload as MissingPayload);
    });

    await mountCartridge<TestData, TestConfig>({
      cartridge: fakeCartridge(),
      config: {},
      template: fakeTemplate(),
      host,
      events,
      preloadedData: { items: [] },
    });

    expect(received).toHaveLength(0);
  });
});
