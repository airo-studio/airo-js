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

  handler(input: unknown, ctx: ToolContext<TData, TConfig>): Promise<unknown>;
}
