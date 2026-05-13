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
  /**
   * Nested object with mixed hot-swap / remount semantics — the canonical
   * shape that motivated dot-path `hotSwapKeys`. Tests assert that a
   * cartridge can declare e.g. `['display.showPrices']` and have a
   * `display.categoryFilter` change correctly trigger remount.
   */
  display?: {
    showPrices?: boolean;
    showRatings?: boolean;
    categoryFilter?: string;
  };
  /** Top-level nested object — exercises the "top-level key covers all children" rule. */
  theme?: {
    primary?: string;
    secondary?: string;
  };
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

/**
 * Renderer that records which lifecycle method was called. Used to verify
 * the hydrate fork: `mode: 'hydrate'` should drive `hydrate()`; `mode: 'csr'`
 * (the default) should drive `render()`.
 */
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

/**
 * Renderer that captures subpage activations for asserting the
 * `SubpageActivation<T>` shape — including the new `page` field
 * landed in 0.7.0 (Finding 3).
 */
export function subpageCapturingRenderer(
  activations: unknown[],
): PageRenderer {
  return {
    render() {
      // no-op
    },
    destroy() {
      // no-op
    },
    activateSubpage(subpage) {
      activations.push(subpage);
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
