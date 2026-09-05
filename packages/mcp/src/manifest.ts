/**
 * Tool manifest emission — what an MCP client sees when it asks what this
 * cartridge can answer.
 *
 * The shape is MCP's `tools/list` payload: `{ tools: [{ name, description,
 * inputSchema }] }`. Nothing more, because everything else on
 * `McpToolDefinition` is framework bookkeeping — `handler` is not
 * serialisable and `requires` is coverage metadata the client cannot act on.
 */

import type { Cartridge, McpToolDefinition } from '@airo-js/cartridge-kit';
import { missingRequiredPaths } from '@airo-js/cartridge-kit';

/** One entry in the manifest — MCP's tool descriptor, and only that. */
export interface McpToolManifestEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolManifest {
  tools: McpToolManifestEntry[];
}

export interface BuildToolManifestOptions<TData> {
  /**
   * When given, tools whose `required: 'always'` paths are absent from this
   * snapshot are omitted from the manifest.
   *
   * Off by default, and worth understanding before turning it on. A manifest
   * is usually static capability advertisement, and MCP clients cache it — a
   * tool that appears and disappears between calls as data changes is worse
   * for an agent than one that is always listed and sometimes answers
   * `missing-required-fields`, because the error names what is missing and a
   * silent absence does not.
   *
   * Pass it when the manifest is built per-request against a snapshot the
   * client will keep for exactly that request, which is the case where
   * advertising an unanswerable tool is the greater harm.
   */
  snapshot?: TData;
  /** Restrict to these tool names, in the cartridge's declaration order. */
  toolNames?: string[];
}

/**
 * Build the MCP tool manifest for a cartridge. Pure and synchronous — no
 * snapshot needed unless you are filtering on coverage.
 *
 * A cartridge with no `mcpTools` yields `{ tools: [] }` rather than throwing:
 * "this cartridge answers no agent questions" is a legitimate configuration,
 * and a host serving several cartridges should not have to special-case it.
 */
export function buildToolManifest<TData, TConfig>(
  cartridge: Cartridge<TData, TConfig>,
  opts: BuildToolManifestOptions<TData> = {},
): McpToolManifest {
  const declared = (cartridge.mcpTools ?? []) as McpToolDefinition<TData, TConfig>[];
  const allow = opts.toolNames ? new Set(opts.toolNames) : null;

  const tools: McpToolManifestEntry[] = [];
  for (const tool of declared) {
    if (allow && !allow.has(tool.name)) continue;
    if (opts.snapshot !== undefined) {
      if (missingRequiredPaths(tool.requires, opts.snapshot).length > 0) continue;
    }
    tools.push({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    });
  }

  return { tools };
}
