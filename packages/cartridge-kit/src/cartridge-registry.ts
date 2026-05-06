/**
 * createCartridgeRegistry — concrete `CartridgeRegistry` implementation.
 *
 * Studios construct one of these at boot, register their cartridges, and
 * use `resolverFor(cartridgeId)` to feed `createApp` / `createCartridgeApp`
 * the right renderer-resolver callback.
 *
 * Two resolution paths per cartridge, checked in order:
 *
 *   1. **Static views.** `cartridge.views[]` is a known list at registration
 *      time. The registry walks it and matches on `pageType`. Works for
 *      cartridges that ship every view in one bundle.
 *
 *   2. **Per-cartridge chunk mailbox.** When a cartridge ships views as
 *      separate chunks, each chunk pushes to `cartridge.mailboxName` via
 *      `pushToMailbox` from `@ai-ro/core`. The registry calls
 *      `createRegistry(mailboxName)` once at register-time, which drains
 *      pre-loaded chunks AND installs a live-registering proxy for
 *      late-loaded chunks. After that, `resolveView` falls through to
 *      `chunkRegistry.resolve(pageType)` whenever the static list misses.
 *
 * The chunk path is opt-in. Cartridges that don't ship chunks declare an
 * empty `views[]` won't see anything resolve through this path; the
 * mailbox is created but stays empty. No runtime cost beyond a Map per
 * cartridge.
 */

import type { PageRendererFactory } from '@ai-ro/core';
import { createRegistry, type Registry } from '@ai-ro/core';

import type { Cartridge, CartridgeRegistry } from './cartridge.js';
import type { CartridgeAppContext } from './view.js';

type ChunkFactory = PageRendererFactory<
  string,
  CartridgeAppContext<unknown, unknown>
>;

/**
 * Create a CartridgeRegistry. `initial` is registered immediately; later
 * cartridges land via `register()`.
 *
 * Idempotent register: re-registering the same `cartridge.id` replaces
 * the prior entry but reuses any already-drained chunk mailbox so chunks
 * that registered between the two `register()` calls aren't lost.
 */
export function createCartridgeRegistry(
  initial: Cartridge[] = [],
): CartridgeRegistry {
  const cartridges = new Map<string, Cartridge>();
  const chunkRegistries = new Map<string, Registry<ChunkFactory>>();

  function register(cartridge: Cartridge): void {
    cartridges.set(cartridge.id, cartridge);

    if (!chunkRegistries.has(cartridge.id)) {
      // First registration of this id — open the mailbox.
      chunkRegistries.set(
        cartridge.id,
        createRegistry<ChunkFactory>(cartridge.mailboxName),
      );
    }
    // Re-registration: keep the existing chunk registry. Plugin chunks
    // registered against the mailbox between register() calls stay
    // resolvable. The static views[] swap is handled implicitly via the
    // cartridges map replacement above.
  }

  for (const c of initial) register(c);

  return {
    register,

    list(): Cartridge[] {
      return Array.from(cartridges.values());
    },

    get(id: string): Cartridge | undefined {
      return cartridges.get(id);
    },

    resolveView(cartridgeId, pageType) {
      const cartridge = cartridges.get(cartridgeId);
      if (!cartridge) return undefined;

      // Static views first — known at construction time.
      const staticView = cartridge.views.find((v) => v.pageType === pageType);
      if (staticView) {
        // Cast through unknown — the registry is heterogeneous across
        // cartridges. The view's factory was typed against the cartridge's
        // own (TData, TConfig); the registry exposes the unknown-bound
        // version because callers don't know which cartridge the factory
        // came from until they look. Sound: the cartridge that authored
        // the view is the one that mounts it.
        return staticView.factory as unknown as ChunkFactory;
      }

      // Then chunk mailbox — populated by lazy-loaded view chunks.
      return chunkRegistries.get(cartridgeId)?.resolve(pageType);
    },

    resolverFor(cartridgeId) {
      // Curry the cartridgeId so the returned callback matches createApp's
      // `resolveRenderer: (pageType) => factory | undefined` signature.
      return (pageType: string) => {
        const cartridge = cartridges.get(cartridgeId);
        if (!cartridge) return undefined;
        const staticView = cartridge.views.find((v) => v.pageType === pageType);
        if (staticView) return staticView.factory as unknown as ChunkFactory;
        return chunkRegistries.get(cartridgeId)?.resolve(pageType);
      };
    },
  };
}
