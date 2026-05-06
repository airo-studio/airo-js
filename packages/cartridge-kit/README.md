# `@ai-ro/cartridge-kit`

The cartridge contract for the airo framework. Defines the API surface every cartridge implements and every studio shell consumes.

> Status: **v0.2.0-rc.x**. Validation pair (WTB skeleton + PublicationAdapter pair skeleton) compiles. Surface still subject to refinement; cartridges should target `^0.2` until `1.0` ships.

## What's in here

- `Cartridge<TData, TConfig>` — the envelope every cartridge implements
- `DataSource` — onboarding affordances + data-loading shape
- `Transformer` / `PostProcessor` / `RuntimePipeline` — runtime pipeline (re-exported from `@ai-ro/core`; pipeline orchestration is rendering, M13)
- `ViewDefinition` + `CartridgeAppContext` — typed wrapper around the framework's `PageRenderer`
- `Template<TConfig>` — pre-composed view-set + default config
- `McpToolDefinition` — agent-facing tools (POST-transformer data)
- `PublicationAdapter` — fan post-pipeline data out to surface-specific outputs (Schema.org JSON-LD, vendor XML feeds, etc.)
- Supporting: `SchemaDefinition`, `OnboardingStep`, `ValidationResult`, `PublicationContext`, `SchemaFieldRef`, `Duration`

## Three contract guarantees

1. **Snapshot fidelity.** Views, MCP tools, and publication adapters all consume the SAME post-Transformer snapshot. No drift between what the rendered widget shows, what an agent answers, and what a downstream indexer consumes.
2. **Coverage gating.** Adapters declare `requires` (schema field paths). The framework can skip an adapter when required fields are absent rather than emit broken output. Studios surface "this adapter needs field X" to the user via this metadata.
3. **Validation as a hard gate.** `validate(output)` runs before the studio publishes. If `valid: false`, the studio refuses to serve the output. Output trust > publish velocity.

## Authoring conventions

### Transformer is shape-preserving (not for schema pivots)

`Transformer.transform: (data: TData, ctx) => TData` — input and output are the same type. Use Transformer for **filter, sort, group, annotate**.

If you need to **pivot the schema** (e.g. flat `Product → SKU` becomes nested `Product → Sku → Offer`), reshape **upstream in `DataSource.fetch`**, not in a Transformer. The Transformer chain assumes a stable shape so views, MCP tools, and publication adapters can each project the same snapshot consistently.

```ts
// ✅ Reshape in DataSource.fetch
const myDataSource: DataSource<NestedShape, MyConfig> = {
  fetch: async (input, ctx) => {
    const flat = await fetchFlatData(input);
    return pivotToNested(flat); // Pivot here, not in a Transformer.
  },
};

// ❌ Don't try to change shape in a Transformer
const reshape: Transformer<UnknownShape, MyConfig> = {
  transform: (data) => pivotToNested(data), // Won't typecheck — TData → TData.
};
```

### Two-envelope pattern for browser/server bundle separation

The `Cartridge` envelope holds references to everything: transformers, views, MCP tools, publication adapters. Tree-shaking can't help when the envelope itself is the import — bundlers see the references and pull all of them in.

PublicationAdapters and MCP tools are typically server-only (they reference disapproval rules, taxonomy mappings, image validation, model SDKs — anywhere from 10 KB to 50+ KB each). Shipping those bytes to the browser is wasteful and exposes proprietary IP.

**Convention: ship two envelopes per cartridge.**

```
my-cartridge/
├── parts/
│   ├── schema.ts                 ← Zod, single source of truth
│   ├── transformers.ts           ← shared (browser + server)
│   ├── data-sources.ts           ← shared
│   ├── views/                    ← shared (page chunks)
│   ├── publication-adapters/     ← server-only
│   └── mcp-tools.ts              ← server-only
├── runtime.ts                    ← browser entry: schema, transformers, views, dataSources
└── full.ts                       ← server entry: everything (re-exports runtime + adds adapters/mcp)
```

`runtime.ts` exports a `Cartridge` with `publicationAdapters` and `mcpTools` undefined. `full.ts` re-exports the same `Cartridge` but with those slots populated. Browser builds import from `<my-cartridge>/runtime`; SSR / publication-runner builds import from `<my-cartridge>/full`.

This is **transparent**: no build-time magic, no conditional exports tooling. Cartridge author writes the split once. Bundlers tree-shake at the package boundary; nothing leaks.

### errorPolicy on Transformers

Each Transformer can declare `errorPolicy: 'fail-render' | 'skip'`. Default is `'fail-render'` — when a transform throws, the render breaks (mirrors v1 production). Pick `'skip'` only for transforms whose absence degrades gracefully (sort, enrichment). **Never** use `'skip'` for filters whose absence widens visibility past a tenant's configured scope.

```ts
const enrichWithRatings: Transformer<MyData, MyConfig> = {
  name: 'enrich-with-ratings',
  isEnabled: () => true,
  transform: (data) => attachRatings(data),
  errorPolicy: 'skip', // Ratings are nice-to-have; don't break render if the rating service is down.
};

const filterByTenant: Transformer<MyData, MyConfig> = {
  name: 'filter-by-tenant',
  isEnabled: () => true,
  transform: (data, ctx) => data.filter((item) => item.tenantId === ctx.config.tenantId),
  // Default errorPolicy: 'fail-render' — never silently widen tenant visibility.
};
```

### Default RuntimePipeline implementation

Studios that want default semantics use `createPipeline` from `@ai-ro/core`:

```ts
import { createPipeline } from '@ai-ro/core';

const pipeline = createPipeline(cartridge.transformers ?? [], cartridge.postProcessors ?? []);

// Run on every render:
const snapshot = pipeline.runTransformers(rawData, { config, navState, locale });

// Mount post-processors after view renders, collect teardown:
const teardown = pipeline.runPostProcessors({ container, config, data: snapshot, events, navState });
// On unmount:
teardown();
```

Studios with custom semantics (async support, custom error reporting, OTel tracing) implement their own `RuntimePipeline<TData, TConfig>`.

### Gate persistence is metadata, not behaviour

`Gate.persist` is a hint cartridges declare; **the framework writes nothing based on it**. Studios implement the actual storage primitive — cookies, localStorage, server-side session table — with their own compliance posture (sameSite, domain rules, GDPR scope, SSO interaction).

This mirrors how `DataSource.cacheTtlMs` works: cartridge declares the hint, studio decides actual cache policy. Same shape, same envelope.

```ts
const ageGate: Gate<MyConfig> = {
  id: 'age-verification',
  // ... isEnabled, precheck, mount, destroy
  persist: {
    key: 'wtb:age-verified',
    ttl: 30 * 24 * 60 * 60 * 1000, // 30 days
    scope: 'persistent',
  },
};
```

**Studio side**, two patterns. Pattern A — read in `precheck`, write before `mount` returns `'allow'`:

```ts
precheck: async (ctx) => {
  const cookie = readMyStudioCookie(myGate.persist.key);
  return cookie && !expired(cookie) ? 'allow' : 'gate-required';
},

mount: async (host, ctx) => {
  // ... paint UI, await user verification
  if (verified) {
    writeMyStudioCookie(myGate.persist.key, { /* ... */ }, myGate.persist.ttl);
    return 'allow';
  }
  return 'block';
},
```

Pattern B — studios with their own auth/session stack skip `persist` entirely and use their existing primitives directly (e.g. session tokens from a hosted auth provider, or a self-managed session store). The studio ignores `Gate.persist` and writes through its existing layer.

**Future**: a separate `@ai-ro/gate-persist` helper package may ship for greenfield studios that want a default `writeGatePersist({ key, ttl, scope })`. Opt-in. Not in `@ai-ro/core` or `@ai-ro/cartridge-kit` — those stay rendering-only.

## Boot sequence

A studio shell mounting a cartridge follows this sequence:

```ts
import { createApp } from '@ai-ro/core';
import {
  createCartridgeRegistry,
  createCartridgeApp,
  createPipeline,
} from '@ai-ro/cartridge-kit';

import { wtbCartridge } from '@my-org/wtb-cartridge';

// 1. Build the registry. Multi-cartridge studios pass an array; single-
//    cartridge studios pass one. Cartridges can also be added later via
//    registry.register(...).
const registry = createCartridgeRegistry([wtbCartridge]);

// 2. Studio user picks a template (UI-driven). For headless boot, default
//    to cartridge.defaultTemplateId.
const cartridge = registry.get('wtb')!;
const template = cartridge.templates.find(
  (t) => t.id === cartridge.defaultTemplateId,
)!;

// 3. Build the AppConfig the framework consumes. Pages come from the
//    template; layout/styles default to whatever the cartridge ships
//    in its component metadata. Studios with their own page editor
//    rewrite the page tree here.
const appConfig = {
  appId: 'my-widget-id',
  pages: template.pages.map((p) => ({
    ...p,
    layout: { regionOrder: [], regions: {} },
  })),
};

// 4. Load data via the cartridge's DataSource and run the pipeline.
//    Snapshot is what views, MCP tools, and publication adapters all read.
const dataSource = cartridge.dataSources[0];
const rawData = await dataSource.fetch(input, { config });
const pipeline = createPipeline(
  cartridge.transformers ?? [],
  cartridge.postProcessors ?? [],
);
const snapshot = pipeline.runTransformers(rawData, { config, navState: { page: '' } });

// 5. Mount. createCartridgeApp builds CartridgeAppContext, derives the
//    resolveRenderer from the cartridge's views[], and delegates to
//    createApp.
const app = createCartridgeApp(cartridge, appConfig, snapshot, config, {
  host: containerEl,
  enableRouter: true,
  // resolveRenderer auto-derived; pass registry.resolverFor('wtb') to use
  // the multi-cartridge / chunk-mailbox resolution path instead.
});
```

### Multi-cartridge resolution

When a studio runs more than one cartridge, pass `registry.resolverFor(cartridgeId)` instead of letting `createCartridgeApp` walk a single cartridge's `views[]`:

```ts
const app = createCartridgeApp(cartridge, appConfig, snapshot, config, {
  host: containerEl,
  resolveRenderer: registry.resolverFor('wtb'),
});
```

The registry's resolver checks the cartridge's static `views[]` first, then falls back to the per-cartridge chunk mailbox (named by `cartridge.mailboxName`). Cartridges shipping views as separate chunks register them via `pushToMailbox(cartridge.mailboxName, { key: pageType, factory })` from each chunk's IIFE — same pattern as v1's plugin self-registration.

## Validation skeletons

Two compile-only skeletons live in `examples/` of the airo-js repo and prove the contract holds:

- `examples/cartridge-wtb-skeleton/` — full Cartridge envelope with 6 transformers, 4 views, 1 template, 3 MCP tools, 2 publication adapters.
- `examples/publication-adapter-skeleton/` — two adapters (JSON-LD inline + XML signed-feed) sharing one snapshot type. Stresses fan-out.

Run `pnpm typecheck` from the workspace root to verify both still compile.

## Contract feedback loop

Cartridge authors finding gaps in the contract: open an issue with a minimal repro. The contract's verification gate (per the migration plan §M6) is "the WTB cartridge + at least one PublicationAdapter pair compile, with no `any`." If your cartridge needs `any` to fit the contract, that's a gap worth surfacing.

## License

Apache 2.0.
