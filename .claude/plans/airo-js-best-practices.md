---
name: @airo-js best-practice guide — the v0 cartridge shape
description: Distilled lessons from the v1 → v0 → cartridge migration (dotter-widget-studio + dotter-monorepo), captured as authoring conventions, architecture patterns, and anti-patterns. The reference doc cartridge authors and host-app developers consult before designing or extending. Updated whenever a finding from a new cartridge port reveals a new pattern. Lives in airo-js/.claude/plans/ for now; promotes to airo-js/docs/ when the project goes public.
---

# `@airo-js` best-practice guide — the v0 cartridge shape

## Context

Three weeks of migration work (dotter-widget-studio v1 → v0 → cartridge, dotter-monorepo cartridge port) surfaced a set of patterns that work and traps that don't. This doc captures them as a forward-looking reference: **future cartridge authors consult this before designing; framework team consults this before extending the contract.**

Distilled from:
- The v0 lift-and-shift in `dotter-widget-studio/src/widget-runtime-v0/` (the empirically-validated shape)
- The cartridge port in `dotter-monorepo/apps/dotter-studio/src/cartridges/commerce/` (the second consumer that pressure-tested everything)
- Three formal review passes (B1 architecture, B1.5 renderer port, B1.5 bundle audit)
- The findings docs (`airo-cartridge-kit-spike-findings.md` in the monorepo, six findings across two passes)

## How to use this guide

- **Cartridge authors** — read top to bottom before writing your first cartridge. The first three sections (Authoring conventions, Architecture patterns, Anti-patterns) are 80% of what you need.
- **Framework team** — consult before extending the cartridge-kit contract. If a proposed addition violates one of the architectural patterns or anti-patterns here, push back or update this doc with the new finding.
- **Host-app developers** (studios consuming cartridges) — focus on Sections 4 (Host app patterns) and 5 (Reference implementations).
- **All** — when something doesn't fit a pattern here, that's a finding worth surfacing. Open an issue in airo-js + this doc grows.

---

## 1. Authoring conventions (per primitive)

### 1.1 `Cartridge<TData, TConfig>` envelope

**Cartridge config (`TConfig`) holds editable surface only.** Fields a studio user (or template author) toggles. Country, locale, feature flags, retailer/data filters. **Not** widget identity (`widgetId`), studio version pins (`runtimeVersion`), or runtime brand (`app.runtime`). Those are studio-shell concerns, not cartridge concerns.

**Cartridge data (`TData`) matches what views/transformers/MCP tools consume.** NOT what publishers publish. Schema.org-shaped types belong in `PublicationAdapter` outputs, not in TData. Use the wire format from your data source as the canonical TData; reshape upstream in `DataSource.fetch` if needed (see 2.3 Shape pivot).

**Mailbox name follows convention:** `__AIRO_<CARTRIDGE_ID_UPPER>_PAGES__`. Two cartridges in the same studio don't collide.

```ts
// ✅
export const commerceCartridge: Cartridge<WtbData, WtbConfig> = {
  id: 'commerce',
  industry: 'CPG product',
  // ...
  mailboxName: '__AIRO_commerce_PAGES__',
};

// ❌ — TConfig polluted with studio identity
interface WtbConfig {
  widgetId: string;        // NO — that's studio-level
  app: { type: string };   // NO — that's the v1 dispatch trap
  // ...
}
```

### 1.2 `DataSource<TData, TConfig>`

**Reshape upstream in `fetch()`.** Transformer is shape-preserving (see 1.3); if your wire format is different from what views consume, pivot inside DataSource. Two reasons: (a) Transformer's `TData → TData` signature won't typecheck a pivot anyway, (b) MCP tools and publication adapters share TData with views — pivoting once at fetch saves three downstream pivots.

**Cache TTL is metadata only.** `cacheTtlMs` is a hint; the host app implements the actual cache. Mirrors `Gate.persist` — declarative, non-behavioural.

**Fetch is async + cancellable.** Always thread `ctx.signal` through to the underlying `fetch` call. Long fetches that survive an unmount waste bandwidth and can race against re-mounts.

### 1.3 `Transformer<TData, TConfig>`

**Sync only at v0.** Async transformers would block render. Pre-compute async work in DataSource (see 1.2) when navigation context allows.

**Shape-preserving (`TData → TData`).** Don't pivot the schema mid-pipeline. Filter, sort, group, annotate — yes. Reshape — no.

**`errorPolicy: 'fail-render'` is the default and almost always correct.** Use `'skip'` only for transforms whose absence degrades gracefully (sort, optional enrichment). **Never** for filters whose absence widens visibility (tenant scoping, retailer allowlist, country gate). A silently-skipped retailer-filter ships products to retailers the brand explicitly disabled.

```ts
// ✅
const sortByPrice: Transformer<WtbData, WtbConfig> = {
  name: 'sort-by-price',
  isEnabled: () => true,
  errorPolicy: 'skip',          // safe: unsorted offers degrade gracefully
  transform: (data) => sortOffers(data),
};

const retailerFilter: Transformer<WtbData, WtbConfig> = {
  name: 'retailer-filter',
  isEnabled: (config) => config.retailers.enabled.length > 0,
  // No errorPolicy → defaults to 'fail-render'. Correct: a broken filter
  // would show products on disabled retailers.
  transform: (data, ctx) => filterByRetailer(data, ctx.config.retailers.enabled),
};
```

### 1.4 `PostProcessor<TData, TConfig>`

**Side-effect hooks only.** Analytics emit, ARIA live regions, scroll restoration, focus management. **NOT** data shaping (use Transformer) and **NOT** content gating (use Gate).

**Return optional teardown.** The pipeline's `runPostProcessors` collects teardowns into a stack; LIFO unwind on page unmount.

```ts
// ✅
const analyticsEmit: PostProcessor<WtbData, WtbConfig> = {
  name: 'analytics-emit',
  isEnabled: () => true,
  apply: ({ container, data, events }) => {
    const handler = (e: Event) => emit('view', e);
    container.addEventListener('click', handler);
    return () => container.removeEventListener('click', handler);
  },
};

// ❌ — gating content via PostProcessor
const ageGate: PostProcessor<WtbData, WtbConfig> = {
  name: 'age-gate',
  apply: ({ container }) => {
    container.innerHTML = '<modal/>';   // NO — too late, user saw content
  },
};
// Use Gate instead — runs BEFORE views paint.
```

### 1.5 `Gate<TConfig>`

**Two-phase contract: `precheck` for fast-path skip; `mount` for UI.** Auth gates verify tokens in precheck (returns `'allow'` if valid, `'gate-required'` otherwise — no UI flash for verified users).

**`'block'` leaves the gate's UI in place.** Framework paints nothing else. Cartridge author writes the "you're blocked" message inside `mount()`.

**`persist` is metadata only.** Cartridge declares `{ key, ttl?, scope }`; host app writes the actual storage primitive. Three reasons (locked decision):
- Cookie writes are state management, not rendering — violates M13
- Cookie semantics are studio concerns (sameSite, domain rules, GDPR scope, SSO)
- Same precedent as `DataSource.cacheTtlMs`: declarative metadata; behaviour stays studio-side

```ts
// ✅
const ageGate: Gate<WtbConfig> = {
  id: 'age-verification',
  isEnabled: (config) => config.ageVerification.enabled,
  precheck: async () => {
    const verified = readSessionStorage('commerce:age-verified') === 'true';
    return verified ? 'allow' : 'gate-required';
  },
  mount: async (host) => {
    // Render modal; resolve 'allow' on user confirm or 'block' on cancel
  },
  destroy: () => undefined,
  persist: { key: 'commerce:age-verified', scope: 'session' },
};
```

### 1.6 `ViewDefinition<TData, TConfig>`

**One renderer per page type.** Don't bundle multiple page states into a single renderer (the v1 layout trap — see 2.1).

**Subpages activate via `parent` + `activateSubpage`.** Quickview's `parent: 'product'` means the framework calls `ProductRenderer.activateSubpage(subpage)` rather than swapping renderers. Implement `activateSubpage` on the parent renderer when you have subpages; instantiate the modal class locally and overlay.

**Renderers are stateless factories.** `() => new MyRenderer()` returns a fresh instance per navigation. State lives in the renderer instance for the duration of one mount; nothing persists across `destroy()`.

**Capabilities are honest declarations.** `'csr-only'` means the framework / SSR pipeline skips this view server-side. Don't claim `'ssr-safe'` if you import `window` or `document.cookie` at module scope.

### 1.7 `Template<TConfig>`

**Page graph is statically declared.** Cartridges with fixed templates (the common case) hardcode the page list — no need for dynamic discovery.

**Templates are not config branches.** Don't use templates to A/B different feature toggles; use cartridge config for that. Templates are *page-graph shapes* — different sets of pages with different navigation flows.

```ts
// ✅
const storePlusTemplate: Template<WtbConfig> = {
  id: 'storeplus-default',
  pages: [
    { id: 'categories', type: 'categories', enabled: true },
    { id: 'products',   type: 'products',   enabled: true },
    { id: 'product',    type: 'product',    enabled: true },
    { id: 'quickview',  type: 'quickview',  enabled: true, parent: 'product' },
    { id: 'storeFinder',type: 'storeFinder',enabled: true },
  ],
  defaultConfig: { /* ... */ },
};
```

### 1.8 `McpToolDefinition<TData, TConfig>`

**Tools read POST-Transformer data.** Same snapshot views and publication adapters consume. The framework guarantees this; don't reach for `ctx.config` to derive what's visible — it's already in `ctx.data`.

**Server-only by default.** MCP tools typically reference SDKs (OpenAI, Anthropic) or proprietary IP (allowlists, ranking heuristics). Use the two-envelope pattern (see 2.5) to keep them out of browser bundles.

### 1.9 `PublicationAdapter<TData, TOutput, TConfig>`

**Consumes POST-Transformer data.** Same as MCP tools. The "snapshot fidelity" contract guarantee: views, MCP tools, and publication adapters all see the same data.

**Validation is a hard gate (default).** `onValidationFail: 'block-publish'` is correct for almost all cases. `'publish-with-warnings'` only when downstream consumers (Google Merchant Center, Amazon Listings) have a "warnings allowed" mode.

**`requires` enforces coverage.** Declare every schema field path the adapter needs; the framework can skip the adapter when fields are absent rather than emit broken output. Studio shells surface coverage gaps to users via this metadata.

**Server-only.** Same envelope split as MCP tools.

---

## 2. Architecture patterns

### 2.1 Per-page chunks, not per-layout

**The trap:** v1 had three layouts (quickshop, showcase, storeplus). Each was one chunk. StorePlus bundled categories + products + product + quickview into one ~96 KB chunk because they all live "inside" the StorePlus layout.

**The fix (v0):** split into per-page renderers. Each page is its own chunk.

```
v1 (wrong):                     v0 (right):
commerce-storeplus.js (96 KB)        commerce-categories.js  (~25 KB)
└─ all 4 sub-pages              commerce-products.js    (~50 KB)
   bundled together             commerce-product.js     (~40 KB)
                                commerce-quickview.js   (~25 KB)
```

Single-page widget at v0: loads ONE chunk (~25-50 KB).
Single-page widget at v1: loads the whole layout chunk regardless.

**Cartridge authors:** ship one `ViewDefinition` per page type, not per layout family. Each chunks separately. Templates compose them.

### 2.2 No `app.type` in cartridge config

**The trap:** v1 dispatched on `config.app.type` ('quick-shop' / 'product-showcase' / 'store-plus'). The dispatcher needed to know about every layout statically; adding a new layout meant changing the dispatcher.

**The fix (v0):** pages[] is the source of truth. Framework's PageManager dispatches on `page.type`. Templates declare which pages a widget exposes.

Cartridge config has NO concept equivalent to `app.type`. Templates ARE the "type" — the studio shell picks one when composing a widget.

### 2.3 Shape pivot lives in `DataSource.fetch`, not Transformer

**The trap:** wire format is flat (`Product → SKU per retailer`); cartridge schema is nested (`Product → Sku per variant → Offer per retailer`). Tempting to write a Transformer that pivots.

**Why it fails:** Transformer is `TData → TData`. Won't typecheck a different output shape.

**The fix:** pivot inside `DataSource.fetch`. The cartridge's TData is already nested when transformers see it.

```ts
// ✅
const myDataSource: DataSource<NestedData, MyConfig> = {
  fetch: async (input, ctx) => {
    const flat = await fetchFlatFromWire(input);
    return pivotToNested(flat);    // reshape HERE, once
  },
};

// ❌
const reshape: Transformer<NestedData, MyConfig> = {
  transform: (data) => pivotFromFlat(data),   // typecheck fails — TData → TData
};
```

### 2.4 Subpages: `parent` + `activateSubpage`, not direct navigation

**The trap:** quickview is a modal that overlays the product page. Tempting to model it as a standalone page; navigate to it via `ctx.navigate({ page: 'quickview' })`.

**Why it gets weird:** if quickview's `parent: 'product'`, the framework dispatches via `ProductRenderer.activateSubpage(subpage)`, NOT by swapping to a QuickViewRenderer. A standalone QuickViewRenderer is dead at runtime — its `render()` never fires.

**The fix:** implement `activateSubpage(subpage)` on the parent renderer; instantiate the modal class there and overlay it. The cartridge ships a modal class (e.g. `QuickViewModal`), not a `QuickViewRenderer`.

**Caveat:** if you want quickview to be reachable from the products LISTING page too (not just product detail), the framework's single-parent dispatch only fires on the declared parent. Two patterns:
- Have ProductsRenderer instantiate the modal directly (bypasses framework subpage dispatch — works but loses URL routing for that case)
- Wait for framework Finding 3 to land (`SubpageActivation` carrying `Page<T>` + multi-parent semantics)

### 2.5 Two-envelope pattern for browser/server bundle separation

**The trap:** cartridge envelope holds references to everything (transformers, views, MCP tools, publication adapters). Tree-shaking can't help when the envelope itself is the import.

**Why it matters:** PublicationAdapters and MCP tools are typically server-only — disapproval rules, taxonomy mapping, AI SDKs (10-50+ KB each). Shipping them to the browser is wasteful and exposes proprietary IP.

**The fix:** ship two envelopes per cartridge:

```
my-cartridge/
├── parts/
│   ├── schema.ts                 ← Zod, single source of truth
│   ├── transformers.ts           ← shared (browser + server)
│   ├── data-sources.ts           ← shared
│   ├── views/                    ← shared (page chunks)
│   ├── publication-adapters/     ← server-only
│   └── mcp-tools.ts              ← server-only
├── runtime.ts                    ← browser entry: schema + transformers + views + dataSources
└── full.ts                       ← server entry: re-exports runtime + adds adapters/mcp
```

Browser builds import `<my-cartridge>/runtime`; SSR / publication-runner builds import `<my-cartridge>/full`. Cartridge author writes the split once. Bundlers tree-shake at the package boundary.

### 2.6 Subfolder-per-page beats flat `views/`

**The trap:** flat `views/CategoriesRenderer.ts`, `views/ProductsRenderer.ts`, etc. Works for skeletons; breaks once renderers gain sub-views, page-specific styles, scoped components.

**The fix:** subfolder per page renderer.

```
layouts/
├── _shared/                  ← cross-page utilities (cssClasses, components, page-config adapters)
├── categories/
│   ├── CategoriesRenderer.ts
│   ├── styles.ts
│   └── index.ts
├── product/
│   ├── ProductRenderer.ts
│   ├── QuickViewModal.ts     ← subpage modal lives next to its parent renderer
│   ├── breadcrumb.ts
│   └── index.ts
└── store-finder/
    ├── StoreFinderRenderer.ts
    ├── core/                 ← page-specific deep tree allowed (map providers, services)
    ├── providers/
    └── views/                ← sub-page-modes (Split / Stacked / ListOnly)
```

Co-location: tests next to source, page-specific CSS in the same folder, sub-views nested. Boundary mirrors framework's PageManager dispatch boundary.

### 2.7 Page-config lives on `Page<T>`, not on cartridge config

**The trap:** v1 stored per-page customisation on `WidgetConfig.pages[<pageId>]`. Cartridge authors lift this and add a `pages[]` field to cartridge config — duplicating what `Page.componentSettings` and `Page.styles` already offer on the framework's `AppConfig.pages`.

**Why it fails:** two sources of truth. Studio chrome edits `componentSettings`; cartridge config has its own. Drift inevitable.

**The fix:** `Page<T>.componentSettings` and `Page<T>.styles` are canonical. Renderers read via `ctx.page` in `RenderContext`. Cartridge config stays minimal.

Adapters in `_shared/utils/` translate the airo `Page<T>` shape into the read patterns renderers expect:

```ts
// ✅ — renderers read ctx.page, not cartridge config.pages[]
function getComponentProps<T>(page: Page<string>, componentId: string, defaults: T): T {
  const props = page.componentSettings?.[componentId]?.props;
  return props ? { ...defaults, ...props } : defaults;
}

function isComponentVisible(page: Page<string>, componentId: string): boolean {
  // 1. componentSettings.visible override wins
  // 2. fall back to slot.visible
  // 3. default true
}
```

### 2.8 Slot-id semantics: runtime simple, editor smart

**The trap:** v1 synthesised slot ids (`<page>:<region>:<componentId>`) for the overlay editor. Cartridge authors lift this and emit synthetic ids at runtime.

**Why it's wrong:** runtime only mounts ONE page at a time. `data-airo-slot="<componentId>"` is unique enough — collisions don't happen because the other pages aren't in the DOM. The page-prefix is editor-time concern (cross-render slot identity for layout drag-reorder).

**The fix:** runtime emits `data-airo-slot="<componentId>"` directly. When the studio overlay editor lands, it synthesises page-prefixed ids at edit time — runtime stays simple.

### 2.9 Cartridges with fixed templates have static page-graph navigation

**The trap:** v1's renderers walked `config.pages[]` dynamically (`resolveNextPageId(pages, currentPageId)`) to find the next non-self page. Useful for studios that compose page graphs dynamically. Tempting to lift verbatim.

**Why most cartridges don't need it:** the cartridge ships its own templates with statically-declared page graphs. The renderer's "next page" is known at cartridge-author time.

**The fix:** hardcode navigation per renderer.

```ts
// ✅
const NEXT_PAGE_ID = 'products';

class CategoriesRenderer implements PageRenderer<'categories', AppCtx> {
  render(targetEl, ctx) {
    // ...
    btn.addEventListener('click', () => {
      ctx.navigate({ page: NEXT_PAGE_ID, category });
    });
  }
}
```

If a future cartridge needs dynamic page-graph composition, the framework adds `findNextEnabledPage(pages, fromId, direction)` to `@airo-js/core` (where `Page<T>` lives). Don't lift dynamic walks into individual cartridges.

### 2.10 Cartridge metadata vs cartridge state

**Pattern recognised across `Gate.persist`, `DataSource.cacheTtlMs`, `PublicationAdapter.refreshCadence`:** declarative metadata that the *host app* implements behaviourally.

**Rule:** if a knob involves storage, scheduling, retries, network, auth, or any other compliance/operational concern — it's metadata in the cartridge contract; behaviour lives host-app-side.

This protects M13: framework owns rendering; host apps own everything else.

---

## 3. Anti-patterns (what NOT to do)

### 3.1 Don't duplicate runtime orchestration in host-app code

If you find yourself writing ~200+ lines of "fetch data → run pipeline → mount" in your studio entry, that's `mountCartridge` from `@airo-js/runtime`. Use it.

If `@airo-js/runtime` doesn't yet do what you need, **flag the gap with the framework team before rolling your own**. The cost asymmetry is severe — studio-side roll-your-own gets factored back later (we just lived through this with the cartridge.ts → runtime extraction).

### 3.2 Don't put cookie/storage/auth/scheduling in the cartridge

These are host-app concerns. Cartridge declares metadata (`Gate.persist`, `DataSource.cacheTtlMs`); host app implements. If a cartridge primitive starts wanting to write cookies directly, push back — it's the camel's-nose-in-the-tent move.

### 3.3 Don't ship Zod schemas to the browser

Zod is ~12 KB gzipped. Cartridge browser bundles use type-only stubs (`SchemaDefinition<TData>` with identity `parse`/`safeParse`). Server bundles import the full Zod schema separately. Two-envelope pattern (see 2.5) handles this.

If you're audit-curious: `grep -c "z\." dist/runtime.js` should return 0 in browser builds.

### 3.4 Don't pivot data shape in a Transformer

Use DataSource.fetch (see 2.3). If you can't, your wire format is too far from your cartridge schema — fix the source-side, not the transformer chain.

### 3.5 Don't lift v1 widget-runtime imports into the cartridge

Every cartridge file should import from `@airo-js/core`, `@airo-js/cartridge-kit`, `@/shared/dom`, or cartridge-local files only. Imports from `@/widget-runtime/*` are the v1-leakage smell.

Audit: `grep -rn "from '@/widget-runtime" cartridges/` should return zero hits except in JSDoc comments explaining lift history.

### 3.6 Don't pre-emptively support studio composition you don't have

Dynamic page-graph walks (see 2.9), multi-cartridge resolverFor in single-cartridge studios, custom shell hooks for theme engines that don't exist yet — all "build the abstraction now in case we need it later" mistakes. **Build it when there's a real consumer. M5 (multi-cartridge) is real but most cartridges run in single-cartridge studios; design for the actual path.**

### 3.7 Don't strip rationale comments during lifts

When porting code from one tree to another (v1 → v0, v0 → cartridge), preserve inline comments that explain *why* non-obvious decisions exist. They cost ~5 minutes to keep; the next maintainer pays days re-deriving them.

We caught this in B1.5 review: ProductCarousel lost ~50 lines of inline rationale during the lift (CSS centering math via custom property, SSR HTML byte-equivalence). The decision to use those patterns was non-obvious; stripping the comments meant the next engineer would "fix" the working pattern. **Preserve inline rationale during lifts.**

### 3.8 Don't roll your own embed loader

Same trap as runtime. If `@airo-js/embed` doesn't ship the auth/fetch/cartridge-resolution shape your studio needs, **flag the gap**. Don't extend your existing v1 embed loader with a cartridge branch and call it "studio-specific" — most of that branch is generic plumbing that should live in `@airo-js/embed` via hooks.

---

## 4. Host app patterns

### 4.1 Translate studio config to cartridge config at the entry, not in the cartridge

Studios with their own React state / Zustand / Redux config shape (e.g. v1 `WidgetConfig`) translate to the cartridge's `TConfig` at the studio's mount entry. The cartridge itself only ever sees clean `TConfig`.

```ts
// studio's mount entry (e.g. cartridge.ts)
function widgetConfigToWtbConfig(input: Partial<WidgetConfig>): { config: WtbConfig; templateId: string } {
  return {
    config: { country: input.app?.country ?? 'GB', /* ... */ },
    templateId: appTypeToTemplateId(input.app?.type),
  };
}
```

When the studio's React state migrates to produce cartridge-shaped config directly, the translation layer goes away.

### 4.2 Use hooks (`onShellReady`, `onError`) for studio-specific extensions

`@airo-js/runtime`'s `mountCartridge` exposes `onShellReady(shell)` and `onError(phase, err, shell)`. Use these to inject:
- Studio's theme engine (Dotter studio's `ThemeEngine`, Airo studio's CSS variable system)
- Studio's analytics / observability hooks
- Studio-branded error UI
- Custom CSS for studio-specific chrome (debug overlays, slot-edit handles)

Don't fork `mountCartridge` to add studio behaviour. Hooks are the contract.

### 4.3 Multi-cartridge studios use `registry.resolverFor(cartridgeId)`

Single-cartridge studios let `mountCartridge` derive `resolveRenderer` from `cartridge.views[]` automatically. Multi-cartridge studios pass `resolveRenderer: registry.resolverFor(cartridgeId)` so the registry walks the right cartridge's chunk mailbox.

### 4.4 Element name + attribute prefix matches your brand

When you call `defineAiroApp({ elementName: 'dotter-app', idAttribute: 'dtr-id' })`, the customer pastes `<dotter-app dtr-id="...">`. Pick names that match your studio's identity — but be consistent; don't mix `dtr-` and `dotter-` prefixes.

---

## 5. Reference implementations

When in doubt, read these files. They're the empirically-validated shapes.

### 5.1 The cartridge

[`dotter-monorepo/apps/dotter-studio/src/cartridges/commerce/`](file:///Users/smithbn/workspace/dotter-monorepo/apps/dotter-studio/src/cartridges/commerce/) — full commerce cartridge port. Survived three formal reviews. Per-page chunks, two-envelope schema, Gate primitive, page-config adapters, all six v0 components lifted.

Specific files worth reading:
- `index.ts` — cartridge envelope (~50 LOC). Minimal, all references to `parts/`.
- `templates.ts` — three templates (QuickShop, Showcase, StorePlus) with multi-page graphs. No `app.type` anywhere.
- `parts/commerce-data.ts` + `parts/schema.ts` — type definitions + browser-safe SchemaDefinition stub.
- `parts/transformers.ts` — six named transformers with errorPolicy discipline.
- `gates.ts` — age verification gate with precheck/mount/persist.
- `layouts/_shared/utils/page-slots.ts` + `componentProps.ts` + `page-styles.ts` — page-config adapters reading from `ctx.page`.
- `layouts/product/ProductRenderer.ts` + `QuickViewModal.ts` — subpage activation pattern.

### 5.2 The framework

[`/Users/smithbn/workspace/biz/airo-js/packages/`](file:///Users/smithbn/workspace/biz/airo-js/packages/) — the airo-js framework itself.

- `core/src/` — createApp, PageManager, EventBus, HashRouter, Theme, IsolationRoot, RuntimePipeline, registry mailbox.
- `cartridge-kit/src/` — Cartridge contract, all primitives, createCartridgeApp helper, createCartridgeRegistry.
- `ssr/src/` — renderAppToHTML, runPublicationAdapters, renderAppWithPublication.
- `runtime/src/` — mountCartridge (when buildout lands per `airo-js-runtime-buildout.md`).
- `embed/src/` — defineAiroApp (when buildout lands per `airo-js-embed-buildout.md`).

### 5.3 The runtime/embed orchestration corpus

When designing or extending runtime/embed surfaces, survey these files together:

- `dotter-widget-studio/src/widget-runtime-v0/entries/core.ts` (422 LOC) — v0 runtime core, no cartridge concept. Multi-widget lifecycle + live updates pattern.
- `dotter-widget-studio/src/embed/index.ts` (546 LOC) — dual-runtime (v1 + airo) embed loader. `chunkBaseFor()` fork.
- `dotter-monorepo/apps/dotter-studio/src/embed/index.ts` (256 LOC) — production auth (HMAC tokens, LoadResponse).
- `dotter-monorepo/apps/dotter-studio/src/widget-runtime/entries/cartridge.ts` (342 LOC) — cartridge-aware studio entry; the `mountCartridge` spec target.
- `dotter-widget-studio/supabase/functions/ssr-widget/index.ts` (772 LOC) — SSR edge function.
- `dotter-widget-studio/src/components/preview/WidgetPreviewIframe.tsx` (1198 LOC, ~150 LOC of inline bootstrap) — minimum viable runtime in iframe srcDoc.

### 5.4 The findings + decisions docs

- `dotter-widget-studio/.claude/plans/airo-cartridge-kit-contract-proposal.md` — original v0.2 contract proposal.
- `dotter-widget-studio/.claude/plans/airo-studio-v0-migration.md` — phased migration plan with M1-M15 decision log.
- `dotter-monorepo/.claude/plans/airo-cartridge-kit-spike-findings.md` — six findings from the commerce consumer mapping.
- `airo-js/.claude/plans/airo-js-runtime-buildout.md` — runtime package buildout.
- `airo-js/.claude/plans/airo-js-embed-buildout.md` — embed package buildout.

---

## 6. Update process

This guide grows when:
- A new cartridge port surfaces a pattern not covered here. Add to Section 1 or 2.
- A common mistake repeats across two cartridges. Add to Section 3.
- A framework primitive ships that changes recommended usage. Update the relevant subsection.
- A v1 trap is recognised that wasn't documented. Add to Section 3 (anti-patterns).

**Process:**
1. Open a PR against `airo-js/.claude/plans/airo-js-best-practices.md` with the new finding/section.
2. Reference the cartridge or migration that surfaced it.
3. Get sign-off from one framework team member + one cartridge author who hit the pattern.
4. Merge; the next cartridge author / framework reviewer reads the updated guide.

This doc lives in `airo-js/.claude/plans/` for now. Promotes to `airo-js/docs/best-practices.md` (public) when the project goes public on GitHub.

---

## 7. Quick reference — cartridge primer

If you're authoring your first cartridge, the minimum-viable shape:

```
my-cartridge/
├── index.ts                          ← Cartridge envelope (≤50 LOC)
├── parts/
│   ├── data.ts                       ← TData + TConfig type definitions
│   ├── schema.ts                     ← browser-safe SchemaDefinition stub
│   ├── data-sources.ts               ← DataSource[] (fetch + reshape upstream)
│   └── transformers.ts               ← Transformer[] (sync, shape-preserving)
├── gates.ts                          ← Gate[] (optional; pre-render guards)
├── post-processors.ts                ← PostProcessor[] (optional; side-effects after render)
├── templates.ts                      ← Template[] (multi-page graphs)
├── default-config.ts                 ← TConfig defaults
├── mcp-tools.ts                      ← McpToolDefinition[] (server-only via two-envelope)
├── publication-adapters/             ← server-only
└── layouts/
    ├── _shared/                      ← cross-page utilities (page-config adapters, components)
    ├── <pageType-1>/
    │   ├── <PageType1>Renderer.ts
    │   └── index.ts
    ├── <pageType-2>/
    │   ├── ...
    └── ...
```

Then in your studio host app's mount entry:

```ts
import { defineAiroApp } from '@airo-js/embed';
import { mountCartridge } from '@airo-js/runtime';

defineAiroApp({
  elementName: 'my-app',
  idAttribute: 'my-id',
  loadConfig: async (id) => fetch(`/widgets/${id}/load`).then(r => r.json()),
  resolveCartridge: async (id) => (await import(`@my-org/${id}-cartridge`)).default,
  onError: (phase, err) => console.error(`[${phase}]`, err),
});
```

That's the v0 shape. Anything materially different from this is either a new pattern (update this guide) or a mistake (re-read this guide).
