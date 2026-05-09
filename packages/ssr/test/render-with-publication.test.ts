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
    renderSSR(container) {
      container.innerHTML = `<div data-marker="${label}">${label}</div>`;
    },
    destroy() {
      // no-op
    },
  };
}

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
