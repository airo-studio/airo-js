/**
 * mountCartridge — generic cartridge mount orchestration.
 *
 * Replaces the ~75 LOC of phase-by-phase orchestration that every host app
 * would otherwise inline (shell setup → optional dataSource fetch →
 * pipeline → createCartridgeApp delegation → unified destroy). Studios
 * extend with their own shell concerns (theme injection, error UI, debug
 * observers) via the `onShellReady` and `onError` hooks rather than
 * forking the orchestration.
 *
 * The M13 line: this package owns generic orchestration; host apps own
 * studio chrome, theme, error UI, and config-shape translation. Hooks
 * are the contract.
 *
 * v0.2 (deferred, additive — signature-compatible):
 *   - `chunkBase: string`                    — CDN URL prefix for lazy page chunks
 *                                              when the cartridge is split per page.
 *   - `MountCartridgeResult.update(delta)`   — landed in 0.7.0 (see below).
 *   - async `onShellReady`                   — when a real use case (server-fetched
 *                                              theme tokens) shows up.
 *
 * Landed in 0.2.0:
 *   - `mode: 'csr' | 'hydrate'`              — SSR-hydrate fork. With `'hydrate'`,
 *                                              the runtime preserves DOM already in
 *                                              `host` and the active page renderer's
 *                                              `hydrate()` runs in place of `render()`.
 *
 * Landed in 0.7.0:
 *   - `MountCartridgeResult.update(delta)`   — live config delta dispatcher.
 *                                              Reads `cartridge.hotSwapKeys` (dot-path
 *                                              aware) to classify changes as hot-swap
 *                                              (replace appContext + re-render active
 *                                              page) vs remount (full pipeline replay
 *                                              with NavigationState preserved).
 *                                              Result type now generic over TConfig.
 *
 * Landed in 0.8.7:
 *   - `update()` / `updatePages()` serialize  — concurrent calls queue FIFO instead
 *                                              of interleaving destroy/remount cycles.
 *                                              Hosts no longer need their own dispatch
 *                                              queue in front of the result handle.
 *   - `'mount:remounted'` event               — emitted on the shared bus (payload:
 *                                              `UpdateResult`) after either dispatcher
 *                                              takes a remount path. Remounts clear
 *                                              `renderRoot`, so live-attached tooling
 *                                              (editor overlays, inspectors) subscribes
 *                                              to re-inject after renderer-initiated
 *                                              `ctx.update` remounts it never called.
 *   - `resolveView` chunk-recovery seam       — the Decision-1 hook, moved onto
 *                                              `SharedLifecycleHooks` so direct
 *                                              mountCartridge callers get the same
 *                                              engine embed's 0.8.5 hook had; embed
 *                                              now forwards instead of owning the loop.
 *
 * None of these change the required surface — `cartridge`, `config`,
 * `template`, `host` remain the only required options.
 */

import {
  EventBus,
  setupIsolationRoot,
  createPipeline,
  resolveMountEntry,
} from '@airo-js/core';
import type {
  App,
  AppConfig,
  IEventBus,
  IsolationRoot,
  NavigationState,
  Page,
  RouterOption,
  StyleIsolation,
  UpdateResult,
} from '@airo-js/core';
import type {
  Cartridge,
  CartridgeAppContext,
  CartridgeRegistry,
  DataSourceInput,
  DeepPartial,
  RunGatePhaseResult,
  Template,
  TemplatePage,
} from '@airo-js/cartridge-kit';
import { createCartridgeApp, runGatePhase, templateToAppConfig } from '@airo-js/cartridge-kit';
import { initLogControls, logger } from '@airo-js/log';

const log = logger('runtime');

/**
 * Handle exposed to `onShellReady`. Studios attach theme engines, inject
 * global styles, and register debug observers against this surface.
 */
export interface ShellHandle {
  /** Element renderers paint into. Inside the shadow root for 'shadow' isolation. */
  renderRoot: HTMLElement;
  /** Where stylesheets append. document.head for 'light', the ShadowRoot for 'shadow'. */
  styleRoot: ShadowRoot | HTMLHeadElement;
  /** App-level event bus. Same instance threaded into gates + renderers. */
  events: IEventBus;
  /** Stable id on the renderRoot — useful for theme namespacing / data-* attributes. */
  rootId: string;
}

/**
 * Phase identifier passed to `onError`. Lets studios render different
 * error UI per phase (e.g. retry-button on fetch failure, fatal panel on
 * shell setup failure).
 *
 * `'resolve-view'` (0.8.7) fires from the chunk-recovery engine when a
 * host-supplied `resolveView` load rejects — post-mount and async, unlike
 * the other phases, so it is never accompanied by a `mountCartridge`
 * throw; the failed load retries on the next `renderer:missing` miss.
 * Since 0.8.8 it also fires when a load *resolves* but the chunk never
 * registers a renderer for the missed page type (bad `pushToMailbox`
 * key / mailbox name) — the other way a chunk "did not load".
 */
export type MountPhase =
  | 'shell'
  | 'gate'
  | 'fetch'
  | 'pipeline'
  | 'mount'
  | 'resolve-view';

/**
 * Lifecycle hooks shared between `mountCartridge` (this package) and the
 * facade `defineAiroApp` (in `@airo-js/embed`). Anything added here MUST
 * be wired through `defineAiroApp` — the embed package's mapped-type
 * forwarding fails to compile when a new key is missing. Keep this
 * interface to truly shared seams; hook signatures that diverge between
 * the two facades (e.g. `onError`, whose phase set differs) stay on each
 * facade's own options interface.
 */
export interface SharedLifecycleHooks {
  /**
   * Pre-built event bus. When omitted, the runtime constructs a fresh one.
   * Pass your own to pre-wire listeners (analytics, logging) before mount.
   */
  events?: IEventBus;
  /**
   * Hook called after the shell is set up (isolation root + style root
   * created), before gates run. Studios use this to inject their own
   * styles, attach theme engines, register debug observers. Do NOT use
   * for content rendering — the runtime mounts page renderers later.
   *
   * **Ordering guarantee (contract, not incident):** `onShellReady` runs
   * synchronously in the shell phase, before the data fetch, pipeline,
   * and mount phases. A `shell.events` subscription made here observes
   * every emission from the render/hydrate phase — including events
   * components fire during their initial render. The runtime's own
   * chunk-recovery engine relies on this same subscribe-before-mount
   * ordering, so it cannot regress silently. `defineAiroApp` forwards
   * this hook unchanged; the guarantee holds through both facades.
   *
   * Sync at v0.1. Async support is additive when a real use case shows up.
   */
  onShellReady?: (shell: ShellHandle) => void;
  /**
   * Optional per-page chunk loader — the shared chunk-recovery seam
   * (0.8.7; previously embed-only, 0.8.5). When the active page's
   * renderer factory isn't registered yet, core's PageManager emits
   * `'renderer:missing'` and the runtime routes it here so the host can
   * load the chunk that owns `pageType`.
   *
   * Contract (locked 0.2.0 on the embed side; identical here):
   *   - Return a `Promise<void>` that resolves AFTER the chunk has
   *     registered its factory to the cartridge mailbox
   *     (`pushToMailbox`). The runtime re-dispatches once the promise
   *     settles; the resolved value is discarded.
   *   - **Transport-agnostic.** The body may be a dynamic `import()`, a
   *     `<script>`-tag injection with SRI, an import-map load, or a
   *     no-op for an already-inlined chunk. The only contract is
   *     "resolves when the factory is in the mailbox."
   *
   * The runtime owns the recovery orchestration so hosts never re-derive
   * it: singleflight per `(cartridgeId, pageType)` with delete-on-reject
   * (a cached rejected promise would permanently brick a chunk), a
   * mount-ready gate (the hook can settle on a microtask — preloaded /
   * warm-CDN chunk — before the mount promise resolves), and the
   * hydrate-vs-navigate dispatch split (getting it wrong wipes SSR DOM).
   * Load rejections surface via `onError` with each facade's own
   * `'resolve-view'` phase and retry on the next miss.
   *
   * Without this hook, a missing renderer soft-fails (no paint) and
   * emits `'renderer:missing'` for host-wired observability only. See
   * best-practices.md §2.5b.
   */
  resolveView?: (cartridgeId: string, pageType: string) => Promise<void>;
}

/**
 * Options bag for `mountCartridge`. Only `cartridge`, `config`, `template`,
 * and `host` are required — everything else (router, isolation strategy,
 * pre-fetched data, hooks) is optional. Keep it that way: the inline-script
 * smoke case (host page, one widget, no studio chrome) should call
 * `mountCartridge({ cartridge, config, template, host })` and work.
 */
export interface MountCartridgeOptions<
  TData,
  TConfig,
  TPageType extends string = string,
> extends SharedLifecycleHooks {
  cartridge: Cartridge<TData, TConfig>;
  /**
   * Cartridge config (shape declared by the cartridge's TConfig). NOT the
   * studio's editable config — the host app translates upstream and passes
   * the cartridge-shaped config in here.
   */
  config: TConfig;
  /** Picked template. The runtime builds AppConfig from `template.pages[]`. */
  template: Template<TConfig, TPageType>;
  /** Element the runtime mounts into. */
  host: HTMLElement;

  /** Style isolation strategy. Default: 'shadow'. */
  styleIsolation?: StyleIsolation;
  /** Stable id used for theme namespacing + DOM `id` on the renderRoot. */
  widgetId?: string;
  /**
   * URL routing strategy. Discriminated union — see `RouterOption` in
   * `@airo-js/core`. Default: `false` (memory only).
   *
   *   `false`               — no router (default).
   *   `true`                — back-compat alias for `{ mode: 'hash' }`.
   *   `{ mode: 'hash' }`    — HashRouter; embed-friendly.
   *   `{ mode: 'path', basePath }` — PathRouter; owned-URL widgets
   *                          (Campaign Pages, edge-rendered).
   */
  enableRouter?: RouterOption;

  /**
   * Mount mode. Default: `'csr'`.
   *
   *   - `'csr'`:     paint fresh views into the host. Whatever DOM was in the
   *                  host before mount gets overwritten.
   *   - `'hydrate'`: adopt SSR-rendered DOM already in the host. The runtime
   *                  preserves the existing markup (moves it inside the shadow
   *                  wrapper when isolation is 'shadow') and the
   *                  active page renderer's `hydrate()` runs in place of
   *                  `render()` — wiring listeners without repainting.
   *
   * Page renderers that don't implement `hydrate()` fall back to plain
   * `render()` (with a warning); the SSR markup gets repainted client-side.
   * Cartridges that ship to SSR pages should implement `hydrate()` on every
   * view that's allowed to be the entry page.
   */
  mode?: 'csr' | 'hydrate';

  /**
   * Mount-time navigation state. Threaded into `createApp` →
   * `PageManager` so the active page + ctx.navState resolve from
   * URL-decoded or host-supplied state, not just the default entry.
   *
   * Three legitimate sources:
   *   - URL-derived — pair with `decodeNavHint` server-side, or rely
   *     on `enableRouter` to populate from `window.location` client-
   *     side (router does this synchronously in PageManager's
   *     constructor; `initialNavState` is the explicit hand-off when
   *     decoding happens outside the framework).
   *   - Host-page programmatic — popup picker, product-locator button
   *     opening a widget with a specific product pre-selected.
   *   - Future — postMessage from parent frame, browser-storage
   *     rehydration.
   *
   * Contract: derivable on BOTH server and client from the same
   * inputs. Never a "server preload bag" — state is recomputed
   * client-side, never serialised into SSR HTML.
   */
  initialNavState?: Partial<NavigationState>;

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
  /** Discriminated input the chosen DataSource consumes. Default: derived from `config.feed.url`. */
  dataSourceInput?: DataSourceInput;
  /** Auth/credential bag threaded into DataSource.fetch. */
  credentials?: Record<string, string>;

  /** Studio-supplied scope passed into gates (locale, country, user_id, brand_id). */
  gateScope?: Record<string, string | undefined>;

  /**
   * Gate ids the host's server render already satisfied for THIS initial
   * mount (0.11.0). A host that rendered a private page with
   * `renderPrivate` verified the session that page is for; the SSR result
   * reports the `appliesTo: 'private'` gates that render met in
   * `gates.satisfied`, the host prints them on the mount root (the
   * convention is `data-airo-gates-satisfied="login"`) and its client entry
   * passes them here. Those gates are skipped on the initial mount — no
   * precheck, no paint, the client attaches listeners — and narrated as
   * `gate:allowed { via: 'server' }`.
   *
   * Initial mount only: `update()` / `updatePages()` remounts re-run every
   * gate, because a remount exists to get fresh data and freshness wins.
   * The runtime reads no attribute itself; the host passes the ids
   * explicitly. Ids naming no applicable, enabled gate are ignored.
   */
  satisfiedGates?: ReadonlyArray<string>;

  /**
   * Optional long-lived `CartridgeRegistry`. When provided, renderer
   * resolution goes through `registry.resolverFor(cartridge.id)` rather
   * than the lazy per-mount default. Single-cartridge studios can leave
   * this absent — the default `getDefaultRenderResolver(cartridge)`
   * builds a memoised single-cartridge registry under the hood.
   *
   * Multi-cartridge studios that own a shared registry across widget
   * instances should pass it here AND ensure the cartridge is
   * registered before mount (`registry.register(cartridge)`). The
   * registry stays alive in the caller's scope; `mountCartridge` only
   * reads from it.
   *
   * Precedence (matches createCartridgeApp): an explicit
   * `resolveRenderer` (not surfaced on MountCartridgeOptions today) >
   * `registry` > the lazy default.
   */
  registry?: CartridgeRegistry;

  /**
   * Hook called when a phase fails. Studios use this to render
   * studio-specific error UI in the host element. Phase identifies which
   * step threw (see MountPhase). The shell may be null when 'shell'
   * itself failed.
   *
   * NOT shared with `defineAiroApp`'s `onError` — embed wraps with its
   * own phase set (`load-config | resolve-cartridge | fetch-ssr | mount`).
   */
  onError?: (phase: MountPhase, err: unknown, shell: ShellHandle | null) => void;

  /**
   * Hook called once the cartridge's transformer pipeline has produced
   * its post-Transformer snapshot — exactly the value views, MCP tools,
   * and PublicationAdapters consume. Primarily exists so the
   * `@airo-js/runtime/test-harness` submodule can return the snapshot
   * for assertion; studio chrome rarely needs it (the active App
   * computes from the same snapshot internally). Harmless to use elsewhere.
   *
   * Fires after the pipeline phase succeeds, before `createCartridgeApp`
   * is called. Synchronous; do not await.
   */
  onPipelineComplete?: (snapshot: TData) => void;
}

// `UpdateResult` moved to `@airo-js/core/page.ts` in 0.7.1 so it can be
// referenced from `RenderContext.update`'s return type without core taking
// a circular dep on runtime. Re-exported here, and forwarded from the barrel
// in `index.ts`, so it stays importable from `@airo-js/runtime` — where the
// calls that return it live. Between 0.7.1 and 0.9.0 this re-export existed
// but the barrel did not forward it, so the back-compat it claimed did not
// actually hold; `exports` only exposes `.` and `./test-harness`, never this
// module's path. Caught by knip pre-1.0.
export type { UpdateResult };

/**
 * Discriminated result of a mount. The `blocked` branch fires when a
 * pre-render Gate returned 'block' — the gate's UI stays in the host
 * element and the framework paints nothing else.
 *
 * Generic over `TConfig` so the `update(delta)` method on the unblocked
 * branch can accept `DeepPartial<TConfig>` (0.7.1 widening — runtime
 * always walked nested deltas; type now matches). The `TConfig = unknown`
 * default preserves backward compatibility for callers that don't
 * propagate the type parameter.
 */
export type MountCartridgeResult<
  TConfig = unknown,
  TPageType extends string = string,
> =
  | {
      app: App;
      blocked: false;
      shell: ShellHandle;
      /** Tear down: destroys the App and clears renderRoot contents (when isolated). */
      destroy: () => void;
      /**
       * Live config delta dispatcher. Classifies `delta` paths against
       * `cartridge.hotSwapKeys` (dot-path aware) — paths covered by the
       * allowlist hot-swap in place (existing snapshot reused, active
       * page renderer torn down + re-rendered with fresh `ctx.app`),
       * any uncovered path triggers a full remount (transformers re-run
       * with `NavigationState` preserved across the destroy/recreate).
       *
       * Async because remount calls back into the cartridge pipeline
       * (gates, transformers, `createCartridgeApp`); hot-swap awaits a
       * resolved promise. Callers can `await` uniformly.
       *
       * Serialized (0.8.7): concurrent `update` / `updatePages` calls
       * queue FIFO — a second call dispatched while a remount is in
       * flight observes the first call's post-remount state instead of
       * interleaving with it. A remount additionally emits
       * `'mount:remounted'` (payload: `UpdateResult`) on `shell.events`
       * so live-attached tooling can re-inject into the cleared
       * renderRoot — including remounts initiated by renderers via
       * `ctx.update`, where the host is not in the call stack.
       *
       * Throws when a remount triggered by `update` runs into a gate
       * that returns `'block'` — same surface as initial mount blocking.
       */
      update: (delta: DeepPartial<TConfig>) => Promise<UpdateResult>;
      /**
       * Live page-graph dispatcher (0.8.0). Replaces (does NOT merge)
       * `AppConfig.pages` with `nextPages` and classifies the per-page
       * diff against `cartridge.pageHotSwapKeys`:
       *
       *  - Covered diff → hot-swap. The active renderer is re-rendered
       *    with the new `ctx.page` and `ctx.pages`; the existing
       *    post-Transformer snapshot is reused (pages are cosmetic from
       *    the snapshot's point of view).
       *  - Uncovered diff OR any structural change (added / removed
       *    pages, changed `id` / `type` / `enabled` / `parent`) →
       *    remount. NavigationState preserved across destroy/recreate
       *    the same way `update(delta)`'s remount path preserves it.
       *
       * The hot-swap path needs `cartridge.pageHotSwapKeys` to declare
       * which page fields are cosmetic. Common allowlists:
       * `['componentSettings', 'styles', 'layout.regions']` covers the
       * per-component override + page-style + slot-prop / slot-visibility
       * surface that a Component-panel editor writes.
       *
       * Async + throws on blocked-gate remount, same surface as `update`.
       * Shares `update`'s FIFO queue and `'mount:remounted'` emission
       * (0.8.7) — see the `update` doc above.
       */
      updatePages: (
        nextPages: ReadonlyArray<TemplatePage<TPageType>>,
      ) => Promise<UpdateResult>;
    }
  | {
      app: null;
      blocked: true;
      blockedBy: string;
      shell: ShellHandle;
      /**
       * Tear down: leaves the gate UI in `host` (caller asked for it via
       * `block`) but releases shell resources we own. Caller can replace
       * the host's contents on their own when they're done with the gate.
       */
      destroy: () => void;
    };

/**
 * Mount a cartridge into `host`. Single-call orchestration:
 *
 *   shell ─► onShellReady ─► resolveMountEntry ─► gate phase ─► data ─► pipeline ─► createCartridgeApp ─► mounted
 *                            (URL > hint > default)   │ block ─► { blocked, blockedBy };  data-airo-gate="blocked"
 *                                                      │ throw ─► onError('gate');         data-airo-gate="error"
 *                                                      └ allow ─► hydrate? restore SSR DOM; data-airo-gate="passed"
 *   satisfiedGates: named gates skipped on the INITIAL mount only (gate:allowed via 'server')
 *   update()/updatePages(): hot-swap keys → replaceAppContext/replacePages (no gates)
 *                           otherwise      → re-run from resolveMountEntry (gates run again; freshness wins)
 *
 *   1. Shell setup    — isolation root + style root + event bus.
 *   2. onShellReady   — studio attaches theme / styles / observers.
 *   3. Entry          — which page this mount starts on, by the same
 *                       URL > `initialNavState` > default ladder PageManager
 *                       uses (`resolveMountEntry`).
 *   4. Gates          — `runGatePhase`, BEFORE any data: a blocked mount
 *                       costs no network and no pipeline. A gate scoped
 *                       `appliesTo: 'private'` runs only when the entry page
 *                       is `private: true`.
 *   5. Data           — `preloadedData` shortcut, otherwise `dataSource.fetch`.
 *   6. Pipeline       — runs the cartridge's transformer chain.
 *   7. Mount          — `createCartridgeApp` (appContext + renderer
 *                       resolution + `createApp`); synchronous since 0.11.0.
 *
 * Errors in any phase fire `onError(phase, err, shell)` and re-throw —
 * the runtime never silently swallows.
 */
export async function mountCartridge<
  TData,
  TConfig,
  TPageType extends string = string,
>(
  opts: MountCartridgeOptions<TData, TConfig, TPageType>,
): Promise<MountCartridgeResult<TConfig, TPageType>> {
  // ?airo-log= opt-in (0.8.8): with the default threshold at 'error',
  // this is how any surface chooses its output level. Once-guarded in
  // @airo-js/log; browser-only; no-op when neither URL param nor the
  // persisted __airo_log key is present.
  initLogControls();
  const isolation: StyleIsolation = opts.styleIsolation ?? 'shadow';
  const mode: 'csr' | 'hydrate' = opts.mode ?? 'csr';
  const events: IEventBus = opts.events ?? new EventBus();

  // Phase 1 — shell. Pure DOM; can't fail under normal browser conditions
  // but we still wrap so onError fires consistently with the other phases.
  //
  // Three SSR adoption paths, in priority order:
  //   1. Declarative Shadow DOM (DSD) — `host.shadowRoot` is already
  //      non-null because the browser parsed `<template shadowrootmode>`
  //      during initial HTML parse. Zero-FOUC: shadow-scoped styles
  //      applied at parse time. Just adopt; no innerHTML lift, no
  //      re-paint. `setupIsolationRoot` handles wrapping if needed.
  //   2. Light-DOM SSR + mode='hydrate' — server emitted markup as
  //      light-DOM children. Lift `innerHTML` into the shadow wrapper.
  //   3. Fresh CSR or 'light' isolation — straight `setupIsolationRoot`.
  //
  // DSD detection has higher priority than mode='hydrate' because the
  // presence of a pre-attached shadow root means the SSR content is
  // already in place — re-painting from `host.innerHTML` (which is
  // empty in the DSD case) would wipe it.
  const hasDeclarativeShadow = isolation !== 'light' && opts.host.shadowRoot !== null;
  let isolationRoot: IsolationRoot;
  try {
    if (hasDeclarativeShadow) {
      // DSD path: adopt the existing shadow. setupIsolationRoot reuses
      // the shadow root, auto-wraps existing content into the
      // `.airo-shadow-root` wrapper if the server didn't emit it.
      isolationRoot = setupIsolationRoot(opts.host, isolation);
    } else if (mode === 'hydrate' && isolation !== 'light') {
      const ssrHtml = opts.host.innerHTML;
      opts.host.innerHTML = '';
      isolationRoot = setupIsolationRoot(opts.host, isolation);
      isolationRoot.renderRoot.innerHTML = ssrHtml;
    } else {
      isolationRoot = setupIsolationRoot(opts.host, isolation);
    }
  } catch (err) {
    opts.onError?.('shell', err, null);
    throw err;
  }

  const renderRoot = isolationRoot.renderRoot;
  // `ShadowRoot` is undefined globally in jsdom and deno-dom; guard the
  // instanceof so consumer test envs that lack the constructor fall through
  // to `document.head` instead of throwing `Right-hand side of 'instanceof'
  // is not an object`. Mirror of the pattern in `@airo-js/core` resolveStyleRoot.
  const styleRoot: ShadowRoot | HTMLHeadElement =
    typeof ShadowRoot !== 'undefined' && isolationRoot.styleRoot instanceof ShadowRoot
      ? isolationRoot.styleRoot
      : document.head;
  if (!renderRoot.id) {
    renderRoot.id = opts.widgetId
      ? `airo-${opts.widgetId}`
      : `airo-${Math.random().toString(36).slice(2, 8)}`;
  }
  const shell: ShellHandle = {
    renderRoot,
    styleRoot,
    events,
    rootId: renderRoot.id,
  };
  opts.onShellReady?.(shell);

  // === Mutable state across remounts (`update` / `updatePages`) ===
  // The result handle the caller holds remains stable; we swap the
  // underlying App + snapshot + pages here when a remount path runs.
  //
  // Declared up front (before `doMountInner` is defined) so the `update`
  // closure below can be wired through to renderers as `ctx.update` BEFORE
  // the initial mount completes — `createCartridgeApp` builds the App's
  // PageManager during the initial mount, and PageManager constructs
  // RenderContexts that close over `hostUpdate`. The state vars are null
  // / undefined during the initial mount window; renderers never call
  // `ctx.update` during their first render anyway (it fires from listener
  // handlers triggered post-mount), so the defensive guard in `update`
  // below is purely a safety net.
  //
  // `widgetId` captured once so a no-widgetId call doesn't generate a
  // fresh `Date.now()` appId on every remount (stable handle for SSR
  // hydration markers + analytics).
  const widgetId = opts.widgetId ?? `${opts.cartridge.id}-${Date.now()}`;
  let currentApp: App | null = null;
  let currentSnapshot: TData | undefined;
  let currentConfig: TConfig = opts.config;
  let currentPages: Page<TPageType>[] = templateToAppConfig<TConfig, TPageType>(
    opts.template,
    widgetId,
  ).pages;

  // === Chunk-recovery engine (0.8.7 — the shared seam, formerly embed
  // Phase 6.5) ===
  // The subscription MUST land before the initial mount below: hydrate-
  // phase misses emit DURING createCartridgeApp, so a post-await
  // subscriber would miss them. Four corners the engine owns so hosts
  // don't re-derive them:
  //   1. Singleflight per (cartridge.id, pageType), delete-on-reject —
  //      concurrent misses collapse to one load; a cached rejected
  //      promise would otherwise permanently brick the chunk.
  //   2. Mount-ready gate — `resolveView` can settle on a microtask
  //      (preloaded / warm-CDN chunk) before the mount promise resolves;
  //      dispatching then would hit a null app and silently strand the
  //      page. Blocked or thrown initial mounts resolve the gate `false`
  //      so queued recoveries return instead of hanging forever.
  //   3. Hydrate-vs-navigate dispatch — a hydrate miss re-runs hydrate
  //      in place (SSR DOM preserved); a navigate miss repaints (CSR —
  //      nothing to preserve). Getting this wrong wipes SSR DOM.
  //   4. Registration-failure detection (0.8.8) — a load that resolves
  //      without registering the missed page type would otherwise loop
  //      forever (dispatch → miss → cached resolved load → dispatch).
  //      One re-dispatch is allowed; a re-miss after a resolved load is
  //      a hard error (log.error + onError('resolve-view')), then reset.
  // Dispatch reads `currentApp` at fire time, so misses emitted after an
  // `update()`/`updatePages()` remount recover against the live App, not
  // a stale capture.
  let signalMountReady: (ready: boolean) => void = () => {};
  if (opts.resolveView) {
    const resolveView = opts.resolveView;
    const mountReady = new Promise<boolean>((res) => {
      signalMountReady = res;
    });
    const inflight = new Map<string, Promise<void>>();
    // Keys whose load resolved and whose recovery already dispatched once.
    // A miss arriving for a key already in here means the chunk loaded
    // WITHOUT registering a renderer for the missed page type — without
    // this guard that case loops forever (dispatch → miss → cached
    // resolved load → dispatch → …) and never surfaces an error.
    const recovered = new Set<string>();
    // Keys whose re-dispatch re-missed. `EventBus.emit` is synchronous,
    // so the re-miss lands in this handler (and flags the key here)
    // DURING the dispatching invocation's `hydratePage`/`navigate` call —
    // letting the dispatcher skip the success log for a failed recovery.
    const remissed = new Set<string>();
    events.on('renderer:missing', async (payload: unknown) => {
      // Documented `'renderer:missing'` payload shape from PageManager.
      const { pageType, pageId, phase } = payload as {
        pageType: string;
        pageId: string;
        phase: 'navigate' | 'hydrate';
      };
      // NUL separator — collision-proof against ids containing spaces;
      // same key convention the embed-side loop used pre-0.8.7.
      const key = `${opts.cartridge.id}\u0000${pageType}`;
      // Read synchronously at entry: `true` only for a re-miss emitted
      // during our own dispatch below (registration failure), never for
      // a second pre-dispatch miss racing the same in-flight load.
      const rerun = recovered.has(key);
      if (rerun) remissed.add(key);
      let load = inflight.get(key);
      if (!load) {
        // Keep the promise on success (chunk stays loaded — repeat
        // misses are free); evict on reject so the next miss reloads.
        load = resolveView(opts.cartridge.id, pageType);
        inflight.set(key, load);
        load.catch(() => inflight.delete(key));
      }
      try {
        await load;
      } catch (err) {
        log.error(
          `chunk load failed for page type "${pageType}" — resolveView rejected. The next miss retries.`,
          err,
          { pageType, pageId, phase, cartridgeId: opts.cartridge.id },
        );
        opts.onError?.('resolve-view', err, shell);
        return;
      }
      if (rerun) {
        // The load resolved but the previous dispatch still missed: the
        // chunk executed without registering this page type. Reset the
        // key so a later attempt (e.g. after the host fixes the chunk)
        // starts a fresh load instead of replaying this stale one.
        const err = new Error(
          `chunk for page type "${pageType}" loaded but registered no renderer — check the chunk's pushToMailbox key against the cartridge's mailboxName and view keys.`,
        );
        log.error(err.message, undefined, {
          pageType,
          pageId,
          phase,
          cartridgeId: opts.cartridge.id,
        });
        recovered.delete(key);
        remissed.delete(key);
        inflight.delete(key);
        opts.onError?.('resolve-view', err, shell);
        return;
      }
      if (!(await mountReady)) return;
      const app = currentApp;
      if (!app) return;
      // Add BEFORE dispatching — the re-miss (if any) fires synchronously
      // inside the dispatch and must see the key as already recovered.
      recovered.add(key);
      if (phase === 'hydrate') app.hydratePage(pageId);
      else app.navigate({ page: pageId });
      if (!remissed.has(key)) {
        log.info(
          `chunk loaded — page type "${pageType}" ${phase === 'hydrate' ? 'hydrated' : 'rendered'} after recovery.`,
          { pageType, pageId, phase, cartridgeId: opts.cartridge.id },
        );
      }
    });
  }

  // === FIFO dispatch queue (0.8.7) ===
  // Both dispatchers below destroy + rebuild the App across an await gap;
  // two in-flight calls would otherwise interleave (both pass the mounted
  // guard, both remount concurrently, last writer wins on `currentApp` and
  // the loser's config merge is lost). Serialize instead: each call chains
  // behind the previous one, errors don't stall the queue.
  let dispatchQueue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(op: () => Promise<T>): Promise<T> => {
    const run = dispatchQueue.then(op, op);
    dispatchQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  // === Live update dispatcher (defined before doMountInner so the
  // `hostUpdate` wrapper below can reference it forward-of-call) ===
  const updateInner = async (delta: DeepPartial<TConfig>): Promise<UpdateResult> => {
    if (!currentApp || currentSnapshot === undefined) {
      throw new Error(
        '[@airo-js/runtime] update() called before mount completed or after destroy(). Wait for `await mountCartridge(...)` to resolve before invoking, and stop calling update from renderers post-destroy.',
      );
    }
    const paths = leafPaths(delta);
    const hotSwap = (opts.cartridge.hotSwapKeys ?? []).map(String);
    const needsRemount = paths.some((p) => !isCovered(p, hotSwap));
    const navState = currentApp.getNavigationState();
    const newConfig = deepMerge(currentConfig, delta);

    if (needsRemount) {
      // Tear down the old app but leave `currentApp` pointing at the
      // destroyed handle until the new app is ready — this preserves
      // the `result.app.state` getter contract during the async gap
      // and avoids null-handling at access sites.
      currentApp.destroy();
      if (isolationRoot.isolated) {
        renderRoot.innerHTML = '';
      }
      const next = await doMountInner(newConfig, navState, false);
      if (next.blocked) {
        // Remount-during-update tripped a gate. Surface as throw — the
        // caller can decide whether to remount with different config or
        // tear down. `currentApp` remains the (destroyed) prior handle,
        // matching post-destroy semantics so subsequent destroy() calls
        // are idempotent.
        throw new Error(
          `[@airo-js/runtime] update() remount was blocked by gate "${next.blockedBy}". Resolve the gate or revert the offending config delta.`,
        );
      }
      currentApp = next.app;
      currentSnapshot = next.snapshot;
      currentConfig = newConfig;
      const outcome: UpdateResult = { mode: 'remount', navState };
      events.emit('mount:remounted', outcome);
      return outcome;
    }

    // Hot-swap path. Existing snapshot is still valid (the cartridge
    // declared these paths as not affecting derived data); replace the
    // appContext + re-render the active page in place.
    const newAppContext: CartridgeAppContext<TData, TConfig> = {
      cartridgeId: opts.cartridge.id,
      config: newConfig,
      data: currentSnapshot,
    };
    currentApp.replaceAppContext(newAppContext);
    currentConfig = newConfig;
    return { mode: 'hot-swap', navState };
  };

  // === Live page-graph dispatcher ===
  // Classify the per-page diff against `cartridge.pageHotSwapKeys`. Any
  // structural change (page added / removed / reordered, or `id` / `type`
  // / `enabled` / `parent` flip on an existing entry) skips the
  // classifier and routes straight to remount — page graph shape is
  // always structural regardless of the allowlist.
  const updatePagesInner = async (
    nextPagesTemplate: ReadonlyArray<TemplatePage<TPageType>>,
  ): Promise<UpdateResult> => {
    if (!currentApp || currentSnapshot === undefined) {
      throw new Error(
        '[@airo-js/runtime] updatePages() called before mount completed or after destroy(). Wait for `await mountCartridge(...)` to resolve before invoking, and stop calling updatePages from renderers post-destroy.',
      );
    }
    // Translate via the same helper as the initial mount + remount paths
    // so any future rich-field addition flows through one source of truth.
    const nextAppConfig = templateToAppConfig<TConfig, TPageType>(
      { ...opts.template, pages: [...nextPagesTemplate] },
      widgetId,
    );
    const nextPages = nextAppConfig.pages;
    const navState = currentApp.getNavigationState();
    const allowed = (opts.cartridge.pageHotSwapKeys ?? []).map(String);
    const canHotSwap = pagesDiffIsCoveredByHotSwap(
      currentPages,
      nextPages,
      allowed,
    );

    if (!canHotSwap) {
      currentApp.destroy();
      if (isolationRoot.isolated) {
        renderRoot.innerHTML = '';
      }
      // Set `currentPages` BEFORE doMountInner so Phase 4 reads the new
      // graph. doMountInner consumes `currentPages` directly.
      currentPages = nextPages;
      const next = await doMountInner(currentConfig, navState, false);
      if (next.blocked) {
        throw new Error(
          `[@airo-js/runtime] updatePages() remount was blocked by gate "${next.blockedBy}". Resolve the gate or revert the offending page-graph delta.`,
        );
      }
      currentApp = next.app;
      currentSnapshot = next.snapshot;
      const outcome: UpdateResult = { mode: 'remount', navState };
      events.emit('mount:remounted', outcome);
      return outcome;
    }

    // Hot-swap path. Snapshot reused; replace pages on the live App and
    // let PageManager re-render the active page in place with the new
    // `ctx.page` / `ctx.pages`.
    currentApp.replacePages(nextPages);
    currentPages = nextPages;
    return { mode: 'hot-swap', navState };
  };

  // Public dispatchers — the serialized fronts the caller (and renderers,
  // via `hostUpdate` below) actually invoke. Everything flows through the
  // FIFO queue so a host never observes interleaved remounts.
  const update = (delta: DeepPartial<TConfig>): Promise<UpdateResult> =>
    enqueue(() => updateInner(delta));
  const updatePages = (
    nextPages: ReadonlyArray<TemplatePage<TPageType>>,
  ): Promise<UpdateResult> => enqueue(() => updatePagesInner(nextPages));

  // Type-erased wrapper passed to PageManager as `hostUpdate`. Cast is
  // safe at runtime — `update()` walks the delta via `leafPaths` regardless
  // of the static type, and cartridge-side callers wrap in
  // `CartridgeRenderContext` for the typed `DeepPartial<TConfig>` at the
  // call site. Without the cast, `RenderContext.update` would have to
  // thread `TConfig` through the generic surface of core's RenderContext,
  // which is a breaking type change.
  const hostUpdate = (delta: Record<string, unknown>): Promise<UpdateResult> =>
    update(delta as DeepPartial<TConfig>);

  // Inner mount sequence (phases 3-7). Factored as a closure because
  // `update()` calls it again on remount paths — same entry / gate / fetch /
  // pipeline / createCartridgeApp work, threaded with the new config +
  // preserved NavigationState. Returns the snapshot too so the outer scope
  // can cache it for hot-swap reuse. No snapshot exists on the blocked
  // branch: gates run before the data phase.
  type InnerMount =
    | { blocked: true; blockedBy: string }
    | { blocked: false; app: App; snapshot: TData };

  // The no-paint attribute (0.11.0). A host that needs zero painted frames
  // before a gate ships `data-airo-gate="pending"` on the host element
  // (from the SSR result's `gates.pending`) and hides under it with its own
  // CSS; the runtime resolves the attribute on EVERY exit of the gate
  // phase. Absent → never written: zero change for hosts that don't use it.
  const setGateAttribute = (value: 'passed' | 'blocked' | 'error'): void => {
    if (opts.host.hasAttribute('data-airo-gate')) {
      opts.host.setAttribute('data-airo-gate', value);
    }
  };

  async function doMountInner(
    config: TConfig,
    navState: Partial<NavigationState> | undefined,
    initial: boolean,
  ): Promise<InnerMount> {
    // Phase 3 — entry. Cheap, and it has to come before the gates: the gate
    // phase is scoped against the page this mount starts on, resolved by
    // the same URL > initialNavState > default ladder PageManager applies
    // inside createApp. Also the "no enabled entry page" sanity check, so a
    // broken graph fails before any gate paints.
    const firstPage = currentPages.find((p) => p.enabled && !p.parent);
    if (!firstPage) {
      const err = new Error(
        '[@airo-js/runtime] mountCartridge: template has no enabled entry page.',
      );
      opts.onError?.('mount', err, shell);
      throw err;
    }
    const entry = resolveMountEntry<TPageType>({
      pages: currentPages,
      enableRouter: opts.enableRouter,
      initialNavState: navState,
    });

    // Phase 4 — gates. BEFORE data: a sign-in gate must be able to stop the
    // member fetch, and a blocked mount must cost no network. In hydrate
    // mode the server's markup is already in `renderRoot`; remember it so
    // a gate that paints over it and then allows does not hand hydration
    // its own DOM (the age-modal-over-SSR-products shape).
    const ssrMarkup = mode === 'hydrate' ? renderRoot.innerHTML : null;
    let gatePhase: RunGatePhaseResult;
    try {
      gatePhase = await runGatePhase({
        gates: opts.cartridge.gates,
        entryPage: entry.page,
        host: renderRoot,
        ctx: { config, events, scope: opts.gateScope },
        satisfiedGates: initial ? opts.satisfiedGates : undefined,
      });
    } catch (err) {
      setGateAttribute('error');
      opts.onError?.('gate', err, shell);
      throw err;
    }
    if (gatePhase.verdict === 'block') {
      // The blocking gate left its UI in `renderRoot`. Nothing else paints,
      // nothing is fetched.
      setGateAttribute('blocked');
      return { blocked: true, blockedBy: gatePhase.blockedBy };
    }
    if (ssrMarkup !== null && renderRoot.innerHTML !== ssrMarkup) {
      renderRoot.innerHTML = ssrMarkup;
    }
    setGateAttribute('passed');

    // Phase 5 — data. preloadedData wins; otherwise call DataSource.fetch.
    let data: TData;
    if (opts.preloadedData !== undefined) {
      data = opts.preloadedData;
    } else {
      const ds = opts.dataSourceId
        ? opts.cartridge.dataSources.find((s) => s.id === opts.dataSourceId)
        : opts.cartridge.dataSources[0];
      if (!ds) {
        const err = new Error(
          `[@airo-js/runtime] mountCartridge: no DataSource found (id=${
            opts.dataSourceId ?? '<default>'
          }).`,
        );
        opts.onError?.('fetch', err, shell);
        throw err;
      }
      const input = opts.dataSourceInput ?? deriveDefaultInput(config);
      try {
        data = await ds.fetch(input, {
          config,
          credentials: opts.credentials,
        });
      } catch (err) {
        opts.onError?.('fetch', err, shell);
        throw err;
      }
    }

    // Phase 6 — pipeline. `firstPage` is the live `currentPages` entry (not
    // `opts.template.pages`) so a remount triggered after `updatePages()`
    // reflects the swapped graph.
    const pipeline = createPipeline<TData, TConfig>(
      opts.cartridge.transformers ?? [],
      opts.cartridge.postProcessors ?? [],
    );
    // Skip the `postRender` wiring entirely when the cartridge declares no
    // post-processors, so PageManager holds no closure and allocates no
    // teardown slot on the common path.
    const hasPostProcessors = (opts.cartridge.postProcessors?.length ?? 0) > 0;
    let snapshot: TData;
    try {
      snapshot = await pipeline.runTransformers(data, {
        config,
        navState: { page: firstPage.id },
        locale: (config as { locale?: string }).locale,
      });
    } catch (err) {
      opts.onError?.('pipeline', err, shell);
      throw err;
    }
    opts.onPipelineComplete?.(snapshot);

    // Phase 7 — createCartridgeApp (synchronous since 0.11.0; gates ran in
    // phase 4). AppConfig is built from the live `currentPages` snapshot so
    // the remount path triggered by `updatePages()` carries the new page
    // graph. Initial mount + `update(delta)` remount both still consume
    // the template-derived pages via the `currentPages` initialization
    // above — single state, no drift.
    const appConfig: AppConfig<TPageType> = {
      appId: widgetId,
      pages: currentPages,
    };
    let app: App;
    try {
      app = createCartridgeApp<TData, TConfig, TPageType>(
        opts.cartridge,
        appConfig,
        snapshot,
        config,
        {
          host: renderRoot,
          events,
          enableRouter: opts.enableRouter,
          hydrate: mode === 'hydrate',
          initialNavState: navState,
          registry: opts.registry,
          // 0.7.1 — forward `hostUpdate` through to `RenderContext.update`
          // so renderers can fire config delta updates from inside listener
          // handlers without holding a separate handle to this result.
          hostUpdate,
          // 0.9.0 — the post-processor chain. PageManager owns the render
          // cadence and the teardown stack; it supplies `container` /
          // `navState` / `events`, and this closure adds the `config` and
          // `data` halves of `PostProcessorContext` that only the runtime
          // holds. Core stays ignorant of pipelines and cartridges.
          //
          // `snapshot` is captured per mount: `update()` / `updatePages()`
          // replay this whole function, so a remount rebuilds the pipeline
          // and this closure against the fresh snapshot.
          postRender: hasPostProcessors
            ? (rc) =>
                pipeline.runPostProcessors({
                  container: rc.container,
                  navState: rc.navState,
                  events: rc.events,
                  config,
                  data: snapshot,
                })
            : undefined,
        },
      );
    } catch (err) {
      opts.onError?.('mount', err, shell);
      throw err;
    }
    return { blocked: false, app, snapshot };
  }

  // === Initial mount ===
  let initialResult: InnerMount;
  try {
    initialResult = await doMountInner(opts.config, opts.initialNavState, true);
  } catch (err) {
    // Release any queued chunk recoveries — the mount they were waiting
    // on is never coming (the M-L4 corner: reject-on-blocked/failed so
    // recoveries don't strand on a never-resolving gate).
    signalMountReady(false);
    throw err;
  }

  // Sync state vars with the initial mount results BEFORE releasing the
  // recovery gate, so a queued dispatch sees the live app. A blocked mount
  // has no app and no snapshot — the gate stopped it before the data phase.
  if (!initialResult.blocked) {
    currentApp = initialResult.app;
    currentSnapshot = initialResult.snapshot;
  }
  signalMountReady(!initialResult.blocked);

  // Unified teardown. Caller gets one destroy() regardless of which branch
  // they're on; the framework knows what to clean up either way. The
  // closure reads `currentApp` so post-remount destroys tear down the
  // live app, not the original. We deliberately do NOT null `currentApp`
  // here — the App handle's own lifecycle FSM transitions to `'destroyed'`
  // on `app.destroy()` and its methods become no-ops, so leaving the ref
  // intact lets `result.app.state` still report `'destroyed'` (the
  // existing assertion contract) without the getter throwing.
  const destroy = () => {
    if (initialResult.blocked && currentApp === null) {
      // Gate UI stays — caller asked for it. Nothing extra to tear down;
      // we never created an App and the shell is the gate's canvas.
      return;
    }
    currentApp?.destroy();
    if (isolationRoot.isolated) {
      // The shadow root itself stays attached (re-attaching throws), but
      // its render contents are emptied so a re-mount starts clean.
      renderRoot.innerHTML = '';
    }
  };

  if (initialResult.blocked) {
    return {
      app: null,
      blocked: true,
      blockedBy: initialResult.blockedBy,
      shell,
      destroy,
    };
  }

  // `app` is exposed as a getter so it always reflects the live App
  // instance — after a `remount` path runs inside `update()`, the
  // internal `currentApp` is reassigned and a captured `result.app`
  // would otherwise be stale (pointing at a destroyed app). The non-null
  // assertion is safe on the unblocked branch: `currentApp` is non-null
  // after initial mount and the remount path destroys-then-reassigns
  // without a null intermediate. Destructuring (`const { app } = result`)
  // captures the value at destructure time and IS subject to the
  // staleness footgun.
  return {
    get app(): App {
      return currentApp!;
    },
    blocked: false,
    shell,
    destroy,
    update,
    updatePages,
  };
}

/**
 * Default `DataSourceInput` derivation. Most cartridges with a URL data
 * source put the feed URL at `config.feed.url`; if it's not there, the
 * caller must pass `dataSourceInput` explicitly.
 */
function deriveDefaultInput<TConfig>(config: TConfig): DataSourceInput {
  const url = (config as { feed?: { url?: string } }).feed?.url;
  if (!url) {
    throw new Error(
      '[@airo-js/runtime] mountCartridge: no `dataSourceInput` provided and `config.feed.url` is missing. Pass `dataSourceInput` explicitly or set `config.feed.url`.',
    );
  }
  return { kind: 'url', url };
}

/**
 * Walk a `Partial<TConfig>` delta to its leaf paths, used by `update()`
 * to classify each changed value against `cartridge.hotSwapKeys`.
 *
 *   leafPaths({ display: { showPrices: true } })       → ['display.showPrices']
 *   leafPaths({ display: { a: 1, b: 2 } })             → ['display.a', 'display.b']
 *   leafPaths({ theme: { primary: 'red' } })           → ['theme.primary']
 *   leafPaths({ theme: undefined })                    → ['theme']
 *
 * Arrays and primitives are leaves — we don't index into arrays for
 * path purposes, mirroring how cartridge authors think about config
 * shape (`tags: string[]` is one thing, not N things).
 *
 * Exported for tests; otherwise module-internal.
 */
export function leafPaths(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    return prefix ? [prefix] : [];
  }
  return entries.flatMap(([k, v]) =>
    leafPaths(v, prefix ? `${prefix}.${k}` : k),
  );
}

/**
 * Prefix-match for path coverage against the cartridge's hotSwap allow
 * list. A top-level entry like `'display'` covers any child path like
 * `'display.showPrices'`; an exact dot-path entry only covers itself.
 *
 *   isCovered('display.showPrices', ['display.showPrices']) → true
 *   isCovered('display.showPrices', ['display'])            → true  (top-level covers all children)
 *   isCovered('display.categoryFilter', ['display.showPrices']) → false
 *   isCovered('theme', [])                                  → false (empty allow list — full remount)
 *
 * Exported for tests; otherwise module-internal.
 */
export function isCovered(path: string, hotSwap: string[]): boolean {
  return hotSwap.some(
    (allowed) => allowed === path || path.startsWith(allowed + '.'),
  );
}

/**
 * Shallow-aware deep merge. Recurses into plain objects so nested
 * deltas don't clobber sibling fields:
 *
 *   deepMerge({ display: { a: 1, b: 2 } }, { display: { a: 9 } })
 *     → { display: { a: 9, b: 2 } }
 *
 * Arrays are replaced wholesale — merging arrays is ambiguous (index
 * align? key align? concat?) and cartridge config shapes don't need it.
 * Primitives + null are also wholesale replacements.
 *
 * Exported for tests; otherwise module-internal.
 */
export function deepMerge<T>(base: T, delta: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(delta)) {
    return delta as T;
  }
  const result: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(delta)) {
    if (isPlainObject(v) && isPlainObject(result[k])) {
      result[k] = deepMerge(result[k], v);
    } else {
      result[k] = v;
    }
  }
  return result as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Structural fields that always force a page-graph remount when they
 * differ between current and next pages. Listed here (not derived from
 * `keyof Page`) because the framework's classifier is the contract — a
 * future Page widening shouldn't silently upgrade fields into the
 * "always-remount" set.
 */
const STRUCTURAL_PAGE_KEYS = ['id', 'type', 'enabled', 'parent'] as const;
type StructuralPageKey = (typeof STRUCTURAL_PAGE_KEYS)[number];

/**
 * Decide whether a `currentPages` → `nextPages` swap can hot-swap (true)
 * or must remount (false). Hot-swap requires:
 *
 *  - Same number of pages, same id sequence (no add / remove / reorder).
 *  - Every page matched 1:1 by id with identical structural fields
 *    (`id` / `type` / `enabled` / `parent`).
 *  - Every leaf-path that differs between `current[i]` and `next[i]` on
 *    the non-structural fields (`layout` / `props` / `styles` /
 *    `componentSettings`) is covered by `allowed` via the same
 *    prefix-match rule used by `isCovered`.
 *
 * Anything else → remount with NavigationState preserved.
 *
 * Exported for tests; otherwise module-internal.
 */
export function pagesDiffIsCoveredByHotSwap<TPageType extends string>(
  current: ReadonlyArray<Page<TPageType>>,
  next: ReadonlyArray<Page<TPageType>>,
  allowed: string[],
): boolean {
  if (current.length !== next.length) return false;
  for (let i = 0; i < next.length; i++) {
    const cur = current[i];
    const nxt = next[i];
    if (!cur || !nxt) return false;
    // Same-index id match — page reorder still counts as structural
    // because the entry-page resolution + ctx.pages iteration order
    // matter for renderers that index pages positionally.
    for (const k of STRUCTURAL_PAGE_KEYS) {
      if (cur[k as StructuralPageKey] !== nxt[k as StructuralPageKey]) {
        return false;
      }
    }
    // Non-structural diff: compute leaf paths of the difference, then
    // require every one to fall under `allowed`. Any uncovered path
    // routes to remount.
    const diff = diffLeafPaths(cur, nxt, '', new Set(STRUCTURAL_PAGE_KEYS));
    if (diff.some((p) => !isCovered(p, allowed))) return false;
  }
  return true;
}

/**
 * Leaf-path diff between two values. Returns the dot-paths at which
 * `a` and `b` differ (`a` missing the key, `b` missing the key, or
 * holding different leaf values). Arrays are leaves — a structurally
 * different array reports the array's path itself, not per-index paths,
 * mirroring `leafPaths`' "arrays are leaves" rule.
 *
 * Deep-equal short-circuit: distinct references holding structurally
 * identical content return no paths. This matters for page-graph
 * comparison — a host that rebuilds `templatePages` from React state on
 * every render passes fresh references for `layout`, `componentSettings`,
 * etc., and reference-only equality would always classify those as
 * diff'd even when nothing changed.
 *
 * `skipKeys` is consulted only at the top level (`prefix === ''`), so
 * callers can exclude structural fields without leaking the exclusion
 * into nested diffs.
 *
 * Exported for tests; otherwise module-internal.
 */
export function diffLeafPaths(
  a: unknown,
  b: unknown,
  prefix = '',
  skipKeys?: ReadonlySet<string>,
): string[] {
  if (deepEqual(a, b)) return [];
  if (!isPlainObject(a) || !isPlainObject(b)) {
    return prefix ? [prefix] : [];
  }
  const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  for (const k of keys) {
    if (!prefix && skipKeys?.has(k)) continue;
    const av = (a as Record<string, unknown>)[k];
    const bv = (b as Record<string, unknown>)[k];
    out.push(...diffLeafPaths(av, bv, prefix ? `${prefix}.${k}` : k));
  }
  return out;
}

/**
 * Structural deep equality — recurses into plain objects + arrays,
 * primitives compared via `Object.is` (so `NaN === NaN`, `+0 !== -0`
 * matches the engine's semantics). Used by `diffLeafPaths` for the
 * short-circuit + by `pagesDiffIsCoveredByHotSwap` indirectly through
 * that helper. Module-internal; tests cover the deep-equal behaviour
 * via `diffLeafPaths` and `pagesDiffIsCoveredByHotSwap`.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!Object.hasOwn(b, k)) return false;
      if (
        !deepEqual(
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k],
        )
      ) {
        return false;
      }
    }
    return true;
  }
  return false;
}

