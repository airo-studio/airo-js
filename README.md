# airo-js

**The rendering-only substrate behind config-driven, plugin-loaded UI.**

`airo-js` is the framework cartridges build on. It owns rendering, lifecycle, style isolation, page routing, and the cartridge-kit contract — and **nothing else**. Drafts, history, auth, tenancy, tokens, and per-studio storage are explicitly outside the framework.

## Status

`v0.0.x` — scaffolding stage. Not published. Layout is being validated against representative cartridge skeletons before any 1.0 commitment.

See `CHANGELOG.md` for what's landing where.

## Packages

| Package | Role |
|---|---|
| `@ai-ro/core` | Runtime engine — `createApp`, `PageManager`, `EventBus`, `Theme`, `IsolationRoot`, `registry`. |
| `@ai-ro/runtime` | Layout chunk loader + hydration glue between core and per-page bundles. |
| `@ai-ro/ssr` | Edge SSR pipeline — `renderAppToHTML` + runtime-agnostic dispatch. |
| `@ai-ro/embed` | ~5 KB bootstrap loader — what customers paste in their HTML. |
| `@ai-ro/mcp` | MCP tool emission helpers — cartridge-defined tools surface here. |
| `@ai-ro/cartridge-kit` | The cartridge contract: `Cartridge<TSchema, TConfig>` + DataSource / View / MCP-tool / Template primitives. |

## Hard scope line

Rendering, lifecycle, style isolation, page routing, MCP tool emission, runtime-agnostic SSR dispatch — yes.
Drafts, history, auth, tenancy, scope isolation, draft locks, token rotation, load endpoints, row-level security — **never** here. Those live in consuming studios, not in the framework.

## Development

```bash
pnpm install
pnpm typecheck
pnpm build
```

Use `pnpm link --global` from a package dir to consume it from a sibling repo during development.

## License

Apache 2.0 — see [LICENSE](./LICENSE).
