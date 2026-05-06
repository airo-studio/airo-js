/**
 * @ai-ro/mcp — MCP tool emission + dispatch helpers.
 *
 * Cartridges declare their MCP tools via `McpToolDefinition<TSchema>` in
 * @ai-ro/cartridge-kit. This package handles registration into the studio's
 * tool surface and the invocation plumbing (input validation, schema-aware
 * data-access, response shaping). Phase 0.5 designs the data-access
 * contract — see migration plan §Phase 0.5.
 */

export const PACKAGE_NAME = '@ai-ro/mcp';
