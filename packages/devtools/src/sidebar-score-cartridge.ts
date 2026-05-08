/**
 * Sidebar:Score — presentation cartridge that emits a <studio-aio-score>
 * mount-point. Pair to <studio-aio-score>; the host bootstrap populates the
 * element's `.cartridge` and `.data` properties so the score recomputes as
 * the user edits.
 *
 * Same "presentation cartridge" shape as EditorShell: minimal stub schema
 * + noop data source. Surfaces the cartridge-kit contract gap noted in the
 * design doc (presentation-cartridge variant or explicit optionality).
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

export type SidebarScoreData = Record<string, never>;

export interface SidebarScoreConfig {
  /** CSS class applied to the wrapping <div>. */
  className: string;
}

const passthroughSchema: SchemaDefinition<SidebarScoreData> = {
  parse: () => ({}),
  safeParse: () => ({ success: true, data: {} }),
  toJsonSchema: () => ({ type: 'object', additionalProperties: false }),
};

const emptyDataSource: DataSource<SidebarScoreData, SidebarScoreConfig> = {
  id: 'noop',
  displayName: 'No data (presentation cartridge)',
  onboardingShape: { kind: 'custom', descriptor: 'sidebar-score-noop' },
  async fetch() {
    return {};
  },
};

const sidebarScoreFactory: () => PageRenderer<
  string,
  CartridgeAppContext<SidebarScoreData, SidebarScoreConfig>
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
  return `<div class="${escapeAttr(className)}"><studio-aio-score></studio-aio-score></div>`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const sidebarScoreView: ViewDefinition<SidebarScoreData, SidebarScoreConfig> = {
  id: 'sidebar-score-view',
  displayName: 'Sidebar: AIO Score',
  pageType: 'sidebar-score',
  factory: sidebarScoreFactory,
  capabilities: ['responsive', 'ssr-safe', 'hydratable'],
};

const sidebarScoreTemplate: Template<SidebarScoreConfig> = {
  id: 'sidebar-score-default',
  displayName: 'Sidebar: AIO Score (default)',
  description:
    'Presentation cartridge that emits a <studio-aio-score> mount-point. Renders the AIO Score with 5-input breakdown.',
  pages: [{ id: 'sidebar-score', type: 'sidebar-score', enabled: true }],
  defaultConfig: { className: 'studio-aio-score-host' },
};

export const sidebarScoreCartridge: Cartridge<SidebarScoreData, SidebarScoreConfig> = {
  id: 'sidebar-score',
  industry: 'devtools',
  displayName: 'Sidebar: AIO Score',
  description:
    'AIO Score panel — the largest visual weight on the studio. Renders five-input breakdown via <studio-aio-score>.',
  version: '0.0.0',

  schema: passthroughSchema,
  dataSources: [emptyDataSource],
  views: [sidebarScoreView],
  templates: [sidebarScoreTemplate],

  defaultConfig: sidebarScoreTemplate.defaultConfig,
  defaultTemplateId: sidebarScoreTemplate.id,
  mailboxName: '__AIRO_SIDEBAR_SCORE_PAGES__',
};
