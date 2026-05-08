/**
 * Preview:Triple — presentation cartridge that emits a
 * <studio-preview-triple> mount-point. The host bootstrap populates
 * `.cartridge`, `.data`, and `.mcpServerUrl` on the element.
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

export type PreviewTripleData = Record<string, never>;

export interface PreviewTripleConfig {
  className: string;
}

const passthroughSchema: SchemaDefinition<PreviewTripleData> = {
  parse: () => ({}),
  safeParse: () => ({ success: true, data: {} }),
  toJsonSchema: () => ({ type: 'object', additionalProperties: false }),
};

const emptyDataSource: DataSource<PreviewTripleData, PreviewTripleConfig> = {
  id: 'noop',
  displayName: 'No data (presentation cartridge)',
  onboardingShape: { kind: 'custom', descriptor: 'preview-triple-noop' },
  async fetch() {
    return {};
  },
};

const factory: () => PageRenderer<
  string,
  CartridgeAppContext<PreviewTripleData, PreviewTripleConfig>
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
  return `<div class="${escapeAttr(className)}"><studio-preview-triple></studio-preview-triple></div>`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const previewTripleView: ViewDefinition<PreviewTripleData, PreviewTripleConfig> = {
  id: 'preview-triple-view',
  displayName: 'Preview: Triple',
  pageType: 'preview-triple',
  factory,
  capabilities: ['responsive', 'ssr-safe', 'hydratable'],
};

const previewTripleTemplate: Template<PreviewTripleConfig> = {
  id: 'preview-triple-default',
  displayName: 'Preview: Triple (default)',
  description:
    'Presentation cartridge that emits a <studio-preview-triple> mount-point. Three preview surfaces (human, SEO-AIO, agent) updating synchronously on save.',
  pages: [{ id: 'preview-triple', type: 'preview-triple', enabled: true }],
  defaultConfig: { className: 'studio-preview-triple-host' },
};

export const previewTripleCartridge: Cartridge<PreviewTripleData, PreviewTripleConfig> = {
  id: 'preview-triple',
  industry: 'devtools',
  displayName: 'Preview: Triple',
  description:
    'Three-pane preview surface — human iframe, SEO/AIO snippet, agent MCP inspector — updating synchronously on save.',
  version: '0.0.0',

  schema: passthroughSchema,
  dataSources: [emptyDataSource],
  views: [previewTripleView],
  templates: [previewTripleTemplate],

  defaultConfig: previewTripleTemplate.defaultConfig,
  defaultTemplateId: previewTripleTemplate.id,
  mailboxName: '__AIRO_PREVIEW_TRIPLE_PAGES__',
};
