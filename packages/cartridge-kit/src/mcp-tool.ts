/**
 * MCP tool definition.
 *
 * Agent-facing tool. The contract guarantees `data` is POST-transformer
 * (matches what the rendered widget shows), so tools can't drift from the
 * user-visible state. Read-only at v0; writable tools deferred to v1+.
 *
 * Same data-coupling guarantee as PublicationAdapter — both consume the
 * post-pipeline snapshot. Three readers (views, MCP tools, publication
 * adapters), one source of truth.
 */

import type { SchemaDefinition } from './cartridge.js';
import type { SchemaFieldRef } from './publication-adapter.js';

export interface ToolContext<TData, TConfig> {
  /** POST-transformer data — same data the user sees in the widget. */
  data: TData;
  config: TConfig;
  schema: SchemaDefinition<TData>;
  locale?: string;

  /**
   * Host-app-supplied scope. Optional and opaque to the framework — host
   * apps pass whatever scoping their tenancy model requires (e.g.
   * tenant_id, locale, user_id). Cartridges read what they need; tools
   * that don't need scope ignore.
   */
  scope?: Record<string, string | undefined>;
}

export interface McpToolDefinition<TData, TConfig = unknown> {
  /** Tool identifier — visible to MCP clients. */
  name: string;
  description: string;
  /** JSON Schema for the tool's input. */
  inputSchema: Record<string, unknown>;

  /**
   * Snapshot fields this tool answers from — the same coverage-gating
   * metadata `PublicationAdapter.requires` carries, and gated by the same
   * shared predicate (`missingRequiredPaths`), so a feed and an agent answer
   * cannot disagree about which snapshots are answerable.
   *
   * `dispatchTool` refuses a tool whose `required: 'always'` paths hold no
   * value, returning `code: 'missing-required-fields'` rather than letting
   * the handler invent an answer from absent data. `'preferred'` and
   * `'optional'` do not gate — a tool that can answer partially should say
   * so in its own handler.
   *
   * Optional, unlike the adapter's, because most tools read the snapshot
   * broadly rather than depending on named leaves. Omitting it means "runs
   * against any snapshot", which is also what `[]` means.
   */
  requires?: readonly SchemaFieldRef[];

  handler(input: unknown, ctx: ToolContext<TData, TConfig>): Promise<unknown>;
}
