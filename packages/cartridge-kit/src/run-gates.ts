/**
 * runGates — execute a cartridge's pre-render Gates in declaration order.
 *
 * Iterates `gates[]`. For each enabled gate:
 *   1. Calls `precheck(ctx)` if implemented.
 *      - `'allow'`: skip mount, advance to the next gate.
 *      - `'gate-required'`: continue to step 2.
 *   2. Calls `mount(host, ctx)`. The gate paints UI into `host` and
 *      resolves with `'allow'` or `'block'`.
 *   3. On `'allow'`: gate's `destroy()` is called and the loop advances.
 *      On `'block'`: gate's UI stays in place, `destroy()` is NOT called
 *      (the gate manages its own paint and lifetime), and the loop returns
 *      `{ verdict: 'block', blockedBy: gate.id }`. The caller refuses to
 *      mount any view.
 *
 * Returns `{ verdict: 'allow' }` if every enabled gate cleared.
 *
 * ## The result names the blocker
 *
 * Until 0.11.0 this returned a bare `'allow' | 'block'` and the caller
 * re-walked every gate's `precheck` to guess which one had blocked. That
 * guess was wrong whenever a gate without a precheck came first (it was
 * reported as the blocker even when it had allowed), and it cost a second
 * network round-trip for any gate whose precheck verifies a token. The
 * runner knows which gate blocked; it says so.
 *
 * ## Lifecycle narration
 *
 * Every decision is emitted on `ctx.events` so hosts and devtools can see
 * the gate lifecycle without wrapping the runner:
 *
 *   gate:precheck  { gateId, decision: 'allow' | 'gate-required' }
 *   gate:mount     { gateId }
 *   gate:allowed   { gateId, via: 'precheck' | 'mount' }
 *   gate:blocked   { gateId }
 *
 * (`gate:allowed` with `via: 'server'` is emitted by `runGatePhase` in
 * `gate-phase.ts` when a gate is skipped because the host's server render
 * already satisfied it — see `satisfiedGates` on `mountCartridge`.)
 *
 * Disabled gates (`isEnabled(config) === false`) are skipped silently
 * without invoking precheck/mount/destroy, and emit nothing.
 *
 * ## Fail closed
 *
 * `mount()` is typed to resolve `'allow' | 'block'`. Anything else — a
 * missing `return` (resolving `undefined`), a typo, a redirect helper that
 * resolves `void` — is treated as `'block'`: the gate's paint stays and
 * nothing else renders. A cartridge bug degrades to "nothing paints", never
 * to "everything paints". `precheck` already behaves this way (anything
 * but `'allow'` falls through to `mount`).
 *
 * Error semantics: a thrown error inside precheck or mount propagates.
 * Caller's responsibility — the runtime reports it as `onError('gate')`.
 */

import type { Gate, GateContext } from './gate.js';

export interface RunGatesOptions<TConfig> {
  gates: ReadonlyArray<Gate<TConfig>>;
  host: HTMLElement;
  ctx: GateContext<TConfig>;
}

/**
 * Discriminated result. `blockedBy` is the id of the gate that returned
 * `'block'` from `mount()` — exact, not inferred.
 */
export type RunGatesResult =
  | { verdict: 'allow' }
  | { verdict: 'block'; blockedBy: string };

/** Payloads of the `gate:*` events emitted on `GateContext.events`. */
export interface GateLifecycleEvents {
  'gate:precheck': { gateId: string; decision: 'allow' | 'gate-required' };
  'gate:mount': { gateId: string };
  'gate:allowed': { gateId: string; via: 'precheck' | 'mount' | 'server' };
  'gate:blocked': { gateId: string };
}

export async function runGates<TConfig>(
  opts: RunGatesOptions<TConfig>,
): Promise<RunGatesResult> {
  const { events } = opts.ctx;
  for (const gate of opts.gates) {
    if (!gate.isEnabled(opts.ctx.config)) continue;

    if (gate.precheck) {
      const decision = await gate.precheck(opts.ctx);
      events.emit('gate:precheck', { gateId: gate.id, decision });
      if (decision === 'allow') {
        events.emit('gate:allowed', { gateId: gate.id, via: 'precheck' });
        continue;
      }
      // 'gate-required' falls through to mount below.
    }

    events.emit('gate:mount', { gateId: gate.id });
    const result: unknown = await gate.mount(opts.host, opts.ctx);
    if (result !== 'allow') {
      // 'block' — or a verdict the contract does not know, which fails
      // closed (see the header). The gate's UI stays; destroy is NOT
      // called here — the gate owns its paint and any observers/timers it
      // set up. The runtime calls `destroy()` when the host tears the
      // mount down or before a remount re-runs the gate phase.
      events.emit('gate:blocked', { gateId: gate.id });
      return { verdict: 'block', blockedBy: gate.id };
    }
    // 'allow' — gate's UI is no longer needed. The next gate (or the
    // first view) will replace whatever it painted; clean up listeners.
    gate.destroy();
    events.emit('gate:allowed', { gateId: gate.id, via: 'mount' });
  }

  return { verdict: 'allow' };
}
