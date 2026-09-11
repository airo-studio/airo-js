/**
 * Compile-time contract for the 0.11.0 `Gate` additions.
 *
 * `persist` accepts one hint or an array of hints, each with an optional
 * `outcome`; `appliesTo` is the closed literal union. The `@ts-expect-error`
 * lines are the test: they must stay errors.
 */

import { describe, expectTypeOf, test } from 'vitest';

import type { Gate, PersistHint } from '../src/gate.js';

interface Cfg {
  requireSignIn: boolean;
}

const base = {
  displayName: 'x',
  isEnabled: () => true,
  async mount() {
    return 'allow' as const;
  },
  destroy() {},
};

describe('Gate (types)', () => {
  test('persist accepts a single hint (the pre-0.11.0 shape) unchanged', () => {
    const gate: Gate<Cfg> = {
      ...base,
      id: 'age',
      persist: { key: 'gate:age-verified', scope: 'persistent' },
    };
    expectTypeOf(gate.persist).toEqualTypeOf<PersistHint | readonly PersistHint[] | undefined>();
  });

  test('persist accepts an array of hints with outcome', () => {
    const gate: Gate<Cfg> = {
      ...base,
      id: 'age',
      persist: [
        { key: 'gate:age-verified', scope: 'persistent', outcome: 'pass' },
        { key: 'gate:age-failed', scope: 'session', outcome: 'fail', ttl: 60_000 },
      ],
    };
    expectTypeOf(gate.id).toEqualTypeOf<string>();
  });

  test('outcome and appliesTo are closed unions', () => {
    const _bad: Gate<Cfg> = {
      ...base,
      id: 'age',
      // @ts-expect-error — 'maybe' is not an outcome
      persist: { key: 'k', scope: 'session', outcome: 'maybe' },
    };
    const _bad2: Gate<Cfg> = {
      ...base,
      id: 'login',
      // @ts-expect-error — only 'all' | 'private'
      appliesTo: 'members',
    };
    const ok: Gate<Cfg> = { ...base, id: 'login', appliesTo: 'private' };
    expectTypeOf(ok.appliesTo).toEqualTypeOf<'all' | 'private' | undefined>();
  });
});
