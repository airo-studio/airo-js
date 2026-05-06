/**
 * Registry + stub-queue mailbox — async plugin self-registration.
 *
 * Plugin chunks load asynchronously. Their order isn't deterministic. A
 * chunk has to register itself with core whether it loaded *before* or
 * *after* core. The classic GA-tracking stub-queue solves this:
 *
 *   1. Plugin does:
 *        (globalThis.MAILBOX = globalThis.MAILBOX || []).push(entry)
 *   2. Core calls `createRegistry(MAILBOX_NAME)` once. The factory:
 *        a. drains any array currently at globalThis[MAILBOX_NAME] into a
 *           Map (these are the "pre-core" plugins),
 *        b. replaces the global with `{ push: liveRegister }` so any
 *           "post-core" plugin push goes straight into the Map.
 *
 * After that, both phases look identical to plugin authors: one
 * `<script>` tag, one push to the mailbox, no awareness of load order.
 */

export interface RegistryEntry<T> {
  key: string;
  factory: T;
}

export interface Registry<T> {
  /**
   * Register a factory under a key. Idempotent — re-registering the same
   * key replaces the prior factory. Useful for hot-reload during development.
   */
  register(key: string, factory: T): void;
  /** Look up a factory by key. Returns undefined if no plugin owns it. */
  resolve(key: string): T | undefined;
  /** Iterate all registrations. Insertion order. */
  entries(): IterableIterator<[string, T]>;
  /** Drop a registration. Returns true if a factory was removed. */
  unregister(key: string): boolean;
  /** Clear everything. Test seam. */
  clear(): void;
}

/**
 * Create a registry backed by a global mailbox. Call once per registry
 * kind per major-version of your runtime — the mailbox name is the key
 * across hot reloads, so two registries sharing a mailbox name will
 * trample each other.
 *
 * Implementation note: the global is replaced with a proxy `{ push }` after
 * draining, not deleted, so late-loaded plugin chunks doing
 * `(globalThis.X = globalThis.X || []).push(entry)` see a truthy value
 * and call .push on it — which goes straight to live registration.
 */
export function createRegistry<T>(mailboxName: string): Registry<T> {
  const map = new Map<string, T>();

  const pending = (globalThis as Record<string, unknown>)[mailboxName];
  if (Array.isArray(pending)) {
    for (const entry of pending as RegistryEntry<T>[]) {
      if (entry && typeof entry.key === 'string') {
        map.set(entry.key, entry.factory);
      }
    }
  }

  (globalThis as Record<string, unknown>)[mailboxName] = {
    push(entry: RegistryEntry<T>): void {
      if (entry && typeof entry.key === 'string') {
        map.set(entry.key, entry.factory);
      }
    },
  };

  return {
    register(key, factory) {
      map.set(key, factory);
    },
    resolve(key) {
      return map.get(key);
    },
    entries() {
      return map.entries();
    },
    unregister(key) {
      return map.delete(key);
    },
    clear() {
      map.clear();
    },
  };
}

/**
 * Helper for plugin chunks. Call from inside a chunk's entry to register
 * a factory under the given mailbox without importing core. Pure DOM —
 * works whether core is loaded or not.
 *
 * Usage from a chunk:
 *   import { pushToMailbox } from '@ai-ro/core';
 *   pushToMailbox('__AIRO_WTB_PAGES__', { key: 'carousel', factory: () => new CarouselRenderer() });
 */
export function pushToMailbox<T>(mailboxName: string, entry: RegistryEntry<T>): void {
  const g = globalThis as Record<string, unknown>;
  const slot = g[mailboxName];
  if (slot && typeof (slot as { push?: unknown }).push === 'function') {
    (slot as { push: (e: RegistryEntry<T>) => void }).push(entry);
  } else {
    const arr = (Array.isArray(slot) ? slot : []) as RegistryEntry<T>[];
    arr.push(entry);
    g[mailboxName] = arr;
  }
}
