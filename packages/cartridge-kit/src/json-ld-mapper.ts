/**
 * JSON-LD mapper — schema.org generators per data slice.
 *
 * @deprecated v0.2 — use a `PublicationAdapter` with `format: 'json-ld'`
 * instead. Kept in the contract for one minor version (v0.2 → v0.3) so
 * existing inline JSON-LD code can land without being rewritten to the
 * `PublicationAdapter` shape on day 1. Removed in v0.3 once
 * `PublicationAdapter` with `format: 'json-ld'` is the canonical path.
 */

export interface JsonLdMapper<TData> {
  /** schema.org type name — 'Menu', 'Product', 'RealEstateListing'. */
  type: string;
  toJsonLd(data: TData): Record<string, unknown>;
}
