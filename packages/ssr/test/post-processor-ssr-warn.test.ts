/**
 * PostProcessors are browser-only BY CONTRACT (0.9.0).
 *
 * `@airo-js/ssr` never constructs a pipeline: this path builds a string,
 * there is no DOM to decorate, and a post-render side effect has no
 * server-side meaning. That is a contract statement, not a "not implemented
 * yet" — a cartridge author must be able to rely on it.
 *
 * The warn exists because the alternative is the same silent-nothing that
 * the 0.9.0 client wiring fixed: declare a post-processor, render it
 * server-side, get no DOM, no error and no output. Requested by a consumer
 * as a permanent guard against the inverse regression.
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { AppConfig, PageRenderer } from '@airo-js/core';
import type { Cartridge, PostProcessor, PublicationContext } from '@airo-js/cartridge-kit';
import type { AiroEvent } from '@airo-js/log';
import { resetLogLevels, resetSink, setLogLevel, setSink } from '@airo-js/log';

import { renderAppWithPublication } from '../src/render-with-publication.js';

interface TestData {
  marker: string;
}
interface TestConfig {
  locale?: string;
}

const noopPostProcessor: PostProcessor<TestData, TestConfig> = {
  name: 'announcer',
  isEnabled: () => true,
  apply: () => undefined,
};

function stubRenderer(): PageRenderer {
  return {
    render(container) {
      container.innerHTML = '<p>rendered</p>';
    },
    destroy() {
      /* no-op */
    },
  };
}

function buildCartridge(
  postProcessors?: PostProcessor<TestData, TestConfig>[],
): Cartridge<TestData, TestConfig> {
  return {
    id: 'ssr-pp-test',
    industry: 'test',
    displayName: 'SSR PostProcessor Test',
    description: 'Fixture.',
    version: '0.0.0',
    schema: {
      parse: (i: unknown) => i as TestData,
      safeParse: (i: unknown) => ({ success: true as const, data: i as TestData }),
    },
    mailboxName: '__AIRO_SSR_PP_TEST_PAGES__',
    dataSources: [],
    views: [
      {
        id: 'home-view',
        displayName: 'Home',
        pageType: 'home',
        factory: () => stubRenderer(),
      },
    ],
    templates: [],
    ...(postProcessors ? { postProcessors } : {}),
  };
}

const appConfig: AppConfig = {
  appId: 'test',
  pages: [{ id: 'home', type: 'home', enabled: true }],
};

const publicationCtx: PublicationContext<TestConfig> = {
  config: {},
  locale: 'en',
  country: 'GB',
};

// Capture through the framework's own sink seam rather than stubbing
// console — that is the supported interception point, and it keeps the
// assertion on the emitted event rather than on console formatting.
let captured: AiroEvent[];

beforeEach(() => {
  captured = [];
  setSink({ emit: (e) => captured.push(e) });
  setLogLevel('warn');
});

afterEach(() => {
  resetSink();
  resetLogLevels();
});

function warnedAbout(substring: string): boolean {
  return captured.some((e) => e.level === 'warn' && e.msg.includes(substring));
}

async function render(cartridge: Cartridge<TestData, TestConfig>): Promise<string> {
  const result = await renderAppWithPublication<TestData, TestConfig>({
    cartridge,
    appConfig,
    snapshot: { marker: 'x' },
    publicationCtx,
    document: globalThis.document,
  });
  return result.html;
}

describe('postProcessors on the SSR path', () => {
  test('warns when a cartridge declares post-processors', async () => {
    await render(buildCartridge([noopPostProcessor]));
    expect(warnedAbout('browser-only')).toBe(true);
  });

  test('names the cartridge so the warn is actionable in a multi-cartridge host', async () => {
    await render(buildCartridge([noopPostProcessor]));
    expect(warnedAbout('ssr-pp-test')).toBe(true);
  });

  test('stays quiet for a cartridge that declares none', async () => {
    await render(buildCartridge());
    expect(warnedAbout('browser-only')).toBe(false);
  });

  test('stays quiet for an empty array — declaring the slot is not a mistake', async () => {
    // The shape a real consumer shipped for a year: the property is part
    // of the cartridge envelope, the array is deliberately empty.
    await render(buildCartridge([]));
    expect(warnedAbout('browser-only')).toBe(false);
  });

  test('the warn does not block rendering', async () => {
    const html = await render(buildCartridge([noopPostProcessor]));
    expect(html).toContain('rendered');
  });
});
