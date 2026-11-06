/** The mount's timers: ids of their own over the engine's setTimeout, cleared on destroy, errors reported. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MountTimers } from '../src/runtime/timers.js';

let errors: unknown[];
let timers: MountTimers;
beforeEach(() => {
  vi.useFakeTimers();
  errors = [];
  timers = new MountTimers(
    (fn, ms) => setTimeout(fn, ms),
    (err) => errors.push(err),
    (member) => {
      throw new Error(`refused ${member}`);
    },
  );
});
afterEach(() => vi.useRealTimers());

describe('MountTimers', () => {
  it('runs a timeout once, with its arguments, and clears it before it fires', () => {
    const fn = vi.fn();
    timers.setTimeout(fn, 100, 'a', 1);
    const cleared = vi.fn();
    timers.clear(timers.setTimeout(cleared, 50));
    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('a', 1);
    expect(cleared).not.toHaveBeenCalled();
    expect(timers.pending).toBe(0);
  });

  it('repeats an interval until it is cleared, also from inside its own callback', () => {
    let n = 0;
    const id = timers.setInterval(() => {
      n++;
      if (n === 3) timers.clear(id);
    }, 1000);
    vi.advanceTimersByTime(10_000);
    expect(n).toBe(3);
  });

  it('clears everything on clearAll (a destroyed mount), and reports a callback that throws without stopping the interval', () => {
    let n = 0;
    timers.setInterval(() => {
      n++;
      throw new Error('tick failed');
    }, 10);
    vi.advanceTimersByTime(35);
    expect(n).toBe(3);
    expect(errors).toHaveLength(3);
    timers.clearAll();
    vi.advanceTimersByTime(100);
    expect(n).toBe(3);
  });

  it('refuses code in a string', () => {
    expect(() => timers.setTimeout('alert(1)', 0)).toThrow(/refused setTimeout\(string\)/);
  });
});
