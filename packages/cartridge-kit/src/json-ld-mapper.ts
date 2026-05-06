/**
 * JSON-LD mapper — schema.org generators per data slice.
 *
 * @deprecated v0.2 — use a `PublicationAdapter` with `format: 'json-ld'`
 * instead. Kept in the contract for one minor version (v0.2 → v0.3) so
 * v1's existing inline JSON-LD code can land in the WTB cartridge without
 * being rewritten to `PublicationAdapter` shape on day 1. Removed in v0.3
 * once SchemaOrgJsonLdAdapter is canonical and all WTB JSON-LD output
 * flows through `PublicationAdapter`.
 */

export interface JsonLdMapper<TData> {
  /** schema.org type name — 'Menu', 'Product', 'RealEstateListing'. */
  type: string;
  toJsonLd(data: TData): Record<string, unknown>;
}
