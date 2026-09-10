/**
 * The gate phase — which gates a mount runs, and running them.
 *
 * `selectGates` is the one place `Gate.appliesTo` is interpreted.
 * `runGatePhase` wraps it around `runGates`, honours the host's
 * `satisfiedGates` hand-off, and is the single entry point the runtime
 * calls (before the data fetch). `createCartridgeApp` runs no gates.
 *
 * Both are pure with respect to the DOM and storage: the only side effects
 * are the gate's own `mount()` and the narration on `ctx.events`.
 */

import type { Page } from '@airo-js/core';

import type { Gate, GateContext } from './gate.js';
import { runGates } from './run-gates.js';

/**
 * Pick the gates that apply to a mount whose resolved entry page is
 * `entryPage`.
 *
 *   - no gate declares `appliesTo: 'private'` → every gate, unchanged.
 *   - the entry page is `private: true` → every gate.
 *   - the entry page is public → gates declared `'private'` are dropped.
 *   - no entry page could be resolved (`undefined`) → every gate; the
 *     unknowable case fails closed.
 *
 * Reads only `Page.private` off the page object both sides already hold,
 * so a chunked browser cartridge with `views: []` gets the same answer as
 * the server.
 */
export function selectGates<TConfig>(
  gates: ReadonlyArray<Gate<TConfig>> | undefined,
  entryPage: Pick<Page, 'private'> | undefined,
): Gate<TConfig>[] {
  const all = gates ?? [];
  if (entryPage === undefined || entryPage.private === true) return [...all];
  return all.filter((g) => g.appliesTo !== 'private');
}

export interface RunGatePhaseOptions<TConfig> {
  /** `cartridge.gates` — may be absent. */
  gates: ReadonlyArray<Gate<TConfig>> | undefined;
  /** The mount's resolved entry page, or `undefined` when none resolved. */
  entryPage: Pick<Page, 'private'> | undefined;
  /** Element gates paint into — the same render root views use. */
  host: HTMLElement;
  ctx: GateContext<TConfig>;
  /**
   * Gate ids the host's server render already satisfied for this mount
   * (it verified the session it rendered for). Those gates are skipped —
   * no precheck, no mount — and narrated as `gate:allowed { via: 'server' }`.
   * Ids that name no selected, enabled gate are ignored.
   */
  satisfiedGates?: ReadonlyArray<string>;
}

export type RunGatePhaseResult =
  | { verdict: 'allow'; applied: Gate[]; satisfied: string[] }
  | { verdict: 'block'; blockedBy: string; applied: Gate[]; satisfied: string[] };

/**
 * Select, skip what the server satisfied, run the rest in order.
 * `applied` lists every gate the phase considered (selected and enabled),
 * whether it ran or was satisfied — the runtime uses it to know whether
 * the mount had any gates at all.
 */
export async function runGatePhase<TConfig>(
  opts: RunGatePhaseOptions<TConfig>,
): Promise<RunGatePhaseResult> {
  const selected = selectGates(opts.gates, opts.entryPage);
  const satisfiedIds = new Set(opts.satisfiedGates ?? []);
  const applied: Gate[] = [];
  const satisfied: string[] = [];
  const toRun: Gate<TConfig>[] = [];

  for (const gate of selected) {
    if (!gate.isEnabled(opts.ctx.config)) continue;
    applied.push(gate as Gate);
    if (satisfiedIds.has(gate.id)) {
      satisfied.push(gate.id);
      opts.ctx.events.emit('gate:allowed', { gateId: gate.id, via: 'server' });
      continue;
    }
    toRun.push(gate);
  }

  const result = await runGates({ gates: toRun, host: opts.host, ctx: opts.ctx });
  if (result.verdict === 'block') {
    return { verdict: 'block', blockedBy: result.blockedBy, applied, satisfied };
  }
  return { verdict: 'allow', applied, satisfied };
}
