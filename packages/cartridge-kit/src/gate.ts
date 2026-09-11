/**
 * Gate — pre-render guard primitive.
 *
 * Two sentences the framework signs, and every rule below follows from them:
 *
 *   1. **A Gate decides whether to paint; whether to serve is the host's,
 *      per request.** The gate is UX — the sign-in panel, the age prompt,
 *      the region notice. The security boundary is the host's API and its
 *      SSR handler, which refuse data and private pages to any request
 *      without a session. A stale or bypassed gate can never leak data,
 *      because the data was never in the page to begin with.
 *   2. **Bots are never gated.** SSR never runs gates; the server-rendered
 *      HTML of a public page is un-gated by guarantee, not by accident.
 *      Private pages (`Page.private`) are the one exception, and they are
 *      refused by the SSR runner, not gated.
 *
 * Runs BEFORE the data fetch and BEFORE any view paints — a blocked mount
 * costs no network and no pipeline. Used for content-visibility decisions
 * that guard a mount: age verification, geo restriction, sign-in, paywall,
 * country selector, maintenance mode. (Cookie consent is NOT a gate: a
 * widget stays usable without consent and consent never blocks anything;
 * model it as a consent provider the views read.)
 *
 * Why a primitive (not a Transformer / PostProcessor / View): a Transformer
 * has no DOM access; a PostProcessor runs after views render — too late;
 * a View implies a route in the navigation graph — gates sit outside it.
 * A gate guards a MOUNT, never a page. `appliesTo: 'private'` narrows a
 * gate to mounts whose resolved entry page carries `private: true`; the
 * default `'all'` runs on every mount.
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
 * short-circuits the chain — later gates don't run. The runner reports
 * which gate blocked (`RunGatesResult.blockedBy`) and narrates every
 * decision on the event bus (`gate:precheck` / `gate:mount` /
 * `gate:allowed` / `gate:blocked`).
 *
 * ## The redirect round trip
 *
 * `mount()` may never settle. A sign-in gate that navigates to an identity
 * provider unloads the page, and that is by design. Re-entry is `precheck`
 * on the NEXT mount: the host session now exists, so it returns `'allow'`
 * and no UI re-shows. The return URL carries the nav state — link to
 * `/auth/login?next=<pathname+search>` and have the host redirect back to
 * `next` (same-origin paths only); hosts with no URL router serialise
 * `ctx.navState` (the state this mount starts on, handed to the gate
 * because no App exists yet at gate time) into `next` and re-supply it
 * as `initialNavState`. Popup and in-page flows (wallet prompts) resolve
 * `mount()` in place and need none of this. A gate that wants to block AND
 * send the visitor somewhere calls `location.assign()` itself and returns
 * `'block'`; no framework channel is needed.
 *
 * ## SSR and hydrate
 *
 * Gates are CSR-only. On the client, in hydrate mode, the runtime snapshots
 * the server's markup before the gate phase — only when a gate could
 * actually paint (one that is enabled, applies to the entry, and was not
 * satisfied by the server) — and restores it when a gate that painted
 * INTO THE RENDER ROOT resolves `'allow'`, so hydration adopts the
 * server's DOM and not the gate's; on `'block'` the gate's paint stays.
 * The restore re-parses the markup: any node reference or observer a host
 * attached to the server's DOM in `onShellReady` points at a detached node
 * afterwards, so attach to the render root, not to what is inside it,
 * when a painting gate is in play. That guarantee covers the render root
 * only. A gate that paints or mutates anywhere else — an overlay appended
 * beside the render root, a `document.body.style` change — undoes it
 * itself in `destroy()`: the contract is "undo what you did", not only
 * "what you did to the host". A gate that blocked keeps its paint and its
 * listeners until the host calls the mount result's `destroy()` or a
 * remount re-runs the gate phase; the runtime calls `destroy()` then.
 * Hosts that need zero painted frames before a gate ship the hide in the
 * initial HTML (`data-airo-gate="pending"`, from the SSR result's
 * `gates.pending`) and the runtime flips the attribute to `passed` /
 * `blocked` / `error` when the phase resolves. Under a one-gate-fan-out (one
 * framework gate running N configured gates) `pending` names the one
 * framework gate — it means "something is pending", not which instance.
 *
 * ## Remounts
 *
 * `update()` / `updatePages()` remounts re-run every gate: a remount exists
 * to get fresh data, and freshness wins over a remembered verdict. The one
 * hand-off is `mountCartridge({ satisfiedGates })`, for the initial mount of
 * a page the host's server already rendered privately — those gates are
 * skipped once and narrated as `gate:allowed { via: 'server' }`.
 */

import type { IEventBus, NavigationState } from '@airo-js/core';

export interface GateContext<TConfig> {
  /** The cartridge's config — same shape every other primitive sees. */
  config: TConfig;
  /** App-level event bus. Gates can listen and emit (e.g. `auth:login`). */
  events: IEventBus;
  /**
   * The navigation state this mount starts on (URL > `initialNavState` >
   * default entry), as resolved by the runtime before the gate phase.
   * `navState.page` is the id of the page the gate is scoped against.
   * Gates run before any App exists, so this is the only framework-supplied
   * way to build a return URL (`next`) for a host with no URL router.
   * Absent when the runner is invoked outside the runtime.
   */
  navState?: Readonly<NavigationState>;
  /**
   * Host-app-supplied scope. Optional and opaque to the framework — host
   * apps pass whatever scoping their tenancy / locale / user model needs.
   * Auth gates typically read user_id from here; geo gates read country.
   */
  scope?: Record<string, string | undefined>;
}

/**
 * One storage hint. METADATA ONLY — see `Gate.persist`.
 */
export interface PersistHint {
  /** Storage key prefix, e.g. 'gate:age-verified'. */
  key: string;
  /** Time-to-live in milliseconds. Omit for indefinite. */
  ttl?: number;
  scope: 'session' | 'persistent';
  /**
   * Which outcome this hint describes. Default `'pass'`. A real age gate
   * needs both: `pass` → persistent (never shown again), `fail` → session
   * (blocked for this tab; a new tab is a fresh attempt).
   */
  outcome?: 'pass' | 'fail';
}

export interface Gate<TConfig = unknown> {
  /** Stable identifier — used for storage keys, logs, and dev tooling. */
  id: string;
  displayName: string;

  /**
   * Which mounts this gate guards. Default `'all'`.
   *
   *   - `'all'`: every mount of the cartridge (age verification, geo).
   *   - `'private'`: only mounts whose resolved entry page carries
   *     `Page.private: true` (a sign-in gate). On a public entry the gate
   *     is skipped without precheck, mount or narration. When no entry page
   *     can be resolved at all, the gate runs — the unknowable case fails
   *     closed.
   *
   * Entry-based, not graph-based: a gate guards the mount it runs on. In-app
   * navigation into a private page does not re-run it; a private view
   * renders its signed-out state when the snapshot carries no member data,
   * and the host's API stays the authority.
   *
   * On the SSR side, `renderPrivate: true` is shorthand for "this render
   * satisfies every `'private'` gate" — right when the only private-scoped
   * gate is the sign-in gate, which is what a verified session satisfies.
   * A host with a second private-scoped gate (a paywall tier, a step-up)
   * names the ones its render actually met with
   * `renderPrivate: { satisfiedGates: [...] }`, and the others stay
   * pending for the client.
   */
  appliesTo?: 'all' | 'private';

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
   * Runs on every mount and every remount. Keep it cheap: a host-set,
   * non-HttpOnly marker cookie beside the real session makes it a
   * synchronous `document.cookie` read, and the API remains the verifier.
   *
   * Errors: throws propagate up to `runGates`; the runtime reports them as
   * `onError('gate')`. Conservative pattern: catch in your own precheck and
   * return `'gate-required'` — surface the error in the gate UI so the user
   * can retry.
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
   *     "sign in to continue" panel).
   *
   * The host element is the same `renderRoot` views would paint into —
   * gates and views share the host. Style isolation (shadow DOM) applies
   * to gate UI the same as view UI. In hydrate mode the runtime restores
   * the server's markup after an `'allow'` (see the header).
   *
   * May never settle if the gate navigates away (see "The redirect round
   * trip" in the header).
   */
  mount(host: HTMLElement, ctx: GateContext<TConfig>): Promise<'allow' | 'block'>;

  /**
   * Tear down listeners, timers, observers. Called when the gate resolved
   * `'allow'` and the next paint replaces its UI, and — for a gate that
   * blocked — when the host calls the mount result's `destroy()` or a
   * remount re-runs the gate phase. Idempotent — safe to call twice.
   */
  destroy(): void;

  /**
   * **Documentation with a type: the framework never reads this field.**
   * Nothing in `@airo-js/*` consumes `persist` — not the runner, not the
   * runtime, not the SSR path — so two gates can declare identical hints
   * and behave differently and nothing will say so. It exists so a host
   * that implements the storage write has one declared place to read the
   * key, lifetime and outcome from. Whether it survives 1.0 as a field or
   * as a docs convention is an open review item; do not build on it
   * being read.
   *
   * Persistence convention — METADATA ONLY. Cartridge declares the hint;
   * the host app implements the actual storage write.
   *
   * **The framework writes NOTHING based on this field.** Decision
   * locked-in for v0.2 (load-bearing for the framework's rendering-only
   * scope line), three reasons:
   *
   *   1. **Cookie writes are state management, not rendering.** Letting
   *      the framework own them violates the rendering-only scope line.
   *      Each "small extension" (sameSite/domain rules, rotation policy,
   *      "refresh on focus", auth-token interaction) quietly redefines
   *      "rendering-only" until it isn't. Reject the category, not just
   *      the instance.
   *
   *   2. **Cookie semantics are host-app concerns.** Different host apps
   *      have different domains, sameSite policies, SSO interactions,
   *      GDPR/CCPA compliance shapes. The framework can't standardise
   *      this without picking sides — and picking sides means forking
   *      per-host-app Gate behaviour later.
   *
   *   3. **Contract precedent.** `DataSource.cacheTtlMs` is exactly this
   *      shape: cartridge declares the hint, host app implements caching.
   *      `Gate.persist` fits the same envelope — cartridge declares
   *      `{ key, ttl, scope, outcome }`, host app writes whatever storage
   *      primitive matches its compliance posture.
   *
   * One hint or several: a real gate often has two lifetimes (a pass that
   * is remembered across sessions, a fail that is remembered for this tab),
   * so an array of `PersistHint`s with `outcome` is accepted. Hosts with
   * their own auth/session stack (a server-set cookie the gate never
   * touches) ignore this field entirely; that pattern is first-class.
   */
  persist?: PersistHint | readonly PersistHint[];
}
