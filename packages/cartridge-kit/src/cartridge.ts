/**
 * Top-level Cartridge envelope + registry.
 *
 * A cartridge is a self-contained bundle of: data schema, data sources,
 * pipeline (transformers + post-processors), views, MCP tools, publication
 * adapters, templates, and onboarding flow. Studios consume cartridges via
 * a `CartridgeRegistry` — they never import cartridge code directly.
 *
 * Each cartridge declares its own mailbox name so multiple cartridges can
 * coexist in the same studio without colliding (M5 of the migration plan).
 */

import type { DataSource } from './data-source.js';
import type { Transformer } from './transformer.js';
import type { PostProcessor } from './post-processor.js';
import type { ViewDefinition } from './view.js';
import type { Template } from './template.js';
import type { McpToolDefinition } from './mcp-tool.js';
import type { PublicationAdapter } from './publication-adapter.js';
import type { JsonLdMapper } from './json-ld-mapper.js';

/**
 * Schema definition pluralism — Zod, JSON Schema, branded types. The
 * framework doesn't lock the implementation; cartridges pick. Studios use
 * `parse`/`safeParse` for runtime validation; tools that need a wire format
 * (MCP, OpenAPI) fall through to `toJsonSchema()` if implemented.
 */
export interface SchemaDefinition<TData> {
  parse(input: unknown): TData;
  safeParse(input: unknown): { success: true; data: TData } | { success: false; error: Error };
  /** Optional JSON Schema export for tools that need it (MCP, OpenAPI). */
  toJsonSchema?(): Record<string, unknown>;
}

/**
 * Onboarding step descriptor. Intentionally thin — `component` is a string
 * the studio resolves to its own React/Vue/whatever component. Framework
 * stays framework-agnostic.
 */
export interface OnboardingStep {
  id: string;
  /** Studio-resolved descriptor; e.g. 'pdf-drop-zone', 'csv-upload'. */
  component: string;
  /** Step graph — which step runs next. Omit for linear flows. */
  next?: string;
  skipIf?: (config: unknown) => boolean;
}

/**
 * The cartridge envelope. Studios discover cartridges via a registry; every
 * cartridge implements this shape. Generic over `TData` (the schema's data
 * shape) and `TConfig` (the cartridge's editable configuration shape).
 */
export interface Cartridge<TData = unknown, TConfig = unknown> {
  /** Identity */
  id: string;
  industry: string;
  displayName: string;
  description: string;
  /** SVG string or asset URL — framework-agnostic. */
  icon?: string;
  /** Cartridge semver — versioned independently of @ai-ro/* */
  version: string;

  /** Data schema — Zod or JSON Schema. */
  schema: SchemaDefinition<TData>;

  /** Data sources — how to load TData. */
  dataSources: DataSource<TData, TConfig>[];

  /**
   * Pure data shaping, ordered chain. Framework runs in declared order
   * before render. Sync at v0; async deferred to v1+ (see §discussion 4
   * in the proposal).
   */
  transformers?: Transformer<TData, TConfig>[];

  /**
   * Side-effectful hooks, run after the views render. Receive DOM +
   * post-transformer data + event bus. Use sparingly — analytics hooks,
   * ARIA live regions, scroll restoration. NOT for data shaping.
   */
  postProcessors?: PostProcessor<TData, TConfig>[];

  /** Views — PageRenderer factories, keyed by page.type. */
  views: ViewDefinition<TData, TConfig>[];

  /** Pre-composed (view-set, default config) bundles for the studio's template picker. */
  templates: Template<TConfig>[];

  /** Agent-facing tools. Receive POST-transformer data. */
  mcpTools?: McpToolDefinition<TData, TConfig>[];

  /**
   * Publication adapters — fan post-Transformer data out to surface-specific
   * outputs. The load-bearing primitive for products like
   * DotterWTB-Google-publication. Framework runs each adapter on the
   * post-pipeline snapshot; studios decide delivery (inline vs signed feed).
   */
  publicationAdapters?: PublicationAdapter<TData, unknown, TConfig>[];

  /**
   * @deprecated v0.2 — use a `PublicationAdapter` with `format: 'json-ld'`.
   * Kept in the contract for one minor version so existing inline JSON-LD
   * code can land in WTB cartridge without rewriting on day 1. Removed in v0.3.
   */
  jsonLdMappers?: JsonLdMapper<TData>[];

  /** Optional onboarding override — replaces studio's default stepper. */
  onboardingFlow?: OnboardingStep[];

  /** Defaults. */
  defaultConfig: TConfig;
  defaultTemplateId: string;

  /**
   * Mailbox name for this cartridge's view chunks. Each cartridge gets its
   * own namespace so two cartridges in the same studio don't collide.
   * Convention: `__AIRO_<CARTRIDGE_ID>_PAGES__` (uppercase, underscored).
   */
  mailboxName: string;
}

/**
 * Studio shell consumes cartridges via this — never imports cartridges by
 * name. Cartridges register themselves at boot (package side-effect or
 * explicit `register(cartridge)` from the studio's manifest).
 */
export interface CartridgeRegistry {
  register(cartridge: Cartridge): void;
  list(): Cartridge[];
  get(id: string): Cartridge | undefined;
}
