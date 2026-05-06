/**
 * Gate — pre-render guard primitive.
 *
 * Runs BEFORE any view paints. Used for content-visibility decisions that
 * gate the entire widget — age verification, geo restriction, auth check,
 * paywall, cookie consent, country selector, maintenance mode.
 *
 * Why a primitive (not a Transformer / PostProcessor / View): a Transformer
 * has no DOM access; a PostProcessor runs after views render — too late;
 * a View implies a route in the navigation graph — gates conceptually sit
 * outside it (they apply to ALL pages, not a specific one).
 *
 * Two-phase contract:
 *
 *   1. **`precheck(ctx) → 'allow' | 'gate-required'`** — optional fast path.
 *      Reads pre-existing state (cookie, localStorage, IP-based geo,
 *      auth-token verification call) and short-circuits the visible UI when
 *      the user is already cleared. Async because real precheck work may
 *      hit external APIs (token verify, geo lookup).
 *
 *   2. **`mount(host, ctx) → 'allow' | 'block'`** — paints the gate UI when
 *      precheck returned 'gate-required' (or no precheck was supplied).
 *      Awaits the user's decision (or the gate's own decision: timeout,
 *      geo block, auth fail). Resolves with `'allow'` to continue rendering
 *      the widget OR `'block'` to stop. On block, the gate's UI stays in
 *      place (it owns the paint); the framework paints nothing else.
 *
 * Multiple gates run sequentially in declaration order. First `'block'`
 * short-circuits the chain — later gates don't run.
 *
 * SSR: gates are CSR-only by design. Server-rendered HTML is un-gated; the
 * embed loader's hydrate path runs gates BEFORE adopting the SSR DOM.
 * Brief content flash possible — cartridges authoring SSR-critical paths
 * should either accept the flash, hide content with CSS until hydrate
 * completes, or skip SSR for gated entry pages.
 */

import type { IEventBus } from '@ai-ro/core';

export interface GateContext<TConfig> {
  /** The cartridge's config — same shape every other primitive sees. */
  config: TConfig;
  /** App-level event bus. Gates can listen and emit (e.g. `auth:login`). */
  events: IEventBus;
  /**
   * Studio-supplied scope. Optional and opaque to the framework — studios
   * pass whatever scoping their tenancy / locale / user model needs.
   * Auth gates typically read user_id from here; geo gates read country.
   */
  scope?: Record<string, string | undefined>;
}

export interface Gate<TConfig = unknown> {
  /** Stable identifier — used for storage keys, logs, and dev tooling. */
  id: string;
  displayName: string;

  /**
   * Whether this gate is active given the current config. Gates with a
   * disabled flag (e.g. age verification toggled off for non-alcohol
   * brands) return false here and are skipped without precheck/mount.
   */
  isEnabled(config: TConfig): boolean;

  /**
   * Optional fast path. Runs BEFORE the gate UI paints.
   *
   *   - `'allow'`: skip the gate entirely. User already verified
   *     (cookie present, token valid, geo cleared). No UI flash.
   *   - `'gate-required'`: framework runs `mount()` next. Either no
   *     pre-existing state to short-circuit on, OR a verification
   *     check failed and we need user input. Either way — paint UI.
   *
   * Async by design. Auth gates verify tokens against an API; geo gates
   * call IP lookup services; cookie gates read storage (sync but typed
   * async for consistency). Default: no precheck → always run mount().
   *
   * Errors: throws propagate up to `runGates`. Caller's responsibility
   * to decide retry vs fall-through. Conservative pattern: catch in your
   * own precheck and return `'gate-required'` — surface the error in the
   * gate UI so the user can retry.
   */
  precheck?(ctx: GateContext<TConfig>): Promise<'allow' | 'gate-required'>;

  /**
   * Paint the gate UI into `host`. Resolves when the gate decides:
   *
   *   - `'allow'`: continue rendering. The gate should clean up its own
   *     UI before resolving (or set up a teardown via `destroy()`).
   *   - `'block'`: stop rendering. The gate's UI stays in place — the
   *     framework paints NOTHING else into host. Cartridge author owns
   *     the "blocked" UX (e.g. "we don't ship to your region" message,
   *     "please contact your administrator" auth-fail copy).
   *
   * The host element is the same `renderRoot` views would paint into —
   * gates and views share the host. Style isolation (shadow DOM) applies
   * to gate UI the same as view UI.
   */
  mount(host: HTMLElement, ctx: GateContext<TConfig>): Promise<'allow' | 'block'>;

  /**
   * Tear down listeners, timers, observers. Called when the framework
   * destroys the App OR when the gate resolved `'allow'` and the next
   * paint replaces its UI. Idempotent — safe to call twice.
   */
  destroy(): void;

  /**
   * Optional persistence convention. Studios with a session-storage layer
   * (Dotter studio, Airo studio) consume this metadata to scope cookies
   * and localStorage keys per-cartridge per-tenant. Cartridges without a
   * convention manage their own storage; framework doesn't write
   * anything based on this field — it's documentation for the studio.
   */
  persist?: {
    /** Storage key prefix, e.g. 'wtb:age-verified'. */
    key: string;
    /** Time-to-live in milliseconds. Omit for indefinite. */
    ttl?: number;
    scope: 'session' | 'persistent';
  };
}
