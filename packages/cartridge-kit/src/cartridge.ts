/**
 * Top-level Cartridge envelope + registry.
 *
 * A cartridge is a self-contained bundle of: data schema, data sources,
 * pipeline (transformers + post-processors), views, MCP tools, publication
 * adapters, templates, and onboarding flow. Studios consume cartridges via
 * a `CartridgeRegistry` — they never import cartridge code directly.
 *
 * Each cartridge declares its own mailbox name so multiple cartridges can
 * coexist in the same studio without colliding.
 */

import type { PageRendererFactory } from '@ai-ro/core';

import type { DataSource } from './data-source.js';
import type { Transformer } from './transformer.js';
import type { PostProcessor } from './post-processor.js';
import type { ViewDefinition, CartridgeAppContext } from './view.js';
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
   * before render. Sync at v0; async deferred to v1+.
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
   * outputs. The load-bearing primitive for cartridges that publish typed
   * feeds (Schema.org JSON-LD, vendor XML, etc.). Framework runs each
   * adapter on the post-pipeline snapshot; studios decide delivery (inline
   * vs signed feed).
   */
  publicationAdapters?: PublicationAdapter<TData, unknown, TConfig>[];

  /**
   * @deprecated v0.2 — use a `PublicationAdapter` with `format: 'json-ld'`.
   * Kept in the contract for one minor version so existing inline JSON-LD
   * code can land without rewriting on day 1. Removed in v0.3.
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
 *
 * Resolution priority for `resolveView(cartridgeId, pageType)`:
 *   1. Static `cartridge.views[]` — fully-loaded cartridges where every
 *      view is in the same bundle.
 *   2. Per-cartridge mailbox (`cartridge.mailboxName`) — cartridges that
 *      ship their views as separate chunks. The registry drains the
 *      mailbox at `register()` time and continues to accept late
 *      registrations after that (stub-queue semantics from
 *      `@ai-ro/core/createRegistry`).
 */
export interface CartridgeRegistry {
  register(cartridge: Cartridge): void;
  list(): Cartridge[];
  get(id: string): Cartridge | undefined;

  /**
   * Resolve a renderer factory for a given cartridge + page type. Checks
   * the cartridge's static `views[]` first, then falls back to the
   * per-cartridge chunk mailbox. Returns undefined when neither path
   * has a matching factory (likely a chunk that hasn't loaded yet).
   *
   * The return type uses `unknown` for `TData`/`TConfig` because the
   * registry is heterogeneous across cartridges. Cartridges narrow when
   * they pull a factory out of the registry; the typing reflects that
   * the registry doesn't (and can't) know which cartridge's data shape
   * a given factory expects.
   */
  resolveView(
    cartridgeId: string,
    pageType: string,
  ): PageRendererFactory<string, CartridgeAppContext<unknown, unknown>> | undefined;

  /**
   * Build a `resolveRenderer` callback scoped to a single cartridge.
   * Useful for passing into `createApp({ resolveRenderer })` or
   * `createCartridgeApp({ resolveRenderer })` when a multi-cartridge
   * studio mounts ONE cartridge at a time.
   *
   * Returns `(pageType) => undefined` for an unknown cartridgeId — the
   * studio sees no factories and the framework falls back to "chunk not
   * loaded yet" semantics, which is the right user-facing behaviour.
   */
  resolverFor(
    cartridgeId: string,
  ): (
    pageType: string,
  ) => PageRendererFactory<string, CartridgeAppContext<unknown, unknown>> | undefined;
}
