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
 *   - `mode: 'csr' | 'hydrate'`             — SSR-hydrate fork (server-rendered DOM
 *                                              already in `host`, runtime adopts
 *                                              instead of painting).
 *   - `chunkBase: string`                    — CDN URL prefix for lazy page chunks
 *                                              when the cartridge is split per page.
 *   - `MountCartridgeResult.update(opts)`    — live config / theme updates from
 *                                              studio chrome without re-mount.
 *   - async `onShellReady`                   — when a real use case (server-fetched
 *                                              theme tokens) shows up.
 *
 * None of these change v0.1's required surface — `cartridge`, `config`,
 * `template`, `host` stay the only required options.
 */

import {
  EventBus,
  setupIsolationRoot,
  createPipeline,
} from '@airo-js/core';
import type {
  App,
  AppConfig,
  IEventBus,
  IsolationRoot,
  StyleIsolation,
} from '@airo-js/core';
import type {
  Cartridge,
  CartridgeAppResult,
  DataSourceInput,
  Template,
} from '@airo-js/cartridge-kit';
import { createCartridgeApp } from '@airo-js/cartridge-kit';

/**
 * Handle exposed to `onShellReady`. Studios attach theme engines, inject
 * global styles, and register debug observers against this surface.
 */
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

/**
 * Phase identifier passed to `onError`. Lets studios render different
 * error UI per phase (e.g. retry-button on fetch failure, fatal panel on
 * shell setup failure).
 */
export type MountPhase = 'shell' | 'gate' | 'fetch' | 'pipeline' | 'mount';

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
> {
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
  /** Stable id used for theme namespacing + DOM `id` on the renderRoot. */
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
  /** Discriminated input the chosen DataSource consumes. Default: derived from `config.feed.url`. */
  dataSourceInput?: DataSourceInput;
  /** Auth/credential bag threaded into DataSource.fetch. */
  credentials?: Record<string, string>;

  /** Studio-supplied scope passed into gates (locale, country, user_id, brand_id). */
  gateScope?: Record<string, string | undefined>;

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
   * Sync at v0.1. Async support is additive when a real use case shows up.
   */
  onShellReady?: (shell: ShellHandle) => void;
  /**
   * Hook called when a phase fails. Studios use this to render
   * studio-specific error UI in the host element. Phase identifies which
   * step threw (see MountPhase). The shell may be null when 'shell'
   * itself failed.
   */
  onError?: (phase: MountPhase, err: unknown, shell: ShellHandle | null) => void;
}

/**
 * Discriminated result of a mount. The `blocked` branch fires when a
 * pre-render Gate returned 'block' — the gate's UI stays in the host
 * element and the framework paints nothing else.
 */
export type MountCartridgeResult =
  | {
      app: App;
      blocked: false;
      shell: ShellHandle;
      /** Tear down: destroys the App and clears renderRoot contents (when isolated). */
      destroy: () => void;
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
 *   1. Shell setup    — isolation root + style root + event bus.
 *   2. onShellReady   — studio attaches theme / styles / observers.
 *   3. Data           — `preloadedData` shortcut, otherwise `dataSource.fetch`.
 *   4. Pipeline       — runs the cartridge's transformer chain.
 *   5. Mount          — delegates to `createCartridgeApp` (handles gates +
 *                       appContext + renderer resolution).
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
): Promise<MountCartridgeResult> {
  const isolation: StyleIsolation = opts.styleIsolation ?? 'partial';
  const events: IEventBus = opts.events ?? new EventBus();

  // Phase 1 — shell. Pure DOM; can't fail under normal browser conditions
  // but we still wrap so onError fires consistently with the other phases.
  let isolationRoot: IsolationRoot;
  try {
    isolationRoot = setupIsolationRoot(opts.host, isolation);
  } catch (err) {
    opts.onError?.('shell', err, null);
    throw err;
  }

  const renderRoot = isolationRoot.renderRoot;
  const styleRoot: ShadowRoot | HTMLHeadElement =
    isolationRoot.styleRoot instanceof ShadowRoot
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

  // Phase 2 — data. preloadedData wins; otherwise call DataSource.fetch.
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
    const err = new Error(
      '[@airo-js/runtime] mountCartridge: template has no enabled entry page.',
    );
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

  // Phase 4 — mount via createCartridgeApp (handles gates, appContext, createApp).
  const appConfig = buildAppConfig<TConfig, TPageType>(
    opts.template,
    opts.widgetId ?? `${opts.cartridge.id}-${Date.now()}`,
  );
  let result: CartridgeAppResult;
  try {
    result = await createCartridgeApp<TData, TConfig, TPageType>(
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
    // createCartridgeApp throws when its required deps are missing or
    // when createApp itself rejects. Gates that block return a non-throwing
    // `{ blocked: true }` result — they don't land here.
    opts.onError?.('mount', err, shell);
    throw err;
  }

  // Unified teardown. Caller gets one destroy() regardless of which branch
  // they're on; the framework knows what to clean up either way.
  const destroy = () => {
    if (result.blocked) {
      // Gate UI stays — caller asked for it. Nothing extra to tear down;
      // we never created an App and the shell is the gate's canvas.
      return;
    }
    result.app.destroy();
    if (isolationRoot.isolated) {
      // The shadow root itself stays attached (re-attaching throws), but
      // its render contents are emptied so a re-mount starts clean.
      renderRoot.innerHTML = '';
    }
  };

  if (result.blocked) {
    return {
      app: null,
      blocked: true,
      blockedBy: result.blockedBy,
      shell,
      destroy,
    };
  }
  return { app: result.app, blocked: false, shell, destroy };
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
 * Build `AppConfig` from a template's pages. The template's page entries
 * are a subset of `Page<T>` (id / type / enabled / parent only); the
 * runtime fills in an empty layout because cartridge-kit's `Template`
 * type doesn't carry the layout shape — page renderers paint into
 * `RenderContext.targetEl` directly. Cartridges that use the region/slot
 * system populate `Page.layout` on their template entries via a richer
 * downstream type.
 */
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
      layout: { regionOrder: [], regions: {} },
    })),
  };
}
