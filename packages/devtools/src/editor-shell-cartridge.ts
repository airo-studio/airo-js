/**
 * EditorShell — presentation-only airo-js cartridge whose View emits a
 * <studio-editor> mount-point. The host app's bootstrap code populates
 * the element's `.cartridge` JS property after the page renders.
 *
 * This is one of three structural cartridges that compose the studio-lite
 * page layout (alongside Sidebar:Score, Sidebar:AdapterCoverage, and
 * Preview:Triple — those land in subsequent commits).
 *
 * Structural cartridges stretch the existing self-contained-content
 * cartridge contract — they have no real data source, transformer, or
 * publication adapter. The contract refinement (presentation-cartridge
 * variant or explicit optionality on those primitives) is a v0.x
 * cartridge-kit design item; this is the first implementation surfacing
 * the precise shape needed. For now we satisfy the contract with empty
 * stubs.
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

// ────────────────────────────── Types ─────────────────────────────

/**
 * Empty by design. The mount-point is filled by the host app's bootstrap
 * code, not by cartridge-side data. Kept as a typed shape for symmetry
 * with the cartridge contract.
 */
export type EditorShellData = Record<string, never>;

export interface EditorShellConfig {
  /** CSS class applied to the wrapping <div> for layout integration. */
  className: string;
}

// ────────────────────────────── Schema ────────────────────────────

const passthroughSchema: SchemaDefinition<EditorShellData> = {
  parse: () => ({}),
  safeParse: () => ({ success: true, data: {} }),
  toJsonSchema: () => ({ type: 'object', additionalProperties: false }),
};

// ──────────────────────────── DataSource ──────────────────────────

const emptyDataSource: DataSource<EditorShellData, EditorShellConfig> = {
  id: 'noop',
  displayName: 'No data (presentation cartridge)',
  onboardingShape: { kind: 'custom', descriptor: 'editor-shell-noop' },
  async fetch() {
    return {};
  },
};

// ──────────────────────────────── View ────────────────────────────

const editorShellRendererFactory: () => PageRenderer<
  string,
  CartridgeAppContext<EditorShellData, EditorShellConfig>
> = () => ({
  render(targetEl, ctx) {
    targetEl.innerHTML = renderMountPoint(ctx.app.config.className);
  },
  destroy() {
    /* declarative — Lit element handles its own teardown */
  },
  renderSSR(targetEl, ctx) {
    // SSR output is the same custom-element placeholder; the Lit element
    // hydrates client-side once `studio-editor.js` defines the tag.
    targetEl.innerHTML = renderMountPoint(ctx.app.config.className);
  },
});

function renderMountPoint(className: string): string {
  return `<div class="${escapeAttr(className)}"><studio-editor></studio-editor></div>`;
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const editorShellView: ViewDefinition<EditorShellData, EditorShellConfig> = {
  id: 'editor-shell-view',
  displayName: 'Editor shell',
  pageType: 'editor-shell',
  factory: editorShellRendererFactory,
  capabilities: ['responsive', 'ssr-safe', 'hydratable'],
};

// ──────────────────────────── Template ────────────────────────────

const editorShellTemplate: Template<EditorShellConfig> = {
  id: 'editor-shell-default',
  displayName: 'Editor shell (default)',
  description:
    'Presentation cartridge that emits a <studio-editor> mount-point for the host app to fill.',
  pages: [{ id: 'editor-shell', type: 'editor-shell', enabled: true }],
  defaultConfig: { className: 'studio-editor-host' },
};

// ───────────────────────── Cartridge envelope ─────────────────────

export const editorShellCartridge: Cartridge<EditorShellData, EditorShellConfig> = {
  id: 'editor-shell',
  industry: 'devtools',
  displayName: 'Editor shell',
  description:
    'Presentation cartridge — emits a <studio-editor> mount-point. Host bootstrap populates the element.',
  version: '0.0.0',

  schema: passthroughSchema,
  dataSources: [emptyDataSource],
  views: [editorShellView],
  templates: [editorShellTemplate],

  defaultConfig: editorShellTemplate.defaultConfig,
  defaultTemplateId: editorShellTemplate.id,
  mailboxName: '__AIRO_EDITOR_SHELL_PAGES__',
};
