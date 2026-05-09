/**
 * Fake-cartridge fixtures for mountCartridge tests.
 *
 * Builders compose: `fakeCartridge({ ...overrides })` produces a minimal
 * valid Cartridge<TestData, TestConfig>; helpers add gates / failing
 * transformers / failing data sources on top.
 */

import type {
  Cartridge,
  DataSource,
  Gate,
  Template,
  Transformer,
} from '@airo-js/cartridge-kit';
import type { PageRenderer } from '@airo-js/core';

export interface TestData {
  items: string[];
}

export interface TestConfig {
  feed?: { url?: string };
  locale?: string;
}

const passthroughSchema = {
  parse: (input: unknown) => input as TestData,
  safeParse: (input: unknown) => ({ success: true as const, data: input as TestData }),
};

export function noopRenderer(): PageRenderer {
  return {
    render() {
      // no-op — tests don't assert on painted DOM
    },
    destroy() {
      // no-op
    },
  };
}

export function fakeDataSource(
  overrides: Partial<DataSource<TestData, TestConfig>> = {},
): DataSource<TestData, TestConfig> {
  return {
    id: 'fake-ds',
    displayName: 'Fake DataSource',
    onboardingShape: { kind: 'url-input' },
    fetch: async () => ({ items: ['from-fetch'] }),
    ...overrides,
  };
}

export function fakeTemplate(): Template<TestConfig> {
  return {
    id: 'main',
    displayName: 'Main',
    description: 'Single-page test template.',
    pages: [{ id: 'home', type: 'home', enabled: true }],
    defaultConfig: {},
  };
}

export function fakeCartridge(
  overrides: Partial<Cartridge<TestData, TestConfig>> = {},
): Cartridge<TestData, TestConfig> {
  return {
    id: 'fake',
    industry: 'test',
    displayName: 'Fake Cartridge',
    description: 'Fixture for runtime tests.',
    version: '0.0.0',
    schema: passthroughSchema,
    dataSources: [fakeDataSource()],
    views: [
      {
        id: 'home-view',
        displayName: 'Home',
        pageType: 'home',
        factory: () => noopRenderer(),
      },
    ],
    templates: [fakeTemplate()],
    defaultConfig: {},
    defaultTemplateId: 'main',
    mailboxName: '__AIRO_FAKE_PAGES__',
    ...overrides,
  };
}

export function blockingGate(id = 'always-block'): Gate<TestConfig> {
  return {
    id,
    displayName: 'Always-Block',
    isEnabled: () => true,
    async precheck() {
      return 'gate-required';
    },
    async mount(host) {
      host.innerHTML = `<div class="gate-${id}">blocked</div>`;
      return 'block';
    },
    destroy() {
      // no-op
    },
  };
}

export function failingTransformer(
  policy: 'fail-render' | 'skip' = 'fail-render',
): Transformer<TestData, TestConfig> {
  return {
    name: 'failing-transformer',
    isEnabled: () => true,
    transform: () => {
      throw new Error('transformer-blew-up');
    },
    errorPolicy: policy,
  };
}
