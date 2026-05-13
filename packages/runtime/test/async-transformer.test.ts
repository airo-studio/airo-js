/**
 * Tests for async `Transformer.transform` — the 0.7 API widening that
 * accepts both sync (`TData`) and async (`Promise<TData>`) returns.
 *
 * Existing sync transformers are exercised across the rest of the suite.
 * This file proves the new async path works end-to-end: pipeline awaits
 * the promise, the resolved snapshot reaches the renderer + the
 * onPipelineComplete hook + the post-transformer view ctx.
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { Transformer } from '@airo-js/cartridge-kit';
import type { RenderContext } from '@airo-js/core';

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

/**
 * Async transformer that resolves to a transformed value after a
 * microtask tick. Mirrors the shape an auth-style flow would use
 * (await network → return enriched data).
 */
function asyncEnrichingTransformer(): Transformer<TestData, TestConfig> {
  return {
    name: 'async-enrich',
    isEnabled: () => true,
    transform: async (data) => {
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      return { items: data.items.map((s) => `${s}-enriched`) };
    },
    errorPolicy: 'fail-render',
  };
}

describe('async Transformer.transform (0.7+)', () => {
  test('async transformer return reaches the renderer + onPipelineComplete', async () => {
    let capturedFromRenderer: TestData | undefined;
    let capturedFromHook: TestData | undefined;

    const result = await mountCartridge<TestData, TestConfig>({
      cartridge: fakeCartridge({
        transformers: [asyncEnrichingTransformer()],
        views: [
          {
            id: 'home-view',
            displayName: 'Home',
            pageType: 'home',
            factory: () => ({
              render(_root: HTMLElement, ctx: RenderContext<string, unknown>) {
                capturedFromRenderer = (ctx.app as { data: TestData }).data;
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
      preloadedData: { items: ['a', 'b'] },
      onPipelineComplete: (snapshot) => {
        capturedFromHook = snapshot;
      },
    });
    if (result.blocked) throw new Error('expected unblocked');

    expect(capturedFromRenderer).toEqual({ items: ['a-enriched', 'b-enriched'] });
    expect(capturedFromHook).toEqual({ items: ['a-enriched', 'b-enriched'] });
  });

  test('sync and async transformers chain in declared order', async () => {
    const seenOrder: string[] = [];

    const syncTagger: Transformer<TestData, TestConfig> = {
      name: 'sync-tag',
      isEnabled: () => true,
      transform: (data) => {
        seenOrder.push('sync');
        return { items: data.items.map((s) => `${s}|sync`) };
      },
    };
    const asyncTagger: Transformer<TestData, TestConfig> = {
      name: 'async-tag',
      isEnabled: () => true,
      transform: async (data) => {
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        seenOrder.push('async');
        return { items: data.items.map((s) => `${s}|async`) };
      },
    };

    let captured: TestData | undefined;
    const result = await mountCartridge<TestData, TestConfig>({
      cartridge: fakeCartridge({
        transformers: [syncTagger, asyncTagger],
      }),
      config: {},
      template: fakeTemplate(),
      host,
      preloadedData: { items: ['x'] },
      onPipelineComplete: (snapshot) => {
        captured = snapshot;
      },
    });
    if (result.blocked) throw new Error('expected unblocked');

    expect(seenOrder).toEqual(['sync', 'async']);
    expect(captured).toEqual({ items: ['x|sync|async'] });
  });

  test('async transformer rejection with fail-render policy aborts mount', async () => {
    const failing: Transformer<TestData, TestConfig> = {
      name: 'async-fail-render',
      isEnabled: () => true,
      transform: async () => {
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        throw new Error('async-boom');
      },
      errorPolicy: 'fail-render',
    };

    await expect(
      mountCartridge<TestData, TestConfig>({
        cartridge: fakeCartridge({ transformers: [failing] }),
        config: {},
        template: fakeTemplate(),
        host,
        preloadedData: { items: [] },
      }),
    ).rejects.toThrow('async-boom');
  });

  test('async transformer rejection with skip policy passes input through', async () => {
    const skipping: Transformer<TestData, TestConfig> = {
      name: 'async-skip',
      isEnabled: () => true,
      transform: async () => {
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        throw new Error('async-skip-boom');
      },
      errorPolicy: 'skip',
    };

    let captured: TestData | undefined;
    const result = await mountCartridge<TestData, TestConfig>({
      cartridge: fakeCartridge({ transformers: [skipping] }),
      config: {},
      template: fakeTemplate(),
      host,
      preloadedData: { items: ['original'] },
      onPipelineComplete: (snapshot) => {
        captured = snapshot;
      },
    });
    if (result.blocked) throw new Error('expected unblocked');

    // Skip policy: error logged, original input passes through.
    expect(captured).toEqual({ items: ['original'] });
  });
});
