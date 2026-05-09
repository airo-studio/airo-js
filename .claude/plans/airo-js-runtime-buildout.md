---
name: @airo-js/runtime — buildout + consumption plan
description: Build the @airo-js/runtime package out of placeholder, factor out the orchestration logic the monorepo team currently inlines in cartridge.ts, and switch the consumer to use it. Two coordinated work streams — framework side ships the package, consumer side migrates to it. Closes the M9 / M13 line cleanly: framework owns mount orchestration, host apps extend with their own shell hooks (theme, error UI, studio chrome).
---

# `@airo-js/runtime` — buildout plan

## Context

`@airo-js/runtime` is currently a 1-export placeholder:

```ts
// packages/runtime/src/index.ts (whole file)
export const PACKAGE_NAME = '@airo-js/runtime';
```

It was scaffolded during the original Phase 0 layout (`packages/{core, runtime, ssr, embed, mcp, cartridge-kit}/`) but never given a real surface. The monorepo team consuming the cartridge bypassed it and rolled their own studio-specific entry at `apps/dotter-studio/src/widget-runtime/entries/cartridge.ts` (~340 LOC), using `@airo-js/core` + `@airo-js/cartridge-kit` directly.

That worked as a get-it-shipped move, but it means **the orchestration logic that every cartridge host app would write is currently duplicated in studio code**, with no shared seam. When a second host app (Restaurant cartridge studio, or the Phase 2 production embed) reaches for the same orchestration, they'd reimplement the same ~200 LOC of generic plumbing.

This plan does two things:

1. **Framework side (airo-js team):** build out `@airo-js/runtime` with the orchestration surface. Replaces the placeholder package with a working implementation.

2. **Consumer side (monorepo team):** migrate `cartridge.ts` to consume `@airo-js/runtime` + `createCartridgeApp` (which they should have been using from the start — audit miss flagged in B1.5 review). Studio-specific glue (v1 `WidgetConfig` translation, v1 `ThemeEngine`, runtime-mode toggle) stays studio-side via hooks the runtime exposes.

Both sides are sized for one developer ~3-4 days total: framework ~2 days + consumer migration ~1-2 days.

## What the runtime package owns (vs what stays studio-side)

Hard line at the M13 boundary: **runtime owns generic orchestration; host apps own their own shell, theme, and config-shape concerns.**

| Concern | Owner | Today | After |
|---|---|---|---|
| Style isolation root setup | `@airo-js/runtime` (wraps `@airo-js/core`'s `setupIsolationRoot`) | inlined in `cartridge.ts:setupShell` | exported from runtime |
| Global style injection contract | `@airo-js/runtime` (provides hook; doesn't ship CSS) | inlined in `cartridge.ts` | hook called by runtime, studio supplies CSS |
| Gate sequencing | `@airo-js/runtime` (delegates to `runGates`) | inlined in `cartridge.ts:252-268` | runtime calls `runGates` |
| DataSource fetch | `@airo-js/runtime` (calls `cartridge.dataSources[0].fetch`) | inlined in `cartridge.ts:270-286` | runtime calls; studio passes `preloadedData` to skip |
| Pipeline orchestration | `@airo-js/runtime` (delegates to `createPipeline`) | inlined in `cartridge.ts:297-305` | runtime calls; studio doesn't see the pipeline |
| `createCartridgeApp` invocation | `@airo-js/runtime` | NOT used (manual `createApp` call with cast) | runtime calls `createCartridgeApp` |
| Theme injection | **studio** | v1 `ThemeEngine` cast to airo `EventBus` shape | studio passes `onShellReady` hook; runtime stays theme-agnostic |
| `WidgetConfig → WtbConfig` translation | **studio** | `widgetConfigToWtbConfig` in entry | unchanged — studio concern |
| Runtime-mode toggle (v1 ↔ cartridge) | **studio** | `useRuntimeMode` hook + iframe flag | unchanged — dev affordance, not framework |
| Custom error UI | **studio** (via `onError` hook) | inline `<div class="widget-error">` in cartridge.ts | hook callback, studio renders |
| Chunk loading (CDN-deployed embeds) | `@airo-js/runtime` (Phase 2) | N/A (everything bundled) | added when production embed needs it |

Net: ~70% of `cartridge.ts` lifts into the runtime package. The remaining ~30% (translation, theme, toggle) stays studio-side because it's studio-specific. The studio entry shrinks from ~340 LOC to ~80-100 LOC.

---

## Framework side — `@airo-js/runtime` work units

**Estimate:** ~2 days, single dev. No external dependencies; all primitives the runtime composes (`createCartridgeApp`, `runGates`, `createPipeline`, `setupIsolationRoot`) are already shipped.

### WU-R1 — Public surface design (~3 hours)

Lock the `mountCartridge(opts)` shape before writing the body. Proposed:

```ts
// packages/runtime/src/mount-cartridge.ts
import type { App, AppConfig, IEventBus, StyleIsolation } from '@airo-js/core';
import type { Cartridge, Template } from '@airo-js/cartridge-kit';

export interface ShellHandle {
  /** Element renderers paint into. Inside the shadow root for partial/full isolation. */
  renderRoot: HTMLElement;
  /** Where stylesheets append. document.head for 'none', the ShadowRoot otherwise. */
  styleRoot: ShadowRoot | HTMLHeadElement;
  /** App-level event bus. Same instance threaded into gates + renderers. */
  events: IEventBus;
  /** Stable id on the renderRoot — useful for theme namespacing / data-* attributes. */
  rootId: string;
}

export interface MountCartridgeOptions<TData, TConfig, TPageType extends string = string> {
  cartridge: Cartridge<TData, TConfig>;
  /**
   * Cartridge config (shape declared by the cartridge's TConfig). NOT the
   * studio's editable config — the host app translates upstream and passes
   * the cartridge-shaped config in here.
   */
  config: TConfig;
  /** Picked template. The runtime builds AppConfig from `template.pages[]`. */
  template: Template<TConfig>;
  /** Element the runtime mounts into. */
  host: HTMLElement;

  /** Style isolation strategy. Default: 'partial'. */
  styleIsolation?: StyleIsolation;
  /** Stable id used for theme namespacing + DOM `data-airo-widget-id` attribute. */
  widgetId?: string;
  /** Opt-in URL ↔ NavigationState routing. Default: false. */
  enableRouter?: boolean;

  /**
   * Skip `dataSource.fetch` and use this data directly. Use when the host
   * app has cached / SSR-prefetched / studio-preloaded data.
   */
  preloadedData?: TData;
  /**
   * Override the data-source pick. Default: `cartridge.dataSources[0]`.
   * Useful for cartridges that ship multiple sources (CSV vs URL vs OAuth).
   */
  dataSourceId?: string;
  /** Discriminated input the chosen DataSource consumes. Default: { kind: 'url', url: deriveFromConfig }. */
  dataSourceInput?: import('@airo-js/cartridge-kit').DataSourceInput;
  /** Auth/credential bag threaded into DataSource.fetch. */
  credentials?: Record<string, string>;

  /** Studio-supplied scope passed into gates (locale, country, user_id, brand_id). */
  gateScope?: Record<string, string | undefined>;

  /**
   * Hook called after the shell is set up (isolation root + style root
   * created), before gates run. Studios use this to inject their own
   * styles, attach theme engines, register debug observers. Do NOT use
   * for content rendering — runtime mounts page renderers later.
   */
  onShellReady?: (shell: ShellHandle) => void;
  /**
   * Hook called when a phase fails. Studios use this to render
   * studio-specific error UI in the host element. Phases:
   *   - 'shell': isolation root setup failed
   *   - 'gate':  a gate threw
   *   - 'fetch': dataSource.fetch threw or returned non-data
   *   - 'pipeline': transformer chain threw under errorPolicy='fail-render'
   *   - 'mount': createApp threw
   */
  onError?: (phase: 'shell' | 'gate' | 'fetch' | 'pipeline' | 'mount', err: unknown, shell: ShellHandle | null) => void;
}

export type MountCartridgeResult =
  | {
      app: App;
      blocked: false;
      shell: ShellHandle;
      /** Aggregate teardown — destroys app + tears down shell-owned resources. */
      destroy: () => void;
    }
  | {
      app: null;
      blocked: true;
      blockedBy: string;
      shell: ShellHandle;
      /** Tears down the shell only (no app to destroy). Gate UI stays in host until called. */
      destroy: () => void;
    };

export async function mountCartridge<TData, TConfig, TPageType extends string = string>(
  opts: MountCartridgeOptions<TData, TConfig, TPageType>,
): Promise<MountCartridgeResult>;
```

**Acceptance:** signature reviewed against (a) the consumer side `cartridge.ts` it'd replace and (b) a hypothetical Restaurant-cartridge studio's needs. No silent assumptions about data source, theme, or studio config shape — all studio specifics arrive via hooks.

### WU-R2 — `mountCartridge` implementation (~6 hours)

Body:

```ts
export async function mountCartridge<TData, TConfig, TPageType extends string = string>(
  opts: MountCartridgeOptions<TData, TConfig, TPageType>,
): Promise<MountCartridgeResult> {
  const isolation = opts.styleIsolation ?? 'partial';
  const events = new EventBus();

  // Phase 1 — shell. Pure DOM; can't fail under normal browser conditions but
  // we still wrap in try/catch so onError fires consistently.
  let isolationRoot: IsolationRoot;
  try {
    isolationRoot = setupIsolationRoot(opts.host, isolation);
  } catch (err) {
    opts.onError?.('shell', err, null);
    throw err;
  }

  const renderRoot = isolationRoot.renderRoot;
  const styleRoot = isolationRoot.styleRoot instanceof ShadowRoot
    ? isolationRoot.styleRoot
    : document.head;
  if (!renderRoot.id) {
    renderRoot.id = opts.widgetId
      ? `airo-${opts.widgetId}`
      : `airo-${Math.random().toString(36).slice(2, 8)}`;
  }
  const shell: ShellHandle = { renderRoot, styleRoot, events, rootId: renderRoot.id };
  opts.onShellReady?.(shell);

  // Phase 2 — data. preloadedData wins; otherwise call DataSource.fetch.
  let data: TData;
  if (opts.preloadedData !== undefined) {
    data = opts.preloadedData;
  } else {
    const dsId = opts.dataSourceId;
    const ds = dsId
      ? opts.cartridge.dataSources.find((s) => s.id === dsId)
      : opts.cartridge.dataSources[0];
    if (!ds) {
      const err = new Error(
        `[@airo-js/runtime] mountCartridge: no DataSource found (id=${dsId ?? '<default>'}).`
      );
      opts.onError?.('fetch', err, shell);
      throw err;
    }
    const input = opts.dataSourceInput ?? deriveDefaultInput(opts.config);
    try {
      data = await ds.fetch(input, {
        config: opts.config,
        credentials: opts.credentials,
      });
    } catch (err) {
      opts.onError?.('fetch', err, shell);
      throw err;
    }
  }

  // Phase 3 — pipeline. Use the cartridge's declared transformers + post-processors.
  const firstPage = opts.template.pages.find((p) => p.enabled && !p.parent);
  if (!firstPage) {
    const err = new Error('[@airo-js/runtime] mountCartridge: template has no entry page.');
    opts.onError?.('mount', err, shell);
    throw err;
  }

  const pipeline = createPipeline<TData, TConfig>(
    opts.cartridge.transformers ?? [],
    opts.cartridge.postProcessors ?? [],
  );
  let snapshot: TData;
  try {
    snapshot = pipeline.runTransformers(data, {
      config: opts.config,
      navState: { page: firstPage.id },
      locale: (opts.config as { locale?: string }).locale,
    });
  } catch (err) {
    opts.onError?.('pipeline', err, shell);
    throw err;
  }

  // Phase 4 — mount via createCartridgeApp (handles gates + appContext + createApp).
  const appConfig = buildAppConfig(opts.template, opts.widgetId ?? `${opts.cartridge.id}-${Date.now()}`);
  let result: CartridgeAppResult;
  try {
    result = await createCartridgeApp(
      opts.cartridge,
      appConfig,
      snapshot,
      opts.config,
      {
        host: renderRoot,
        events,
        enableRouter: opts.enableRouter,
        gateScope: opts.gateScope,
      },
    );
  } catch (err) {
    opts.onError?.('mount', err, shell);
    throw err;
  }

  // Build the unified teardown.
  const destroy = () => {
    if (result.blocked) {
      // Gate UI stays until explicit unmount — caller asked for it.
      // We tear down nothing extra here.
      return;
    }
    result.app.destroy();
    // Shell teardown: remove the renderRoot wrapper inside the shadow,
    // detach styles we own. shadow root itself stays (re-attaching
    // throws), but contents are emptied.
    if (isolationRoot.isolated) {
      renderRoot.innerHTML = '';
    }
  };

  if (result.blocked) {
    return { app: null, blocked: true, blockedBy: result.blockedBy, shell, destroy };
  }
  return { app: result.app, blocked: false, shell, destroy };
}

function deriveDefaultInput<TConfig>(config: TConfig): DataSourceInput {
  const url = (config as { feed?: { url?: string } }).feed?.url;
  if (!url) {
    throw new Error('[@airo-js/runtime] no DataSource input provided and config.feed.url missing.');
  }
  return { kind: 'url', url };
}

function buildAppConfig<TConfig, TPageType extends string>(
  template: Template<TConfig>,
  appId: string,
): AppConfig<TPageType> {
  return {
    appId,
    pages: template.pages.map((p) => ({
      id: p.id,
      type: p.type as TPageType,
      enabled: p.enabled,
      parent: p.parent,
      // Empty layout — page renderers paint into ctx targetEl directly.
      // Cartridges that use the region/slot system populate Page.layout
      // on their template entries; the cartridge-kit Template type doesn't
      // declare layout so the runtime defaults to empty.
      layout: { regionOrder: [], regions: {} },
    })),
  };
}
```

**Acceptance:** unit tests cover each phase's error path, the preloaded-data shortcut, the gate-blocks-mount path, the dataSourceId selector. ~80 LOC of test against fake cartridge fixtures.

### WU-R3 — Tests (~3 hours)

Cover:
- Happy path: cartridge with no gates + preloaded data + 1 page → `blocked: false, app: App`
- Gate blocks: cartridge with a gate that returns 'block' → `blocked: true, blockedBy: '<gate.id>'`
- Fetch error: dataSource.fetch throws → `onError('fetch', err, shell)` fires + throws
- Pipeline error: transformer with `errorPolicy: 'fail-render'` throws → `onError('pipeline', err, shell)` fires + throws
- preloadedData skips fetch: dataSource.fetch is NOT called when `preloadedData` is supplied
- onShellReady fires once, before gates: spy on shell hook and gate.precheck order
- destroy() teardown: app.destroy called; shadow root contents emptied (if isolated)

Test approach: same fake-cartridge fixture pattern the cartridge-kit tests use. ~6 tests, ~150 LOC.

### WU-R4 — Barrel + package update (~30 min)

```ts
// packages/runtime/src/index.ts

export type {
  ShellHandle,
  MountCartridgeOptions,
  MountCartridgeResult,
} from './mount-cartridge.js';
export { mountCartridge } from './mount-cartridge.js';

export const PACKAGE_NAME = '@airo-js/runtime';
```

Bump `packages/runtime/package.json` to declare `@airo-js/cartridge-kit` as a workspace dep (currently only depends on `@airo-js/core`).

### WU-R5 — README + yalc push (~30 min)

`packages/runtime/README.md` with:
- The mountCartridge surface
- A 30-line "minimal host app entry" example
- The hook contract (onShellReady, onError) with one example each
- Migration guide for hosts that currently inline the orchestration (point at consumer-side WU below)

Then `pnpm yalc:push` from the workspace root. Consumer pulls + migrates in WU-C1.

### Acceptance gate (framework side complete)

```
[ ] WU-R1: mountCartridge signature merged
[ ] WU-R2: implementation merged
[ ] WU-R3: 6+ tests passing
[ ] WU-R4: package surface + dep wiring landed
[ ] WU-R5: README + yalc push
[ ] CONTRACT_VERSION bumped on @airo-js/cartridge-kit if any contract type changes (none expected)
[ ] Type-check + build clean across all 7 packages in airo-js workspace
```

---

## Consumer side — monorepo team work units

**Estimate:** ~1-2 days, single dev. Mostly mechanical migration of existing cartridge.ts to use mountCartridge.

### WU-C1 — Pull `@airo-js/runtime` via yalc (~15 min)

```bash
cd /Users/smithbn/workspace/dotter-monorepo
yalc add @airo-js/runtime
pnpm install
```

Verify the package resolves and types appear in `node_modules/@airo-js/runtime/dist/`.

### WU-C2 — Migrate `cartridge.ts` to `mountCartridge` (~3-4 hours)

**Before (current cartridge.ts):**

```ts
async preview(selector, studioConfig, options): Promise<void> {
  const host = ...;
  const { config, templateId } = widgetConfigToWtbConfig(studioConfig);
  const template = wtbCartridge.templates.find(t => t.id === templateId);

  const { renderRoot } = setupShell(host, options, options.theme ?? studioConfig);
  const events = new AiroEventBus();

  // 75 LOC of manual gate sequencing + fetch + pipeline + createApp + cast
  // ...
}
```

**After:**

```ts
async preview(selector, studioConfig, options): Promise<void> {
  const host = ...;
  const { config, templateId } = widgetConfigToWtbConfig(studioConfig);
  const template = wtbCartridge.templates.find(t => t.id === templateId);
  if (!template) {
    console.error(`[DotterCartridgeWidget] unknown template '${templateId}'`);
    return;
  }

  const result = await mountCartridge({
    cartridge: wtbCartridge,
    config,
    template,
    host,
    styleIsolation: options.styleIsolation ?? 'partial',
    widgetId: options.widgetId,
    enableRouter: false,
    preloadedData: options.preloadedData,
    onShellReady: (shell) => {
      // Studio-specific shell extensions:
      //   1. v1 global widget styles (Dotter studio's getAllStyles())
      //   2. Skeleton CSS (deletes when v0 layouts fully port)
      //   3. v1 ThemeEngine wired to the shell's events bus + render root
      injectGlobalStyles(shell.styleRoot);
      injectSkeletonStyles(shell.styleRoot);

      const themeConfig = options.theme ?? studioConfig;
      if (themeConfig) {
        const theme = new ThemeEngine(
          themeConfig as WidgetConfig,
          shell.events as unknown as ConstructorParameters<typeof ThemeEngine>[1],
          shell.rootId,
          { styleRoot: shell.styleRoot, containerEl: shell.renderRoot },
        );
        theme.init();
      }
    },
    onError: (phase, err) => {
      console.error(`[DotterCartridgeWidget] ${phase} failed:`, err);
      // Studio-specific error UI lives here, not in the runtime.
    },
  });

  if (result.blocked) {
    console.log(`[DotterCartridgeWidget] gate blocked mount: ${result.blockedBy}`);
    return;
  }
  console.log('[DotterCartridgeWidget] mounted via runtime; cartridge:', wtbCartridge.id, 'template:', templateId);
}
```

Net change: ~340 LOC → ~110 LOC. Studio-specific glue isolated in `onShellReady` and `onError` hooks. Translation layer (`widgetConfigToWtbConfig`), template picker, `runtimeMode` toggle: all unchanged — they're studio concerns.

**Files to delete from cartridge.ts:**
- `setupShell` function (replaced by runtime's shell setup)
- Gate execution block (lines 252-268; runtime calls `runGates` via `createCartridgeApp`)
- DataSource fetch block (lines 270-286; runtime calls)
- Pipeline construction + run (lines 297-305; runtime calls)
- `buildAppConfig` (runtime has its own)
- The `createApp` call + `as unknown as` cast (lines 317-323; runtime delegates to `createCartridgeApp`)

**Files staying in cartridge.ts:**
- `widgetConfigToWtbConfig` (studio config translation — studio concern)
- `injectGlobalStyles` / `injectSkeletonStyles` (studio CSS resources — studio concern)
- `DotterCartridgeWidget` global registration (studio API surface)

### WU-C3 — Update studio entry imports (~30 min)

```diff
- import { createApp, EventBus as AiroEventBus, type AppConfig } from '@airo-js/core';
- import { createCartridgeRegistry, runGates } from '@airo-js/cartridge-kit';
- import { createPipeline } from '@airo-js/core';
+ import { mountCartridge } from '@airo-js/runtime';
+ import { createCartridgeRegistry } from '@airo-js/cartridge-kit';
```

`createCartridgeRegistry` stays imported because the cartridge.ts file still owns the registry (it's the studio's cartridge inventory, not a runtime concern). Everything else collapses into the `mountCartridge` import.

### WU-C4 — Verify smoke (~1 hour)

Run the dev-server smoke checklist from the prior gate:

```
[ ] QuickShop template renders via mountCartridge
[ ] Showcase template renders
[ ] StorePlus full nav (categories → products → product → quickview → storeFinder)
[ ] Age gate fires (precheck → mount → 'allow')
[ ] Cookie persistence (refresh → precheck returns 'allow', no modal flash)
[ ] Style isolation 'partial' works (widget CSS scoped to shadow root)
[ ] runtimeMode toggle: v1 ↔ cartridge swap works
[ ] Console clean
```

Bundle re-verify:

```
[ ] dotter-cartridge-core.js size delta from B1.5: ±2 KB acceptable
[ ] No new chunks (mountCartridge bundles into core)
[ ] @airo-js/runtime appears in the bundle (grep for 'mount-cartridge' or 'mountCartridge')
```

### WU-C5 — Delete dead code from `widget-runtime/` (~30 min)

After smoke passes, the studio entry has these now-unused helpers:

- `setupShell` (replaced by runtime + onShellReady)
- `buildAppConfig` (runtime has its own)
- The manual gate / fetch / pipeline phases

Delete; type-check should still pass. Keeps the entry honest about what's studio-specific.

### Acceptance gate (consumer side complete)

```
[ ] WU-C1: yalc add complete, types resolve
[ ] WU-C2: cartridge.ts migrated to mountCartridge
[ ] WU-C3: imports updated
[ ] WU-C4: smoke passes (10/10 checks)
[ ] WU-C5: dead code deleted
[ ] cartridge.ts LOC dropped from ~340 to ~110 (~70% reduction; studio glue isolated to hooks)
[ ] type-check + build clean in dotter-monorepo
[ ] runtimeMode toggle still works (no regression on v1 path)
```

---

## Migration sequence

```
Day 1 (framework):
  ├─ AM  WU-R1 (signature design)
  └─ PM  WU-R2 start (mountCartridge body)

Day 2 (framework):
  ├─ AM  WU-R2 finish + WU-R3 (tests)
  └─ PM  WU-R4 (barrel) + WU-R5 (README + yalc push)
         ⇒ framework gate cleared; consumer can pull

Day 3 (consumer):
  ├─ AM  WU-C1 (yalc add) + WU-C2 (cartridge.ts migration)
  └─ PM  WU-C3 (imports) + WU-C4 (smoke)

Day 4 (consumer, half day):
  └─ AM  WU-C5 (dead code cleanup) + bundle re-verify + PR open
```

Total: **~3.5 days of single-dev work end-to-end.** Framework + consumer can run partly in parallel: WU-R3/R4/R5 can land in parallel with consumer-side reading (WU-C1) once R1+R2 are merged.

## What this closes

- **Eliminates the 70% duplication** between cartridge.ts and what every future cartridge host app would write.
- **Brings consumer onto `createCartridgeApp`** (resolves the audit miss flagged in B1.5 review). The `as unknown as Parameters<typeof createApp<...>>[1]['resolveRenderer']` cast disappears — the helper handles it internally.
- **Establishes the M13 line in code:** runtime owns generic orchestration (shell setup, gates, fetch, pipeline, mount); host apps own studio chrome, theme, error UI, config translation. Hooks (`onShellReady`, `onError`) are the contract.
- **Ships a real `@airo-js/runtime` package.** Removes the placeholder smell (`pnpm add @airo-js/runtime` getting 1 export).

## What this DOESN'T close (deliberately deferred)

- **Chunk loading + CDN deployment.** When the cartridge ships to production behind a CDN with separate chunks per page, `mountCartridge` grows additional knobs (`runtimeBase` URL, lazy script loading, hydrate-from-SSR fork). That's Phase 2 work — additive, doesn't break the v0.1 surface defined here.
- **`@airo-js/embed` package.** Customer-facing ~5KB browser bootstrap is its own package; same placeholder problem as runtime, same eventual buildout. Not in scope here.
- **`ThemeEngine` port to airo-native.** Documented as deferred bridge; lives in the consumer's `onShellReady` hook until Phase 1 reduction ports `@airo-js/core/Theme` to cover what `ThemeEngine` does today.
- **`styleIsolation` consolidation.** Consumer still uses `@/widget-runtime/core/styleIsolation` (v1) instead of `@airo-js/core`'s. Survey CSS class selectors first; flip when safe. Out of scope here.
- **Restaurant cartridge buildout.** Second-cartridge work that proves the contract generalizes; happens after this lands and after Restaurant has a real PoC scope.

## Open questions for the framework team

1. **Does `mountCartridge` belong in `@airo-js/runtime` or `@airo-js/cartridge-kit`?** Current proposal: runtime. Argument: runtime owns mount orchestration; cartridge-kit owns the contract types. But cartridge-kit already has `createCartridgeApp` (mount helper) and `createCartridgeRegistry` (registry). Is `mountCartridge` not just the next step in that progression?
   - **Recommendation:** runtime. Reasons: (a) cartridge-kit stays a *contract* package — types + thin glue. (b) runtime is allowed to depend on cartridge-kit; cartridge-kit shouldn't depend on shell orchestration. (c) the M13 line says "framework rendering only" — orchestration is rendering-adjacent, not contract-shaping. (d) when chunk-loading + SSR hydrate land in Phase 2, they're runtime concerns; growing them inside cartridge-kit pulls cartridge-kit into runtime concerns.

2. **Should `onShellReady` be sync or async?** Sync today (host app injects styles + theme synchronously). Async would support theme engines that fetch tokens from a server. **Recommendation:** sync for v0.1. Theme tokens are typically static or sync-loaded. Async support is additive if a real use case shows up.

3. **Should `mountCartridge` accept a pre-built `EventBus`?** Today the runtime constructs one. Some host apps may want to pre-wire listeners before mount (analytics, logging). **Recommendation:** add `events?: IEventBus` to `MountCartridgeOptions` — defaults to a fresh EventBus, host apps can pass their own. Trivial addition, real use case.

## Verification

This is a plan doc. "Verification" means:

1. Framework team reviews the proposed `mountCartridge` signature, signs off (or pushes back) on the open questions above.
2. WU-R1 → WU-R5 land; framework gate cleared.
3. Consumer team migrates per WU-C1 → WU-C5; consumer gate cleared.
4. Bundle re-verify shows the cartridge size unchanged (±2 KB) — the runtime work is a re-architecture, not a feature add.
5. Both teams confirm the resulting `cartridge.ts` is reviewable in one sitting (~110 LOC).

When all five steps pass, `@airo-js/runtime` is a real package + the consumer side is on `createCartridgeApp` + `mountCartridge`.
