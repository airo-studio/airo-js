/**
 * Regression test for the chunk-mailbox blocker on the SSR path.
 *
 * Pre-fix, `renderAppWithPublication`'s default resolveRenderer walked
 * `cartridge.views[]` only — same defect as `createCartridgeApp` in
 * cartridge-kit. Cartridges shipping per-chunk views (`views: []` +
 * `mailboxName`) couldn't render server-side. Fixed by routing the
 * default through `getDefaultRenderResolver` from cartridge-kit.
 */

import { describe, expect, test } from 'vitest';

import { pushToMailbox } from '@airo-js/core';
import type { AppConfig, PageRenderer } from '@airo-js/core';
import type { Cartridge, PublicationContext } from '@airo-js/cartridge-kit';

import { renderAppWithPublication } from '../src/render-with-publication.js';

interface TestData {
  marker: string;
}
interface TestConfig {
  locale?: string;
}

function buildCartridge(mailboxName: string): Cartridge<TestData, TestConfig> {
  return {
    id: 'ssr-test',
    industry: 'test',
    displayName: 'SSR Test',
    description: 'SSR test cartridge fixture.',
    version: '0.0.0',
    schema: {
      parse: (input) => input as TestData,
      safeParse: (input) => ({ success: true as const, data: input as TestData }),
    },
    dataSources: [],
    views: [], // chunk pattern — no static views
    templates: [],
    defaultConfig: {},
    defaultTemplateId: 'main',
    mailboxName,
  };
}

function ssrRenderer(label: string): PageRenderer {
  return {
    render() {
      // no-op — SSR uses renderSSR
    },
    renderSSR(container, ctx) {
      // Emit navState context fields too so tests can assert
      // initialNavState flowed through, not just the resolved page id.
      const navContext = Object.entries(ctx.navState ?? {})
        .filter(([k]) => k !== 'page')
        .map(([k, v]) => `data-nav-${k}="${v}"`)
        .join(' ');
      container.innerHTML =
        `<div data-marker="${label}" data-page="${ctx.page.id}"${navContext ? ' ' + navContext : ''}>${label}</div>`;
    },
    destroy() {
      // no-op
    },
  };
}

describe('renderAppWithPublication — csr-only capability gate', () => {
  test('skips SSR when entry view declares capabilities: ["csr-only"]; still emits adapter results', async () => {
    const cartridge: Cartridge<TestData, TestConfig> = {
      id: 'csr-only-test',
      industry: 'test',
      displayName: 'CSR-only Test',
      description: 'csr-only capability fixture.',
      version: '0.0.0',
      schema: {
        parse: (input) => input as TestData,
        safeParse: (input) => ({ success: true as const, data: input as TestData }),
      },
      dataSources: [],
      views: [
        {
          id: 'map-view',
          displayName: 'Map',
          pageType: 'map',
          factory: () => ({
            render() {
              throw new Error('should not be called — view is csr-only');
            },
            renderSSR() {
              throw new Error('should not be called — view is csr-only');
            },
            destroy() {},
          }),
          capabilities: ['csr-only'],
        },
      ],
      templates: [],
      defaultConfig: {},
      defaultTemplateId: 'main',
    };

    const appConfig: AppConfig<string> = {
      pages: [{ id: 'map', type: 'map', enabled: true }],
    };
    const publicationCtx: PublicationContext<TestConfig> = {
      config: {},
      locale: 'en-GB',
      country: 'GB',
      currency: 'GBP',
    };

    const result = await renderAppWithPublication({
      cartridge,
      appConfig,
      snapshot: { marker: 'irrelevant' },
      publicationCtx,
    });

    expect(result.skipped).toEqual({ pageType: 'map', reason: 'csr-only' });
    expect(result.html).toBe(''); // no JSON-LD adapters in this cartridge, no widget HTML
    expect(result.adapterResults).toEqual([]);
  });
});

describe('renderAppWithPublication — initialNavState (deep-link seed)', () => {
  // Build a cartridge with static views[] (no mailbox global state)
  // so each test gets a fresh, isolated render path. The existing
  // mailbox-based buildCartridge above is shared across tests via
  // globalThis, which makes multi-test setups non-deterministic.
  function multiPageCartridge(): Cartridge<TestData, TestConfig> {
    return {
      id: 'entry-id-test',
      industry: 'test',
      displayName: 'Entry ID Test',
      description: 'Fixture for entryPageId override tests.',
      version: '0.0.0',
      schema: {
        parse: (input) => input as TestData,
        safeParse: (input) => ({ success: true as const, data: input as TestData }),
      },
      dataSources: [],
      views: [
        {
          id: 'home-view',
          displayName: 'Home',
          pageType: 'home',
          factory: () => ssrRenderer('home'),
        },
        {
          id: 'product-view',
          displayName: 'Product',
          pageType: 'product',
          factory: () => ssrRenderer('product'),
        },
      ],
      templates: [],
      defaultConfig: {},
      defaultTemplateId: 'main',
      // mailboxName required for getDefaultRenderResolver — the registry
      // builds globalThis[mailboxName] as part of resolver construction.
      mailboxName: `__AIRO_TEST_ENTRY_${Math.random().toString(36).slice(2, 8)}__`,
    };
  }

  function publicationCtx(): PublicationContext<TestConfig> {
    return {
      config: { locale: 'en-GB' },
      locale: 'en-GB',
      country: 'GB',
      currency: 'GBP',
    };
  }

  test('initialNavState.page selects the deeplinked page instead of the default entry', async () => {
    const cartridge = multiPageCartridge();
    const appConfig: AppConfig<string> = {
      pages: [
        { id: 'home', type: 'home', enabled: true },
        { id: 'product', type: 'product', enabled: true },
      ],
    };

    const result = await renderAppWithPublication({
      cartridge,
      appConfig,
      snapshot: { marker: 'x' },
      publicationCtx: publicationCtx(),
      initialNavState: { page: 'product' },
    });

    expect(result.html).toContain('data-marker="product"');
    expect(result.html).not.toContain('data-marker="home"');
  });

  test('initialNavState passes context fields (productId, category) into ctx.navState — the v3 bug fix', async () => {
    const cartridge = multiPageCartridge();
    const appConfig: AppConfig<string> = {
      pages: [
        { id: 'home', type: 'home', enabled: true },
        { id: 'product', type: 'product', enabled: true },
      ],
    };

    const result = await renderAppWithPublication({
      cartridge,
      appConfig,
      snapshot: { marker: 'x' },
      publicationCtx: publicationCtx(),
      initialNavState: { page: 'product', productId: 'abc', category: 'Cereal' },
    });

    expect(result.html).toContain('data-marker="product"');
    // The renderer saw the full navState, not just .page — context
    // fields make it to ctx.navState verbatim. This is the regression
    // the v3 contract closes. (DOM attribute names normalise to
    // lowercase on serialisation; the value is preserved verbatim.)
    expect(result.html).toContain('data-nav-productid="abc"');
    expect(result.html).toContain('data-nav-category="Cereal"');
  });

  test('framework-validated entry id wins over a disagreeing initialNavState.page', async () => {
    // Spread-order guard: when initialNavState.page resolves cleanly,
    // ctx.page.id and ctx.navState.page must be identical even if the
    // host accidentally passes a different .page in initialNavState.
    // Today both come from the same resolved entry, so this test just
    // documents the invariant; if a future change splits the two paths
    // and they disagree, this test catches it.
    const cartridge = multiPageCartridge();
    const appConfig: AppConfig<string> = {
      pages: [
        { id: 'home', type: 'home', enabled: true },
        { id: 'product', type: 'product', enabled: true },
      ],
    };

    const result = await renderAppWithPublication({
      cartridge,
      appConfig,
      snapshot: { marker: 'x' },
      publicationCtx: publicationCtx(),
      initialNavState: { page: 'product', productId: 'abc' },
    });

    // ctx.page.id and the data-marker label are the same id.
    expect(result.html).toContain('data-page="product"');
    expect(result.html).toContain('data-marker="product"');
  });

  test('unknown initialNavState.page falls back to the default entry (safe deeplink decode)', async () => {
    const cartridge = multiPageCartridge();
    const appConfig: AppConfig<string> = {
      pages: [
        { id: 'home', type: 'home', enabled: true },
        { id: 'product', type: 'product', enabled: true },
      ],
    };

    const result = await renderAppWithPublication({
      cartridge,
      appConfig,
      snapshot: { marker: 'x' },
      publicationCtx: publicationCtx(),
      initialNavState: { page: 'does-not-exist' },  // tampered / stale deeplink
    });

    // Falls back to first enabled non-parent — home.
    expect(result.html).toContain('data-marker="home"');
  });

  test('disabled target page falls back to default (silent rescue)', async () => {
    const cartridge = multiPageCartridge();
    const appConfig: AppConfig<string> = {
      pages: [
        { id: 'home', type: 'home', enabled: true },
        { id: 'product', type: 'product', enabled: false },  // disabled
      ],
    };

    const result = await renderAppWithPublication({
      cartridge,
      appConfig,
      snapshot: { marker: 'x' },
      publicationCtx: publicationCtx(),
      initialNavState: { page: 'product' },
    });

    expect(result.html).toContain('data-marker="home"');
  });

  test('subpage target page is rejected — falls back to default (subpage URLs not supported)', async () => {
    // Documents the contract: navState.page targeting a subpage
    // (p.parent set) is rejected by resolveEntryPage, falls back to
    // the default top-level entry. No one should infer subpage-URL
    // support from this surface — if it becomes needed, file a
    // separate ticket.
    const cartridge = multiPageCartridge();
    const appConfig: AppConfig<string> = {
      pages: [
        { id: 'home', type: 'home', enabled: true },
        { id: 'product', type: 'product', enabled: true },
        // A subpage variant of product (e.g. quick-shop) — parent set.
        { id: 'product-quick', type: 'product', enabled: true, parent: 'product' },
      ],
    };

    const result = await renderAppWithPublication({
      cartridge,
      appConfig,
      snapshot: { marker: 'x' },
      publicationCtx: publicationCtx(),
      initialNavState: { page: 'product-quick' },  // subpage — rejected
    });

    expect(result.html).toContain('data-marker="home"');
  });

  test('gate target page is rejected — falls back to non-gate default', async () => {
    const cartridge = multiPageCartridge();
    const appConfig: AppConfig<string> = {
      pages: [
        { id: 'gate', type: 'gate', enabled: true },
        { id: 'home', type: 'home', enabled: true },
        { id: 'product', type: 'product', enabled: true },
      ],
    };

    const result = await renderAppWithPublication({
      cartridge,
      appConfig,
      snapshot: { marker: 'x' },
      publicationCtx: publicationCtx(),
      initialNavState: { page: 'gate' },  // tampered URL pointing to gate
      isGatePage: (type) => type === 'gate',
    });

    // Gate is filtered; falls back to first non-gate non-parent — home.
    expect(result.html).toContain('data-marker="home"');
  });
});

describe('renderAppWithPublication — default resolver', () => {
  test('chunk-mailbox cartridge (views: []) renders entry page from pushed factory', async () => {
    const mailbox = '__AIRO_TEST_SSR_MAILBOX_A__';
    pushToMailbox(mailbox, {
      key: 'home',
      factory: () => ssrRenderer('home'),
    });

    try {
      const cartridge = buildCartridge(mailbox);
      const appConfig: AppConfig<string> = {
        pages: [{ id: 'home', type: 'home', enabled: true }],
      };
      const publicationCtx: PublicationContext<TestConfig> = {
        config: { locale: 'en-GB' },
        locale: 'en-GB',
        country: 'GB',
        currency: 'GBP',
      };

      const result = await renderAppWithPublication({
        cartridge,
        appConfig,
        snapshot: { marker: 'irrelevant' },
        publicationCtx,
      });

      expect(result.html).toContain('data-marker="home"');
      expect(result.adapterResults).toEqual([]);
    } finally {
      delete (globalThis as Record<string, unknown>)[mailbox];
    }
  });
});
