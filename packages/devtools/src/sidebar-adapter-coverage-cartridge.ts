/**
 * Sidebar:AdapterCoverage — presentation cartridge that emits a
 * <studio-adapter-coverage> mount-point. Pair to <studio-adapter-coverage>;
 * the host bootstrap populates `.cartridge` and `.data`.
 *
 * Same shape as editorShellCartridge / sidebarScoreCartridge: stub schema,
 * noop data source, view emits the mount-point custom element.
 */

import type {
  Cartridge,
  CartridgeAppContext,
  DataSource,
  SchemaDefinition,
  Template,
  ViewDefinition,
} from '@airo-js/cartridge-kit';
import type { PageRenderer } from '@airo-js/core';

export type SidebarAdapterCoverageData = Record<string, never>;

export interface SidebarAdapterCoverageConfig {
  className: string;
}

const passthroughSchema: SchemaDefinition<SidebarAdapterCoverageData> = {
  parse: () => ({}),
  safeParse: () => ({ success: true, data: {} }),
  toJsonSchema: () => ({ type: 'object', additionalProperties: false }),
};

const emptyDataSource: DataSource<SidebarAdapterCoverageData, SidebarAdapterCoverageConfig> = {
  id: 'noop',
  displayName: 'No data (presentation cartridge)',
  onboardingShape: { kind: 'custom', descriptor: 'sidebar-adapter-coverage-noop' },
  async fetch() {
    return {};
  },
};

const factory: () => PageRenderer<
  string,
  CartridgeAppContext<SidebarAdapterCoverageData, SidebarAdapterCoverageConfig>
> = () => ({
  render(targetEl, ctx) {
    targetEl.innerHTML = renderMountPoint(ctx.app.config.className);
  },
  destroy() {
    /* declarative — Lit handles teardown */
  },
  renderSSR(targetEl, ctx) {
    targetEl.innerHTML = renderMountPoint(ctx.app.config.className);
  },
});

function renderMountPoint(className: string): string {
  return `<div class="${escapeAttr(className)}"><studio-adapter-coverage></studio-adapter-coverage></div>`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const sidebarAdapterCoverageView: ViewDefinition<
  SidebarAdapterCoverageData,
  SidebarAdapterCoverageConfig
> = {
  id: 'sidebar-adapter-coverage-view',
  displayName: 'Sidebar: Adapter coverage',
  pageType: 'sidebar-adapter-coverage',
  factory,
  capabilities: ['responsive', 'ssr-safe', 'hydratable'],
};

const sidebarAdapterCoverageTemplate: Template<SidebarAdapterCoverageConfig> = {
  id: 'sidebar-adapter-coverage-default',
  displayName: 'Sidebar: Adapter coverage (default)',
  description:
    'Presentation cartridge that emits a <studio-adapter-coverage> mount-point. Lists every PublicationAdapter with status and missing field paths.',
  pages: [{ id: 'sidebar-adapter-coverage', type: 'sidebar-adapter-coverage', enabled: true }],
  defaultConfig: { className: 'studio-adapter-coverage-host' },
};

export const sidebarAdapterCoverageCartridge: Cartridge<
  SidebarAdapterCoverageData,
  SidebarAdapterCoverageConfig
> = {
  id: 'sidebar-adapter-coverage',
  industry: 'devtools',
  displayName: 'Sidebar: Adapter coverage',
  description:
    'PublicationAdapter coverage panel — every adapter declared, with status and missing field paths.',
  version: '0.0.0',

  schema: passthroughSchema,
  dataSources: [emptyDataSource],
  views: [sidebarAdapterCoverageView],
  templates: [sidebarAdapterCoverageTemplate],

  defaultConfig: sidebarAdapterCoverageTemplate.defaultConfig,
  defaultTemplateId: sidebarAdapterCoverageTemplate.id,
  mailboxName: '__AIRO_SIDEBAR_ADAPTER_COVERAGE_PAGES__',
};
