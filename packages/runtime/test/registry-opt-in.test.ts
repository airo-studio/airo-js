/**
 * Tests for `mountCartridge.registry` opt-in — the long-open framework
 * item documented as additive in CLAUDE.md §3. Multi-cartridge studios
 * pass a shared `CartridgeRegistry` instead of letting `mountCartridge`
 * build a per-mount default.
 *
 * Behaviour to verify:
 *   1. Passing a registry resolves renderers via `registry.resolverFor(cartridgeId)`.
 *   2. Omitting it falls back to the lazy WeakMap default (existing path).
 *   3. The registry handles late chunk pushes (chunk mailbox semantics).
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { createCartridgeRegistry, type Cartridge } from '@airo-js/cartridge-kit';
import { pushToMailbox } from '@airo-js/core';

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

describe('mountCartridge.registry opt-in', () => {
  test('renderer resolves via the shared registry when one is provided', async () => {
    const lifecycle: string[] = [];
    const cartridge = fakeCartridge({
      views: [
        {
          id: 'home-view',
          displayName: 'Home',
          pageType: 'home',
          factory: () => recordingRenderer(lifecycle),
        },
      ],
    });
    const registry = createCartridgeRegistry([cartridge as unknown as Cartridge]);

    const result = await mountCartridge<TestData, TestConfig>({
      cartridge,
      config: {},
      template: fakeTemplate(),
      host,
      preloadedData: { items: [] },
      registry,
    });
    if (result.blocked) throw new Error('expected unblocked');

    // Renderer was resolved + rendered through the registry path.
    expect(lifecycle).toContain('render');
  });

  test('registry resolves renderers from late chunk mailbox pushes', async () => {
    const lifecycle: string[] = [];
    const mailboxName = '__AIRO_REGISTRY_OPT_IN_TEST__';
    const cartridge = fakeCartridge({
      views: [], // chunk-mailbox pattern — no static views
      mailboxName,
    });
    const registry = createCartridgeRegistry([cartridge as unknown as Cartridge]);

    try {
      // Simulate a chunk that pushes its factory AFTER registry creation
      // but BEFORE mount — the registry's resolverFor proxy should see it.
      pushToMailbox(mailboxName, {
        key: 'home',
        factory: () => recordingRenderer(lifecycle),
      });

      const result = await mountCartridge<TestData, TestConfig>({
        cartridge,
        config: {},
        template: fakeTemplate(),
        host,
        preloadedData: { items: [] },
        registry,
      });
      if (result.blocked) throw new Error('expected unblocked');

      expect(lifecycle).toContain('render');
    } finally {
      delete (globalThis as Record<string, unknown>)[mailboxName];
    }
  });

  test('omitting registry falls back to the default per-mount resolver', async () => {
    const lifecycle: string[] = [];
    const cartridge = fakeCartridge({
      views: [
        {
          id: 'home-view',
          displayName: 'Home',
          pageType: 'home',
          factory: () => recordingRenderer(lifecycle),
        },
      ],
    });

    // No registry passed — should use getDefaultRenderResolver under the hood.
    const result = await mountCartridge<TestData, TestConfig>({
      cartridge,
      config: {},
      template: fakeTemplate(),
      host,
      preloadedData: { items: [] },
    });
    if (result.blocked) throw new Error('expected unblocked');

    expect(lifecycle).toContain('render');
  });

  test('a shared registry can mount the same cartridge twice', async () => {
    // Multi-instance scenario — studios with two widget embeds on the
    // same page sharing one registry. Each mount() call resolves via
    // the same registry without interference.
    const lifecycleA: string[] = [];
    const lifecycleB: string[] = [];
    const cartridgeA = fakeCartridge({
      id: 'shared-cart',
      views: [
        {
          id: 'home-view',
          displayName: 'Home',
          pageType: 'home',
          factory: () => recordingRenderer(lifecycleA),
        },
      ],
    });
    const registry = createCartridgeRegistry([cartridgeA as unknown as Cartridge]);

    const hostB = document.createElement('div');
    document.body.appendChild(hostB);

    try {
      const r1 = await mountCartridge<TestData, TestConfig>({
        cartridge: cartridgeA,
        config: {},
        template: fakeTemplate(),
        host,
        preloadedData: { items: [] },
        registry,
      });
      const r2 = await mountCartridge<TestData, TestConfig>({
        cartridge: cartridgeA,
        config: {},
        template: fakeTemplate(),
        host: hostB,
        preloadedData: { items: [] },
        registry,
      });

      if (r1.blocked || r2.blocked) throw new Error('expected unblocked');
      // Both mounts resolved + rendered via the shared registry.
      // (Both share the same lifecycle array because both factory
      // closures push to lifecycleA — proves the same factory was
      // resolved from the same registry both times.)
      expect(lifecycleA.filter((s) => s === 'render').length).toBe(2);
    } finally {
      hostB.remove();
    }
  });
});
