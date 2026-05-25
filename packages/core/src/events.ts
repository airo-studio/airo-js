/**
 * EventBus — Observer pattern with snapshot-on-emit semantics.
 *
 * Subscribers added during an emit fire on the *next* event, not the
 * current one. Without this, a handler that re-renders + re-subscribes
 * (e.g. a renderer being destroyed and re-mounted on navigate) is
 * visited again by `Set.forEach` and the cycle never terminates.
 * This is the contract Node's EventEmitter has too.
 */

import { logger } from '@airo-js/log';

const log = logger('core');

export type EventCallback = (...args: unknown[]) => void;

export interface IEventBus {
  on(event: string, callback: EventCallback): void;
  off(event: string, callback: EventCallback): void;
  emit(event: string, ...args: unknown[]): void;
  once(event: string, callback: EventCallback): void;
  clear(event?: string): void;
  /**
   * Number of subscribers currently wired for `event`. Used internally
   * (e.g. PageManager downgrades the `'renderer:missing'` warn to info
   * when a subscriber is wired — recoverable path) and available to
   * consumers that want the same introspection.
   *
   * Returns 0 for events with no listeners. Includes `once` listeners
   * that haven't fired yet.
   */
  listenerCount(event: string): number;
}

export class EventBus implements IEventBus {
  private events: Map<string, Set<EventCallback>> = new Map();

  on(event: string, callback: EventCallback): void {
    if (!this.events.has(event)) {
      this.events.set(event, new Set());
    }
    this.events.get(event)!.add(callback);
  }

  off(event: string, callback: EventCallback): void {
    const callbacks = this.events.get(event);
    if (callbacks) {
      callbacks.delete(callback);
    }
  }

  emit(event: string, ...args: unknown[]): void {
    const callbacks = this.events.get(event);
    if (callbacks) {
      const snapshot = Array.from(callbacks);
      for (const callback of snapshot) {
        try {
          callback(...args);
        } catch (error) {
          log.error(`Error in event handler for "${event}"`, error);
        }
      }
    }
  }

  once(event: string, callback: EventCallback): void {
    const wrapper: EventCallback = (...args) => {
      this.off(event, wrapper);
      callback(...args);
    };
    this.on(event, wrapper);
  }

  clear(event?: string): void {
    if (event) {
      this.events.delete(event);
    } else {
      this.events.clear();
    }
  }

  listenerCount(event: string): number {
    return this.events.get(event)?.size ?? 0;
  }
}
