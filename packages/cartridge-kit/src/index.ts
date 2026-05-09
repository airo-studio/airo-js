/**
 * @airo-js/cartridge-kit — the cartridge contract.
 *
 * The highest-stakes API surface in airo-js. v0.2 promotes
 * `PublicationAdapter` to a first-class primitive for fanning post-pipeline
 * data out to typed feed surfaces (Schema.org JSON-LD, vendor XML, etc.);
 * the deprecated `JsonLdMapper` is kept for one minor version.
 *
 * Three contract guarantees:
 *   1. Snapshot fidelity — views, MCP tools, and publication adapters all
 *      consume the SAME post-Transformer snapshot. No drift between what
 *      the user sees, what an agent answers, and what indexers consume.
 *   2. Coverage gating — adapters declare required schema field paths;
 *      framework skips broken outputs; host app surfaces gaps to the user.
 *   3. Validation as hard gate — `validate(output)` blocks publish on
 *      failure. Output trust > publish velocity.
 *
 * This file defines the public surface; lower-level wiring (DataSource ↔
 * Transformer data flow, MCP tool data-access, View vs PageRenderer) is
 * defined in the per-primitive files alongside.
 */

export type {
  Cartridge,
  CartridgeRegistry,
  SchemaDefinition,
  OnboardingStep,
} from './cartridge.js';

export type {
  DataSource,
  DataSourceContext,
  DataSourceInput,
  DataSourceOnboardingShape,
} from './data-source.js';

export type {
  Transformer,
  TransformerContext,
  RuntimePipeline,
  TraceEntry,
} from './transformer.js';

/** @deprecated v0.2-rc.2 — renamed to `RuntimePipeline`. Type alias kept for one minor version. */
export type { TransformerPipeline } from './transformer.js';

export type {
  PostProcessor,
  PostProcessorContext,
} from './post-processor.js';

export type {
  ViewDefinition,
  CartridgeAppContext,
} from './view.js';

export type { Template } from './template.js';

export type {
  McpToolDefinition,
  ToolContext,
} from './mcp-tool.js';

export type {
  PublicationAdapter,
  PublicationContext,
  ValidationResult,
  ValidationError,
  ValidationWarning,
  SchemaFieldRef,
  Duration,
} from './publication-adapter.js';

/** @deprecated v0.2 — use PublicationAdapter with format 'json-ld'. */
export type { JsonLdMapper } from './json-ld-mapper.js';

export type {
  Gate,
  GateContext,
} from './gate.js';

export type {
  RunGatesOptions,
  RunGatesResult,
} from './run-gates.js';
export { runGates } from './run-gates.js';

export type {
  CartridgeAppDeps,
  CartridgeAppResult,
} from './cartridge-app.js';
export { createCartridgeApp } from './cartridge-app.js';

export {
  createCartridgeRegistry,
  getDefaultRenderResolver,
} from './cartridge-registry.js';

// ---------------------------------------------------------------------------
// Editor-time metadata — schemas studios consume to render configuration UIs.
// Cartridges that don't ship them remain valid; host studios fall through to
// their own defaults.
// ---------------------------------------------------------------------------

export type {
  FieldType,
  ChangeScope,
  PropSchema,
  ComponentSchema,
  PageSchema,
  TokenDef,
  TokenSection,
  ThemeSchema,
} from './editor-schema.js';

export type {
  StyleKindDef,
  StyleSurfaceDef,
  StyleValuesOf,
} from './style-surface.js';
export { defineStyleSurface } from './style-surface.js';

export type { CssVarFor } from './derive-component-tokens.js';
export { deriveComponentTokens } from './derive-component-tokens.js';

export const PACKAGE_NAME = '@airo-js/cartridge-kit';
export const CONTRACT_VERSION = '0.4.0-rc.0';
