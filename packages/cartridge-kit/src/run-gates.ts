/**
 * runGates — execute a cartridge's pre-render Gates in declaration order.
 *
 * Iterates `cartridge.gates[]`. For each enabled gate:
 *   1. Calls `precheck(ctx)` if implemented.
 *      - `'allow'`: skip mount, advance to the next gate.
 *      - `'gate-required'`: continue to step 2.
 *   2. Calls `mount(host, ctx)`. The gate paints UI into `host` and
 *      resolves with `'allow'` or `'block'`.
 *   3. On `'allow'`: gate's `destroy()` is called and the loop advances.
 *      On `'block'`: gate's UI stays in place, `destroy()` is NOT called
 *      (the gate manages its own paint and lifetime), the loop returns
 *      `'block'`. The caller (createCartridgeApp) refuses to mount any
 *      view.
 *
 * Returns `'allow'` if every enabled gate cleared, `'block'` otherwise.
 *
 * Disabled gates (`isEnabled(config) === false`) are skipped silently
 * without invoking precheck/mount/destroy.
 *
 * Error semantics: a thrown error inside precheck or mount propagates.
 * Caller's responsibility — typical pattern is to wrap the
 * `createCartridgeApp` call in try/catch and surface the error in the
 * host app's error UI.
 */

import type { Gate, GateContext } from './gate.js';

export interface RunGatesOptions<TConfig> {
  gates: ReadonlyArray<Gate<TConfig>>;
  host: HTMLElement;
  ctx: GateContext<TConfig>;
}

export type RunGatesResult = 'allow' | 'block';

export async function runGates<TConfig>(
  opts: RunGatesOptions<TConfig>,
): Promise<RunGatesResult> {
  for (const gate of opts.gates) {
    if (!gate.isEnabled(opts.ctx.config)) continue;

    if (gate.precheck) {
      const decision = await gate.precheck(opts.ctx);
      if (decision === 'allow') continue;
      // 'gate-required' falls through to mount below.
    }

    const result = await gate.mount(opts.host, opts.ctx);
    if (result === 'block') {
      // Gate's UI stays. Don't call destroy — gate owns its paint and
      // any observers/timers it set up. They live until the host
      // element is unmounted from the DOM.
      return 'block';
    }
    // 'allow' — gate's UI is no longer needed. The next gate (or the
    // first view) will replace whatever it painted; clean up listeners.
    gate.destroy();
  }

  return 'allow';
}
