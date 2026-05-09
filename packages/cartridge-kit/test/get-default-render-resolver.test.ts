/**
 * Regression tests for getDefaultRenderResolver — the per-cartridge
 * memoized helper that fixes the chunk-mailbox blocker (apps shipping
 * `views: []` + `mailboxName` couldn't resolve renderers because the
 * default in createCartridgeApp / renderAppWithPublication walked
 * `views[]` only).
 *
 * Tests focus on the helper itself; the integration test through
 * mountCartridge lives in @airo-js/runtime.
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { pushToMailbox } from '@airo-js/core';
import type { PageRendererFactory } from '@airo-js/core';

import type { Cartridge } from '../src/cartridge.js';
import type { CartridgeAppContext } from '../src/view.js';
import { getDefaultRenderResolver } from '../src/cartridge-registry.js';

type AnyFactory = PageRendererFactory<
  string,
  CartridgeAppContext<unknown, unknown>
>;

/**
 * Counter so each test gets a fresh mailbox name — registries collide on
 * the global slot, and our memoization keys on cartridge identity, not
 * mailbox name. Unique-per-test keeps tests independent regardless of
 * order.
 */
let mailboxCounter = 0;
function uniqueMailbox(): string {
  return `__AIRO_TEST_MAILBOX_${mailboxCounter++}__`;
}

function buildCartridge(
  overrides: Partial<Cartridge> = {},
): Cartridge {
  const mailboxName = overrides.mailboxName ?? uniqueMailbox();
  return {
    id: 'test-cartridge',
    industry: 'test',
    displayName: 'Test',
    description: 'Test cartridge fixture.',
    version: '0.0.0',
    schema: {
      parse: (input) => input,
      safeParse: (input) => ({ success: true as const, data: input }),
    },
    dataSources: [],
    views: [],
    templates: [],
    defaultConfig: {},
    defaultTemplateId: 'main',
    mailboxName,
    ...overrides,
  };
}

function fakeFactory(label: string): AnyFactory {
  // The factory just needs to be a unique reference — we identify it by
  // identity, not by what it produces.
  const fn = () => ({
    render() {
      // no-op
    },
    destroy() {
      // no-op
    },
  });
  Object.defineProperty(fn, 'name', { value: `factory:${label}` });
  return fn as unknown as AnyFactory;
}

const installedMailboxes: string[] = [];

afterEach(() => {
  // Tear down any globalThis slots installed by createRegistry so tests
  // remain hermetic. (Memoization keys on cartridge identity, so cleaning
  // global slots doesn't help dedupe between tests — unique mailbox names
  // do that — but it keeps the global namespace tidy.)
  const g = globalThis as Record<string, unknown>;
  for (const name of installedMailboxes) {
    delete g[name];
  }
  installedMailboxes.length = 0;
});

function trackMailbox(name: string): string {
  installedMailboxes.push(name);
  return name;
}

describe('getDefaultRenderResolver', () => {
  test('drains pre-loaded mailbox entries (chunk pushed BEFORE first resolve)', () => {
    const mailbox = trackMailbox(uniqueMailbox());
    const factory = fakeFactory('quickshop');

    // Simulate a chunk that loaded before the host bootstrapped — pushes
    // to a bare array at globalThis[mailbox].
    pushToMailbox(mailbox, { key: 'quickshop', factory });

    const cartridge = buildCartridge({ views: [], mailboxName: mailbox });
    const resolve = getDefaultRenderResolver(cartridge);

    expect(resolve('quickshop')).toBe(factory);
  });

  test('live-proxy path: chunk pushed AFTER first resolve still resolvable', () => {
    const mailbox = trackMailbox(uniqueMailbox());
    const cartridge = buildCartridge({ views: [], mailboxName: mailbox });

    // First resolve installs the live proxy; nothing pushed yet.
    const resolve = getDefaultRenderResolver(cartridge);
    expect(resolve('categories')).toBeUndefined();

    // Late-loaded chunk pushes through the proxy.
    const factory = fakeFactory('categories');
    pushToMailbox(mailbox, { key: 'categories', factory });

    expect(resolve('categories')).toBe(factory);
  });

  test('static views[] resolve without touching the mailbox (no regression)', () => {
    const mailbox = trackMailbox(uniqueMailbox());
    const factory = fakeFactory('home');

    const cartridge = buildCartridge({
      mailboxName: mailbox,
      views: [
        {
          id: 'home-view',
          displayName: 'Home',
          pageType: 'home',
          factory: factory as unknown as Cartridge['views'][number]['factory'],
        },
      ],
    });

    const resolve = getDefaultRenderResolver(cartridge);
    expect(resolve('home')).toBe(factory);
  });

  test('memoizes per-cartridge identity: second call sees chunks pushed between calls', () => {
    const mailbox = trackMailbox(uniqueMailbox());
    const cartridge = buildCartridge({ views: [], mailboxName: mailbox });

    const resolveA = getDefaultRenderResolver(cartridge);
    expect(resolveA('late')).toBeUndefined();

    const factory = fakeFactory('late');
    pushToMailbox(mailbox, { key: 'late', factory });

    // Calling getDefaultRenderResolver again on the SAME cartridge object
    // must NOT rebuild the registry — that would lose the entry pushed
    // through the live proxy.
    const resolveB = getDefaultRenderResolver(cartridge);
    expect(resolveB('late')).toBe(factory);

    // Both resolvers share the same underlying registry, so the first
    // resolver also sees the new entry.
    expect(resolveA('late')).toBe(factory);
  });

  test('separate cartridge objects with different mailboxes get separate registries', () => {
    const mailboxA = trackMailbox(uniqueMailbox());
    const mailboxB = trackMailbox(uniqueMailbox());
    const cartridgeA = buildCartridge({ id: 'shared-id', mailboxName: mailboxA });
    const cartridgeB = buildCartridge({ id: 'shared-id', mailboxName: mailboxB });

    const factoryA = fakeFactory('only-in-a');
    pushToMailbox(mailboxA, { key: 'only-in-a', factory: factoryA });

    const resolveA = getDefaultRenderResolver(cartridgeA);
    const resolveB = getDefaultRenderResolver(cartridgeB);

    expect(resolveA('only-in-a')).toBe(factoryA);
    // cartridgeB has its own registry against mailboxB — never saw the push.
    expect(resolveB('only-in-a')).toBeUndefined();
  });

  test('returns undefined for an unknown pageType (no static view, no mailbox push)', () => {
    const mailbox = trackMailbox(uniqueMailbox());
    const cartridge = buildCartridge({ views: [], mailboxName: mailbox });
    const resolve = getDefaultRenderResolver(cartridge);
    expect(resolve('does-not-exist')).toBeUndefined();
  });
});
