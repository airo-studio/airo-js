/**
 * @ai-ro/cartridge-kit — the cartridge contract.
 *
 * The highest-stakes API surface in airo-js. v0.2 against the
 * DotterWTB-Google-publication priority pivot: `PublicationAdapter` is a
 * first-class primitive (the load-bearing v0 product mechanism); validation
 * pair is WTB cartridge + PublicationAdapter pair (Schema.org + Merchant
 * Center), not WTB + Restaurant.
 *
 * Three contract guarantees:
 *   1. Snapshot fidelity — views, MCP tools, and publication adapters all
 *      consume the SAME post-Transformer snapshot. No drift between what
 *      the user sees, what an agent answers, and what Google indexes.
 *   2. Coverage gating — adapters declare required schema field paths;
 *      framework skips broken outputs; studio surfaces gaps to the user.
 *   3. Validation as hard gate — `validate(output)` blocks publish on
 *      failure. Customer trust > publish velocity.
 *
 * Phase 0.5 designs the lower-level primitives (DataSource ↔ Transformer
 * data flow, MCP tool data-access contract, View vs PageRenderer
 * relationship). This file defines the surface; lower-level wiring is
 * Phase 0.5 work.
 *
 * Companion proposal: `dotter-widget-studio/.claude/plans/airo-cartridge-kit-contract-proposal.md`
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
  TransformerPipeline,
  TraceEntry,
} from './transformer.js';

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

export const PACKAGE_NAME = '@ai-ro/cartridge-kit';
export const CONTRACT_VERSION = '0.2.0-rc.1';
