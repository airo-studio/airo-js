/**
 * @airo-js/runtime/editor — authoring capabilities for a mounted cartridge
 * (0.11.2).
 *
 * Everything here is for an editor's canvas, never for a page a visitor
 * loads, so it ships as its own entry: a bundle that only mounts never
 * downloads it. It reaches the mount through the versioned hook in
 * `editor-hook.ts`, which is all a mount carries for it.
 *
 * `replaceData` — show a mounted widget against other data. An editor uses
 * it to draw a state the live data cannot produce (an empty grid, a facet
 * the draft does not configure) from sample data, and then gives the mount
 * its own data back, without a remount either way.
 */

import { createPipeline } from '@airo-js/core';
import type { IEventBus, NavigationState, UpdateResult } from '@airo-js/core';
import type { DeepPartial } from '@airo-js/cartridge-kit';
import { logger } from '@airo-js/log';

import { deepMerge } from './deep-merge.js';
import { EDITOR_HOOK } from './editor-hook.js';
import type { EditorHook } from './editor-hook.js';
import type { MountCartridgeResult } from './mount-cartridge.js';

const log = logger('runtime');

/**
 * Payload of `'mount:data-replaced'` on `shell.events`. Emitted after the
 * render lands, by `replaceData` — `replaced: true` on every apply, `false`
 * on a restore — and after a remount that had to drop the replacement
 * because the transformers threw on it under the new config. The data
 * itself is never echoed on the bus: the caller that replaced it holds it.
 */
export interface DataReplacedEvent {
  replaced: boolean;
  navState: NavigationState;
}

interface Held<TData, TConfig> {
  data: TData;
  overlay: DeepPartial<TConfig> | undefined;
}

// Hooks whose mount currently shows replaced data. A hook is one object per
// mount, so a destroyed mount's entry goes with it.
const held = new WeakSet<object>();

/**
 * Show `mount` against other data, or with `null`, give it its own back.
 *
 *  - Apply: the cartridge's transformers run over `next.data` — no fetch,
 *    no gates — with the ACTIVE page as `navState.page`, then the active
 *    page re-renders in place. NavigationState is preserved and no
 *    navigation event fires. Applying again replaces the previous data.
 *  - `next.config` is a transient overlay, merged over the mount's config
 *    for everything that displays: these transformers, views
 *    (`ctx.app.config`) and post-processors. The mount's config never
 *    takes it in: `update()` neither diffs against it nor merges it, and
 *    gates and fetch never see it.
 *  - `null` restores the mount's own snapshot (fetched or preloaded, or the
 *    one the last remount refreshed) and drops the overlay, with no
 *    refetch. A no-op — no render, no event — when nothing is replaced.
 *
 * While replaced, an `update()` / `updatePages()` hot-swap keeps the data
 * and re-applies the overlay over the new config. A remount still fetches
 * under the real config — so a later `null` restores data computed for the
 * config that is live — then re-runs the transformers over the replaced
 * data and mounts that. If they throw on it under the new config, the
 * remount drops it, mounts the live data, logs the error and emits
 * `'mount:data-replaced'` with `replaced: false`; the `update()` that
 * remounted still resolves.
 *
 * Shares the mount's FIFO queue with `update` / `updatePages`. Resolves
 * after the render lands: render, then post-processors, then
 * `'mount:data-replaced'` (`DataReplacedEvent`), then the promise. One
 * exception: when the active page's renderer is not registered yet (an
 * unloaded chunk), the page paints later, by chunk recovery.
 *
 * Resolves `null` — nothing applied — when `mount` carries no editor hook:
 * a gate-blocked mount, or a runtime older than 0.11.2. Rejects, and
 * changes nothing, when a transformer throws on `next.data` (after
 * `onError('pipeline')`), when a gate blocked the last remount, and after
 * `destroy()`.
 */
export function replaceData<TConfig, TPageType extends string, TData>(
  mount: MountCartridgeResult<TConfig, TPageType, TData>,
  next: { data: TData; config?: DeepPartial<TConfig> } | null,
): Promise<UpdateResult | null> {
  if (mount.blocked) return Promise.resolve(null);
  const hook = mount[EDITOR_HOOK];
  if (!hook) return Promise.resolve(null);
  return hook.enqueue(async () => {
    // A destroyed mount and one whose last remount a gate blocked both
    // leave a destroyed App behind: nothing live to render into.
    if (mount.app.state === 'destroyed') {
      throw new Error(
        '[@airo-js/runtime/editor] replaceData(): no live App — the mount was destroyed, or a gate blocked its last remount (the next update() remounts).',
      );
    }
    const own = hook.own();
    const { events } = mount.shell;
    const navState = mount.app.getNavigationState();
    if (next === null) {
      if (!held.has(hook)) return { mode: 'hot-swap', navState };
      held.delete(hook);
      hook.display(null);
      hook.show(own);
    } else {
      const config = withOverlay(own.config, next.config);
      let data: TData;
      try {
        data = await transform(hook, next.data, config, navState);
      } catch (err) {
        hook.opts.onError?.('pipeline', err, mount.shell);
        throw err;
      }
      const replacement: Held<TData, TConfig> = { data: next.data, overlay: next.config };
      held.add(hook);
      installDisplay(hook, events, replacement, data);
      hook.show({ config, data });
    }
    const event: DataReplacedEvent = { replaced: next !== null, navState };
    events.emit('mount:data-replaced', event);
    return { mode: 'hot-swap', navState };
  });
}

// The override the mount consults while data is replaced. `snapshot` is the
// post-Transformer result on screen: a hot-swap reuses it (its keys do not
// affect derived data), a remount recomputes it under the new config.
function installDisplay<TData, TConfig>(
  hook: EditorHook<TData, TConfig>,
  events: IEventBus,
  replacement: Held<TData, TConfig>,
  snapshot: TData,
): void {
  let current = snapshot;
  hook.display(async (base, navState, remount) => {
    const config = withOverlay(base, replacement.overlay);
    if (!remount) return { config, data: current };
    try {
      current = await transform(hook, replacement.data, config, navState);
      return { config, data: current };
    } catch (err) {
      // Display-only data must not fail the remount the caller's real edit
      // triggered: drop it, let the mount show its own, and say so once the
      // remount has landed.
      log.error('replaceData: transformers threw on the replaced data during a remount; it was dropped.', err, {
        phase: 'pipeline',
        cartridgeId: hook.opts.cartridge.id,
      });
      held.delete(hook);
      hook.display(null);
      events.once('mount:remounted', (outcome: unknown) => {
        const event: DataReplacedEvent = {
          replaced: false,
          navState: (outcome as UpdateResult).navState,
        };
        events.emit('mount:data-replaced', event);
      });
      return null;
    }
  });
}

function withOverlay<TConfig>(base: TConfig, overlay: DeepPartial<TConfig> | undefined): TConfig {
  return overlay === undefined ? base : deepMerge(base, overlay);
}

function transform<TData, TConfig>(
  hook: EditorHook<TData, TConfig>,
  data: TData,
  config: TConfig,
  navState: NavigationState,
): Promise<TData> {
  return createPipeline<TData, TConfig>(hook.opts.cartridge.transformers ?? [], []).runTransformers(data, {
    config,
    navState,
    locale: (config as { locale?: string }).locale,
  });
}
