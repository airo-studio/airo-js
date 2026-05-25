/**
 * createCartridgeApp — cartridge-aware wrapper around `createApp`.
 *
 * When a cartridge view renders, `RenderContext.app` is
 * `CartridgeAppContext<TData, TConfig>` — a typed envelope of
 * `{ cartridgeId, config, data }`. `createApp` itself accepts an opaque
 * `appContext: TAppContext`; without this helper, consumers have to
 * construct the envelope and thread the typing themselves.
 *
 * This helper does the construction. Consumers pass the cartridge + config
 * + already-post-Transformer snapshot, and it threads everything into
 * `createApp` with the right typing.
 *
 * Async (returns `Promise<CartridgeAppResult>`) because pre-render Gates
 * run BEFORE views paint, and Gates are async (precheck() may verify a
 * token over the network, mount() awaits the user's decision). When all
 * gates clear, the helper proceeds with `createApp` and returns the App
 * handle. When any gate blocks, no App is created and the helper returns
 * `{ blocked: true }` — the gate's UI stays in `host` and the framework
 * paints nothing else.
 *
 * Why this lives in `@airo-js/cartridge-kit` and not `@airo-js/core`: putting
 * it in core would require core to depend on cartridge-kit (for `Cartridge`
 * and gate types), creating a circular workspace dependency. Keeping it
 * here lets core stay cartridge-unaware.
 */

import type {
  App,
  AppDeps,
  AppConfig,
} from '@airo-js/core';
import { createApp } from '@airo-js/core';

import type { Cartridge, CartridgeRegistry } from './cartridge.js';
import type { CartridgeAppContext } from './view.js';
import { runGates } from './run-gates.js';
import { getDefaultRenderResolver } from './cartridge-registry.js';

export interface CartridgeAppDeps<TPageType extends string = string>
  extends Omit<
    AppDeps<TPageType, CartridgeAppContext<unknown, unknown>>,
    'appContext' | 'resolveRenderer'
  > {
  /** Optional override — defaults to a renderer resolver built from the cartridge's views. */
  resolveRenderer?: AppDeps<
    TPageType,
    CartridgeAppContext<unknown, unknown>
  >['resolveRenderer'];
  /**
   * Optional long-lived `CartridgeRegistry`. When provided, the resolver
   * is derived via `registry.resolverFor(cartridge.id)` — useful for
   * multi-cartridge studios that maintain a shared registry across
   * widget instances. The caller is responsible for registering the
   * cartridge before mount (`registry.register(cartridge)`); if the
   * registry doesn't know the cartridge, `resolverFor` returns a
   * resolver that hands back `undefined` for every page type and the
   * framework treats it as "chunk not loaded yet."
   *
   * Precedence at resolution time: explicit `resolveRenderer` > `registry`
   * > lazy WeakMap-memoised default built from the cartridge alone.
   */
  registry?: CartridgeRegistry;
  /**
   * Host-app-supplied scope passed through to gate `precheck` / `mount`
   * via `GateContext.scope`. Host apps with tenancy or auth use this to
   * thread user_id / locale / country into gates without making them
   * host-app-specific.
   */
  gateScope?: Record<string, string | undefined>;
}

export type CartridgeAppResult =
  | { app: App; blocked: false }
  | { app: null; blocked: true; blockedBy: string };

/**
 * Mount a cartridge against a `host` element. Sequence:
 *
 *   1. Run pre-render gates (see `runGates`). Gates paint into `host` if
 *      they need user input. First gate that resolves `'block'`
 *      short-circuits — the helper returns early with `{ blocked: true }`.
 *   2. Build `CartridgeAppContext` from cartridge id + config + snapshot.
 *   3. Derive `resolveRenderer` from `cartridge.views[]` (or use the
 *      override).
 *   4. Delegate to `createApp` from `@airo-js/core` for the actual mount.
 *
 * Snapshot is REQUIRED — caller has run the cartridge's transformer chain
 * (typically via `createPipeline().runTransformers`) and passes the result
 * here. Separating the pipeline from the mount lets consumers decide
 * caching, async pre-fetch, and re-mount semantics.
 */
export async function createCartridgeApp<TData, TConfig, TPageType extends string = string>(
  cartridge: Cartridge<TData, TConfig>,
  config: AppConfig<TPageType>,
  snapshot: TData,
  cartridgeConfig: TConfig,
  deps: CartridgeAppDeps<TPageType>,
): Promise<CartridgeAppResult> {
  // Phase 1 — gates. Skip gracefully when the cartridge has none.
  const gates = cartridge.gates ?? [];
  if (gates.length > 0) {
    const events = deps.events;
    if (!events) {
      throw new Error(
        '[@airo-js/cartridge-kit] createCartridgeApp: gates require an `events` bus on deps. Pass `events: new EventBus()` (or your existing one) so gate UIs can emit cross-component signals.',
      );
    }
    const gateResult = await runGates({
      gates,
      host: deps.host,
      ctx: {
        config: cartridgeConfig,
        events,
        scope: deps.gateScope,
      },
    });
    if (gateResult === 'block') {
      // The first gate to block left its UI in `host`. The framework
      // paints nothing else; caller checks `result.blocked` to decide
      // whether to surface a "blocked by" message in the host app.
      const blockedBy = await firstBlockedGateId(cartridge, cartridgeConfig, deps.gateScope);
      return { app: null, blocked: true, blockedBy };
    }
  }

  // Phase 2 — view mount.
  const appContext: CartridgeAppContext<TData, TConfig> = {
    cartridgeId: cartridge.id,
    config: cartridgeConfig,
    data: snapshot,
  };

  // Renderer resolution precedence:
  //   1. Explicit `deps.resolveRenderer` (caller knows exactly what they
  //      want — wins over everything).
  //   2. `deps.registry.resolverFor(cartridge.id)` (caller passed a
  //      shared long-lived registry — derive the per-cartridge resolver).
  //   3. Default — `getDefaultRenderResolver(cartridge)` builds a lazy
  //      WeakMap-memoised single-cartridge registry under the hood.
  //
  // Cast in all three paths: the registry returns its heterogeneous
  // `ChunkFactory` typed against `string`; the call site narrows to the
  // caller-provided `TPageType`. Sound because every factory in the
  // registry originated from `cartridge.views[]` or
  // `pushToMailbox(cartridge.mailboxName, ...)` — both authored against
  // the cartridge's own page-type union.
  const resolveRenderer =
    deps.resolveRenderer ??
    ((deps.registry?.resolverFor(cartridge.id) ??
      getDefaultRenderResolver(cartridge)) as AppDeps<
      TPageType,
      CartridgeAppContext<unknown, unknown>
    >['resolveRenderer']);

  const app = createApp<TPageType, CartridgeAppContext<unknown, unknown>>(config, {
    ...deps,
    appContext: appContext as unknown as CartridgeAppContext<unknown, unknown>,
    resolveRenderer,
  });

  return { app, blocked: false };
}

/**
 * Best-effort identification of which gate blocked. Walks the gates again
 * (precheck-only — mount is one-shot and can't be replayed) and returns
 * the first id whose precheck would fail. When precheck isn't implemented
 * for the blocking gate, falls back to a generic id.
 *
 * Used only for the diagnostic `blockedBy` field — not on the hot path.
 */
async function firstBlockedGateId<TConfig>(
  cartridge: Cartridge<unknown, TConfig>,
  config: TConfig,
  scope: Record<string, string | undefined> | undefined,
): Promise<string> {
  for (const gate of cartridge.gates ?? []) {
    if (!gate.isEnabled(config)) continue;
    if (!gate.precheck) {
      // No precheck path; can't distinguish without re-running mount.
      return gate.id;
    }
    // Best effort — replay precheck. Real mount() decisions can't be
    // re-played idempotently so this is approximate.
    try {
      const decision = await gate.precheck({
        config,
        events: {
          on() {},
          off() {},
          emit() {},
          once() {},
          clear() {},
          listenerCount() {
            return 0;
          },
        },
        scope,
      });
      if (decision === 'gate-required') return gate.id;
    } catch {
      return gate.id;
    }
  }
  return 'unknown';
}
