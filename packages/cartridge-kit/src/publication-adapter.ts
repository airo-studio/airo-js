/**
 * PublicationAdapter — fan post-Transformer data out to surface-specific
 * outputs.
 *
 * The load-bearing primitive for cartridges that publish typed feeds. A
 * cartridge declares N adapters; the framework runs each on the post-
 * pipeline snapshot to produce the output for that surface (Schema.org
 * JSON-LD, vendor XML feeds, MCP-tools wrappers, etc.).
 *
 * Example adapter shapes:
 *   - inline JSON-LD:   embedded in host page HTML
 *   - signed XML feed:  stable URL polled by an external indexer, scoped
 *                       per tenant and locale
 *
 * Three contract guarantees:
 *   1. **Snapshot fidelity.** Adapters consume the SAME post-Transformer
 *      snapshot that views render and MCP tools answer from. Inline
 *      JSON-LD, an XML feed, and any MCP tool all answer the same
 *      question — what the rendered widget shows.
 *   2. **Coverage gating.** Adapters declare `requires` (schema field
 *      paths). Framework can skip an adapter when required fields are
 *      absent rather than emit broken output. Host apps surface
 *      "you can't enable adapter X because data is missing field Y" to
 *      the user via this metadata.
 *   3. **Validation as a hard gate.** `validate(output)` runs before the
 *      host app publishes. If `valid: false`, the host app refuses to
 *      serve the output and surfaces errors. The trust layer — never
 *      publish a broken feed to a downstream indexer.
 */

export type Duration = { ms: number };

export interface SchemaFieldRef {
  /** Dotted path into the cartridge schema. e.g. 'product.gtin'. */
  path: string;
  /** Cardinality requirement. */
  required: 'always' | 'preferred' | 'optional';
}

export interface ValidationError {
  code: string;
  /** Path into the output where validation failed. */
  path?: string;
  message: string;
  /** Hint for remediation — surfaced in the host app's error log. */
  remediation?: string;
}

export interface ValidationWarning {
  code: string;
  path?: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  /** How much of the schema the adapter covered, if computable. */
  coverage?: { covered: number; total: number };
}

export interface PublicationContext<TConfig = unknown> {
  config: TConfig;
  /** BCP-47 — 'en-GB', 'en-US', etc. */
  locale: string;
  /** ISO 3166-1 alpha-2 — 'GB', 'US'. */
  country: string;
  /** ISO 4217 — optional; some adapters need it (e.g. priced feeds). */
  currency?: string;
  /** Tenant-side toggles — e.g. items disabled from publication. */
  tenantOverrides?: Record<string, unknown>;
}

export interface PublicationAdapter<TData, TOutput, TConfig = unknown> {
  /** Stable identifier — used by host apps to enable/disable per-tenant. */
  id: string;
  displayName: string;
  description: string;

  /** Output format. Host apps route to the right delivery surface based on this. */
  format: 'json-ld' | 'xml' | 'tsv' | 'json' | 'mcp-tools' | 'custom';

  /**
   * Required cartridge schema fields. Used by:
   *   (a) host app — to surface coverage gaps to the user;
   *   (b) framework — to skip the adapter if required fields are absent
   *       rather than emit broken output;
   *   (c) validation — to gate `enable()` on coverage threshold.
   */
  requires: SchemaFieldRef[];

  /**
   * Generate the surface-specific output from a post-Transformer snapshot.
   * Async because real adapters do non-trivial work (image validation,
   * external taxonomy lookups, locale mappings).
   */
  generate(snapshot: TData, ctx: PublicationContext<TConfig>): Promise<TOutput>;

  /**
   * Validate the generated output BEFORE the host app publishes. Hard gate:
   * if `valid: false`, the host app refuses to serve the output.
   */
  validate(output: TOutput): ValidationResult;

  /**
   * Refresh cadence hint. Adapter declares the minimum and maximum
   * acceptable interval between regenerations. Host app decides actual
   * cadence within those bounds.
   *
   * Examples:
   *   - inline JSON-LD:    { min: 0, max: 6h }     (every render is fine)
   *   - signed XML feed:   { min: 1h, max: 24h }   (external poller; daily floor)
   */
  refreshCadence: { min: Duration; max: Duration };

  /**
   * Optional — adapter declares it requires a stable signed URL (vs
   * inlining in the host page). Host apps use this to decide hosting.
   */
  delivery?: 'inline-in-host' | 'signed-feed-url' | 'host-decides';

  /**
   * Per-adapter validation-failure policy. Default `'block-publish'` —
   * never publish broken output downstream. Override only with explicit reason.
   */
  onValidationFail?: 'block-publish' | 'publish-with-warnings' | 'fail-loud';
}
