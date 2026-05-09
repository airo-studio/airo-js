# Changelog

All notable changes to this repo are documented here. Format follows [Keep a Changelog](https://keepachangelog.com); each package versions independently per [SemVer](https://semver.org).

## [Unreleased]

(empty — see versioned entries below)

## `@airo-js/log` 0.1.0 — 2026-05-09

First release. Sink-based structured event logging — the framework's logging substrate. Layer 1 of the framework devtools story (a separate `@airo-js/devtools` panel that consumes the sink will follow on demand).

### Added
- `logger(channel)` — channel-bound `ChannelLogger` with `debug` / `info` / `warn` / `error` methods. Framework packages call this at module scope and replace direct `console.*` invocations.
- `AiroEvent` — structured event type (timestamp, channel, level, message, optional phase / widgetId / cartridgeId / data / error info).
- `AiroSink` — `{ emit(event): void }`. Replaceable via `setSink(...)`; defaults to `consoleSink` (verbatim console behaviour preservation).
- `consoleSink`, `noopSink`, `setSink`, `getSink`, `resetSink`.

## `@airo-js/core` 0.2.0 — 2026-05-09

Adopts `@airo-js/log` for all internal `console.*` calls. Public API unchanged; default behaviour identical (same `[@airo-js/core] ...` messages reach the console).

### Changed
- `EventBus.emit` handler-error log → `logger('core').error(...)`
- `RuntimePipelineImpl` transformer / post-processor / teardown error logs → `logger('core').error(...)`
- `PageManager` no-renderer / hydrate-fallback / router-init / router-push warnings → `logger('core').warn(...)`
- `HashRouter` hash-change error log → `logger('core').error(...)`

### Added (transitive surface)
- New runtime dep on `@airo-js/log` (~80 LOC, identity-mapped behaviour by default). Apps that want to feed framework events into devtools / Sentry / Datadog now `setSink(...)` from `@airo-js/log`.

## `@airo-js/embed` 0.2.0 — 2026-05-09

Adopts `@airo-js/log`. Public API unchanged; default behaviour identical. Bumps peerDep on `@airo-js/runtime` to `^0.2.0` to match the runtime line.

### Changed
- All embed `console.warn` / `console.error` → `logger('embed').warn/error(...)`.
- Bundle-size budget impact: +710 B minified / +298 B gzip (still well under the 5 KB / 2.5 KB ceiling — current 3.20 KB / 1.43 KB).

## `@airo-js/ssr` 0.2.0 — 2026-05-09

Adopts `@airo-js/log`. Public API unchanged.

### Changed
- `renderAppToHTML` `renderSSR()`-fallback warning → `logger('ssr').warn(...)`.

## `@airo-js/embed` 0.1.0 — 2026-05-09

First public release. Replaces the v0.0.0 placeholder.

Customer-facing browser bootstrap loader. Ships ahead of demand to prevent the runtime mistake from repeating: every host app that needs production cartridge embed would otherwise inline ~250-540 LOC of generic plumbing (custom-element registration, lifecycle, runtime lazy-load, SSR-hydrate wiring). This package owns that plumbing; host apps extend via hooks (`loadConfig`, `resolveCartridge`, `fetchSsrHtml`, `onError`, `onMounted`).

### Added
- `defineAiroApp(opts)` — register a custom element that mounts a cartridge on `connectedCallback` and tears down on `disconnectedCallback`
- `DefineAiroAppOptions` — required: `loadConfig`, `resolveCartridge`. Optional: `elementName`, `idAttribute`, `tokenAttribute`, `fetchSsrHtml`, `onError`, `onMounted`
- `LoadConfigResult<TConfig>` — what `loadConfig` returns: `config`, `cartridgeId`, `templateId`, `styleIsolation`, `runtimeBase`, `runtimeVersion`, `ssrHtml`, `preloadedData`
- `EmbedPhase` — phase identifier for `onError`: `'load-config' | 'resolve-cartridge' | 'fetch-ssr' | 'mount'`
- Bundle-size CI gate (`pnpm size:check`): minified ≤ 5 KB, gzip ≤ 2.5 KB. Current: 2.51 KB / 1.14 KB.

### Notes
- `@airo-js/runtime ^0.2` is a **peer** dep — loaded dynamically on first element mount, not bundled. Customer pages with N widgets pay the runtime cost once. Pages with no widget elements never pay it.
- SSR-hydrate path: when `loadConfig` returns `ssrHtml` (or `fetchSsrHtml` does), embed paints the markup AND passes `mode: 'hydrate'` to `mountCartridge`. Cartridges intending to ship to SSR pages should implement `hydrate()` on every view.
- Idempotent registration — a second `defineAiroApp` call with the same `elementName` warns and no-ops; different names can coexist (e.g. `<dotter-app>` v1 alongside `<airo-app>` cartridge during a transition).

## `@airo-js/runtime` 0.2.0 — 2026-05-09

Adds the SSR-hydrate fork. Additive minor — every v0.1 call site keeps working unchanged.

### Added
- `MountCartridgeOptions.mode: 'csr' | 'hydrate'` — when `'hydrate'`, the runtime preserves DOM already in `host` (moves it inside the shadow wrapper for `'partial'` / `'full'` isolation) and the active page renderer's `hydrate()` runs in place of `render()`. Renderers without `hydrate()` fall back to `render()` with a `[@airo-js/core]` warning.

### Notes
- `mode` defaults to `'csr'` — v0.1 behaviour is preserved verbatim. No code changes required for existing callers.
- The runtime's hydrate path delegates to `@airo-js/core`'s `pageManager.hydrateEntry` (already shipped); this release wires the fork into the cartridge mount surface.

## `@airo-js/runtime` 0.1.0 — 2026-05-09

First public release. Replaces the v0.0.0 placeholder (which exported only a `PACKAGE_NAME` constant).

Cartridge mount orchestration: every host app that runs a cartridge would otherwise inline ~75 LOC of phase-by-phase plumbing (shell setup → fetch → pipeline → mount). This package ships that plumbing as a single call and exposes studio-specific extensions via hooks.

### Added
- `mountCartridge(opts)` — single-call orchestration: shell setup → optional `dataSource.fetch` (or `preloadedData` shortcut) → transformer pipeline → mount via `createCartridgeApp` (which handles gates internally) → unified `destroy()`
- `MountCartridgeOptions<TData, TConfig>` — required: `cartridge`, `config`, `template`, `host`. Optional: `styleIsolation`, `widgetId`, `enableRouter`, `preloadedData`, `dataSourceId`, `dataSourceInput`, `credentials`, `gateScope`, `events`, `onShellReady`, `onError`
- `MountCartridgeResult` — discriminated union: `{ blocked: false, app, shell, destroy }` or `{ blocked: true, blockedBy, shell, destroy }`
- `ShellHandle` — passed to `onShellReady`: `renderRoot`, `styleRoot`, `events`, `rootId`
- `MountPhase` — phase identifier passed to `onError`: `'shell' | 'gate' | 'fetch' | 'pipeline' | 'mount'`

### Deferred (signature-compatible — additive in v0.2)
- Per-page chunk loading + `chunkBase` URL prefix
- SSR-hydrate fork (`mode: 'csr' | 'hydrate'`)
- Live `update(opts)` for studio chrome (theme + config deltas without re-mount)
- async `onShellReady`

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
