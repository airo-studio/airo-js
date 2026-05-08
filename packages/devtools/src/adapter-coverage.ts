/**
 * Adapter coverage analysis — pure helper for <studio-adapter-coverage>.
 *
 * For each PublicationAdapter the cartridge declares, walks the data
 * snapshot and produces a per-adapter status:
 *   - 'ready'              every `required: 'always'` field populated AND
 *                          generate() + validate() pass.
 *   - 'partially-blocked'  some 'always' fields missing OR validation fails.
 *   - 'fully-blocked'      no 'always' fields populated OR generate() throws.
 *
 * Surfaces the missing dotted paths so the panel can tell the user
 * exactly what to fill in to clear an adapter's gate.
 */

import type {
  Cartridge,
  PublicationAdapter,
  PublicationContext,
  SchemaFieldRef,
} from '@airo-js/cartridge-kit';

import { isFieldPopulated } from './score-formula.js';

export type AdapterStatus = 'ready' | 'partially-blocked' | 'fully-blocked';

export interface AdapterCoverageRow {
  id: string;
  displayName: string;
  format: PublicationAdapter<unknown, unknown>['format'];
  status: AdapterStatus;
  /** Always-required field paths that are missing from the data. */
  missingAlways: string[];
  /** Preferred-required field paths that are missing — soft warnings. */
  missingPreferred: string[];
  /** Total declared `requires` paths (across all cardinalities). */
  totalRequires: number;
  /** How many of the total are populated. */
  populatedRequires: number;
  /** Validation error count (0 if generate threw — that's surfaced as `error`). */
  validationErrors: number;
  /** Set when generate() threw; otherwise undefined. */
  generateError?: string;
}

const COVERAGE_CONTEXT: PublicationContext<unknown> = {
  config: {},
  locale: 'en',
  country: 'US',
};

export async function analyzeAdapterCoverage<TData, TConfig>(
  cartridge: Cartridge<TData, TConfig>,
  data: TData,
): Promise<AdapterCoverageRow[]> {
  const adapters = (cartridge.publicationAdapters ?? []) as PublicationAdapter<
    TData,
    unknown,
    TConfig
  >[];

  return Promise.all(
    adapters.map((adapter) => analyzeOne(adapter, data, cartridge.defaultConfig)),
  );
}

async function analyzeOne<TData, TConfig>(
  adapter: PublicationAdapter<TData, unknown, TConfig>,
  data: TData,
  config: TConfig,
): Promise<AdapterCoverageRow> {
  const requires: SchemaFieldRef[] = adapter.requires ?? [];
  const missingAlways: string[] = [];
  const missingPreferred: string[] = [];
  let populated = 0;
  for (const ref of requires) {
    const ok = isFieldPopulated(data, ref.path);
    if (ok) {
      populated += 1;
    } else if (ref.required === 'always') {
      missingAlways.push(ref.path);
    } else if (ref.required === 'preferred') {
      missingPreferred.push(ref.path);
    }
  }

  let generateError: string | undefined;
  let validationErrors = 0;
  let validationOk = false;

  if (missingAlways.length === 0) {
    try {
      const ctx = { ...COVERAGE_CONTEXT, config } as PublicationContext<TConfig>;
      const out = await adapter.generate(data, ctx);
      const result = adapter.validate(out);
      validationErrors = result.errors.length;
      validationOk = result.valid;
    } catch (e) {
      generateError = e instanceof Error ? e.message : String(e);
    }
  }

  let status: AdapterStatus;
  if (missingAlways.length === 0 && validationOk) {
    status = 'ready';
  } else if (populated === 0 || generateError) {
    status = 'fully-blocked';
  } else {
    status = 'partially-blocked';
  }

  return {
    id: adapter.id,
    displayName: adapter.displayName,
    format: adapter.format,
    status,
    missingAlways,
    missingPreferred,
    totalRequires: requires.length,
    populatedRequires: populated,
    validationErrors,
    ...(generateError ? { generateError } : {}),
  };
}
