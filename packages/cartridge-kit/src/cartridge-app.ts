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
 * `createApp` with the right typing. It is synchronous and returns the
 * `App` handle.
 *
 * ## Gates do not run here (0.11.0)
 *
 * Until 0.11.0 this helper ran the cartridge's Gates before `createApp`,
 * which is why it was async and why gates ran AFTER the data fetch — this
 * helper needs the snapshot, so anything inside it inherited "after
 * snapshot". A sign-in gate cannot protect a member-data fetch from
 * behind the fetch. The gate phase is now `runGatePhase` (in this
 * package), and `@airo-js/runtime`'s `mountCartridge` runs it before the
 * data phase. Its only caller was the runtime, so no consumer path
 * changes; a direct caller that relied on gates running here must call
 * `runGatePhase` itself first.
 *
 * Why this lives in `@airo-js/cartridge-kit` and not `@airo-js/core`: putting
 * it in core would require core to depend on cartridge-kit (for `Cartridge`
 * and view types), creating a circular workspace dependency. Keeping it
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
}

/**
 * Mount a cartridge against a `host` element. Sequence:
 *
 *   1. Build `CartridgeAppContext` from cartridge id + config + snapshot.
 *   2. Derive `resolveRenderer` from `cartridge.views[]` (or use the
 *      override / the registry).
 *   3. Delegate to `createApp` from `@airo-js/core` for the actual mount.
 *
 * Snapshot is REQUIRED — caller has run the cartridge's transformer chain
 * (typically via `createPipeline().runTransformers`) and passes the result
 * here. Separating the pipeline from the mount lets consumers decide
 * caching, async pre-fetch, and re-mount semantics. Gates are the
 * caller's phase too — see the header.
 */
export function createCartridgeApp<TData, TConfig, TPageType extends string = string>(
  cartridge: Cartridge<TData, TConfig>,
  config: AppConfig<TPageType>,
  snapshot: TData,
  cartridgeConfig: TConfig,
  deps: CartridgeAppDeps<TPageType>,
): App {
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

  return createApp<TPageType, CartridgeAppContext<unknown, unknown>>(config, {
    ...deps,
    appContext: appContext as unknown as CartridgeAppContext<unknown, unknown>,
    resolveRenderer,
  });
}
