/**
 * runPublicationAdapters — execute a cartridge's PublicationAdapters
 * against a post-Transformer snapshot.
 *
 * Generates the surface-specific output (Schema.org JSON-LD object,
 * Merchant Center XML string, etc), validates it, and reports per-adapter
 * results. Does NOT decide what to do with the outputs — that's the
 * caller's job (inline JSON-LD into HTML, write XML to a signed feed
 * URL, hand to a delivery worker).
 *
 * Use `renderAppWithPublication` when you want the SSR HTML and
 * inline-host outputs woven together in one call. Use this helper alone
 * when you're generating non-HTML outputs (XML feeds, MCP-tools manifests)
 * or running adapters on a schedule independent of widget render.
 *
 * Adapter selection — three layered filters:
 *   1. `adapterIds` (optional): explicit allowlist by adapter id.
 *   2. `formats` (optional): include only specified formats.
 *   3. `deliveries` (optional): include only specified delivery modes.
 *
 * Default (no filter): runs every adapter declared on the cartridge.
 *
 * ## Coverage gating (1.0)
 *
 * After the filters and BEFORE `generate()`, each adapter's `requires`
 * entries with `required: 'always'` are checked against the snapshot. If any
 * are absent the adapter does not run: the result carries `included: false`
 * and a `skipped` reason naming the missing paths. This is the second of the
 * three contract guarantees, and until 1.0 it was documented but not
 * implemented.
 *
 * Two deliberate narrowings:
 *
 * - **Only `'always'` gates.** `'preferred'` and `'optional'` stay pure
 *   metadata for the host app's coverage UI. Whether a missing `'preferred'`
 *   field should stop publication is a judgment the adapter makes in
 *   `validate()`, where it can see the output it actually produced.
 *
 * - **Present means non-nullish**, i.e. `getByPath(...) != null`. `''`, `0`,
 *   `false` and `[]` all count as present — an adapter that considers an
 *   empty string unusable says so in `validate()`. Note this is NOT
 *   `hasByPath`'s semantic, which reports a declared-but-`undefined` key as
 *   present; that distinction exists to tell a typo'd path from an unset
 *   global, and a feed adapter cannot emit `undefined` either way.
 *
 * The gate ignores `onValidationFail`. That policy governs what to do with
 * output that failed `validate()`; a skipped adapter produced no output, and
 * the signal a caller checks (`included: false`) is the same one
 * `'block-publish'` yields. So a skip never throws, even under `'fail-loud'`.
 *
 * Validation handling per adapter's `onValidationFail`:
 *   - `'block-publish'` (default): output IS included in the result, but
 *     `included: false` is set. The caller checks that flag before
 *     publishing. Hard gate at the call site.
 *   - `'publish-with-warnings'`: `included: true`, `validation.errors`
 *     visible for logging.
 *   - `'fail-loud'`: throws the validation as an Error. Caller's loop
 *     terminates on first failure.
 */

import type {
  Cartridge,
  PublicationAdapter,
  PublicationContext,
  ValidationResult,
} from '@airo-js/cartridge-kit';
import { missingRequiredPaths } from '@airo-js/cartridge-kit';

export interface RunPublicationOptions {
  /** Allowlist by adapter id. Empty/undefined = include all. */
  adapterIds?: string[];
  /** Include only these formats. Empty/undefined = include all. */
  formats?: PublicationAdapter<unknown, unknown, unknown>['format'][];
  /** Include only these delivery modes. Empty/undefined = include all. */
  deliveries?: NonNullable<PublicationAdapter<unknown, unknown, unknown>['delivery']>[];
}

/**
 * Why an adapter was reported without running. Present only on skipped
 * entries — check it to tell "ran and failed validation" apart from "never
 * ran", which `included: false` alone cannot distinguish.
 */
export interface AdapterSkipped {
  reason: 'missing-required-fields';
  /** The `required: 'always'` schema paths that were absent from the snapshot. */
  missing: string[];
}

export interface AdapterRunResult {
  adapterId: string;
  format: PublicationAdapter<unknown, unknown, unknown>['format'];
  delivery: NonNullable<PublicationAdapter<unknown, unknown, unknown>['delivery']>;
  /** `undefined` when the adapter was skipped — it never generated. */
  output: unknown;
  validation: ValidationResult;
  /**
   * True when the caller should publish this output. False when
   * `onValidationFail: 'block-publish'` (the default) and validation
   * failed — output is in the result for diagnostic, but the host app
   * MUST NOT serve it downstream. Also false for a skipped adapter.
   */
  included: boolean;
  /**
   * Set when coverage gating stopped the adapter before `generate()`.
   * Absent on every adapter that actually ran.
   */
  skipped?: AdapterSkipped;
}

/**
 * Run the cartridge's PublicationAdapters in declaration order. Returns
 * one entry per matched adapter. Adapters that throw during `generate()`
 * propagate the error — wrap the call in try/catch in the caller if you
 * need partial-success semantics.
 */
export async function runPublicationAdapters<TData, TConfig>(
  cartridge: Cartridge<TData, TConfig>,
  snapshot: TData,
  ctx: PublicationContext<TConfig>,
  opts: RunPublicationOptions = {},
): Promise<AdapterRunResult[]> {
  const adapters = cartridge.publicationAdapters ?? [];
  if (adapters.length === 0) return [];

  const idAllow = opts.adapterIds ? new Set(opts.adapterIds) : null;
  const formatAllow = opts.formats ? new Set(opts.formats) : null;
  const deliveryAllow = opts.deliveries ? new Set(opts.deliveries) : null;

  const results: AdapterRunResult[] = [];

  for (const adapter of adapters) {
    if (idAllow && !idAllow.has(adapter.id)) continue;
    if (formatAllow && !formatAllow.has(adapter.format)) continue;
    const delivery = adapter.delivery ?? 'host-decides';
    if (deliveryAllow && !deliveryAllow.has(delivery)) continue;

    const missing = missingRequiredPaths(adapter.requires, snapshot);

    if (missing.length > 0) {
      results.push({
        adapterId: adapter.id,
        format: adapter.format,
        delivery,
        output: undefined,
        validation: {
          valid: false,
          errors: missing.map((path) => ({
            code: 'missing-required-field',
            path,
            message: `Adapter "${adapter.id}" requires "${path}" (required: 'always') but the snapshot has no value there.`,
            remediation: `Populate "${path}" in the DataSource or a Transformer, or relax the requirement to 'preferred' if the adapter can emit without it.`,
          })),
          warnings: [],
        },
        included: false,
        skipped: { reason: 'missing-required-fields', missing },
      });
      continue;
    }

    const output = await adapter.generate(snapshot, ctx);
    const validation = adapter.validate(output);
    const policy = adapter.onValidationFail ?? 'block-publish';

    if (!validation.valid && policy === 'fail-loud') {
      const err = new Error(
        `[@airo-js/ssr] PublicationAdapter "${adapter.id}" validation failed (onValidationFail='fail-loud'). ` +
          (validation.errors[0]?.message ?? 'no error message'),
      );
      throw err;
    }

    results.push({
      adapterId: adapter.id,
      format: adapter.format,
      delivery,
      output,
      validation,
      included: validation.valid || policy === 'publish-with-warnings',
    });
  }

  return results;
}
