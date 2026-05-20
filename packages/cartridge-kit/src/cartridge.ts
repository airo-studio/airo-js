/**
 * Top-level Cartridge envelope + registry.
 *
 * A cartridge is a self-contained bundle of: data schema, data sources,
 * pipeline (transformers + post-processors), views, MCP tools, publication
 * adapters, templates, and onboarding flow. Host apps consume cartridges
 * via a `CartridgeRegistry` — they never import cartridge code directly.
 *
 * Each cartridge declares its own mailbox name so multiple cartridges can
 * coexist in the same host app without colliding.
 */

import type { PageRendererFactory } from '@airo-js/core';

import type { DataSource } from './data-source.js';
import type { Transformer } from './transformer.js';
import type { PostProcessor } from './post-processor.js';
import type { ViewDefinition, CartridgeAppContext } from './view.js';
import type { Template } from './template.js';
import type { McpToolDefinition } from './mcp-tool.js';
import type { PublicationAdapter } from './publication-adapter.js';
import type { JsonLdMapper } from './json-ld-mapper.js';
import type { Gate } from './gate.js';
import type { ComponentSchema, ThemeSchema } from './editor-schema.js';

/**
 * Schema definition pluralism — Zod, JSON Schema, branded types. The
 * framework doesn't lock the implementation; cartridges pick. Host apps
 * use `parse`/`safeParse` for runtime validation; tools that need a wire
 * format (MCP, OpenAPI) fall through to `toJsonSchema()` if implemented.
 */
export interface SchemaDefinition<TData> {
  parse(input: unknown): TData;
  safeParse(input: unknown): { success: true; data: TData } | { success: false; error: Error };
  /** Optional JSON Schema export for tools that need it (MCP, OpenAPI). */
  toJsonSchema?(): Record<string, unknown>;
}

/**
 * Onboarding step descriptor. Intentionally thin — `component` is a string
 * the host app resolves to its own React/Vue/whatever component. Framework
 * stays framework-agnostic.
 */
export interface OnboardingStep {
  id: string;
  /** Host-app-resolved descriptor; e.g. 'pdf-drop-zone', 'csv-upload'. */
  component: string;
  /** Step graph — which step runs next. Omit for linear flows. */
  next?: string;
  skipIf?: (config: unknown) => boolean;
}

/**
 * The cartridge envelope. Host apps discover cartridges via a registry;
 * every cartridge implements this shape. Generic over:
 *
 *   - `TData`   — the schema's data shape (post-pipeline snapshot)
 *   - `TConfig` — the cartridge's editable configuration shape
 *   - `TStyles` — the cartridge's curated style surface (typically derived
 *                 via `defineStyleSurface` + `StyleValuesOf<typeof ...>`).
 *                 Defaults to `unknown` for cartridges that don't ship a
 *                 `componentSchema`.
 */
export interface Cartridge<TData = unknown, TConfig = unknown, TStyles = unknown> {
  /** Identity */
  id: string;
  industry: string;
  displayName: string;
  description: string;
  /** SVG string or asset URL — framework-agnostic. */
  icon?: string;
  /** Cartridge semver — versioned independently of @airo-js/* */
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

  /**
   * Pre-render guards. Run sequentially BEFORE any view paints, in the
   * order declared. Used for content-visibility decisions: age verification,
   * geo restriction, auth check, paywall, cookie consent, country selector,
   * maintenance mode. First gate that resolves `'block'` short-circuits;
   * the framework refuses to mount any view.
   *
   * Sync precheck path skips visible UI for already-cleared users (cookie,
   * verified token, IP-based geo). Async by design.
   */
  gates?: Gate<TConfig>[];

  /**
   * Views — `ViewDefinition` entries keyed by `pageType`. Two valid
   * shapes depending on how the cartridge ships its renderers:
   *
   * **Monolithic bundle** — every view in one build artifact. Declare
   * the full `views: [...]` array with factories + capabilities. The
   * framework's resolver walks this list first and short-circuits on
   * `pageType` match. This is the default and the simplest shape.
   *
   * **Chunked browser bundle (two-envelope pattern)** — when page
   * renderers ship as separate code-split chunks (`product.chunk.js`,
   * `quickshop.chunk.js`, etc.), the BROWSER cartridge declares
   * `views: []` and lets each chunk self-register via
   * `pushToMailbox(cartridge.mailboxName, { key: pageType, factory })`
   * at load time. The SERVER cartridge keeps the full `views: [...]`
   * with factories + capabilities (server SSR has no hydrate code to
   * split and benefits from one-load-per-worker).
   *
   * Do NOT ship placeholder factories on the browser cartridge — the
   * resolver checks `views[]` BEFORE consulting the mailbox, so a
   * placeholder permanently blocks the mailbox path for that
   * `pageType`. Empty array means "all factories arrive via mailbox."
   *
   * `capabilities` (declared per `ViewDefinition`) is consumed by SSR
   * coverage gating + adapter routing — they only matter on the
   * SERVER cartridge. The browser doesn't need them.
   *
   * See `getDefaultRenderResolver` and `createCartridgeRegistry` in
   * this package for the resolver order.
   */
  views: ViewDefinition<TData, TConfig>[];

  /** Pre-composed (view-set, default config) bundles for the host app's template picker. */
  templates: Template<TConfig>[];

  /** Agent-facing tools. Receive POST-transformer data. */
  mcpTools?: McpToolDefinition<TData, TConfig>[];

  /**
   * Publication adapters — fan post-Transformer data out to surface-specific
   * outputs. The load-bearing primitive for cartridges that publish typed
   * feeds (Schema.org JSON-LD, vendor XML, etc.). Framework runs each
   * adapter on the post-pipeline snapshot; host apps decide delivery
   * (inline vs signed feed).
   */
  publicationAdapters?: PublicationAdapter<TData, unknown, TConfig>[];

  /**
   * @deprecated v0.2 — use a `PublicationAdapter` with `format: 'json-ld'`.
   * Kept in the contract for one minor version so existing inline JSON-LD
   * code can land without rewriting on day 1. Removed in v0.3.
   */
  jsonLdMappers?: JsonLdMapper<TData>[];

  /** Optional onboarding override — replaces the host app's default stepper. */
  onboardingFlow?: OnboardingStep[];

  /** Defaults. */
  defaultConfig: TConfig;
  defaultTemplateId: string;

  /**
   * Mailbox name for this cartridge's view chunks. The global symbol
   * (`window[mailboxName]`) is the stub-queue that lazy-loaded page
   * chunks push their factories into; the framework's registry drains
   * the queue and replaces it with a live-registering proxy. See
   * `createRegistry` / `pushToMailbox` in `@airo-js/core`.
   *
   * **Naming:** `__AIRO_<CARTRIDGE_ID>_PAGES__` (uppercase,
   * underscored). The framework doesn't enforce the convention; pick
   * any string. What matters is that the cartridge declaration here
   * and the `pushToMailbox(name, ...)` call inside each page chunk
   * agree on the exact string.
   *
   * **Mailbox identity = cartridge identity, not patch version.** The
   * framework assumes patch versions of the same cartridge id are
   * interchangeable (semver patch contract). Two browser instances of
   * the same cartridge pinned to different patches (e.g. `0.1.3` +
   * `0.1.5`) share the same mailbox; their pushed factories collide on
   * `pageType` and last-write-wins. This is fine when patches are
   * interchangeable, and a versioning bug when they aren't. If you
   * genuinely need isolation (e.g. a 1.x → 2.x migration where both
   * majors must coexist on the same page), declare them as separate
   * cartridges with different `id` and different `mailboxName`.
   *
   * **Same-cartridge multi-instance is fine.** Two widgets on one page
   * running the same cartridge at the same patch version share one
   * mailbox + one chunk fetch — that's the intended efficiency.
   */
  mailboxName: string;

  /**
   * Per-component editable schema. Studios render Component-panel inputs
   * (props + style controls) from this — without it they fall through to
   * their own defaults, so existing cartridges remain valid. The
   * `TStyles` generic ties `styles.allowed` to the cartridge's style
   * surface; cartridges declare it via `defineStyleSurface` and pass the
   * derived value type as the `TStyles` parameter.
   */
  componentSchema?: Record<string, ComponentSchema<TStyles>>;

  /**
   * Token catalog grouped by `app` / `page` / `component` scope. Studios
   * render Style-panel inputs from this. The `component` scope is
   * typically derived via `deriveComponentTokens` from the same
   * `componentSchema` + style surface declaration so the cartridge
   * author keeps a single source of truth.
   */
  themeSchema?: ThemeSchema;

  /**
   * Config paths that can hot-swap (re-render the active page in place
   * without remount) when delivered via `MountCartridgeResult.update()`
   * in `@airo-js/runtime`. Paths NOT in this list trigger a remount,
   * with NavigationState preserved. Defaults to `[]` — everything
   * remounts.
   *
   * **Decision criterion — when to declare a path here vs omit it:**
   * declare paths where the value can change WITHOUT invalidating the
   * post-Transformer snapshot — the renderer reads the new value
   * directly and the existing derived data is still correct. Cosmetic
   * flags (`showPrices`, theme tokens, copy overrides) belong here.
   * Anything that affects what transformers produce (filters, grouping
   * keys, anything that changes derived data shape) should be OMITTED
   * so the runtime triggers a remount + transformer re-run.
   *
   * Supports both top-level keys and dot-paths into nested config:
   *
   * ```ts
   * hotSwapKeys: ['theme', 'display.showPrices', 'display.showRatings']
   * ```
   *
   * Prefix-match semantics:
   *   - `'theme'`              — matches any change under `theme.*`
   *   - `'display.showPrices'` — matches only that exact leaf
   *
   * The `(string & {})` intersection on the type preserves
   * keyof-autocomplete on the top-level `TConfig` keys while leaving
   * the type open for dot-path strings. Compile-time path validation
   * (a future `Paths<TConfig>` template-literal type) can tighten this
   * without breaking the surface.
   */
  hotSwapKeys?: Array<keyof TConfig | (string & {})>;

  /**
   * Per-page field paths that can hot-swap (re-render the active page in
   * place without remount) when delivered via
   * `MountCartridgeResult.updatePages()` in `@airo-js/runtime`. Paths NOT
   * in this list — or any structural page-graph change (added or removed
   * pages, changed `id` / `type` / `enabled` / `parent`) — trigger a
   * remount with NavigationState preserved. Defaults to `[]` —
   * everything remounts.
   *
   * Mirror of `hotSwapKeys` but scoped to per-page state on the
   * framework's `Page<T>` shape rather than cartridge config:
   *
   * ```ts
   * pageHotSwapKeys: ['componentSettings', 'styles', 'layout.regions']
   * ```
   *
   * **Decision criterion** — declare paths where the value can change
   * WITHOUT invalidating the post-Transformer snapshot. Per-component
   * prop overrides, per-page styles, and slot visibility / prop changes
   * are cosmetic from the snapshot's point of view and belong here.
   * Page-graph structure changes (a new template page, a page type
   * flip) are always remounts regardless of this list.
   *
   * Prefix-match semantics — same as `hotSwapKeys`:
   *   - `'componentSettings'`                        — covers any `componentSettings.*` change
   *   - `'componentSettings.productRating.props'`    — covers only that exact subtree
   *   - `'layout.regions'`                           — covers slot props + visibility (slot reordering
   *                                                    via `layout.regionOrder` is also covered if
   *                                                    you include `'layout.regionOrder'` or `'layout'`)
   *
   * The framework-curated literals (`'componentSettings'`, `'styles'`,
   * `'props'`, `'layout'`) give autocomplete; arbitrary dot-paths are
   * accepted via the `(string & {})` widening, same pattern as
   * `hotSwapKeys`.
   */
  pageHotSwapKeys?: Array<
    'componentSettings' | 'styles' | 'props' | 'layout' | (string & {})
  >;
}

/**
 * Host apps consume cartridges via this — never importing cartridges by
 * name. Cartridges register themselves at boot (package side-effect or
 * explicit `register(cartridge)` from the host app's manifest).
 *
 * Resolution priority for `resolveView(cartridgeId, pageType)`:
 *   1. Static `cartridge.views[]` — fully-loaded cartridges where every
 *      view is in the same bundle.
 *   2. Per-cartridge mailbox (`cartridge.mailboxName`) — cartridges that
 *      ship their views as separate chunks. The registry drains the
 *      mailbox at `register()` time and continues to accept late
 *      registrations after that (stub-queue semantics from
 *      `@airo-js/core/createRegistry`).
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
   * host app mounts ONE cartridge at a time.
   *
   * Returns `(pageType) => undefined` for an unknown cartridgeId — the
   * host app sees no factories and the framework falls back to "chunk
   * not loaded yet" semantics, which is the right user-facing behaviour.
   */
  resolverFor(
    cartridgeId: string,
  ): (
    pageType: string,
  ) => PageRendererFactory<string, CartridgeAppContext<unknown, unknown>> | undefined;
}
