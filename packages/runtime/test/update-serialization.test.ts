/**
 * Tests for the 0.8.7 dispatch hardening:
 *
 *   1. FIFO serialization — concurrent `update()` / `updatePages()` calls
 *      queue instead of interleaving destroy/remount cycles. The second
 *      call must observe the first call's post-remount state (config
 *      merges compose; renderer lifecycles balance to exactly one live
 *      instance).
 *   2. Queue resilience — a rejected dispatch doesn't stall the queue;
 *      the next call still runs.
 *   3. `'mount:remounted'` — emitted on `shell.events` (payload:
 *      `UpdateResult`) from the remount path of BOTH dispatchers, never
 *      from the hot-swap path.
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { Transformer } from '@airo-js/cartridge-kit';
import { EventBus } from '@airo-js/core';
import type { UpdateResult } from '@airo-js/core';

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
});

/**
 * Async transformer with a real await gap — forces the remount path to
 * yield to the microtask/macrotask queue so a second dispatch fired
 * synchronously after the first genuinely overlaps it.
 */
function slowRecordingTransformer(
  seen: TestConfig[],
  delayMs = 10,
): Transformer<TestData, TestConfig> {
  return {
    name: 'slow-recording',
    isEnabled: () => true,
    transform: async (data, ctx) => {
      await new Promise((r) => setTimeout(r, delayMs));
      seen.push(ctx.config);
      return data;
    },
    errorPolicy: 'fail-render',
  };
}

describe('update() FIFO serialization (0.8.7)', () => {
  test('concurrent remounting updates queue — second sees first\'s merged config', async () => {
    const seen: TestConfig[] = [];
    const result = await mountCartridge<TestData, TestConfig>({
      // No hotSwapKeys — every update takes the remount path.
      cartridge: fakeCartridge({
        transformers: [slowRecordingTransformer(seen)],
      }),
      config: { locale: 'en-US' },
      template: fakeTemplate(),
      host,
      preloadedData: { items: [] },
    });
    if (result.blocked) throw new Error('expected unblocked');
    expect(seen).toHaveLength(1);

    // Fire both without awaiting the first — this is the overlap that
    // interleaved before serialization landed.
    const p1 = result.update({ locale: 'fr-FR' });
    const p2 = result.update({ theme: { primary: 'blue' } });
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.mode).toBe('remount');
    expect(r2.mode).toBe('remount');
    // Pipeline ran exactly once per dispatch, in order.
    expect(seen).toHaveLength(3);
    expect(seen[1]).toEqual({ locale: 'fr-FR' });
    // The second update's deep-merge started from the FIRST update's
    // result — the lost-update failure mode of interleaved dispatch.
    expect(seen[2]).toEqual({ locale: 'fr-FR', theme: { primary: 'blue' } });

    expect(result.app.state).toBe('mounted');
  });

  test('renderer lifecycles balance to exactly one live instance after concurrent remounts', async () => {
    const lifecycle: string[] = [];
    const result = await mountCartridge<TestData, TestConfig>({
      cartridge: fakeCartridge({
        transformers: [slowRecordingTransformer([])],
        views: [
          {
            id: 'home-view',
            displayName: 'Home',
            pageType: 'home',
            factory: () => recordingRenderer(lifecycle),
          },
        ],
      }),
      config: { locale: 'en-US' },
      template: fakeTemplate(),
      host,
      preloadedData: { items: [] },
    });
    if (result.blocked) throw new Error('expected unblocked');

    await Promise.all([
      result.update({ locale: 'fr-FR' }),
      result.update({ locale: 'de-DE' }),
      result.update({ locale: 'it-IT' }),
    ]);

    const renders = lifecycle.filter((e) => e === 'render').length;
    const destroys = lifecycle.filter((e) => e === 'destroy').length;
    // Interleaved dispatch leaks a live app (renders outrun destroys by
    // more than the one active instance). Serialized: initial + 3
    // remounts = 4 renders, 3 destroys.
    expect(renders).toBe(4);
    expect(destroys).toBe(3);
    expect(result.app.state).toBe('mounted');
  });

  test('a rejected dispatch does not stall the queue', async () => {
    const seen: TestConfig[] = [];
    const boomTransformer: Transformer<TestData, TestConfig> = {
      name: 'boom-on-flag',
      isEnabled: () => true,
      transform: async (data, ctx) => {
        await new Promise((r) => setTimeout(r, 5));
        if (ctx.config.locale === 'boom') throw new Error('pipeline-blew-up');
        seen.push(ctx.config);
        return data;
      },
      errorPolicy: 'fail-render',
    };
    const result = await mountCartridge<TestData, TestConfig>({
      cartridge: fakeCartridge({ transformers: [boomTransformer] }),
      config: { locale: 'en-US' },
      template: fakeTemplate(),
      host,
      preloadedData: { items: [] },
    });
    if (result.blocked) throw new Error('expected unblocked');

    const p1 = result.update({ locale: 'boom' });
    const p2 = result.update({ locale: 'fr-FR' });

    await expect(p1).rejects.toThrow('pipeline-blew-up');
    const r2 = await p2;
    expect(r2.mode).toBe('remount');
    expect(result.app.state).toBe('mounted');
  });

  test('update() and updatePages() share one queue', async () => {
    const seen: TestConfig[] = [];
    const result = await mountCartridge<TestData, TestConfig>({
      cartridge: fakeCartridge({
        transformers: [slowRecordingTransformer(seen)],
      }),
      config: { locale: 'en-US' },
      template: fakeTemplate(),
      host,
      preloadedData: { items: [] },
    });
    if (result.blocked) throw new Error('expected unblocked');

    // Structural page change (added page) → remount; overlapped with a
    // config remount. Both must resolve without interleaving.
    const p1 = result.update({ locale: 'fr-FR' });
    const p2 = result.updatePages([
      { id: 'home', type: 'home', enabled: true },
      { id: 'home-2', type: 'home', enabled: true },
    ]);
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.mode).toBe('remount');
    expect(r2.mode).toBe('remount');
    expect(seen).toHaveLength(3);
    expect(result.app.state).toBe('mounted');
  });
});

describe("'mount:remounted' event (0.8.7)", () => {
  test('remount path emits UpdateResult on shell.events; hot-swap does not', async () => {
    const events = new EventBus();
    const emissions: UpdateResult[] = [];
    events.on('mount:remounted', (outcome) => {
      emissions.push(outcome as UpdateResult);
    });

    const result = await mountCartridge<TestData, TestConfig>({
      cartridge: fakeCartridge({ hotSwapKeys: ['theme'] }),
      config: { theme: { primary: 'red' }, locale: 'en-US' },
      template: fakeTemplate(),
      host,
      events,
      preloadedData: { items: [] },
    });
    if (result.blocked) throw new Error('expected unblocked');
    expect(result.shell.events).toBe(events);

    // Hot-swap: covered by hotSwapKeys — no emission.
    const hot = await result.update({ theme: { primary: 'blue' } });
    expect(hot.mode).toBe('hot-swap');
    expect(emissions).toHaveLength(0);

    // Remount: uncovered path — one emission carrying the UpdateResult.
    const cold = await result.update({ locale: 'fr-FR' });
    expect(cold.mode).toBe('remount');
    expect(emissions).toHaveLength(1);
    expect(emissions[0]).toEqual(cold);
    expect(emissions[0].navState).toBeDefined();
  });

  test('updatePages() remount path emits too', async () => {
    const events = new EventBus();
    const emissions: UpdateResult[] = [];
    events.on('mount:remounted', (outcome) => {
      emissions.push(outcome as UpdateResult);
    });

    const result = await mountCartridge<TestData, TestConfig>({
      cartridge: fakeCartridge(),
      config: {},
      template: fakeTemplate(),
      host,
      events,
      preloadedData: { items: [] },
    });
    if (result.blocked) throw new Error('expected unblocked');

    const outcome = await result.updatePages([
      { id: 'home', type: 'home', enabled: true },
      { id: 'home-2', type: 'home', enabled: true },
    ]);
    expect(outcome.mode).toBe('remount');
    expect(emissions).toHaveLength(1);
    expect(emissions[0]).toEqual(outcome);
  });

  test('subscription survives the remount (same bus instance across App swaps)', async () => {
    const events = new EventBus();
    let count = 0;
    events.on('mount:remounted', () => {
      count++;
    });

    const result = await mountCartridge<TestData, TestConfig>({
      cartridge: fakeCartridge(),
      config: { locale: 'en-US' },
      template: fakeTemplate(),
      host,
      events,
      preloadedData: { items: [] },
    });
    if (result.blocked) throw new Error('expected unblocked');

    await result.update({ locale: 'fr-FR' });
    await result.update({ locale: 'de-DE' });
    expect(count).toBe(2);
    // The bus the overlay subscribed to is still the live one.
    expect(result.shell.events).toBe(events);
  });
});
