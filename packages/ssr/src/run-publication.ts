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

export interface RunPublicationOptions {
  /** Allowlist by adapter id. Empty/undefined = include all. */
  adapterIds?: string[];
  /** Include only these formats. Empty/undefined = include all. */
  formats?: PublicationAdapter<unknown, unknown, unknown>['format'][];
  /** Include only these delivery modes. Empty/undefined = include all. */
  deliveries?: NonNullable<PublicationAdapter<unknown, unknown, unknown>['delivery']>[];
}

export interface AdapterRunResult {
  adapterId: string;
  format: PublicationAdapter<unknown, unknown, unknown>['format'];
  delivery: NonNullable<PublicationAdapter<unknown, unknown, unknown>['delivery']>;
  output: unknown;
  validation: ValidationResult;
  /**
   * True when the caller should publish this output. False when
   * `onValidationFail: 'block-publish'` (the default) and validation
   * failed — output is in the result for diagnostic, but the host app
   * MUST NOT serve it downstream.
   */
  included: boolean;
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
