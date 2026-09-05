# `@airo-js/mcp`

MCP tool manifest emission and dispatch for airo-js cartridges.

Cartridges declare agent-facing tools as `McpToolDefinition` entries in
`@airo-js/cartridge-kit`. This package turns those declarations into the two
operations an MCP server performs: advertise the tools, and invoke one.

## The guarantee

Tools answer from the **same post-Transformer snapshot** the views rendered and
the publication adapters published. Three readers, one source of truth — so the
rendered page, the indexed feed and the agent's answer cannot disagree.

`dispatchTool` takes the snapshot as a parameter rather than fetching one,
because a host that renders from one snapshot and dispatches against a fresher
one has already broken the guarantee, whatever this package does.

## What's in here

### `buildToolManifest(cartridge, opts?)`

Returns MCP's `tools/list` payload — `{ tools: [{ name, description,
inputSchema }] }` — and nothing else. `handler` is not serialisable and
`requires` is coverage metadata a client cannot act on.

Pure and synchronous. A cartridge with no `mcpTools` yields `{ tools: [] }`
rather than throwing.

`opts.toolNames` restricts the set. `opts.snapshot` additionally omits tools
whose `required: 'always'` paths that snapshot cannot cover — **off by
default**, because MCP clients cache tool lists and a tool that appears and
disappears as data changes is worse for an agent than one that is always
listed and sometimes answers `missing-required-fields`, which at least names
what is missing.

### `dispatchTool(cartridge, toolName, input, snapshot, opts)`

Resolves the tool, gates it on coverage, optionally validates the input, then
invokes it. Returns a discriminated union:

```ts
{ ok: true,  toolName, result }
{ ok: false, toolName, error: { code, message, missing?, validationErrors?, cause? } }
```

`code` is one of `'unknown-tool'`, `'missing-required-fields'`,
`'invalid-input'`, `'handler-threw'`.

**It never throws.** Every outcome becomes a protocol response, and an agent
calling a stale tool name is ordinary rather than exceptional — throwing would
turn that into a crashed request handler and make the common failure
indistinguishable from a bug in the host.

`ctx.schema` is taken from `cartridge.schema`, so callers never construct one.

## Scope

Emission and dispatch. **Not** transport, auth, rate limiting, tenancy or
session state — those are host concerns, and none of them is rendering or
dispatch. `ToolContext.scope` carries a host's tenancy through opaquely; the
framework never reads it.

Input validation is a **seam**, not a dependency. `inputSchema` is JSON Schema,
and validating it needs a validator — a choice with real weight that belongs to
the host, which already has one if it serves an API. Pass `validateInput` to
enable it; omit it and inputs reach handlers unvalidated, which is documented
rather than silent.

## Install

```bash
npm install @airo-js/mcp @airo-js/cartridge-kit
```

`@airo-js/cartridge-kit` is a peer dependency.

**Server-only.** Ship MCP tools from a cartridge's `full.ts` envelope, never
from `runtime.ts` — see best-practices §2.5. A handler closing over server
credentials is the normal case.

## Example

```ts
import { buildToolManifest, dispatchTool } from '@airo-js/mcp';

app.get('/mcp/tools', (_req, res) => {
  res.json(buildToolManifest(cartridge));
});

app.post('/mcp/call', async (req, res) => {
  const snapshot = await snapshotFor(req.body.slug);
  const out = await dispatchTool(
    cartridge, req.body.name, req.body.arguments, snapshot, { config },
  );
  res.status(out.ok ? 200 : 400).json(out);
});
```

Working versions in [`examples/full-site`](../../examples/full-site) (Express,
one cartridge serving HTML, JSON-LD, `llms.txt` and MCP off one snapshot) and
[`examples/shopify-edge-worker`](../../examples/shopify-edge-worker) (two
cartridges on one Cloudflare Worker).

## License

Apache-2.0
