/**
 * Tests for `runGates` — the sequential pre-render gate runner.
 *
 * The first direct coverage this runner has had: until 0.11.0 it was
 * exercised only through `mountCartridge` with a single always-blocking
 * fixture, which is how the wrong-blocker defect in the old re-walk went
 * unnoticed (a gate without a precheck placed before the real blocker was
 * reported as the blocker). The two-gate case below pins the fix.
 *
 * Covers: disabled gates skipped without any call, precheck 'allow' skips
 * mount and destroy, mount 'allow' calls destroy, mount 'block' does not,
 * `blockedBy` names the gate that actually blocked, a throwing precheck
 * propagates, and the `gate:*` narration in order.
 */

import { describe, expect, test, vi } from 'vitest';

import type { IEventBus } from '@airo-js/core';

import type { Gate } from '../src/gate.js';
import { runGates } from '../src/run-gates.js';

interface Cfg {
  ageGate: boolean;
}

/** Records every emit so tests can assert the narration verbatim. */
function recordingBus(): { events: IEventBus; log: Array<[string, unknown]> } {
  const log: Array<[string, unknown]> = [];
  const events: IEventBus = {
    on() {},
    off() {},
    once() {},
    clear() {},
    listenerCount() {
      return 0;
    },
    emit(event, ...args) {
      log.push([event, args[0]]);
    },
  };
  return { events, log };
}

interface GateSpec {
  id: string;
  enabled?: boolean;
  precheck?: 'allow' | 'gate-required' | Error;
  mount?: 'allow' | 'block';
}

function makeGate(spec: GateSpec): Gate<Cfg> & { calls: string[] } {
  const calls: string[] = [];
  const gate: Gate<Cfg> & { calls: string[] } = {
    id: spec.id,
    displayName: spec.id,
    calls,
    isEnabled: () => spec.enabled ?? true,
    async mount() {
      calls.push('mount');
      return spec.mount ?? 'allow';
    },
    destroy() {
      calls.push('destroy');
    },
  };
  if (spec.precheck !== undefined) {
    const decision = spec.precheck;
    gate.precheck = async () => {
      calls.push('precheck');
      if (decision instanceof Error) throw decision;
      return decision;
    };
  }
  return gate;
}

// `runGates` only passes `host` through to `mount`; it never touches it,
// so a plain object stands in and the suite stays in the node environment.
const host = {} as HTMLElement;

describe('runGates', () => {
  test('disabled gates are skipped without precheck, mount, destroy or narration', async () => {
    const { events, log } = recordingBus();
    const gate = makeGate({ id: 'age', enabled: false, precheck: 'gate-required', mount: 'block' });

    const result = await runGates({ gates: [gate], host, ctx: { config: { ageGate: false }, events } });

    expect(result).toEqual({ verdict: 'allow' });
    expect(gate.calls).toEqual([]);
    expect(log).toEqual([]);
  });

  test("precheck 'allow' skips mount and destroy", async () => {
    const { events, log } = recordingBus();
    const gate = makeGate({ id: 'age', precheck: 'allow', mount: 'block' });

    const result = await runGates({ gates: [gate], host, ctx: { config: { ageGate: true }, events } });

    expect(result).toEqual({ verdict: 'allow' });
    expect(gate.calls).toEqual(['precheck']);
    expect(log).toEqual([
      ['gate:precheck', { gateId: 'age', decision: 'allow' }],
      ['gate:allowed', { gateId: 'age', via: 'precheck' }],
    ]);
  });

  test("mount 'allow' calls destroy and advances", async () => {
    const { events, log } = recordingBus();
    const gate = makeGate({ id: 'age', precheck: 'gate-required', mount: 'allow' });

    const result = await runGates({ gates: [gate], host, ctx: { config: { ageGate: true }, events } });

    expect(result).toEqual({ verdict: 'allow' });
    expect(gate.calls).toEqual(['precheck', 'mount', 'destroy']);
    expect(log).toEqual([
      ['gate:precheck', { gateId: 'age', decision: 'gate-required' }],
      ['gate:mount', { gateId: 'age' }],
      ['gate:allowed', { gateId: 'age', via: 'mount' }],
    ]);
  });

  test("mount 'block' keeps the paint (no destroy) and names the gate", async () => {
    const { events, log } = recordingBus();
    const gate = makeGate({ id: 'login', mount: 'block' });

    const result = await runGates({ gates: [gate], host, ctx: { config: { ageGate: true }, events } });

    expect(result).toEqual({ verdict: 'block', blockedBy: 'login' });
    expect(gate.calls).toEqual(['mount']);
    expect(log).toEqual([
      ['gate:mount', { gateId: 'login' }],
      ['gate:blocked', { gateId: 'login' }],
    ]);
  });

  test('blockedBy names the gate that blocked, not the first gate without a precheck', async () => {
    // The old re-walk returned the first no-precheck gate unconditionally,
    // so this exact arrangement reported `consent` as the blocker.
    const { events } = recordingBus();
    const allower = makeGate({ id: 'consent', mount: 'allow' });
    const blocker = makeGate({ id: 'login', precheck: 'gate-required', mount: 'block' });

    const result = await runGates({
      gates: [allower, blocker],
      host,
      ctx: { config: { ageGate: true }, events },
    });

    expect(result).toEqual({ verdict: 'block', blockedBy: 'login' });
    expect(allower.calls).toEqual(['mount', 'destroy']);
    expect(blocker.calls).toEqual(['precheck', 'mount']);
  });

  test('a block short-circuits: later gates never run', async () => {
    const { events } = recordingBus();
    const blocker = makeGate({ id: 'login', mount: 'block' });
    const later = makeGate({ id: 'age', precheck: 'allow' });

    await runGates({ gates: [blocker, later], host, ctx: { config: { ageGate: true }, events } });

    expect(later.calls).toEqual([]);
  });

  test('a throwing precheck propagates and emits nothing for that gate', async () => {
    const { events, log } = recordingBus();
    const gate = makeGate({ id: 'login', precheck: new Error('token verify failed') });

    await expect(
      runGates({ gates: [gate], host, ctx: { config: { ageGate: true }, events } }),
    ).rejects.toThrow('token verify failed');
    expect(log).toEqual([]);
  });

  test('a throwing mount propagates after gate:mount was narrated, and nothing after it', async () => {
    // The runtime reports this as onError('gate'); the narration up to the
    // throw is what a devtools observer sees, so it must stop at `gate:mount`
    // — no `gate:allowed`, no `gate:blocked`, no destroy.
    const { events, log } = recordingBus();
    const gate = makeGate({ id: 'login', precheck: 'gate-required' });
    gate.mount = async () => {
      throw new Error('paint failed');
    };

    await expect(
      runGates({ gates: [gate], host, ctx: { config: { ageGate: true }, events } }),
    ).rejects.toThrow('paint failed');
    expect(gate.calls).toEqual(['precheck']);
    expect(log).toEqual([
      ['gate:precheck', { gateId: 'login', decision: 'gate-required' }],
      ['gate:mount', { gateId: 'login' }],
    ]);
  });

  test("a mount verdict that is not 'allow' fails closed: treated as 'block', destroy not called", async () => {
    // A redirect helper that resolves `void`, a missing `return`, a typo —
    // none of them may degrade to "everything paints".
    const { events, log } = recordingBus();
    const gate = makeGate({ id: 'redirect', precheck: 'gate-required' });
    gate.mount = async () => {
      gate.calls.push('mount');
      return undefined as unknown as 'block';
    };

    const result = await runGates({ gates: [gate], host, ctx: { config: { ageGate: true }, events } });

    expect(result).toEqual({ verdict: 'block', blockedBy: 'redirect' });
    expect(gate.calls).toEqual(['precheck', 'mount']);
    expect(log.at(-1)).toEqual(['gate:blocked', { gateId: 'redirect' }]);
  });

  test('gates run in declaration order and the narration is sequential', async () => {
    const { events, log } = recordingBus();
    const order: string[] = [];
    const first = makeGate({ id: 'first', precheck: 'allow' });
    const second = makeGate({ id: 'second', precheck: 'gate-required', mount: 'allow' });
    const spyFirst = vi.spyOn(first, 'precheck');
    spyFirst.mockImplementation(async () => {
      order.push('first');
      return 'allow';
    });
    const spySecond = vi.spyOn(second, 'mount');
    spySecond.mockImplementation(async () => {
      order.push('second');
      return 'allow';
    });

    await runGates({ gates: [first, second], host, ctx: { config: { ageGate: true }, events } });

    expect(order).toEqual(['first', 'second']);
    expect(log.map(([name]) => name)).toEqual([
      'gate:precheck',
      'gate:allowed',
      'gate:precheck',
      'gate:mount',
      'gate:allowed',
    ]);
  });
});
