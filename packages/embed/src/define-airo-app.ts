/**
 * defineAiroApp — register a custom element that mounts an Airo cartridge.
 *
 * The smallest possible host-page surface: a customer pastes
 * `<airo-app airo-id="…">` into their HTML, the embed bundle handles
 * everything else. The host app supplies hooks for the parts that are
 * inherently studio-specific:
 *
 *   - `loadConfig`       — hit your studio backend, return widget config
 *   - `resolveCartridge` — dynamic-import your cartridge module
 *   - `fetchSsrHtml`     — optional SSR-hydrate path
 *   - `onError`          — render studio-branded error UI
 *   - `onMounted`        — observability anchor
 *
 * Everything else (custom-element registration, lifecycle, runtime
 * lazy-load, mount handoff) is generic and lives here. M13 line: embed
 * owns generic orchestration; host apps own auth, fetch, and cartridge
 * resolution.
 *
 * Bundle budget: ~5 KB minified / ~2.5 KB gzip. The runtime is lazy-
 * imported via `await import('@airo-js/runtime')` so customer pages with
 * many widgets pay the runtime cost once, and pages that never reach a
 * mount path don't pay it at all.
 *
 * SSR-hydrate path: when `loadConfig` returns `ssrHtml` (or `fetchSsrHtml`
 * does), embed paints it into the host element AND passes `mode: 'hydrate'`
 * to `mountCartridge`. With runtime v0.2+, the runtime preserves the SSR
 * markup inside the shadow wrapper and the active page renderer's
 * `hydrate()` runs in place of `render()` — wiring listeners without
 * repainting. With runtime v0.1, the `mode` option is silently ignored
 * and `ssrHtml` becomes a paint skeleton (overwritten by a fresh CSR
 * mount). The peerDep range is `^0.1.0 || ^0.2.0`; both work, hydrate
 * fidelity scales with the runtime version.
 *
 * Cartridges whose views don't implement `hydrate()` fall back to
 * `render()` even on runtime v0.2 (with a `[@airo-js/core]` warning); the
 * SSR markup gets repainted client-side.
 */

import { logger } from '@airo-js/log';

import type { Cartridge, TemplatePage } from '@airo-js/cartridge-kit';
import type {
  IEventBus,
  NavigationState,
  RouterOption,
  StyleIsolation,
} from '@airo-js/core';
import { extractPathTail } from '@airo-js/core';
import type { SharedLifecycleHooks } from '@airo-js/runtime';

const log = logger('embed');

/**
 * Result the host app's `loadConfig` returns. Carries the cartridge id
 * (for `resolveCartridge`), the cartridge-shaped config, plus optional
 * runtime metadata (CDN base, version pin, SSR HTML, preloaded data).
 */
export interface LoadConfigResult<TConfig = unknown> {
  /** Cartridge config — shape declared by the cartridge's TConfig. */
  config: TConfig;
  /** Cartridge id — passed to `resolveCartridge` to load the cartridge module. */
  cartridgeId: string;
  /** Template id picked for this widget. Defaults to `cartridge.defaultTemplateId`. */
  templateId?: string;
  /** Style isolation strategy. Default: 'shadow'. */
  styleIsolation?: StyleIsolation;
  /**
   * URL routing strategy. When supplied, embed reads the appropriate
   * URL surface (hash for `mode: 'hash'`; path tail under `basePath`
   * for `mode: 'path'`) BEFORE calling `fetchSsrHtml`, and forwards
   * the extracted fragment as the third argument (`navHint`) so the
   * SSR endpoint can render the deeplink target directly — no flash.
   * The runtime uses the same option to instantiate the matching
   * router after mount. See `RouterOption` in `@airo-js/core`.
   */
  enableRouter?: RouterOption;
  /** CDN base URL for runtime + chunk loading (forward-compat for v0.2 chunk loader). */
  runtimeBase?: string;
  /** Pinned runtime version. e.g. '0.1.0' (forward-compat for v0.2 chunk loader). */
  runtimeVersion?: string;
  /**
   * Optional pre-rendered HTML for the SSR-hydrate path. v0.1 paints this
   * as a load skeleton (see file-level note); runtime v0.2 will hydrate
   * over it.
   */
  ssrHtml?: string;
  /** Optional preloaded data — skips `dataSource.fetch` in mountCartridge. */
  preloadedData?: unknown;
  /**
   * Mount-time navigation state. Threaded through to `mountCartridge` →
   * `createApp` → `PageManager` so the active page + ctx.navState resolve
   * from URL-decoded or host-supplied state at construction time.
   *
   * When `enableRouter` is set, the framework's HashRouter / PathRouter
   * auto-derives navigation state from `window.location` synchronously
   * during PageManager construction — `initialNavState` is the explicit
   * hand-off for host-page programmatic state (e.g. customer-page commerce
   * popup that pre-selects a product:
   *
   *   loadConfig: async (id) => ({
   *     cartridgeId: 'commerce',
   *     config: { ... },
   *     initialNavState: { page: 'product', productId: chosenProduct },
   *   })
   *
   * Server-side SSR pairing (`renderAppWithPublication`) uses the same
   * type — host endpoint decodes URL or its own session state into
   * `initialNavState`, framework respects it identically on both sides.
   *
   * Contract: derivable on BOTH server and client from the same inputs.
   * Never serialised into SSR HTML.
   */
  initialNavState?: Partial<NavigationState>;
  /**
   * Per-widget page graph override (0.7.3+). When supplied, replaces
   * `cartridge.templates[templateId].pages` for this mount only.
   *
   * Use case: host applications that let customers customize the page
   * graph (add / remove / reorder / enable / disable pages) persist
   * those edits per-widget. Without this hook the customer's edits are
   * invisible to the framework — the cartridge's static default wins,
   * and customer-edit-then-hydrate diverges from SSR HTML painted
   * against the actual graph (dead clicks because the renderer queries
   * the wrong DOM).
   *
   * **Named field, not `pages`** — `pages` collides with
   * `loaded.config.pages` (cartridge config layer). `templatePages`
   * is the template layer, distinct from config.
   *
   * **Shared `TemplatePage` type** — re-exported from
   * `@airo-js/cartridge-kit` so the wire shape matches `Template.pages`
   * exactly. When that type grows, both sides update in lockstep.
   *
   * **Host validation responsibility** — the host MUST validate the
   * graph before returning it: no duplicate ids, no orphan subpages
   * (every `parent` must resolve to a non-subpage page), at least one
   * enabled non-subpage page (else mount errors late at `findEntryPage`),
   * `type` values that match a registered `ViewDefinition.pageType`.
   * The framework only catches missing-entry-page; everything else
   * surfaces as navigation bugs at click time. This is non-feature by
   * design — embed shouldn't re-walk a graph the host just composed.
   *
   * **Mount-time only** — `templatePages` is read once on mount.
   * Post-mount page-graph changes go through `el.updatePages(nextPages)`
   * (0.8.0+), which hot-swaps when the diff is covered by
   * `cartridge.pageHotSwapKeys` and otherwise remounts with
   * NavigationState preserved. `el.update(delta)` remains scoped to
   * cartridge config (`Partial<TConfig>`) — the two delta channels are
   * independent.
   */
  templatePages?: ReadonlyArray<TemplatePage>;
}

/**
 * Phase identifier passed to `onError`. Lets host apps render different
 * error UI per phase (retry on transient `load-config`, fatal on
 * `resolve-cartridge`, fall through on `fetch-ssr`).
 */
export type EmbedPhase =
  | 'load-config'
  | 'resolve-cartridge'
  | 'fetch-ssr'
  | 'resolve-view'
  | 'mount';

/**
 * `DefineAiroAppOptions` extends `SharedLifecycleHooks` so that every
 * lifecycle seam `mountCartridge` accepts is automatically surfaced on
 * the embed facade with identical semantics. Adding a new hook to
 * `SharedLifecycleHooks` in `@airo-js/runtime` automatically appears
 * here AND fails the mapped-type forwarding inside `connectedCallback`
 * until it's wired through — no silent drift.
 */
export interface DefineAiroAppOptions extends SharedLifecycleHooks {
  /**
   * Custom element tag name. Default: 'airo-app'. Host apps pick a name
   * that fits their brand: `<shop-app>`, `<commerce-widget>`, etc. Custom
   * element names must contain a hyphen per the spec.
   */
  elementName?: string;
  /**
   * Attribute name carrying the widget id. Default: 'airo-id'. Customer
   * pastes `<airo-app airo-id="app_abc123">` to mount.
   */
  idAttribute?: string;
  /**
   * Attribute name carrying the auth token. Default: 'airo-token'.
   * Optional per element — same-origin previews typically skip the token.
   */
  tokenAttribute?: string;

  /**
   * Attribute name carrying the SSR mode signal. Default: 'airo-ssr'.
   *
   * When the attribute value is `'hydrate'` AND the element has
   * non-empty `innerHTML` at connectedCallback time, embed treats the
   * existing markup as host-server-rendered SSR HTML — skips
   * `fetchSsrHtml` (no round-trip), preserves the innerHTML, and
   * mounts in hydrate mode. This is the Campaign Page flow: the
   * customer's server already rendered the widget into the element
   * before the page shipped.
   *
   * Without `airo-ssr="hydrate"`, embed ignores existing innerHTML
   * (preserving the v0.4.1 behaviour where a loading skeleton inside
   * the element gets overwritten on mount).
   */
  ssrModeAttribute?: string;

  /**
   * Fetch widget config from the host app's studio backend. Called once
   * per element mount with the id + (optional) token attribute values.
   * Host app handles auth headers, allowed-domain checks, LoadResponse
   * envelope unwrapping — embed only sees the result.
   */
  loadConfig: (
    id: string,
    token: string | null,
  ) => Promise<LoadConfigResult>;

  /**
   * Resolve a cartridge by id. Host app typically dynamic-imports the
   * cartridge module here — keeps the embed bundle tiny because cartridge
   * code only loads when an element with that id renders:
   *
   *   resolveCartridge: async (id) => {
   *     if (id === 'commerce') return (await import('@my-org/commerce-cartridge')).commerceCartridge;
   *     throw new Error(`unknown cartridge: ${id}`);
   *   }
   */
  resolveCartridge: (id: string) => Promise<Cartridge<unknown, unknown>>;

  /**
   * Optional per-page chunk loader. Called when the active page's
   * renderer factory isn't loaded yet — the core `PageManager` emits
   * `'renderer:missing'` and embed routes it here so the host can load
   * the chunk that owns `pageType`.
   *
   * Contract (locked 0.2.0):
   *   - Return a `Promise<void>` that resolves AFTER the chunk has
   *     registered its factory to the cartridge mailbox (`pushToMailbox`).
   *     embed re-resolves through the registry once the promise settles;
   *     the resolved value is discarded.
   *   - **Transport-agnostic.** embed never assumes ESM module semantics.
   *     The body may be a dynamic `import()`, a `<script>`-tag injection
   *     with SRI, an import-map load, or a no-op for an already-inlined
   *     chunk. The only contract is "resolves when the factory is in the
   *     mailbox."
   *   - `cartridgeId` is always the resolved `cartridge.id` (the key the
   *     chunk registry is keyed on) — reconstruct your transport/manifest
   *     key from `(cartridgeId, pageType)` as needed.
   *   - embed singleflights calls per `(cartridgeId, pageType)` with
   *     delete-on-reject, so this hook need not dedupe: concurrent misses
   *     for the same view collapse to one call; a rejected load retries
   *     on the next miss.
   *
   * Without this hook, a missing renderer soft-fails (no paint) and emits
   * `'renderer:missing'` for host-wired observability only — the same
   * pre-0.2.0 behaviour. See best-practices.md §2.5b.
   *
   *   resolveView: (cartridgeId, pageType) =>
   *     import(`https://cdn.example/${cartridgeId}/${pageType}.js`),
   */
  resolveView?: (cartridgeId: string, pageType: string) => Promise<void>;

  /**
   * Optional SSR-hydrate path. When implemented AND `loadConfig` didn't
   * already return `ssrHtml`, embed calls this to fetch the SSR HTML.
   * Errors fall through to CSR — SSR is opportunistic.
   *
   * `navHint` (3rd parameter, added in 0.5.0) carries the URL fragment
   * embed extracted from `window.location` based on the configured
   * `enableRouter` mode:
   *   - hash mode → `window.location.hash.slice(1)` (without the `#`)
   *   - path mode → path tail under `basePath` (e.g. `'products/abc'`)
   *   - no router → `null`
   * The host endpoint can pass the hint to
   * `decodeNavHint(navHint, validPages)` from `@airo-js/core` and
   * forward as `entryPageId` to `renderAppWithPublication` — server
   * SSRs the deeplinked target directly, no flash.
   *
   * Back-compat: callbacks that take only two parameters keep working
   * (JS ignores extra args).
   */
  fetchSsrHtml?: (
    id: string,
    token: string | null,
    navHint: string | null,
  ) => Promise<string | null>;

  /**
   * Hook called when mount fails at any phase. Host app supplies the
   * studio-branded error UI in `host`. Without this hook, embed logs to
   * console.error and leaves the host element empty.
   */
  onError?: (phase: EmbedPhase, err: unknown, host: HTMLElement) => void;

  /**
   * Hook called once per successful mount. Host app emits to its own
   * telemetry from here.
   */
  onMounted?: (id: string, host: HTMLElement) => void;
}

/**
 * Mount handle the custom element keeps internally so disconnect can
 * trigger teardown and `el.update(delta)` can forward to the runtime.
 * Mirrors the `destroy` + `update` subset of MountCartridgeResult's
 * unblocked branch so we don't take a structural dep on the runtime
 * types at compile time (the runtime is dynamic-imported).
 *
 * `update` is optional because the runtime returns a `blocked` branch
 * without it when a pre-render gate intercepts the mount.
 */
interface MountHandle {
  destroy: () => void;
  update?: (delta: unknown) => Promise<{ mode: 'hot-swap' | 'remount'; navState: unknown }>;
  updatePages?: (
    nextPages: ReadonlyArray<TemplatePage>,
  ) => Promise<{ mode: 'hot-swap' | 'remount'; navState: unknown }>;
  /**
   * Live App handle — structural subset used by the chunk-recovery
   * dispatch (`resolveView`). `navigate` repaints (CSR miss); `hydratePage`
   * re-runs hydrate in place against the SSR DOM (hydrate miss). Optional
   * because the gate-blocked mount branch may not expose an app.
   */
  app?: {
    hydratePage: (pageId: string) => void;
    navigate: (state: Partial<NavigationState>) => void;
  };
}

const REGISTERED_ELEMENTS = new Set<string>();

/**
 * Register the custom element. Idempotent — calling twice with the same
 * `elementName` warns and no-ops; different element names can coexist
 * (one bundle may register both `<shop-app>` and `<airo-app>` during
 * a v1 → cartridge transition).
 *
 * Server-safe: when `customElements` is undefined (SSR / old runtimes)
 * the call returns without error so host apps can register at module
 * load time without guarding.
 */
export function defineAiroApp(opts: DefineAiroAppOptions): void {
  const elementName = opts.elementName ?? 'airo-app';
  const idAttribute = opts.idAttribute ?? 'airo-id';
  const tokenAttribute = opts.tokenAttribute ?? 'airo-token';
  const ssrModeAttribute = opts.ssrModeAttribute ?? 'airo-ssr';

  if (typeof customElements === 'undefined') return;

  if (REGISTERED_ELEMENTS.has(elementName)) {
    log.warn(`'${elementName}' already registered; skipping.`, { elementName });
    return;
  }

  class AiroAppElement extends HTMLElement {
    private mount: MountHandle | null = null;
    private disposed = false;

    async connectedCallback(): Promise<void> {
      // Reset `disposed` so reconnections (element removed and reinserted)
      // can complete a fresh mount. Without this, the prior
      // `disconnectedCallback()` latch leaves disposed=true forever and
      // every post-async-phase check below short-circuits silently — the
      // element appears mounted in DOM but no renderer is wired.
      this.disposed = false;
      const id = this.getAttribute(idAttribute);
      if (!id) {
        log.error(`<${elementName}> is missing required attribute '${idAttribute}'.`, undefined, {
          elementName,
          idAttribute,
        });
        return;
      }
      const token = this.getAttribute(tokenAttribute);

      // Phase 1 — host-app config fetch.
      let loaded: LoadConfigResult;
      try {
        loaded = await opts.loadConfig(id, token);
      } catch (err) {
        emitError(opts, 'load-config', err, this);
        return;
      }
      if (this.disposed) return;

      // Phase 2 — host-app cartridge resolution.
      let cartridge: Cartridge<unknown, unknown>;
      try {
        cartridge = await opts.resolveCartridge(loaded.cartridgeId);
      } catch (err) {
        emitError(opts, 'resolve-cartridge', err, this);
        return;
      }
      if (this.disposed) return;

      // Phase 3 — SSR HTML resolution. Four sources, in priority order:
      //   1. Declarative Shadow DOM — `this.shadowRoot` is non-null
      //      because the browser parsed `<template shadowrootmode>`
      //      during initial HTML parse. Zero-FOUC: shadow content + CSS
      //      are already in place. No fetch, no light-DOM lift. The
      //      runtime detects the same condition and adopts the existing
      //      shadow at mount time.
      //   2. `airo-ssr="hydrate"` attribute + non-empty innerHTML —
      //      host-server-rendered Campaign Page flow with light DOM.
      //      Use existing markup; no fetchSsrHtml round-trip; no repaint.
      //   3. `loadConfig` returned `ssrHtml` — studio API embedded it
      //      in the load response.
      //   4. `fetchSsrHtml` hook — opportunistic out-of-band fetch.
      // Errors in source 4 fall through to CSR (SSR is opportunistic).
      const hasDeclarativeShadow = this.shadowRoot !== null;
      const ssrMode = this.getAttribute(ssrModeAttribute);
      const hostInjected = ssrMode === 'hydrate' && this.innerHTML.trim() !== '';
      // navHint — extracted from window.location based on the
      // configured router mode. Forwarded as 3rd arg to fetchSsrHtml
      // so the SSR endpoint can deeplink directly to the target page.
      // Hash precedence rule: in path mode, a trailing `#anchor` is
      // treated as a normal page anchor, NOT as a route override —
      // the path is the route source of truth.
      const navHint = extractNavHint(loaded.enableRouter);
      let ssrHtml: string | null = null;
      if (hasDeclarativeShadow) {
        // DSD present — shadow content already in DOM; nothing to fetch,
        // nothing to paint. Runtime adopts the shadow root in hydrate mode.
      } else if (hostInjected) {
        ssrHtml = this.innerHTML;
      } else {
        ssrHtml = loaded.ssrHtml ?? null;
        if (!ssrHtml && opts.fetchSsrHtml) {
          try {
            ssrHtml = await opts.fetchSsrHtml(id, token, navHint);
          } catch (err) {
            emitError(opts, 'fetch-ssr', err, this);
            // Intentional fall-through — SSR is opportunistic.
          }
          if (this.disposed) return;
        }
      }

      // Phase 4 — pick template.
      const templateId = loaded.templateId ?? cartridge.defaultTemplateId;
      const baseTemplate = cartridge.templates.find((t) => t.id === templateId);
      if (!baseTemplate) {
        emitError(
          opts,
          'mount',
          new Error(
            `[@airo-js/embed] cartridge '${cartridge.id}' has no template '${templateId}'.`,
          ),
          this,
        );
        return;
      }
      // Per-widget page graph override (0.7.3). When the host supplies
      // `templatePages` in `loadConfig`, replace the cartridge template's
      // static pages with the customer's customized graph. Deep-clone the
      // entries (not just the array) so host-side mutation after
      // `loadConfig` resolves cannot corrupt the runtime's view of the
      // template — runtime closes over `opts.template` for remount paths
      // and reading mutated objects would silently drift on the next
      // `update(delta)` that triggers a remount.
      const template = loaded.templatePages
        ? {
            ...baseTemplate,
            pages: loaded.templatePages.map((p) => ({ ...p })),
          }
        : baseTemplate;

      // Phase 5 — paint SSR HTML into the host before mount. The runtime
      // (mode: 'hydrate' below) preserves it inside the shadow wrapper and
      // hands off to renderer.hydrate() instead of renderer.render().
      // Skip the assignment when the host already injected the markup
      // (re-assigning innerHTML to itself wipes user-attached listeners
      // and burns a parser round-trip for no gain) or when a declarative
      // shadow root is already attached (its content lives in the shadow,
      // not in innerHTML — runtime adopts it directly).
      const hydrating = hasDeclarativeShadow || Boolean(ssrHtml);
      if (ssrHtml && !hostInjected && !hasDeclarativeShadow) {
        this.innerHTML = ssrHtml;
      }

      // Phase 6 — lazy-import the runtime. Bundle budget protected by
      // never statically importing — esbuild + tsc treat dynamic import
      // as a chunk boundary.
      let mountCartridge: typeof import('@airo-js/runtime').mountCartridge;
      let EventBus: typeof import('@airo-js/runtime').EventBus;
      try {
        ({ mountCartridge, EventBus } = await import('@airo-js/runtime'));
      } catch (err) {
        emitError(opts, 'mount', err, this);
        return;
      }
      if (this.disposed) return;

      // Phase 6.5 — chunk-recovery wiring. Only when the host supplies
      // `resolveView`. embed owns two things generically here that every
      // chunked-client host would otherwise hand-roll (best-practices §2.5b):
      //   1. Singleflight per (cartridge.id, pageType) with delete-on-reject
      //      — concurrent misses collapse to one load; a failed load retries.
      //   2. The hydrate-vs-navigate dispatch — getting this wrong wipes the
      //      SSR DOM, so it must not be left to each host.
      // The subscription MUST land before mountCartridge runs: the phase-5
      // hydrate emission fires DURING mount, so a post-await `result.app`
      // subscriber would miss it. We reuse the host's bus if they passed one
      // (so their own observability subscribers still see the event), else
      // construct one and hand it to the runtime.
      // Resolves with the live App handle once Phase 7 finishes mounting
      // (or `undefined` if the mount fails / the element is disposed). The
      // recovery handler awaits this before dispatching: the CSR-navigate
      // and SSR-hydrate misses both emit DURING mount, before `this.mount`
      // is set — and `resolveView` can settle on a microtask (a preloaded
      // or cached chunk), so we cannot assume the mount finished by the time
      // the chunk did. Gating on this deferred removes the race.
      let signalMounted: (app: MountHandle['app']) => void = () => {};
      let events = opts.events;
      if (opts.resolveView) {
        const resolveView = opts.resolveView;
        const mounted = new Promise<MountHandle['app']>((res) => {
          signalMounted = res;
        });
        // Reuse the host's bus if they passed one; else construct one from
        // `EventBus` pulled off the runtime module dynamic-imported above
        // (Phase 6) — NOT a static `@airo-js/core` import, which would
        // inflate the embed entry bundle past its size budget. The runtime
        // chunk already carries EventBus, so this costs the entry zero bytes.
        const bus: IEventBus = opts.events ?? new EventBus();
        events = bus;
        const inflight = new Map<string, Promise<void>>();
        // Bus payloads are typed `unknown` (the bus is string-keyed); this
        // is the documented `'renderer:missing'` shape from PageManager.
        bus.on('renderer:missing', async (payload: unknown) => {
          const { pageType, pageId, phase } = payload as {
            pageType: string;
            pageId: string;
            phase: 'navigate' | 'hydrate';
          };
          // No disposed guard here — the post-`await mounted` check below
          // gates every DOM mutation; a stray resolveView on a disposed
          // element is harmless and singleflighted.
          const key = `${cartridge.id} ${pageType}`;
          let load = inflight.get(key);
          if (!load) {
            // Keep the promise on success (chunk stays loaded — repeat
            // misses are free); evict on reject so the next miss reloads.
            // Same shape as a host-side asset-loader singleflight.
            load = resolveView(cartridge.id, pageType);
            inflight.set(key, load);
            load.catch(() => inflight.delete(key));
          }
          try {
            await load;
          } catch (err) {
            emitError(opts, 'resolve-view', err, this);
            return;
          }
          // Wait for the mount to finish so `app` is live regardless of
          // whether the chunk resolved before or after mountCartridge
          // returned. hydrate miss keeps the SSR DOM in place; navigate
          // miss repaints from scratch (CSR — no SSR markup to preserve).
          const app = await mounted;
          if (!app || this.disposed) return;
          if (phase === 'hydrate') app.hydratePage(pageId);
          else app.navigate({ page: pageId });
        });
      }

      // Phase 7 — mount.
      //
      // Type-level forwarding enforcement: `sharedHooks` is typed as a
      // mapped type with every key in `SharedLifecycleHooks` REQUIRED in
      // the object literal (Required<>) but values keep the original
      // optional-or-not type. Adding a new hook to `SharedLifecycleHooks`
      // fails compilation here until the corresponding `opts.<hook>`
      // forwarding line is added. Matches the invariant in CLAUDE.md §5
      // — the embed facade mirrors every lifecycle hook `mountCartridge`
      // accepts, with identical semantics.
      const sharedHooks: { [K in keyof Required<SharedLifecycleHooks>]: SharedLifecycleHooks[K] } = {
        events: opts.events,
        onShellReady: opts.onShellReady,
      };
      try {
        const result = await mountCartridge({
          ...sharedHooks,
          events,
          cartridge,
          config: loaded.config,
          template,
          host: this,
          styleIsolation: loaded.styleIsolation,
          enableRouter: loaded.enableRouter,
          widgetId: id,
          preloadedData: loaded.preloadedData,
          initialNavState: loaded.initialNavState,
          mode: hydrating ? 'hydrate' : 'csr',
        });
        if (this.disposed) {
          // Element disconnected mid-mount — tear down what we just built.
          result.destroy();
          signalMounted(undefined);
          return;
        }
        // Structural cast: at the embed boundary TConfig is type-erased.
        // The runtime's `update(delta: Partial<TConfig>)` is correctly typed
        // for direct mountCartridge callers; the custom-element forwarding
        // path widens to `unknown` because attribute-driven mounts can't
        // express TConfig at compile time.
        this.mount = result as unknown as MountHandle;
        // Release any chunk-recovery handler waiting on the live App handle
        // (no-op when `resolveView` isn't wired). Must fire AFTER `this.mount`
        // is set so a pending `renderer:missing` recovery sees the handle.
        signalMounted(this.mount.app);
        if (!result.blocked) {
          opts.onMounted?.(id, this);
        }
      } catch (err) {
        emitError(opts, 'mount', err, this);
        signalMounted(undefined);
      }
    }

    disconnectedCallback(): void {
      this.disposed = true;
      if (this.mount) {
        try {
          this.mount.destroy();
        } catch (err) {
          log.error('destroy threw', err);
        }
        this.mount = null;
      }
    }

    /**
     * Live config delta — forwards to the runtime's
     * `MountCartridgeResult.update()` when the element is mounted and
     * not gate-blocked. Resolves with `{ mode, navState }` reporting
     * whether the runtime hot-swapped in place or triggered a full
     * remount. Resolves with `null` when called against a never-mounted,
     * gate-blocked, or already-disconnected element — symmetric with
     * the runtime's "no update on blocked" contract; callers can branch
     * on the null without try/catch.
     *
     * Throws (propagated from the runtime) when a remount triggered by
     * the delta hits a gate that returns `'block'`.
     */
    async update(
      delta: unknown,
    ): Promise<{ mode: 'hot-swap' | 'remount'; navState: unknown } | null> {
      if (this.disposed || !this.mount || !this.mount.update) return null;
      return this.mount.update(delta);
    }

    /**
     * Live page-graph delta (0.8.0) — forwards to the runtime's
     * `MountCartridgeResult.updatePages()`. Replaces `AppConfig.pages`
     * with `nextPages` and hot-swaps (re-render the active page in
     * place) when the diff is covered by `cartridge.pageHotSwapKeys`,
     * otherwise remounts with NavigationState preserved. Resolves with
     * `null` under the same conditions as `update()` (never-mounted,
     * gate-blocked, disconnected).
     */
    async updatePages(
      nextPages: ReadonlyArray<unknown>,
    ): Promise<{ mode: 'hot-swap' | 'remount'; navState: unknown } | null> {
      if (this.disposed || !this.mount || !this.mount.updatePages) return null;
      return this.mount.updatePages(
        nextPages as ReadonlyArray<TemplatePage>,
      );
    }
  }

  customElements.define(elementName, AiroAppElement);
  REGISTERED_ELEMENTS.add(elementName);
}

/**
 * Extract a navigation hint from the current URL based on the
 * configured router mode. Forwarded as the 3rd arg to `fetchSsrHtml`
 * so the SSR endpoint can deeplink directly to the target page —
 * closes the zero-flash deep-link gap for the customer-embed flow.
 *
 * Behaviour by router mode:
 *
 *   - `false`  / undefined   → null (no router; no deeplinks).
 *   - `true`                 → back-compat alias for `{ mode: 'hash' }`.
 *   - `{ mode: 'hash' }`     → window.location.hash without the `#`,
 *                              or null when the hash is empty/missing.
 *   - `{ mode: 'path' }`     → path tail under `basePath` via
 *                              `extractPathTail`, or null when the
 *                              current URL doesn't belong to basePath
 *                              (boundary check rejects e.g.
 *                              `/campaign/xyzabc` when basePath is
 *                              `/campaign/xyz`).
 *
 * Hash-while-path-active: path mode does NOT read the hash. Any
 * trailing `#anchor` on a path-mode URL is treated as a normal page
 * anchor; the path is the sole route source of truth. Documented in
 * best-practices §5.10.
 */
function extractNavHint(routerOpt: RouterOption | undefined): string | null {
  if (!routerOpt) return null;
  if (routerOpt === true) return readHashFragment();
  if (routerOpt.mode === 'hash') return readHashFragment();
  if (routerOpt.mode === 'path') {
    const tail = extractPathTail(window.location.pathname, routerOpt.basePath);
    if (tail == null) return null;
    // Concatenate search so query-string state survives the navHint
    // round-trip (matches PathRouter's parseCurrent — server-side
    // decode and client-side router see the same fragment shape).
    return tail + window.location.search;
  }
  return null;
}

function readHashFragment(): string | null {
  const h = window.location.hash;
  return h.length > 1 ? h.slice(1) : null;
}

/**
 * Default error path — calls the host app's `onError` if provided, falls
 * back to console.error otherwise. Centralized so the connectedCallback
 * never silently swallows a phase error.
 */
function emitError(
  opts: DefineAiroAppOptions,
  phase: EmbedPhase,
  err: unknown,
  host: HTMLElement,
): void {
  if (opts.onError) {
    try {
      opts.onError(phase, err, host);
    } catch (hookErr) {
      log.error('onError hook itself threw', hookErr);
    }
    return;
  }
  log.error(`${phase} failed`, err, { phase });
}

/**
 * Test-only escape hatch — clears the registered-elements memo so a
 * single test process can call defineAiroApp many times with the same
 * element name without the idempotency warning. NOT exported from the
 * package barrel; tests import directly from this file.
 */
export function __resetRegisteredElementsForTesting(): void {
  REGISTERED_ELEMENTS.clear();
}
