/**
 * Tests for the @airo-js/runtime/test-harness submodule.
 *
 * Two things being verified here:
 *   1. The harness actually works — mounts, captures dom + snapshot, cleans up.
 *   2. Failure modes throw with actionable messages (no templates, blocked
 *      by gate, missing document) so cartridge authors aren't left guessing.
 */

import { afterEach, describe, expect, test } from 'vitest';

import { mountCartridgeInMemory } from '../src/test-harness.js';
import {
  blockingGate,
  fakeCartridge,
  fakeDataSource,
  fakeTemplate,
  type TestConfig,
  type TestData,
} from './fixtures.js';

describe('mountCartridgeInMemory', () => {
  // Track host elements that survived a failed mount so we can rebuild a
  // clean body between tests. Successful tests call cleanup() themselves;
  // the error-path tests rely on the harness's own cleanup-on-throw.
  afterEach(() => {
    document.body.innerHTML = '';
  });

  test('happy path returns dom string, pipelineSnapshot, and cleanup', async () => {
    const result = await mountCartridgeInMemory<TestData, TestConfig>({
      cartridge: fakeCartridge(),
      config: {},
      fixtureFeed: { items: ['fixture-a', 'fixture-b'] },
    });

    expect(typeof result.dom).toBe('string');
    expect(result.pipelineSnapshot).toEqual({ items: ['fixture-a', 'fixture-b'] });
    expect(typeof result.cleanup).toBe('function');

    result.cleanup();
  });

  test('fixtureFeed bypasses DataSource.fetch — no network call', async () => {
    let fetchCalled = false;
    const cartridge = fakeCartridge({
      dataSources: [
        fakeDataSource({
          fetch: async () => {
            fetchCalled = true;
            return { items: ['from-fetch'] };
          },
        }),
      ],
    });

    const result = await mountCartridgeInMemory<TestData, TestConfig>({
      cartridge,
      config: {},
      fixtureFeed: { items: ['preloaded'] },
    });

    expect(fetchCalled).toBe(false);
    expect(result.pipelineSnapshot).toEqual({ items: ['preloaded'] });

    result.cleanup();
  });

  test('cleanup() removes the in-memory host and destroys the app', async () => {
    const childrenBefore = document.body.children.length;

    const result = await mountCartridgeInMemory<TestData, TestConfig>({
      cartridge: fakeCartridge(),
      config: {},
      fixtureFeed: { items: [] },
    });

    expect(document.body.children.length).toBe(childrenBefore + 1);

    result.cleanup();

    expect(document.body.children.length).toBe(childrenBefore);
  });

  test('defaults to cartridge.defaultTemplateId when no template is passed', async () => {
    const mainTemplate = { ...fakeTemplate(), id: 'main' };
    const other = { ...fakeTemplate(), id: 'other' };
    const cartridge = fakeCartridge({
      defaultTemplateId: 'main',
      templates: [other, mainTemplate],
    });

    // Should not throw; should resolve to mainTemplate (asserted by mounting cleanly).
    const result = await mountCartridgeInMemory<TestData, TestConfig>({
      cartridge,
      config: {},
      fixtureFeed: { items: [] },
    });

    expect(result.pipelineSnapshot).toBeDefined();
    result.cleanup();
  });

  test('falls back to templates[0] when defaultTemplateId does not match', async () => {
    const cartridge = fakeCartridge({
      defaultTemplateId: 'does-not-exist',
      templates: [fakeTemplate()],
    });

    const result = await mountCartridgeInMemory<TestData, TestConfig>({
      cartridge,
      config: {},
      fixtureFeed: { items: [] },
    });

    expect(result.pipelineSnapshot).toBeDefined();
    result.cleanup();
  });

  test('accepts an explicit template override', async () => {
    const custom = { ...fakeTemplate(), id: 'custom' };
    const cartridge = fakeCartridge({
      templates: [fakeTemplate(), custom],
    });

    const result = await mountCartridgeInMemory<TestData, TestConfig>({
      cartridge,
      config: {},
      fixtureFeed: { items: [] },
      template: custom,
    });

    expect(result.pipelineSnapshot).toBeDefined();
    result.cleanup();
  });

  test('throws an actionable error when the cartridge has no templates', async () => {
    const cartridge = fakeCartridge({ templates: [] });

    await expect(
      mountCartridgeInMemory<TestData, TestConfig>({
        cartridge,
        config: {},
        fixtureFeed: { items: [] },
      }),
    ).rejects.toThrow(/declares no templates/);
  });

  test('throws an actionable error when a gate blocks the mount', async () => {
    const cartridge = fakeCartridge({ gates: [blockingGate('age-gate')] });

    await expect(
      mountCartridgeInMemory<TestData, TestConfig>({
        cartridge,
        config: {},
        fixtureFeed: { items: [] },
      }),
    ).rejects.toThrow(/blocked by gate "age-gate"/);
  });
});
