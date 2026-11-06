/**
 * Timers for hydrate code on device: `setTimeout`, `clearTimeout`,
 * `setInterval` and `clearInterval`, as `window.*` and as globals where the
 * main thread lacks them.
 *
 * They run on the engine's own `setTimeout`, with ids of their own, so they
 * need nothing else from the engine: a cleared timer's engine callback still
 * fires, and does nothing. They belong to the mount: `destroy()` clears what
 * is left, and a callback that throws is reported, as a browser reports an
 * uncaught error, rather than lost.
 */

type Callback = (...args: unknown[]) => void;

export class MountTimers {
  private next = 1;
  private readonly live = new Set<number>();

  constructor(
    /** The engine's `setTimeout`, captured at mount. */
    private readonly schedule: (fn: () => void, ms: number) => unknown,
    private readonly onError: (err: unknown) => void,
    private readonly refuse: (member: string, detail: string) => never,
  ) {}

  private run(fn: Callback, args: unknown[]): void {
    try {
      fn(...args);
    } catch (err) {
      this.onError(err);
    }
  }

  private callback(member: string, fn: unknown): Callback {
    if (typeof fn !== 'function') this.refuse(`${member}(string)`, 'pass a function; code in a string is not run on device');
    return fn as Callback;
  }

  readonly setTimeout = (fn: unknown, ms?: unknown, ...args: unknown[]): number => {
    const run = this.callback('setTimeout', fn);
    const id = this.next++;
    this.live.add(id);
    this.schedule(() => {
      if (this.live.delete(id)) this.run(run, args);
    }, Number(ms) || 0);
    return id;
  };

  readonly setInterval = (fn: unknown, ms?: unknown, ...args: unknown[]): number => {
    const run = this.callback('setInterval', fn);
    const id = this.next++;
    const delay = Number(ms) || 0;
    const step = (): void => {
      this.schedule(() => {
        if (!this.live.has(id)) return;
        this.run(run, args);
        if (this.live.has(id)) step();
      }, delay);
    };
    this.live.add(id);
    step();
    return id;
  };

  /** `clearTimeout` and `clearInterval`: interchangeable, as in a browser. */
  readonly clear = (id?: unknown): void => {
    this.live.delete(Number(id));
  };

  /** Timers still pending; for tests and the device script. */
  get pending(): number {
    return this.live.size;
  }

  clearAll(): void {
    this.live.clear();
  }
}
