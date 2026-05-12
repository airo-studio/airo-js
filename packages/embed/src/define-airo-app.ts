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

import type { Cartridge } from '@airo-js/cartridge-kit';
import type { StyleIsolation } from '@airo-js/core';
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
}

/**
 * Phase identifier passed to `onError`. Lets host apps render different
 * error UI per phase (retry on transient `load-config`, fatal on
 * `resolve-cartridge`, fall through on `fetch-ssr`).
 */
export type EmbedPhase = 'load-config' | 'resolve-cartridge' | 'fetch-ssr' | 'mount';

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
   * that fits their brand: `<dotter-app>`, `<commerce-widget>`, etc. Custom
   * element names must contain a hyphen per the spec.
   */
  elementName?: string;
  /**
   * Attribute name carrying the widget id. Default: 'airo-id'. Customer
   * pastes `<airo-app airo-id="dw_abc123">` to mount.
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
   * Optional SSR-hydrate path. When implemented AND `loadConfig` didn't
   * already return `ssrHtml`, embed calls this to fetch the SSR HTML.
   * Errors fall through to CSR — SSR is opportunistic.
   */
  fetchSsrHtml?: (id: string, token: string | null) => Promise<string | null>;

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
 * trigger teardown. Mirrors the destroy-only subset of MountCartridgeResult
 * so we don't take a structural dep on the runtime types at compile time
 * (the runtime is dynamic-imported).
 */
interface MountHandle {
  destroy: () => void;
}

const REGISTERED_ELEMENTS = new Set<string>();

/**
 * Register the custom element. Idempotent — calling twice with the same
 * `elementName` warns and no-ops; different element names can coexist
 * (one bundle may register both `<dotter-app>` and `<airo-app>` during
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

      // Phase 3 — SSR HTML resolution. Three sources, in priority order:
      //   1. `airo-ssr="hydrate"` attribute + non-empty innerHTML —
      //      host-server-rendered Campaign Page flow. Use existing
      //      markup; no fetchSsrHtml round-trip; no repaint.
      //   2. `loadConfig` returned `ssrHtml` — studio API embedded it
      //      in the load response.
      //   3. `fetchSsrHtml` hook — opportunistic out-of-band fetch.
      // Errors in source 3 fall through to CSR (SSR is opportunistic).
      const ssrMode = this.getAttribute(ssrModeAttribute);
      const hostInjected = ssrMode === 'hydrate' && this.innerHTML.trim() !== '';
      let ssrHtml: string | null = null;
      if (hostInjected) {
        ssrHtml = this.innerHTML;
      } else {
        ssrHtml = loaded.ssrHtml ?? null;
        if (!ssrHtml && opts.fetchSsrHtml) {
          try {
            ssrHtml = await opts.fetchSsrHtml(id, token);
          } catch (err) {
            emitError(opts, 'fetch-ssr', err, this);
            // Intentional fall-through — SSR is opportunistic.
          }
          if (this.disposed) return;
        }
      }

      // Phase 4 — pick template.
      const templateId = loaded.templateId ?? cartridge.defaultTemplateId;
      const template = cartridge.templates.find((t) => t.id === templateId);
      if (!template) {
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

      // Phase 5 — paint SSR HTML into the host before mount. The runtime
      // (mode: 'hydrate' below) preserves it inside the shadow wrapper and
      // hands off to renderer.hydrate() instead of renderer.render().
      // Skip the assignment when the host already injected the markup
      // (re-assigning innerHTML to itself wipes user-attached listeners
      // and burns a parser round-trip for no gain).
      const hydrating = Boolean(ssrHtml);
      if (ssrHtml && !hostInjected) {
        this.innerHTML = ssrHtml;
      }

      // Phase 6 — lazy-import the runtime. Bundle budget protected by
      // never statically importing — esbuild + tsc treat dynamic import
      // as a chunk boundary.
      let mountCartridge: typeof import('@airo-js/runtime').mountCartridge;
      try {
        ({ mountCartridge } = await import('@airo-js/runtime'));
      } catch (err) {
        emitError(opts, 'mount', err, this);
        return;
      }
      if (this.disposed) return;

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
          cartridge,
          config: loaded.config,
          template,
          host: this,
          styleIsolation: loaded.styleIsolation,
          widgetId: id,
          preloadedData: loaded.preloadedData,
          mode: hydrating ? 'hydrate' : 'csr',
        });
        if (this.disposed) {
          // Element disconnected mid-mount — tear down what we just built.
          result.destroy();
          return;
        }
        this.mount = result;
        if (!result.blocked) {
          opts.onMounted?.(id, this);
        }
      } catch (err) {
        emitError(opts, 'mount', err, this);
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
  }

  customElements.define(elementName, AiroAppElement);
  REGISTERED_ELEMENTS.add(elementName);
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
