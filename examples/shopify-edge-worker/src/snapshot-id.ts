/**
 * snapshotId computation — stable hash of the post-Transformer data.
 *
 * v0 placeholder for framework Ask 2 (RenderContext.snapshotId on
 * the bridge: msg_mpgtzyld_19ef1e). When the framework hoists this
 * into `RenderContext`, delete this file and read `ctx.snapshotId`
 * everywhere instead.
 *
 * Algorithm: SHA-256 of the canonical JSON serialization of the
 * snapshot's data fields, truncated to 16 hex chars. Stable so the
 * same data → same id; collision risk is negligible for the demo's
 * cardinality. Uses Web Crypto SubtleCrypto — available in
 * Cloudflare Workers, Deno, Bun, modern Node, and browsers.
 *
 * Snapshot-id timing convention:
 * compute post-pipeline, pre-PostProcessor. This example has no
 * pipeline, so we hash the DataSource output.
 */

/**
 * Canonicalize an object so equivalent shapes hash to the same id.
 * Sorts keys deterministically and stringifies. Doesn't handle cycles
 * (not expected for snapshot shapes).
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`);
  return `{${parts.join(',')}}`;
}

/**
 * Hash a snapshot to a 16-char hex id. Stable across renders for the
 * same input data.
 */
export async function hashSnapshot(snapshot: unknown): Promise<string> {
  const canonical = canonicalize(snapshot);
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return hex.slice(0, 16);
}
