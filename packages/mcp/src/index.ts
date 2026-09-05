/**
 * @airo-js/mcp — MCP tool emission + dispatch.
 *
 * Cartridges declare agent-facing tools via `McpToolDefinition` in
 * `@airo-js/cartridge-kit`; this package turns those declarations into the
 * two operations an MCP server performs — advertise the tools
 * (`buildToolManifest`) and invoke one (`dispatchTool`).
 *
 * ## The guarantee
 *
 * Tools answer from the SAME post-Transformer snapshot the views rendered
 * and the publication adapters published. Three readers, one source of
 * truth — so the rendered widget, the indexed feed and the agent's answer
 * cannot disagree. `dispatchTool` takes the snapshot as a parameter rather
 * than fetching one, because a host that renders from one snapshot and
 * dispatches against a fresher one has already broken the guarantee.
 *
 * Coverage gating uses the same `missingRequiredPaths` predicate as
 * `runPublicationAdapters`, so a feed and an agent answer reading the same
 * field cannot reach opposite verdicts about whether it is answerable.
 *
 * ## Scope — M13
 *
 * Emission and dispatch only. Transport (HTTP, stdio, SSE), auth, rate
 * limiting, tenancy and session state are host concerns; none of them is
 * rendering or dispatch. `ToolContext.scope` carries a host's tenancy through
 * opaquely and the framework never reads it. Input validation is a seam
 * (`validateInput`), not a bundled JSON Schema validator.
 *
 * ## Envelope
 *
 * Server-only. Ship MCP tools from a cartridge's `full.ts` envelope, never
 * from `runtime.ts` — see best-practices §2.5. Nothing here is browser-safe
 * by intent, and a handler closing over server credentials is the normal
 * case.
 *
 * @example
 * ```ts
 * import { buildToolManifest, dispatchTool } from '@airo-js/mcp';
 *
 * app.get('/mcp/tools', (_req, res) => res.json(buildToolManifest(cartridge)));
 *
 * app.post('/mcp/call', async (req, res) => {
 *   const snapshot = await snapshotFor(req.body.page);
 *   const out = await dispatchTool(
 *     cartridge, req.body.name, req.body.arguments, snapshot, { config },
 *   );
 *   res.status(out.ok ? 200 : 400).json(out);
 * });
 * ```
 */

export type {
  McpToolManifest,
  McpToolManifestEntry,
  BuildToolManifestOptions,
} from './manifest.js';
export { buildToolManifest } from './manifest.js';

export type {
  McpErrorCode,
  McpDispatchError,
  McpDispatchResult,
  DispatchToolOptions,
} from './dispatch.js';
export { dispatchTool } from './dispatch.js';

export const PACKAGE_NAME = '@airo-js/mcp';
/** Package version — publish preflight asserts this matches package.json. */
export const VERSION = '0.10.0';
