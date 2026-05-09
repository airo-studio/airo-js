/**
 * Fixtures for embed tests.
 *
 * The embed integration tests dynamically import `@airo-js/runtime` for
 * real (workspace dep) so the runtime → cartridge → mount path is
 * exercised end-to-end. This keeps the fixtures small — they only need
 * to satisfy the cartridge-kit contract enough for `mountCartridge` to
 * complete.
 */

import type { Cartridge } from '@airo-js/cartridge-kit';
import type { PageRenderer } from '@airo-js/core';

export interface TestData {
  items: string[];
}

export interface TestConfig {
  feed?: { url?: string };
}

const passthroughSchema = {
  parse: (input: unknown) => input as TestData,
  safeParse: (input: unknown) => ({ success: true as const, data: input as TestData }),
};

export function recordingRenderer(record: string[]): PageRenderer {
  return {
    render() {
      record.push('render');
    },
    hydrate() {
      record.push('hydrate');
    },
    destroy() {
      record.push('destroy');
    },
  };
}

export function fakeCartridge(
  lifecycleSink: string[] = [],
): Cartridge<TestData, TestConfig> {
  return {
    id: 'fake',
    industry: 'test',
    displayName: 'Fake Cartridge',
    description: 'Fixture for embed tests.',
    version: '0.0.0',
    schema: passthroughSchema,
    dataSources: [
      {
        id: 'fake-ds',
        displayName: 'Fake DS',
        onboardingShape: { kind: 'url-input' },
        fetch: async () => ({ items: ['from-fetch'] }),
      },
    ],
    views: [
      {
        id: 'home-view',
        displayName: 'Home',
        pageType: 'home',
        factory: () => recordingRenderer(lifecycleSink),
      },
    ],
    templates: [
      {
        id: 'main',
        displayName: 'Main',
        description: 'Test template.',
        pages: [{ id: 'home', type: 'home', enabled: true }],
        defaultConfig: {},
      },
    ],
    defaultConfig: {},
    defaultTemplateId: 'main',
    mailboxName: '__AIRO_FAKE_PAGES__',
  };
}

/**
 * Wait for a predicate to become true; throws after `timeoutMs`. Used by
 * tests to await async element-lifecycle work that fires inside
 * connectedCallback (which can't be awaited directly).
 */
export async function waitFor(
  pred: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor: predicate did not become true within timeout');
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

let elementCounter = 0;
/** Returns a unique custom-element tag name per call (test isolation). */
export function uniqueElementName(prefix = 'airo-app-test'): string {
  elementCounter += 1;
  return `${prefix}-${elementCounter}`;
}
