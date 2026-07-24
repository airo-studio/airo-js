/**
 * Tests for the 0.8.8 native narration layer in @airo-js/core:
 *
 *   - Every `EventBus.emit` narrates `bus: <event>` at debug on the
 *     core channel, with `listeners` and the payload — replaces the
 *     emit-wrap consumers monkey-patched for the same trace.
 *   - PageManager narrates `navigation: …` at debug with the trigger
 *     kind (navigate | hydrate) — the one thing the
 *     `navigation:changed` bus payload doesn't carry.
 *   - All of it is invisible at the default 'error' threshold.
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { EventBus } from '@airo-js/core';
import type { AiroEvent } from '@airo-js/log';
import {
  isLevelEnabled,
  resetLogLevels,
  resetSink,
  setLogLevel,
  setSink,
} from '@airo-js/log';

import { mountCartridge } from '../src/mount-cartridge.js';
import {
  fakeCartridge,
  fakeTemplate,
  type TestConfig,
  type TestData,
} from './fixtures.js';

let host: HTMLElement;
let captured: AiroEvent[];

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  captured = [];
  setSink({ emit: (e) => captured.push(e) });
});

afterEach(() => {
  host.remove();
  resetSink();
  resetLogLevels();
});

describe('bus narration', () => {
  test('emit narrates event name, listener count, and unwrapped single payload at debug', () => {
    setLogLevel('debug');
    const bus = new EventBus();
    bus.on('my:event', () => {});
    bus.on('my:event', () => {});
    bus.emit('my:event', { value: 42 });

    const line = captured.find((e) => e.msg === 'bus: my:event');
    expect(line).toBeDefined();
    expect(line?.channel).toBe('core');
    expect(line?.level).toBe('debug');
    expect(line?.data).toMatchObject({
      listeners: 2,
      payload: { value: 42 },
    });
  });

  test('zero-listener emissions narrate too (listeners: 0, no payload key for arg-less events)', () => {
    setLogLevel('debug');
    const bus = new EventBus();
    bus.emit('nobody:listens');
    const line = captured.find((e) => e.msg === 'bus: nobody:listens');
    expect(line?.data).toMatchObject({ listeners: 0 });
    expect(line?.data?.payload).toBeUndefined();
  });

  test("silent at the default 'error' threshold", () => {
    const bus = new EventBus();
    bus.emit('my:event', { value: 42 });
    expect(captured).toHaveLength(0);
  });

  test('isLevelEnabled reflects the threshold that gates the hot path', () => {
    // emit() guards narration behind isLevelEnabled('core', 'debug') so the
    // template string + payload object are built only when it will emit.
    // The guard is unobservable via a sink (the logger's own check drops
    // the same events), so we test the predicate the guard reads directly.
    expect(isLevelEnabled('core', 'debug')).toBe(false); // default 'error'
    expect(isLevelEnabled('core', 'error')).toBe(true);
    setLogLevel('debug');
    expect(isLevelEnabled('core', 'debug')).toBe(true);
  });
});

describe('navigation narration', () => {
  test('mount narrates the entry navigation with the trigger kind', async () => {
    setLogLevel('debug');
    await mountCartridge<TestData, TestConfig>({
      cartridge: fakeCartridge(),
      config: {},
      template: fakeTemplate(),
      host,
      preloadedData: { items: [] },
    });

    const nav = captured.filter((e) => e.msg.startsWith('navigation:'));
    expect(nav.length).toBeGreaterThanOrEqual(1);
    expect(nav[0]?.msg).toBe('navigation: page "home" (navigate)');
    expect(nav[0]?.level).toBe('debug');
    expect(nav[0]?.data).toMatchObject({ pageId: 'home', pageType: 'home' });
    // The bus line for navigation:changed rides alongside — both layers
    // of the story are visible under core:debug.
    expect(captured.some((e) => e.msg === 'bus: navigation:changed')).toBe(true);
  });

  test('hydrate-mode mount narrates with (hydrate)', async () => {
    setLogLevel('debug');
    host.innerHTML = '<div data-airo-ssr="1">pre-rendered</div>';
    await mountCartridge<TestData, TestConfig>({
      cartridge: fakeCartridge(),
      config: {},
      template: fakeTemplate(),
      host,
      mode: 'hydrate',
      preloadedData: { items: [] },
    });

    const nav = captured.filter((e) => e.msg.startsWith('navigation:'));
    expect(nav.some((e) => e.msg === 'navigation: page "home" (hydrate)')).toBe(true);
  });
});
