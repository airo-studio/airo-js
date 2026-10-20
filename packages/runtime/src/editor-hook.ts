/**
 * The protocol between a mount and `@airo-js/runtime/editor` (0.11.2).
 *
 * Editor-only capabilities (`replaceData`) live in a separate entry so a
 * page that only mounts never downloads them. The mount carries the
 * smallest seam they need — this hook, under a registry symbol — and the
 * editor entry owns everything else.
 *
 * Versioned in the key, not the shape: an editor overlay is often served
 * apart from the runtime it attaches to (the runtime pinned per widget, the
 * overlay shipped with the editor), so the two may come from different
 * runtime releases. `Symbol.for` resolves to the same symbol in every copy
 * of every bundle; a runtime without the hook simply has no property under
 * the key, which the editor entry reports as "not applied". A change that
 * would break an older editor entry ships under a `v2` key beside this one,
 * never as an edit to `v1`.
 *
 * Not for direct use: call the functions `@airo-js/runtime/editor` exports.
 */

import type { NavigationState } from '@airo-js/core';

import type { MountCartridgeOptions } from './mount-cartridge.js';

export const EDITOR_HOOK: unique symbol = Symbol.for('airo-js.runtime.editor.v1');

/** What the live App displays: the config and snapshot views and post-processors read. */
export interface Shown<TData, TConfig> {
  config: TConfig;
  data: TData;
}

/**
 * Display override the editor installs while it shows other data. The mount
 * calls it with the mount's own config on two paths:
 *
 *  - `remount: true` — inside a remount, after the fetch and the mount's own
 *    pipeline. Re-run whatever the override shows under `config`; returning
 *    `null` mounts the mount's own snapshot instead.
 *  - `remount: false` — on an `update()` hot-swap. The snapshot is still
 *    valid by the `hotSwapKeys` contract; return it with the new config.
 */
export type EditorDisplay<TData, TConfig> = (
  config: TConfig,
  navState: NavigationState,
  remount: boolean,
) => Promise<Shown<TData, TConfig> | null> | Shown<TData, TConfig> | null;

export interface EditorHook<TData, TConfig> {
  /** The mount's FIFO dispatch queue, shared with `update` / `updatePages`. */
  enqueue<T>(op: () => Promise<T>): Promise<T>;
  /**
   * The mount's OWN config and snapshot — never what a display override
   * shows. Read inside `enqueue`, after checking the mount's App is live
   * (`mount.app.state !== 'destroyed'`: a destroyed mount, and one whose
   * last remount a gate blocked, both leave a destroyed App).
   */
  own(): Shown<TData, TConfig>;
  /** Install (or, with `null`, remove) the display override. */
  display(fn: EditorDisplay<TData, TConfig> | null): void;
  /** Swap what the live App displays and re-render the active page in place. Synchronous. */
  show(shown: Shown<TData, TConfig>): void;
  /** The mount's options: the editor reads `cartridge` and `onError`. */
  opts: Pick<MountCartridgeOptions<TData, TConfig>, 'cartridge' | 'onError'>;
}
