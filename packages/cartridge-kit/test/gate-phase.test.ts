/**
 * Tests for the gate phase — `selectGates` (the one place `appliesTo` is
 * interpreted) and `runGatePhase` (selection + the server-satisfied
 * hand-off + `runGates`).
 *
 * Covers: passthrough when no gate is private-scoped, private entry runs
 * everything, public entry drops private-scoped gates, an unresolved entry
 * fails closed, `satisfiedGates` skips with `via: 'server'` narration and
 * ignores unknown or disabled ids, and `applied` / `blockedBy` reporting.
 */

import { describe, expect, test } from 'vitest';

import type { IEventBus } from '@airo-js/core';

import type { Gate } from '../src/gate.js';
import { runGatePhase, selectGates } from '../src/gate-phase.js';

interface Cfg {
  requireSignIn: boolean;
}

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

function makeGate(
  id: string,
  opts: { appliesTo?: 'all' | 'private'; enabled?: boolean; mount?: 'allow' | 'block' } = {},
): Gate<Cfg> & { calls: string[] } {
  const calls: string[] = [];
  return {
    id,
    displayName: id,
    calls,
    ...(opts.appliesTo ? { appliesTo: opts.appliesTo } : {}),
    isEnabled: () => opts.enabled ?? true,
    async precheck() {
      calls.push('precheck');
      return 'gate-required';
    },
    async mount() {
      calls.push('mount');
      return opts.mount ?? 'allow';
    },
    destroy() {
      calls.push('destroy');
    },
  };
}

const host = {} as HTMLElement;
const ctxFor = (events: IEventBus) => ({ config: { requireSignIn: true }, events });

describe('selectGates', () => {
  test('no private-scoped gate → every gate, in order', () => {
    const age = makeGate('age');
    const geo = makeGate('geo', { appliesTo: 'all' });
    expect(selectGates([age, geo], { private: false })).toEqual([age, geo]);
    expect(selectGates([age, geo], undefined)).toEqual([age, geo]);
  });

  test('private entry page → every gate', () => {
    const age = makeGate('age');
    const login = makeGate('login', { appliesTo: 'private' });
    expect(selectGates([age, login], { private: true })).toEqual([age, login]);
  });

  test('public entry page → private-scoped gates dropped, order kept', () => {
    const age = makeGate('age');
    const login = makeGate('login', { appliesTo: 'private' });
    const geo = makeGate('geo');
    expect(selectGates([age, login, geo], { private: false })).toEqual([age, geo]);
    expect(selectGates([age, login, geo], {})).toEqual([age, geo]);
  });

  test('no entry page resolved → every gate (fails closed)', () => {
    const login = makeGate('login', { appliesTo: 'private' });
    expect(selectGates([login], undefined)).toEqual([login]);
  });

  test('undefined gates → empty', () => {
    expect(selectGates(undefined, { private: true })).toEqual([]);
  });

  test('returns a fresh array, never the input', () => {
    const gates = [makeGate('age')];
    expect(selectGates(gates, undefined)).not.toBe(gates);
  });
});

describe('runGatePhase', () => {
  test('runs the selected gates and reports them as applied', async () => {
    const { events } = recordingBus();
    const age = makeGate('age');
    const login = makeGate('login', { appliesTo: 'private' });

    const result = await runGatePhase({
      gates: [age, login],
      entryPage: { private: false },
      host,
      ctx: ctxFor(events),
    });

    expect(result.verdict).toBe('allow');
    expect(result.applied.map((g) => g.id)).toEqual(['age']);
    expect(result.satisfied).toEqual([]);
    expect(age.calls).toEqual(['precheck', 'mount', 'destroy']);
    expect(login.calls).toEqual([]);
  });

  test('satisfiedGates skips the named gate without precheck or mount and narrates via: server', async () => {
    const { events, log } = recordingBus();
    const login = makeGate('login', { appliesTo: 'private' });

    const result = await runGatePhase({
      gates: [login],
      entryPage: { private: true },
      host,
      ctx: ctxFor(events),
      satisfiedGates: ['login'],
    });

    expect(result).toEqual({ verdict: 'allow', applied: [login], satisfied: ['login'] });
    expect(login.calls).toEqual([]);
    expect(log).toEqual([['gate:allowed', { gateId: 'login', via: 'server' }]]);
  });

  test('satisfiedGates: ids that name no selected or enabled gate are ignored', async () => {
    const { events, log } = recordingBus();
    const age = makeGate('age');
    const off = makeGate('off', { enabled: false });
    const login = makeGate('login', { appliesTo: 'private' });

    const result = await runGatePhase({
      gates: [age, off, login],
      entryPage: { private: false },
      host,
      ctx: ctxFor(events),
      satisfiedGates: ['off', 'login', 'nope'],
    });

    expect(result.verdict).toBe('allow');
    expect(result.satisfied).toEqual([]);
    expect(result.applied.map((g) => g.id)).toEqual(['age']);
    expect(log.filter(([name]) => name === 'gate:allowed')).toEqual([
      ['gate:allowed', { gateId: 'age', via: 'mount' }],
    ]);
  });

  test('a block names the blocker and keeps applied / satisfied', async () => {
    const { events } = recordingBus();
    const age = makeGate('age');
    const login = makeGate('login', { appliesTo: 'private', mount: 'block' });

    const result = await runGatePhase({
      gates: [age, login],
      entryPage: { private: true },
      host,
      ctx: ctxFor(events),
      satisfiedGates: ['age'],
    });

    expect(result).toEqual({
      verdict: 'block',
      blockedBy: 'login',
      applied: [age, login],
      satisfied: ['age'],
    });
    expect(age.calls).toEqual([]);
    expect(login.calls).toEqual(['precheck', 'mount']);
  });

  test('disabled gates are neither applied nor run', async () => {
    const { events, log } = recordingBus();
    const off = makeGate('off', { enabled: false, mount: 'block' });

    const result = await runGatePhase({ gates: [off], entryPage: undefined, host, ctx: ctxFor(events) });

    expect(result).toEqual({ verdict: 'allow', applied: [], satisfied: [] });
    expect(log).toEqual([]);
  });
});
