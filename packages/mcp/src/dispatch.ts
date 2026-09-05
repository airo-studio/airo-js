/**
 * Tool dispatch — resolve a tool by name, gate it, invoke it, shape the
 * result.
 *
 * This is the invocation half of the contract `McpToolDefinition` declares.
 * The guarantee it keeps is snapshot fidelity: the `data` a tool answers from
 * is the SAME post-Transformer snapshot the views rendered and the
 * publication adapters published. A host that renders HTML from one snapshot
 * and dispatches a tool against a fresher one has broken the guarantee no
 * matter what this function does, so `snapshot` is a parameter rather than
 * something the framework fetches.
 *
 * ## Why this returns instead of throwing
 *
 * Every outcome here becomes a protocol response. An MCP server must turn
 * "no such tool" into a JSON-RPC error payload, not a crashed request
 * handler, and an agent calling a stale tool name is an ordinary event rather
 * than an exceptional one. Throwing would force a try/catch around every call
 * site and make the common failure indistinguishable from a bug in the host.
 * So `dispatchTool` returns a discriminated union and reserves throwing for
 * nothing at all.
 *
 * ## What this deliberately does not do — M13
 *
 * No transport, no auth, no rate limiting, no tenancy resolution, no session
 * state. Those are host concerns and none of them is rendering or dispatch.
 * `ToolContext.scope` exists so a host can pass its own tenancy through
 * opaquely; the framework never reads it.
 *
 * Input validation is a SEAM rather than a dependency. `inputSchema` is JSON
 * Schema, and validating it needs a JSON Schema validator — a choice with
 * real weight (ajv is ~30 KB) that belongs to the host, which already has one
 * if it serves an API. Pass `validateInput` to enable it; omit it and inputs
 * reach handlers unvalidated, which is documented rather than silent.
 */

import type { Cartridge, ToolContext } from '@airo-js/cartridge-kit';
import { missingRequiredPaths } from '@airo-js/cartridge-kit';

export type McpErrorCode =
  /** No tool with that name is declared on the cartridge. */
  | 'unknown-tool'
  /** Coverage gating: the tool's `required: 'always'` paths hold no value. */
  | 'missing-required-fields'
  /** `validateInput` rejected the input against the tool's `inputSchema`. */
  | 'invalid-input'
  /** The tool's own handler threw. */
  | 'handler-threw'
  // Open on purpose, matching `LogChannel` and `hotSwapKeys` elsewhere in the
  // framework. A closed union would make every future code a 2.0 change,
  // because an exhaustive `switch` with a `never` default breaks on the first
  // addition. Consumers must carry a default branch.
  | (string & {});

export interface McpDispatchError {
  code: McpErrorCode;
  message: string;
  /** Set on `missing-required-fields` — the absent `'always'` paths. */
  missing?: string[];
  /** Set on `invalid-input` — whatever the host's validator reported. */
  validationErrors?: string[];
  /**
   * The value that was thrown, unwrapped. Set on `handler-threw`, and on the
   * `invalid-input` produced when the host's own validator threw instead of
   * returning a verdict.
   *
   * **Do not serialise this to an untrusted caller.** It is whatever the
   * cartridge's own code threw, and handlers routinely close over server
   * credentials — a driver error carrying a connection string is the ordinary
   * case, not a contrived one. Log it host-side; return `code` and `message`.
   */
  cause?: unknown;
}

export type McpDispatchResult =
  | { ok: true; toolName: string; result: unknown }
  | { ok: false; toolName: string; error: McpDispatchError };

export interface DispatchToolOptions<TConfig> {
  /** Cartridge config the tool reads through `ctx.config`. */
  config: TConfig;
  /** BCP-47. Passed through to `ctx.locale`. */
  locale?: string;
  /**
   * Host-supplied tenancy or scoping, opaque to the framework and passed
   * through to `ctx.scope` untouched.
   */
  scope?: Record<string, string | undefined>;
  /**
   * Optional JSON Schema validator. Called with the raw input and the tool's
   * `inputSchema` before the handler runs. Return `valid: false` to reject.
   * Omit to skip input validation entirely.
   */
  validateInput?: (
    input: unknown,
    schema: Record<string, unknown>,
  ) => { valid: boolean; errors?: string[] };
}

/**
 * Invoke one MCP tool against a post-Transformer snapshot.
 *
 * Order is deliberate: resolve, then gate on coverage, then validate input,
 * then invoke. Coverage precedes validation because a well-formed input to a
 * tool that has no data to answer from should report the missing data, not a
 * schema complaint about an input that was fine.
 *
 * `ctx.schema` is taken from `cartridge.schema`, so callers do not construct
 * one. A hand-rolled dispatcher has to invent a stub here; reaching for the
 * cartridge is both simpler and the only way `ctx.schema` is guaranteed to
 * describe the `data` alongside it.
 */
export async function dispatchTool<TData, TConfig>(
  cartridge: Cartridge<TData, TConfig>,
  toolName: string,
  input: unknown,
  snapshot: TData,
  opts: DispatchToolOptions<TConfig>,
): Promise<McpDispatchResult> {
  const declared = cartridge.mcpTools ?? [];
  const tool = declared.find((t) => t.name === toolName);

  if (!tool) {
    const known = declared.map((t) => t.name);
    return {
      ok: false,
      toolName,
      error: {
        code: 'unknown-tool',
        message:
          `Cartridge "${cartridge.id}" declares no MCP tool named "${toolName}". ` +
          (known.length > 0 ? `Known tools: ${known.join(', ')}.` : 'It declares no tools at all.'),
      },
    };
  }

  // Wrapped for the same reason `validateInput` is: this walks an arbitrary
  // `TData` by dotted path, and a snapshot carrying a throwing getter or a
  // revoked Proxy is not exotic when a DataSource returns class instances.
  // An escape here would be the unhandled rejection this package removes.
  let missing: string[];
  try {
    missing = missingRequiredPaths(tool.requires, snapshot);
  } catch (err) {
    return {
      ok: false,
      toolName,
      error: {
        code: 'missing-required-fields',
        message: `Could not read the snapshot to check "${toolName}"'s required paths.`,
        missing: [],
        cause: err,
      },
    };
  }
  if (missing.length > 0) {
    return {
      ok: false,
      toolName,
      error: {
        code: 'missing-required-fields',
        message:
          `Tool "${toolName}" requires ${missing.map((p) => `"${p}"`).join(', ')} ` +
          `(required: 'always'), and the snapshot has no value there.`,
        missing,
      },
    };
  }

  if (opts.validateInput) {
    // The validator is host code, and the common shape wraps a JSON Schema
    // library — ajv throws on a malformed schema rather than returning false.
    // Calling it outside this try would let one bad `inputSchema` become the
    // unhandled rejection this package exists to remove from a host's request
    // handler, and would make the "never throws" contract above a lie.
    let verdict: { valid: boolean; errors?: string[] };
    try {
      verdict = opts.validateInput(input, tool.inputSchema);
    } catch (err) {
      return {
        ok: false,
        toolName,
        error: {
          code: 'invalid-input',
          message:
            `The validator for tool "${toolName}" threw rather than returning a verdict — ` +
            `usually a malformed inputSchema. ` +
            `${err instanceof Error ? err.message : String(err)}`,
          validationErrors: [],
          cause: err,
        },
      };
    }
    if (!verdict.valid) {
      return {
        ok: false,
        toolName,
        error: {
          code: 'invalid-input',
          message: `Input to tool "${toolName}" failed validation against its inputSchema.`,
          validationErrors: verdict.errors ?? [],
        },
      };
    }
  }

  const ctx: ToolContext<TData, TConfig> = {
    data: snapshot,
    config: opts.config,
    schema: cartridge.schema,
    ...(opts.locale !== undefined ? { locale: opts.locale } : {}),
    ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
  };

  try {
    const result = await tool.handler(input, ctx);
    return { ok: true, toolName, result };
  } catch (err) {
    // A handler that throws is the cartridge author's bug, but it reaches us
    // as one agent request among many — the host still owes the client a
    // response, and the other tools still work.
    return {
      ok: false,
      toolName,
      error: {
        code: 'handler-threw',
        // Deliberately does NOT interpolate the thrown message. A handler
        // closing over server credentials is the normal case for this package
        // (see the README), and every host wiring in our own docs forwards
        // this object straight to the caller — so anything folded in here
        // reaches an agent. The detail lives on `cause`, which a host opts
        // into logging and must not serialise to an untrusted client.
        message: `Tool "${toolName}" threw. See \`cause\` for detail; do not return it to the caller.`,
        cause: err,
      },
    };
  }
}
