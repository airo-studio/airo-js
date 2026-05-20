# Changelog

All notable changes to this repo are documented here. Format follows [Keep a Changelog](https://keepachangelog.com); each package versions independently per [SemVer](https://semver.org).

## [Unreleased]

(empty — see versioned entries below)

## `@airo-js/core` 0.8.1 — 2026-05-20

`'renderer:missing'` event — observability for lazy-loaded page chunks.

### Added
- `PageManager` emits `'renderer:missing'` on the App event bus when `resolveRenderer(pageType)` returns `undefined` and the framework soft-fails the paint. Fires on both the CSR `navigate` path and the SSR-hydrate path. Payload: `{ pageType: string; pageId: string; phase: 'navigate' | 'hydrate' }`.
- Studios that lazy-load page chunks subscribe to this event to render a skeleton / spinner while the chunk fetch is in flight, then re-navigate to the page once `pushToMailbox` registers the factory. Replaces the previous workaround of monkey-patching the warn-log line. Documented in the `PageManager` JSDoc alongside the existing `'navigation:changed'` event.

### Notes
- Event fires once per missing-resolve attempt; PageManager does NOT retry on its own. Subscribers re-navigate or invoke `app.navigate(state)` after their chunk-load callback resolves to drive the next attempt.

## `@airo-js/cartridge-kit` 0.8.1 — 2026-05-20

JSDoc clarifications on the two-envelope chunking pattern.

### Changed
- `Cartridge.views` JSDoc — documents both shapes: monolithic (`views: [...]` with factories) and chunked browser bundles (`views: []`, factories arrive via `pushToMailbox` from each page chunk; server cartridge keeps the full views list). Warns against shipping placeholder factories — the resolver checks `views[]` first and a placeholder permanently blocks the mailbox path for that `pageType`.
- `Cartridge.mailboxName` JSDoc — documents the mailbox-identity contract: mailbox identity = cartridge identity, not patch version. Patch versions of the same cartridge are assumed interchangeable (semver patch). If two majors must coexist on the same page, declare them as separate cartridges with different `id` and `mailboxName`.

### Notes
- Pure documentation patch — no surface change. `CONTRACT_VERSION` stays at `0.5.0`.

## `@airo-js/runtime` 0.8.1 — 2026-05-20

Sync rev for `workspace:^` peerDep coherence with the 0.8.1 line. No source change. The new `'renderer:missing'` event is observable through `mountCartridge` opts.events when consumers supply their own EventBus.

## `@airo-js/ssr` 0.8.1 — 2026-05-20

Sync rev for `workspace:^` peerDep coherence with the 0.8.1 line. No source change.

## `@airo-js/embed` 0.8.1 — 2026-05-20

Sync rev for `workspace:^` peerDep coherence with the 0.8.1 line. No source change.

## `@airo-js/cartridge-kit` 0.8.0 — 2026-05-18

Rich `TemplatePage` round-trip + `cartridge.pageHotSwapKeys` for live page-graph deltas. Closes the contract gap reported on the bridge: pre-0.8 `templateToAppConfig` dropped `componentSettings` / `styles` / `props` / `layout` on the floor, so `resolveComponentProp` had no path to honour per-page overrides — half-built feature.

### Added
- `TemplatePage` widened with optional `layout` / `props` / `styles` / `componentSettings` carriers. The four structural fields (`id` / `type` / `enabled` / `parent`) are still required; the new fields round-trip through `templateToAppConfig` onto `AppConfig.pages[]` when present. Hosts driving a Component-panel editor (per-page prop / visibility / style overrides) now thread the overrides through `template.pages[i].componentSettings` and the runtime sees them on `ctx.page`.
- `TemplatePage<TPageType extends string = string>` is now generic so cartridges that narrow page types keep the narrowing through `template.pages[]` → `AppConfig.pages[]`. Defaults to `string` — existing references continue to resolve.
- `Template<TConfig, TPageType extends string = string>` widens its second generic parameter for the same reason. `Template<TConfig>` continues to resolve.
- `Cartridge.pageHotSwapKeys?: Array<'componentSettings' | 'styles' | 'props' | 'layout' | (string & {})>` — per-page hot-swap allowlist. Same prefix-match semantics as the existing `hotSwapKeys` (which is scoped to cartridge config). `MountCartridgeResult.updatePages()` from `@airo-js/runtime` classifies the per-page diff against this list; covered diffs hot-swap, uncovered diffs (and any structural page-graph change) remount with NavigationState preserved.

### Changed
- `templateToAppConfig` round-trips all rich fields; `layout` falls back to `{ regionOrder: [], regions: {} }` when omitted, matching pre-0.8 behaviour for cartridges that paint via `RenderContext.targetEl` directly.
- `CONTRACT_VERSION` bumped to `0.5.0` — consumers can train on the constant; helper additions and internal refactors don't bump it, but this widens the cartridge envelope (new `pageHotSwapKeys`) and TemplatePage shape.

### Notes
- Backward-compatible: cartridges that only set the four structural `TemplatePage` fields still produce the same empty-layout `AppConfig.pages[]` they did pre-0.8. Add the rich fields opportunistically when you want per-page state to reach `ctx.page`.

## `@airo-js/core` 0.8.0 — 2026-05-18

`App.replacePages` / `PageManager.replacePages` — page-graph hot-swap primitive.

### Added
- `App.replacePages(newPages: unknown[]): void` — replaces the active page graph and re-renders the active page in place. Type-erased at the App surface (TPageType is generic at the PageManager layer); the cartridge runtime narrows on the way in when delivering `MountCartridgeResult.updatePages()`.
- `PageManager.replacePages(newPages: Page<TPageType>[]): void` — drives the hot-swap. Replaces (does not merge), looks up the active page by id, destroys + re-instantiates the active renderer with a fresh `RenderContext` reflecting the new `page` + `pages`. NavigationState preserved; no `navigation:changed` emission and no router push (cosmetic delta, not a navigation event).

### Changed
- `PageManager` introduces a private `pages` field initialised from `opts.pages`. `replacePages` reassigns this; every read site that previously walked `this.opts.pages` now reads `this.pages` so `ctx.pages` follows the swap.
- `RenderContext.pages` JSDoc updated: the reference is stable across `update(delta)` hot-swap (snapshot reuse path) but DOES change after a successful `updatePages()` call. Renderers that cache `ctx.pages` across renders won't see post-`updatePages` graphs — read on each render.

### Notes
- Sync rev for `workspace:^` peerDep coherence across the 0.8.0 line.

## `@airo-js/runtime` 0.8.0 — 2026-05-18

`MountCartridgeResult.updatePages()` — live page-graph dispatcher.

### Added
- `updatePages(nextPages: ReadonlyArray<TemplatePage<TPageType>>): Promise<UpdateResult>` on the unblocked `MountCartridgeResult` branch. Replaces `AppConfig.pages` with `nextPages` and classifies the per-page diff against `cartridge.pageHotSwapKeys`. Covered diff → hot-swap (re-render the active page in place with new `ctx.page` / `ctx.pages`, snapshot reused). Uncovered diff OR any structural change (added / removed / reordered pages, changed `id` / `type` / `enabled` / `parent`) → remount with NavigationState preserved.
- `pagesDiffIsCoveredByHotSwap(current, next, allowed)` + `diffLeafPaths(a, b, prefix?, skipKeys?)` exported for tests. Module-internal otherwise.

### Changed
- `MountCartridgeResult<TConfig, TPageType extends string = string>` is now generic over `TPageType` so `updatePages` can carry the narrowed type. Existing `MountCartridgeResult<TConfig>` references resolve unchanged via the default.
- `widgetId` is captured once at the top of `mountCartridge` and reused on every `doMountInner` call — eliminates the latent footgun where a no-`widgetId` mount would generate a fresh `Date.now()` appId on every remount.
- `currentPages` mirrors the live page graph; `doMountInner` builds `AppConfig` from it on remount paths, so an `updatePages()` remount carries the new graph and the entry-page resolution uses it.

### Notes
- `update(delta)` and `updatePages(nextPages)` are independent channels — cartridge config delta vs page-graph delta. Studios that change BOTH should call both methods.
- Backward-compatible: existing `update(delta)` callers continue to work unchanged.

## `@airo-js/ssr` 0.8.0 — 2026-05-18

Sync rev for `workspace:^` peerDep coherence with the 0.8.0 line. No source change — `renderAppWithPublication` and `renderAppToHTML` already consume `templateToAppConfig` from `@airo-js/cartridge-kit`, so the rich-field round-trip on the SSR path comes free.

## `@airo-js/embed` 0.8.0 — 2026-05-18

`el.updatePages(nextPages)` — page-graph delta forwarded to the runtime.

### Added
- `updatePages(nextPages: ReadonlyArray<TemplatePage>)` method on the `<airo-app>` element class. Forwards to the runtime's `MountCartridgeResult.updatePages()` when the element is mounted and not gate-blocked. Resolves with `{ mode, navState }` reporting whether the runtime hot-swapped or remounted; resolves with `null` for never-mounted / gate-blocked / disconnected elements (symmetric with `el.update()`).

### Changed
- `LoadConfigResult.templatePages` JSDoc updated: post-mount page-graph changes now go through `el.updatePages()`, which hot-swaps when the diff is covered by `cartridge.pageHotSwapKeys`. The two delta channels (`update` for cartridge config, `updatePages` for page graph) are independent.

## `@airo-js/embed` 0.7.3 — 2026-05-18

Per-widget page graph override + reconnect-bug fix.

### Added
- `LoadConfigResult.templatePages?: ReadonlyArray<TemplatePage>` — host-supplied page graph override that replaces the cartridge template's static pages for this mount only. Closes [msg_mpbhrhex_f07dda](https://github.com/airo-studio/airo-js — bridge thread). Use case: hosts that let customers customize the page graph (add / remove / reorder / enable / disable pages) persist those edits per-widget. Without this hook, SSR painted against the actual graph (server-side override) and client hydrate ran against the cartridge default — DOM mismatch → dead clicks.

### Changed
- Field name is `templatePages`, NOT `pages` (per Codex review: avoids collision with `loaded.config.pages` which lives at the cartridge-config layer).
- `TemplatePage` shape is re-exported from `@airo-js/cartridge-kit` rather than duplicated inline in embed — prevents silent cross-package drift when the template page shape grows.
- Page entries are deep-cloned when building the effective template (`{ ...p }` per entry). Host mutation of the array entries after `loadConfig` resolves cannot corrupt the runtime's view of the template, which closes over `opts.template` for remount paths.
- **Host validation responsibility** is documented on the JSDoc: no duplicate ids, no orphan subpages, at least one enabled non-subpage page, types matching registered `ViewDefinition.pageType`. The framework only catches missing-entry-page; everything else surfaces as navigation bugs at click time. Embed deliberately does not re-walk the graph the host just composed.

### Fixed
- `connectedCallback` now resets `this.disposed = false` at the top, allowing an element to be removed from DOM and reinserted (browser re-connection scenarios). Without the reset, the prior `disconnectedCallback()` latch left disposed=true forever and every post-async-phase check short-circuited silently — the element appeared mounted in DOM but no renderer was wired. Bonus fix surfaced during the Codex review of the 0.7.3 diff.

## `@airo-js/cartridge-kit` 0.7.3 — 2026-05-18

Shared component-resolution helpers + `TemplatePage` named export + JSDoc examples for category/FieldType extensions.

### Added
- `TemplatePage` interface — named export of the shape that `Template.pages` carries. Used by `@airo-js/embed`'s `LoadConfigResult.templatePages` to keep cross-package wire shape consistent without inline duplication.
- `resolveComponentProp(page, componentId, propKey, schema?)` — joins the three component-state layers (`page.componentSettings.props`, `Slot.props`, `ComponentSchema.props[k].default`) per the canonical precedence rule, returns the effective value. Pure; no DOM, no async, no consumer-specific logic.
- `resolveComponentVisibility(page, componentId)` — joins `page.componentSettings.visible`, `Slot.visible`, default `true` per the same precedence rule. Pure.

### Changed
- `Template.pages` is now typed as `TemplatePage[]` (was inline literal). Backward-compatible — structural shape is identical.
- `PropSchema.category` JSDoc adds `'data-binding'` as an example value alongside the existing `'behaviour' / 'layout' / 'style' / 'advanced'`. Explicitly NOT a blessed canonical enum — open string by design; studios are free to bucket however they want. Closes [msg_mpbhshsx_aacb20](https://github.com/airo-studio/airo-js Q1 question on the bridge).
- `FieldType` JSDoc expanded: `'attribute'`, `'reference'`, `'image'` documented as common cartridge-side extensions, NOT promoted to the core union. Per Codex review: promoting `'attribute'` to core would commit every downstream studio to rendering feed-attribute UI; that's a data-source semantics decision, not a UI-input-type decision. Cartridges keep using the `(string & {})` extension path. Closes Q2.

### Notes
- The component resolvers are scoped to **framework-defined precedence on framework-owned schema** (`Slot`, `Page.componentSettings`, `ComponentSchema`). Cartridge-specific computed logic (e.g., "show this prop only if the parent flag is on") stays in consumer code that wraps the resolved value. The helpers prevent two-place drift between the runtime renderer and the studio panel — both can now call the same precedence rule rather than each implementing it.

## `@airo-js/core` 0.7.3 — 2026-05-18

Sync rev for the 0.7.3 line. No API changes. The `Slot` / `Page.componentSettings` / `ComponentSchema` schema layers consumed by `@airo-js/cartridge-kit`'s new resolvers are unchanged from 0.7.2.

## `@airo-js/runtime` 0.7.3 — 2026-05-18

Sync rev for the 0.7.3 line. No API changes.

## `@airo-js/ssr` 0.7.3 — 2026-05-18

Sync rev for the 0.7.3 line. No API changes.

## `@airo-js/core` 0.7.2 — 2026-05-18

`RenderContext.pages` — renderer-readable page graph. Closes [msg_mpbfwheu_350d52](https://github.com/airo-studio/airo-js — the bridge thread that surfaced this gap during dotter-studio's commerce breadcrumb-component work).

### Added
- `RenderContext.pages: ReadonlyArray<Page<TPageType>>` — required field on every `RenderContext`. PageManager populates from its `opts.pages` (originally `AppConfig.pages`). Renderers reach the full page graph without re-deriving from `template.pages` via host-side `WeakMap`-on-event-bus workaround patterns. Use with the existing `buildCrumbs(pages, activePageId, navState)` helper.

### Changed
- `RenderContext` type widens by one required field. Existing renderers that don't reference `ctx.pages` keep working — they just have one more field available. Code outside the framework that constructs `RenderContext` manually (uncommon — only PageManager and the SSR renderer do this in-tree) needs to add `pages: appConfig.pages` to the literal.

### Notes
- Pages array reference is stable across hot-swap (PageManager's `opts.pages` doesn't change inside `update()`). A remount path technically carries the same reference too — `mountCartridge` doesn't swap templates inside `update()`. Tested in `packages/runtime/test/render-context-pages.test.ts`.
- Layering: this is framework state, not cartridge data — so it lives on bare `RenderContext`, not on `CartridgeAppContext`. Consistent with `ctx.page` (active page) and `ctx.navState` (current nav).

## `@airo-js/cartridge-kit` 0.7.2 — 2026-05-18

Sync rev for `workspace:^` peerDep coherence. No API changes — cartridge-kit re-exports `Page` from core, and `CartridgeRenderContext` inherits the new `pages` field via its `Omit<RenderContext, 'update'>` base.

## `@airo-js/runtime` 0.7.2 — 2026-05-18

Sync rev for the 0.7.2 line. No runtime change — `RenderContext.pages` is populated by `@airo-js/core`'s `PageManager` which runtime already delegates to via `createCartridgeApp`.

## `@airo-js/embed` 0.7.2 — 2026-05-18

Sync rev for `workspace:^` peerDep coherence with the 0.7.2 line. No API change.

## `@airo-js/ssr` 0.7.2 — 2026-05-18

Sync rev for the 0.7.2 line. `renderAppToHTML` now populates `RenderContext.pages` from `appConfig.pages` so SSR-rendered cartridges have access to the same page graph as client-side mounts.

### Changed
- `packages/ssr/src/render-app.ts` — adds `pages: config.pages` to the RenderContext literal at the renderer.renderSSR() / renderer.render() call site. Required to typecheck against the 0.7.2 `RenderContext` shape.

## `@airo-js/core` 0.7.1 — 2026-05-14

Renderer-callable update seam. `RenderContext` exposes `update`, so renderers can fire `MountCartridgeResult.update()` deltas from inside listener handlers without holding the host's mount handle. Closes [msg_mp58z77m_65d9ed](https://github.com/airo-studio/airo-js — the bridge thread that surfaced this gap during dotter-studio's D5 planning).

### Added
- `RenderContext.update?: (delta: Record<string, unknown>) => Promise<UpdateResult>` — optional field on every `RenderContext`. When the App is mounted via `mountCartridge` from `@airo-js/runtime`, the framework wires this to the host's `MountCartridgeResult.update()` closure on every mount. Raw `createApp` callers without a cartridge runtime can leave it `undefined` and renderers fall through their `?.()` guard.
- `UpdateResult` type — moved from `@airo-js/runtime` into core so `RenderContext.update`'s return type can be expressed without core depending on runtime. Re-exported from `@airo-js/runtime` for back-compat; existing imports unchanged.
- `AppDeps.hostUpdate?: ...` — wires the dispatcher through `createApp` → `PageManager` → `RenderContext`. Cartridge runtimes pass it; non-cartridge `createApp` callers omit.

### Notes
- Delta type at the core layer is `Record<string, unknown>` because `RenderContext` is generic over `TAppContext` but not over the cartridge's `TConfig`. Cartridge authors narrow via `CartridgeRenderContext` from `@airo-js/cartridge-kit` (see below).
- Existing renderers that don't reference `ctx.update` continue to work — the field is optional and additive.

## `@airo-js/cartridge-kit` 0.7.1 — 2026-05-14

Two type-utilities to make `update(delta)` ergonomic for cartridge authors.

### Added
- `DeepPartial<T>` — recursive partial type. Used as the delta type for `MountCartridgeResult.update()` and the typed `CartridgeRenderContext.update`, matching the runtime contract that already walked nested deltas via `leafPaths()`. Closes [msg_mp4hrxlk_954a8b](https://github.com/airo-studio/airo-js).
- `CartridgeRenderContext<TPageType, TData, TConfig>` — strongly-typed `RenderContext` for cartridge renderers. Extends `RenderContext<TPageType, CartridgeAppContext<TData, TConfig>>` with two narrowings: `app` is the typed cartridge envelope, and `update` accepts `DeepPartial<TConfig>` instead of `Record<string, unknown>`. Use this type in your renderer factories to get compile-time delta-shape checking on `ctx.update?.()` calls.

### Notes
- The core `RenderContext` stays generic. `CartridgeRenderContext` is an ergonomic extension cartridge-kit ships; both reference the same runtime function — no behavioral difference between them.

## `@airo-js/runtime` 0.7.1 — 2026-05-14

Widens `update(delta)` to `DeepPartial<TConfig>` (was shallow `Partial<TConfig>`), aligning the static type with the runtime contract. Wires `hostUpdate` through to `createCartridgeApp` so renderers receive `ctx.update`.

### Changed
- `MountCartridgeResult<TConfig>.update(delta)` parameter type: `Partial<TConfig>` → `DeepPartial<TConfig>` (from `@airo-js/cartridge-kit`). Backward-compatible — every shallow partial is a deep partial. Removes the cast that dotter-studio's Wave 0 smoke had to use.
- `UpdateResult` is now re-exported from `@airo-js/core` (the canonical home). Existing `import { UpdateResult } from '@airo-js/runtime'` keeps working unchanged.
- `mountCartridge` restructured to define the `update` closure before `doMountInner` runs, so `hostUpdate` (a type-erased wrapper around `update`) can be passed through `createCartridgeApp` → `createApp` → `PageManager`. State vars (`currentApp`, `currentSnapshot`, `currentConfig`) declared up-front; defensive guard in `update` throws if called before initial mount completes (impossible from a renderer in practice — renderers run after mount).

### Notes
- The `hostUpdate` wrapper casts `Record<string, unknown>` → `DeepPartial<TConfig>` at the boundary. Runtime walks the delta via `leafPaths` regardless of static type, so the cast is sound; cartridge-side type safety lives on `CartridgeRenderContext`.

## `@airo-js/embed` 0.7.1 — 2026-05-14

No public API changes. Sync rev for `workspace:^` peerDep coherence with the 0.7.1 line.

### Notes
- `el.update(delta: unknown)` stays type-erased at the embed boundary because attribute-driven mounts can't express `TConfig` at compile time. The 0.7.1 `DeepPartial<TConfig>` widening on the runtime side flows through structurally.

## `@airo-js/ssr` 0.7.1 — 2026-05-14

No API changes. Sync rev for `workspace:^` peerDep coherence with the 0.7.1 line.

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
