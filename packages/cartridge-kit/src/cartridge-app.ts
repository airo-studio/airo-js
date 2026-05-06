/**
 * createCartridgeApp — cartridge-aware wrapper around `createApp`.
 *
 * Resolves Gap 4 from the consumer-side mapping feedback: when a cartridge
 * view renders, `RenderContext.app` is `CartridgeAppContext<TData, TConfig>`
 * — a typed envelope of `{ cartridgeId, config, data }`. Today's `createApp`
 * accepts an opaque `appContext: TAppContext`; consumers have to construct
 * the envelope themselves and remember its shape.
 *
 * This helper does the construction. Consumers pass the cartridge + config
 * + already-post-Transformer snapshot, and it threads everything into
 * `createApp` with the right typing.
 *
 * Why this lives in `@ai-ro/cartridge-kit` and not `@ai-ro/core` (despite
 * the consumer feedback's suggestion): putting it in core would require
 * core to depend on cartridge-kit (for the `Cartridge` and
 * `CartridgeAppContext` types), creating a circular workspace dependency.
 * Putting it here keeps core dep-free upward and the helper still ergonomic
 * — a single import from `@ai-ro/cartridge-kit` covers both contract types
 * and this wrapper.
 *
 * Studios that don't use cartridges (rare, but possible) ignore this helper
 * and call `createApp` from `@ai-ro/core` directly.
 */

import type {
  App,
  AppDeps,
  AppConfig,
} from '@ai-ro/core';
import { createApp } from '@ai-ro/core';

import type { Cartridge } from './cartridge.js';
import type { CartridgeAppContext } from './view.js';

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
}

/**
 * Mount a cartridge against a `host` element. Builds `CartridgeAppContext`
 * from the cartridge id + config + post-Transformer snapshot, derives the
 * `resolveRenderer` callback from the cartridge's `views[]` if not supplied,
 * and delegates to `createApp` from `@ai-ro/core`.
 *
 * Snapshot is REQUIRED — there's no default. The caller has run the
 * cartridge's transformer chain (typically via `createPipeline().runTransformers`)
 * and passes the result here. The framework does not run transformers
 * automatically inside this helper — separating the pipeline from the
 * mount lets consumers decide caching, async pre-fetch, and re-mount
 * semantics without the helper second-guessing them.
 *
 * Returns the same `App` handle `createApp` returns.
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

  // Default renderer resolver: walk the cartridge's views[], match on
  // `pageType`, return the matching factory. Consumers can override for
  // multi-cartridge studios where a single page type might be served by
  // different cartridges depending on context.
  const resolveRenderer =
    deps.resolveRenderer ??
    ((pageType: TPageType) => {
      const view = cartridge.views.find((v) => v.pageType === pageType);
      return view?.factory as
        | AppDeps<TPageType, CartridgeAppContext<unknown, unknown>>['resolveRenderer'] extends (
            ...args: unknown[]
          ) => infer R
          ? R
          : undefined;
    });

  // Cast through unknown — the helper layers `CartridgeAppContext<TData, TConfig>`
  // on top of `createApp`'s `TAppContext = CartridgeAppContext<unknown, unknown>`
  // bound. Unification is sound because every renderer's TAppContext bound
  // is set by the same cartridge.
  return createApp<TPageType, CartridgeAppContext<unknown, unknown>>(config, {
    ...deps,
    appContext: appContext as unknown as CartridgeAppContext<unknown, unknown>,
    resolveRenderer,
  });
}
