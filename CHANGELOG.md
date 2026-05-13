# Changelog

All notable changes to this repo are documented here. Format follows [Keep a Changelog](https://keepachangelog.com); each package versions independently per [SemVer](https://semver.org).

## [Unreleased]

(empty — see versioned entries below)

## `@airo-js/runtime` 0.7.0 — 2026-05-13

Live config deltas + the cartridge test-harness. Closes the framework gap on the dotter-studio team's tech-debt punch list (their D4 / D5 / D12 unblock with this rev).

### Added
- `MountCartridgeResult.update(delta: Partial<TConfig>): Promise<UpdateResult>` — live config delta dispatcher. Reads `cartridge.hotSwapKeys` (dot-path aware) to classify each path: covered paths hot-swap in place (existing snapshot reused, active page renderer torn down + re-rendered with fresh `ctx.app`), uncovered paths trigger a full remount with `NavigationState` preserved across the destroy/recreate. Studio chrome uses this to retire its own structural-fields lifecycle policy.
- `UpdateResult` — `{ mode: 'hot-swap' | 'remount'; navState: NavigationState }`. Lets studios decide whether to re-emit telemetry / scroll / refire preview-side effects per dispatch path.
- `@airo-js/runtime/test-harness` submodule — `mountCartridgeInMemory({ cartridge, config, fixtureFeed })` returns `{ dom, pipelineSnapshot, cleanup }`. Re-exports ONLY the harness types + function; the structural M13 boundary is the export surface, not magic. Cartridge authors write `cartridge.test.ts` that imports from `@airo-js/runtime/test-harness` + their own cartridge module and cannot transitively pull in studio shell types.
- `MountCartridgeOptions.registry?: CartridgeRegistry` — opt-in shared registry for multi-cartridge studios. When provided, renderer resolution goes through `registry.resolverFor(cartridge.id)`. When absent, the lazy WeakMap-memoised single-cartridge default runs unchanged.
- `MountCartridgeOptions.onPipelineComplete?: (snapshot) => void` — fires after the pipeline phase succeeds. Primarily test-harness facing; documented as harmless to use elsewhere.

### Changed
- `MountCartridgeResult` is now generic over `TConfig` (`MountCartridgeResult<TConfig = unknown>`). The default keeps existing call sites typing unchanged; consumers that pass `TConfig` get `Partial<TConfig>` typing on `update(delta)`.
- `MountCartridgeResult.app` is now a getter — always reflects the live `App` instance, including after a remount path runs inside `update()`. Destructuring (`const { app } = result`) still captures the value at destructure time and IS subject to the staleness footgun; documented on the type.
- Pipeline phase awaits transformer chain (transformers may return `Promise<TData>` — see `@airo-js/core` 0.7.0 + `@airo-js/cartridge-kit` 0.7.0).

### Notes
- Remount re-runs transformers — declared as the v0 cost on hot-swap-vs-remount classification. `// TODO 0.8` annotation in `mount-cartridge.ts` marks the optimization site (skip transformer re-run when only post-pipeline config fields changed).
- Test-harness defaults to `styleIsolation: 'light'` so `result.dom` is observable directly without shadow-root traversal. Pass `'shadow'` to test shadow-DOM-specific behaviour.

## `@airo-js/cartridge-kit` 0.7.0 — 2026-05-13

Cartridges declare hot-swap surface via `hotSwapKeys`; transformers may now be async.

### Added
- `Cartridge.hotSwapKeys?: Array<keyof TConfig | (string & {})>` — config paths that can hot-swap (re-render the active page in place without remount) when delivered via `MountCartridgeResult.update()`. Supports both top-level keys and dot-paths into nested config (`['theme', 'display.showPrices']`). Prefix-match semantics: a top-level key like `'display'` covers all of `display.*`; a dot-path like `'display.showPrices'` matches only that exact leaf. Cosmetic flags belong here; anything that affects what transformers produce should be omitted so the runtime triggers a remount + transformer re-run.
- `CartridgeAppDeps.registry?: CartridgeRegistry` — long-lived shared registry. When provided, `createCartridgeApp` derives the resolver via `registry.resolverFor(cartridge.id)`. Caller is responsible for `registry.register(cartridge)` before mount. Renderer resolution precedence: explicit `resolveRenderer` > `registry` > lazy WeakMap-memoised default.

### Changed
- `Transformer.transform` return type widened from `TData` to `TData | Promise<TData>`. Sync transformers keep working unchanged; async transformers (auth-token verification, lazy enrichment, IO-bound transforms) are now first-class. The pipeline awaits uniformly.
- `RuntimePipeline.runTransformers` return type widened to `Promise<TData>` (was `TData`). All callers must `await`. One in-tree caller (`@airo-js/runtime`'s `mountCartridge`) updated in this rev.

### Notes
- The `(string & {})` intersection on `hotSwapKeys` preserves keyof-autocomplete on top-level `TConfig` keys while leaving the type open for dot-path strings. A future `Paths<TConfig>` template-literal type can tighten compile-time path validation without breaking the surface.
- Removed the long-standing "Sync only at v0; async deferred to v0.3" note from the `Transformer` JSDoc.

## `@airo-js/core` 0.7.0 — 2026-05-13

App-level live appContext swap + the `SubpageActivation.page` type extension.

### Added
- `App.replaceAppContext(newAppContext: unknown): void` on the public `App` interface — replaces the opaque appContext bag and re-renders the active page with a fresh `RenderContext`. Type-erased on the public handle (TAppContext is opaque there); the cartridge runtime casts on the way in when delivering `MountCartridgeResult.update()`'s hot-swap path.
- `PageManager.replaceAppContext(newAppContext: TAppContext): void` — backing implementation. Destroys + re-instantiates the active page renderer with a fresh `RenderContext`. NavigationState preserved (no URL push, no `navigation:changed` emission — this is a config delta, not a navigation event). No-op when destroyed, no active page mounted, or the active page id no longer resolves.
- `SubpageActivation<TPageType>.page?: Page<TPageType>` — full `Page<T>` for the subpage. PageManager populates this when dispatching a subpage activation so parent renderers can apply page-config styles + componentSettings without re-walking the page graph. Resolves "Finding 3" from CLAUDE.md §3.

### Changed
- `SubpageActivation`'s index signature value type widens to `string | undefined | Page<TPageType>` to accommodate the new typed `page` field while preserving the legacy spread-of-navContext pattern. Consumers indexing by a navContext-shaped string key receive the union and should narrow via `typeof v === 'string'`.
- `Transformer.transform` return type widened to `TData | Promise<TData>`. Pipeline impl (`RuntimePipelineImpl.runTransformers`) is now async and awaits each transformer's result; both the fast-path and traced-path branches updated. Applies identically to sync throws and rejected promises under `errorPolicy: 'skip'`.

## `@airo-js/embed` 0.7.0 — 2026-05-13

Custom-element imperative `update(delta)` for live config deltas.

### Added
- `AiroAppElement.update(delta): Promise<{ mode; navState } | null>` — forwards to the runtime's `MountCartridgeResult.update()` when the element is mounted and not gate-blocked. Resolves with `null` when called against a never-mounted, gate-blocked, or already-disconnected element. Symmetric with the runtime's "no update on blocked" contract; callers can branch on null without try/catch.

### Notes
- The `MountHandle` interface (internal mirror of the destroy-only subset of `MountCartridgeResult`) widened to include `update?` so the custom-element path can forward. Type-erased at the embed boundary because attribute-driven mounts can't express `TConfig` at compile time; the runtime's `update(delta: Partial<TConfig>)` remains correctly typed for direct `mountCartridge` callers.

## `@airo-js/ssr` 0.7.0 — 2026-05-13

Sync-only rev — no API changes. Bumped so the `workspace:^` peerDeps on `@airo-js/core` + `@airo-js/cartridge-kit` resolve to `^0.7.0` in published tarballs and consumers can install the 0.7.0 line coherently.

### Notes
- The `RuntimePipeline.runTransformers` return-type change in `@airo-js/core` 0.7.0 is API-widening only (no current ssr caller); the SSR adapter pipeline path is unaffected.

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
