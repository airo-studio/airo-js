/**
 * Tests for `filterServerSafeCartridge` — the ergonomics helper that
 * drops views tagged with server-unsafe capabilities from a cartridge
 * before it reaches `renderAppWithPublication`.
 *
 * Covers: default csr-only exclusion, custom excludeCapabilities,
 * generics preservation, no-mutation guarantee, untagged views pass
 * through, mailbox-only cartridges (empty views[]) are a no-op, and
 * the composition with renderAppWithPublication.
 */

import { describe, expect, test } from 'vitest';

import type { Cartridge, PublicationContext } from '@airo-js/cartridge-kit';
import type { AppConfig, PageRenderer } from '@airo-js/core';

import { filterServerSafeCartridge } from '../src/filter-server-safe-cartridge.js';
import { renderAppWithPublication } from '../src/render-with-publication.js';

interface TestData { marker: string }
interface TestConfig { locale?: string }

function ssrRenderer(label: string): PageRenderer {
  return {
    render() { /* no-op */ },
    renderSSR(container) {
      container.innerHTML = `<div data-marker="${label}">${label}</div>`;
    },
    destroy() { /* no-op */ },
  };
}

function buildCartridge(mailboxName = '__AIRO_CAPABILITY_TEST_MAILBOX__'): Cartridge<TestData, TestConfig> {
  return {
    id: 'capability-test',
    industry: 'test',
    displayName: 'Capability Test',
    description: 'Fixture for filterServerSafeCartridge.',
    version: '0.0.0',
    schema: {
      parse: (input) => input as TestData,
      safeParse: (input) => ({ success: true as const, data: input as TestData }),
    },
    dataSources: [],
    mailboxName,
    views: [
      {
        id: 'home-view',
        displayName: 'Home',
        pageType: 'home',
        factory: () => ssrRenderer('home'),
        capabilities: ['ssr-safe', 'hydratable'],
      },
      {
        id: 'map-view',
        displayName: 'Map',
        pageType: 'map',
        factory: () => ssrRenderer('map'),
        capabilities: ['csr-only'],
      },
      {
        id: 'auth-view',
        displayName: 'Authenticated Dashboard',
        pageType: 'dashboard',
        factory: () => ssrRenderer('dashboard'),
        capabilities: ['requires-auth'],
      },
      {
        id: 'untagged-view',
        displayName: 'Untagged',
        pageType: 'plain',
        factory: () => ssrRenderer('plain'),
        // No capabilities declared — passes through every filter.
      },
    ],
    templates: [],
    defaultConfig: {},
    defaultTemplateId: 'main',
  };
}

describe('filterServerSafeCartridge', () => {
  test('default exclusion drops csr-only views and keeps everything else', () => {
    const cartridge = buildCartridge();
    const filtered = filterServerSafeCartridge(cartridge);
    const ids = filtered.views.map((v) => v.id);
    expect(ids).toEqual(['home-view', 'auth-view', 'untagged-view']);
    expect(ids).not.toContain('map-view');
  });

  test('custom excludeCapabilities composes multiple capability gates', () => {
    const cartridge = buildCartridge();
    const filtered = filterServerSafeCartridge(cartridge, {
      excludeCapabilities: ['csr-only', 'requires-auth'],
    });
    const ids = filtered.views.map((v) => v.id);
    expect(ids).toEqual(['home-view', 'untagged-view']);
  });

  test('preserves every other cartridge field (immutability of unrelated keys)', () => {
    const cartridge = buildCartridge();
    const filtered = filterServerSafeCartridge(cartridge);
    expect(filtered.id).toBe(cartridge.id);
    expect(filtered.schema).toBe(cartridge.schema);
    expect(filtered.dataSources).toBe(cartridge.dataSources);
    expect(filtered.templates).toBe(cartridge.templates);
    expect(filtered.defaultConfig).toBe(cartridge.defaultConfig);
    expect(filtered.defaultTemplateId).toBe(cartridge.defaultTemplateId);
  });

  test('does not mutate the input cartridge', () => {
    const cartridge = buildCartridge();
    const before = cartridge.views.length;
    filterServerSafeCartridge(cartridge);
    expect(cartridge.views.length).toBe(before);
    expect(cartridge.views.find((v) => v.id === 'map-view')).toBeDefined();
  });

  test('mailbox-only cartridges (empty views[]) pass through as a no-op', () => {
    const cartridge: Cartridge<TestData, TestConfig> = {
      ...buildCartridge('__AIRO_MAILBOX_ONLY_TEST__'),
      views: [],
    };
    const filtered = filterServerSafeCartridge(cartridge);
    expect(filtered.views).toEqual([]);
    expect(filtered.mailboxName).toBe('__AIRO_MAILBOX_ONLY_TEST__');
  });

  test('empty excludeCapabilities keeps all views (escape hatch)', () => {
    const cartridge = buildCartridge();
    const filtered = filterServerSafeCartridge(cartridge, { excludeCapabilities: [] });
    expect(filtered.views.length).toBe(cartridge.views.length);
  });

  test('composes with renderAppWithPublication — csr-only entry vanishes after filter', async () => {
    const cartridge = buildCartridge();
    const filtered = filterServerSafeCartridge(cartridge);

    // Build an AppConfig whose entry is the (now-removed) map view.
    const appConfig: AppConfig<string> = {
      pages: [{ id: 'map', type: 'map', enabled: true }],
    };
    const publicationCtx: PublicationContext<TestConfig> = {
      config: {},
      locale: 'en-GB',
      country: 'GB',
      currency: 'GBP',
    };

    // After filtering, the map view isn't in cartridge.views — the
    // runtime's resolveRenderer will return undefined for 'map', and
    // renderAppToHTML throws with a clear error. Production code
    // would either filter the appConfig.pages array too, or let the
    // throw bubble. For this test we assert the throw surface is
    // honest.
    await expect(
      renderAppWithPublication({
        cartridge: filtered,
        appConfig,
        snapshot: { marker: 'irrelevant' },
        publicationCtx,
      }),
    ).rejects.toThrow(/no renderer registered for page type "map"/);
  });
});
