/**
 * PublicationAdapter — fan post-Transformer data out to surface-specific
 * outputs.
 *
 * The load-bearing primitive for products like DotterWTB-Google-publication.
 * A cartridge declares N adapters; the framework runs each on the post-
 * pipeline snapshot to produce the output for that surface (Schema.org
 * JSON-LD, Merchant Center XML, future MCP-tools wrapper, etc.).
 *
 * v0 reference adapters:
 *   - schema-org-json-ld:    inline in widget HTML (Product, Offer, AggregateOffer)
 *   - merchant-center-xml:   signed feed URL per customer per locale
 *
 * Three contract guarantees:
 *   1. **Snapshot fidelity.** Adapters consume the SAME post-Transformer
 *      snapshot that views render and MCP tools answer from. Schema.org
 *      JSON-LD inline, the Merchant Center feed, and any MCP tool all
 *      answer the same question — what the rendered widget shows.
 *   2. **Coverage gating.** Adapters declare `requires` (schema field
 *      paths). Framework can skip an adapter when required fields are
 *      absent rather than emit broken output. Studios surface
 *      "you can't enable adapter X because data is missing field Y" to
 *      the user via this metadata.
 *   3. **Validation as a hard gate.** `validate(output)` runs before the
 *      studio publishes. If `valid: false`, the studio refuses to serve
 *      the output and surfaces errors in the dashboard. The customer-
 *      trust layer — never publish a broken Merchant Center feed.
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
  /** Hint for remediation — surfaced in studio's disapproval log. */
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
  /** ISO 4217 — optional; some adapters need it (Merchant Center). */
  currency?: string;
  /** Customer-side toggles — e.g. SKUs disabled from publication. */
  customerOverrides?: Record<string, unknown>;
}

export interface PublicationAdapter<TData, TOutput, TConfig = unknown> {
  /** Stable identifier — used by studios to enable/disable per-customer. */
  id: string;
  displayName: string;
  description: string;

  /** Output format. Studios route to the right delivery surface based on this. */
  format: 'json-ld' | 'xml' | 'tsv' | 'json' | 'mcp-tools' | 'custom';

  /**
   * Required cartridge schema fields. Used by:
   *   (a) studio shell — to surface coverage gaps to the user;
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
   * Validate the generated output BEFORE the studio publishes. Hard gate:
   * if `valid: false`, the studio refuses to serve the output.
   */
  validate(output: TOutput): ValidationResult;

  /**
   * Refresh cadence hint. Adapter declares the minimum and maximum
   * acceptable interval between regenerations. Studio decides actual
   * cadence within those bounds.
   *
   * Examples:
   *   - schema-org-json-ld:   { min: 0, max: 6h }     (every render is fine)
   *   - merchant-center-xml:  { min: 1h, max: 24h }   (Google polls; daily floor)
   */
  refreshCadence: { min: Duration; max: Duration };

  /**
   * Optional — adapter declares it requires a stable signed URL (vs
   * inlining in the host page). Studios use this to decide hosting.
   */
  delivery?: 'inline-in-host' | 'signed-feed-url' | 'studio-decides';

  /**
   * Per-adapter validation-failure policy. Default `'block-publish'` —
   * never publish broken to Google. Override only with explicit reason.
   */
  onValidationFail?: 'block-publish' | 'publish-with-warnings' | 'fail-loud';
}
