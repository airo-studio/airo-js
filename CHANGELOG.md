# Changelog

All notable changes to this repo are documented here. Format follows [Keep a Changelog](https://keepachangelog.com); each package versions independently per [SemVer](https://semver.org).

## [Unreleased]

(empty — see versioned entries below)

## `@airo-js/cartridge-kit` 0.2.0-rc.4 — 2026-05-07

First public release candidate. The cartridge contract is the highest-stakes API surface; expect refinement based on feedback before `1.0`. Cartridges should target `^0.2`.

### Added
- `Cartridge<TData, TConfig>` envelope + `CartridgeRegistry` discovery
- `DataSource<TData, TConfig>` — schema-agnostic data loaders with discriminated `onboardingShape`
- `Transformer<TData, TConfig>` + `PostProcessor` (re-exported from `@airo-js/core`)
- `ViewDefinition<TData, TConfig>` + `CartridgeAppContext<TData, TConfig>`
- `Template<TConfig>` — pre-composed view-set + default config bundle
- `McpToolDefinition<TData, TConfig>` — agent-facing tools, post-Transformer data
- `PublicationAdapter<TData, TOutput, TConfig>` — fan post-pipeline data to surface-specific outputs (Schema.org JSON-LD, vendor XML, etc.); coverage gating + validation as a hard gate
- `Gate<TConfig>` — pre-render guards (age verification, geo, auth, paywall, cookie consent); first-blocking-gate short-circuits and the framework refuses to mount any view
- `createCartridgeApp(cartridge, config, snapshot, cartridgeConfig, deps)` — cartridge-aware wrapper around `createApp` that runs gates first, then mounts views with the typed `CartridgeAppContext`
- `createCartridgeRegistry(cartridges)` — registry with two resolution paths (static `views[]`, then per-cartridge chunk mailbox via `cartridge.mailboxName`)
- `runGates({ gates, host, ctx })` — gate executor with sequential precheck/mount semantics

### Changed (breaking)
- `PublicationAdapter['delivery']`: literal `'studio-decides'` renamed to `'host-decides'` (consistent vendor-neutral vocabulary)
- `PublicationContext`: `customerOverrides` field renamed to `tenantOverrides` (matched the JSDoc which already said "Tenant-side toggles")

### Deprecated
- `JsonLdMapper<TData>` — use `PublicationAdapter` with `format: 'json-ld'`. Kept for one minor version (removed in `0.3`).

## `@airo-js/core` 0.1.0 — 2026-05-07

First public release. Pure rendering primitives — no domain knowledge, no opinions about data shape.

### Added
- App lifecycle: `createApp`, `App`, `AppDeps`
- Page rendering: `PageManager`, `PageRenderer`, `PageRendererFactory`, `RenderContext`
- Schema types: `Page`, `PageLayout`, `Region`, `Slot`, `AppConfig`, `ComponentSettings`
- Navigation: `HashRouter`, `NavigationState`, `Breadcrumb`, `mountBreadcrumb`
- Events: `EventBus`, `IEventBus` (snapshot-semantics observer)
- Style isolation: `IsolationRoot`, `setupIsolationRoot`, `wrapInShadow`, `resolveStyleRoot` — three modes (`none` / `partial` / `full`) for Shadow DOM strategy
- Theming: `Theme` — CSS custom-property injection + `customCSS` escape hatch
- Pipeline orchestration: `Transformer`, `PostProcessor`, `RuntimePipeline`, `RuntimePipelineImpl`, `createPipeline`
- Plugin discovery: `Registry`, `createRegistry`, `pushToMailbox` (stub-queue self-registration for late-loading chunks)

### Deprecated
- `TransformerPipeline<TData, TConfig>` — renamed to `RuntimePipeline` (covers both transformer and post-processor chains). Type alias kept for one minor version.

## `@airo-js/ssr` 0.1.0 — 2026-05-07

First public release. Runtime-agnostic edge SSR — pure functions, no DOM globals required (pass a document from `linkedom` or `deno-dom` server-side).

### Added
- `renderAppToHTML(config, deps)` — pure App → HTML; no listeners attached, no state serialised into output
- `runPublicationAdapters(cartridge, snapshot, ctx, opts?)` — execute a cartridge's `PublicationAdapter`s and return per-adapter results with validation; filterable by `id`, `format`, `delivery`
- `renderAppWithPublication(opts)` — combined SSR + inline JSON-LD output, with `</script>` breakout escaping for snapshot-field XSS safety
