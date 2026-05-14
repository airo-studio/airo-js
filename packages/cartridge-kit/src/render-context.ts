/**
 * `CartridgeRenderContext` — strongly-typed RenderContext for cartridge
 * renderers.
 *
 * Extends `@airo-js/core`'s generic `RenderContext` with two cartridge-
 * specific narrowings:
 *
 *   1. `app` is `CartridgeAppContext<TData, TConfig>` (the typed
 *      cartridge envelope from `view.ts`), not opaque `TAppContext`.
 *      Renderers reach `ctx.app.config` + `ctx.app.data` natively
 *      without casting through `unknown`.
 *
 *   2. `update` is typed as `(delta: DeepPartial<TConfig>) => Promise<UpdateResult>`,
 *      narrowing the bare `Record<string, unknown>` shape that the
 *      core `RenderContext.update` carries. The runtime contract is
 *      unchanged — the framework wires the SAME function for both — but
 *      cartridge authors get type-checked deep-partial deltas at the
 *      call site instead of having to cast.
 *
 * Use this type in your cartridge's renderer factories:
 *
 * ```ts
 * import type { CartridgeRenderContext } from '@airo-js/cartridge-kit';
 *
 * type WtbCtx = CartridgeRenderContext<WtbPageType, WtbData, WtbConfig>;
 *
 * export function quickShopRenderer(): PageRenderer<WtbPageType, CartridgeAppContext<WtbData, WtbConfig>> {
 *   return defineSSRSafeRenderer<WtbPageType, WtbData, WtbConfig>({
 *     template(ctx: WtbCtx) { ... },
 *     hydrate(root, ctx: WtbCtx) {
 *       variantSelector.on('select', (variant) => {
 *         ctx.update?.({ display: { selectedGroupIndex: variant.idx } });
 *       });
 *     },
 *   });
 * }
 * ```
 *
 * The bare `RenderContext` from core still works — every cartridge
 * renderer is structurally compatible with the looser type. This
 * extension exists for ergonomics + compile-time guarantees, not for
 * runtime behavior change.
 */

import type { RenderContext, UpdateResult } from '@airo-js/core';

import type { DeepPartial } from './deep-partial.js';
import type { CartridgeAppContext } from './view.js';

export interface CartridgeRenderContext<
  TPageType extends string,
  TData,
  TConfig,
> extends Omit<
    RenderContext<TPageType, CartridgeAppContext<TData, TConfig>>,
    'update'
  > {
  /**
   * Typed forward into `MountCartridgeResult.update()`. Same runtime
   * primitive as core's `RenderContext.update`, narrowed to
   * `DeepPartial<TConfig>` for compile-time delta shape checking.
   */
  update?: (delta: DeepPartial<TConfig>) => Promise<UpdateResult>;
}
