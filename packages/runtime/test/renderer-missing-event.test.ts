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

import { EventBus } from '@airo-js/core';

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
