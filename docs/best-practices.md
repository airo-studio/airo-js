# `@airo-js` best-practice guide

Authoring conventions, architecture patterns, and anti-patterns for cartridges and host apps built on `@airo-js`.

## Audience

- **Cartridge authors** — read top to bottom before writing your first cartridge. Sections 1–3 are 80% of what you need.
- **Framework contributors** — consult before extending the cartridge-kit contract. If a proposed addition violates one of the architectural patterns or anti-patterns here, push back or update this doc with the new finding.
- **Host-app developers** (studios consuming cartridges) — focus on Section 4 (Host app patterns).

When something in your code doesn't fit a pattern here, that's a finding worth surfacing — open an issue.

---

## 1. Authoring conventions (per primitive)

### 1.1 `Cartridge<TData, TConfig>` envelope

**Cartridge config (`TConfig`) holds editable surface only.** Fields a studio user (or template author) toggles. Country, locale, feature flags, retailer/data filters. **Not** widget identity (`widgetId`), studio version pins, or runtime brand. Those are studio-shell concerns, not cartridge concerns.

**Cartridge data (`TData`) matches what views, transformers, and MCP tools consume.** Not what publishers publish — Schema.org-shaped types belong in `PublicationAdapter` outputs, not in `TData`. Use the wire format from your data source as the canonical `TData`; reshape upstream in `DataSource.fetch` if needed (see 2.3).

**Mailbox name follows convention:** `__AIRO_<CARTRIDGE_ID_UPPER>_PAGES__`. Two cartridges in the same studio don't collide.

```ts
// ✅
export const myCartridge: Cartridge<MyData, MyConfig> = {
  id: 'my-cartridge',
  industry: 'CPG product',
  // ...
  mailboxName: '__AIRO_MY_CARTRIDGE_PAGES__',
};

// ❌ — TConfig polluted with studio identity
interface MyConfig {
  widgetId: string;        // NO — that's studio-level
  app: { type: string };   // NO — pages[] is the source of truth (see 2.2)
}
```

### 1.2 `DataSource<TData, TConfig>`

**Reshape upstream in `fetch()`.** `Transformer` is shape-preserving (see 1.3); if your wire format differs from what views consume, pivot inside `DataSource`. Two reasons: (a) `Transformer`'s `TData → TData` signature won't typecheck a pivot anyway; (b) MCP tools and publication adapters share `TData` with views — pivoting once at fetch saves three downstream pivots.

**Cache TTL is metadata only.** `cacheTtlMs` is a hint; the host app implements the actual cache. Mirrors `Gate.persist` — declarative, non-behavioural.

**Fetch is async + cancellable.** Always thread `ctx.signal` through to the underlying `fetch` call. Long fetches that survive an unmount waste bandwidth and can race against re-mounts.

### 1.3 `Transformer<TData, TConfig>`

**Sync only at v0.** Async transformers would block render. Pre-compute async work in `DataSource` (see 1.2) when navigation context allows.

**Shape-preserving (`TData → TData`).** Don't pivot the schema mid-pipeline. Filter, sort, group, annotate — yes. Reshape — no.

**`errorPolicy: 'fail-render'` is the default and almost always correct.** Use `'skip'` only for transforms whose absence degrades gracefully (sort, optional enrichment). **Never** for filters whose absence widens visibility (tenant scoping, retailer allowlist, country gate). A silently-skipped retailer-filter ships products to retailers the brand explicitly disabled.

```ts
// ✅
const sortByPrice: Transformer<MyData, MyConfig> = {
  name: 'sort-by-price',
  isEnabled: () => true,
  errorPolicy: 'skip',          // safe: unsorted offers degrade gracefully
  transform: (data) => sortOffers(data),
};

const retailerFilter: Transformer<MyData, MyConfig> = {
  name: 'retailer-filter',
  isEnabled: (config) => config.retailers.enabled.length > 0,
  // No errorPolicy → defaults to 'fail-render'. Correct: a broken filter
  // would show products on disabled retailers.
  transform: (data, ctx) => filterByRetailer(data, ctx.config.retailers.enabled),
};
```

### 1.4 `PostProcessor<TData, TConfig>`

**Side-effect hooks only.** Analytics emit, ARIA live regions, scroll restoration, focus management. **Not** data shaping (use `Transformer`) and **not** content gating (use `Gate`).

**Return optional teardown.** The pipeline's `runPostProcessors` collects teardowns into a stack; LIFO unwind on page unmount.

```ts
// ✅
const analyticsEmit: PostProcessor<MyData, MyConfig> = {
  name: 'analytics-emit',
  isEnabled: () => true,
  apply: ({ container, data, events }) => {
    const handler = (e: Event) => emit('view', e);
    container.addEventListener('click', handler);
    return () => container.removeEventListener('click', handler);
  },
};

// ❌ — gating content via PostProcessor
const ageGate: PostProcessor<MyData, MyConfig> = {
  name: 'age-gate',
  apply: ({ container }) => {
    container.innerHTML = '<modal/>';   // NO — too late, user saw content
  },
};
// Use Gate instead — runs BEFORE views paint.
```

### 1.5 `Gate<TConfig>`

**Two-phase contract: `precheck` for fast-path skip; `mount` for UI.** Auth gates verify tokens in precheck (returns `'allow'` if valid, `'gate-required'` otherwise — no UI flash for verified users).

**`'block'` leaves the gate's UI in place.** The framework paints nothing else. The cartridge author writes the "you're blocked" message inside `mount()`.

**`persist` is metadata only.** The cartridge declares `{ key, ttl?, scope }`; the host app writes the actual storage primitive. Three reasons (locked decision):

- Cookie writes are state management, not rendering — violates the rendering-only scope line.
- Cookie semantics are studio concerns (sameSite, domain rules, GDPR scope, SSO).
- Same precedent as `DataSource.cacheTtlMs`: declarative metadata; behaviour stays studio-side.

```ts
// ✅
const ageGate: Gate<MyConfig> = {
  id: 'age-verification',
  isEnabled: (config) => config.ageVerification.enabled,
  precheck: async () => {
    const verified = readSessionStorage('mycart:age-verified') === 'true';
    return verified ? 'allow' : 'gate-required';
  },
  mount: async (host) => {
    // Render modal; resolve 'allow' on user confirm or 'block' on cancel.
  },
  destroy: () => undefined,
  persist: { key: 'mycart:age-verified', scope: 'session' },
};
```

### 1.6 `ViewDefinition<TData, TConfig>`

**One renderer per page type.** Don't bundle multiple page states into a single renderer (see 2.1).

**Subpages activate via `parent` + `activateSubpage`.** A quickview's `parent: 'product'` means the framework calls `ProductRenderer.activateSubpage(subpage)` rather than swapping renderers. Implement `activateSubpage` on the parent renderer when you have subpages; instantiate the modal class locally and overlay.

**Renderers are stateless factories.** `() => new MyRenderer()` returns a fresh instance per navigation. State lives in the renderer instance for the duration of one mount; nothing persists across `destroy()`.

**Capabilities are honest declarations.** `'csr-only'` means the framework's SSR pipeline skips this view server-side. Don't claim `'ssr-safe'` if you import `window` or `document.cookie` at module scope.

### 1.7 `Template<TConfig>`

**Page graph is statically declared.** Cartridges with fixed templates (the common case) hardcode the page list — no need for dynamic discovery.

**Templates are not config branches.** Don't use templates to A/B different feature toggles; use cartridge config for that. Templates are *page-graph shapes* — different sets of pages with different navigation flows.

```ts
// ✅
const fullStoreTemplate: Template<MyConfig> = {
  id: 'full-store',
  pages: [
    { id: 'categories',  type: 'categories',  enabled: true },
    { id: 'products',    type: 'products',    enabled: true },
    { id: 'product',     type: 'product',     enabled: true },
    { id: 'quickview',   type: 'quickview',   enabled: true, parent: 'product' },
    { id: 'storeFinder', type: 'storeFinder', enabled: true },
  ],
  defaultConfig: { /* ... */ },
};
```

### 1.8 `McpToolDefinition<TData, TConfig>`

**Tools read POST-Transformer data.** The same snapshot views and publication adapters consume. The framework guarantees this; don't reach for `ctx.config` to derive what's visible — it's already in `ctx.data`.

**Server-only by default.** MCP tools typically reference SDKs (OpenAI, Anthropic) or proprietary IP (allowlists, ranking heuristics). Use the two-envelope pattern (see 2.5) to keep them out of browser bundles.

### 1.9 `PublicationAdapter<TData, TOutput, TConfig>`

**Consumes POST-Transformer data.** Same as MCP tools. The "snapshot fidelity" contract guarantee: views, MCP tools, and publication adapters all see the same data.

**Validation is a hard gate (default).** `onValidationFail: 'block-publish'` is correct for almost all cases. `'publish-with-warnings'` only when downstream consumers (Google Merchant Center, Amazon Listings) have a "warnings allowed" mode.

**`requires` enforces coverage.** Declare every schema field path the adapter needs; the framework can skip the adapter when fields are absent rather than emit broken output. Studio shells surface coverage gaps to users via this metadata.

**Server-only.** Same envelope split as MCP tools.

---

## 2. Architecture patterns

### 2.1 Per-page chunks, not per-layout

**The trap:** bundling several page states into one chunk because they all live "inside" the same layout family. A multi-page widget then loads ~100 KB even when only one page renders.

**The fix:** split into per-page renderers. Each page is its own chunk.

```
wrong:                     right:
storeplus.js (96 KB)       categories.js  (~25 KB)
└─ all 4 sub-pages         products.js    (~50 KB)
   bundled together        product.js     (~40 KB)
                           quickview.js   (~25 KB)
```

A single-page widget then loads ONE chunk (~25–50 KB). Ship one `ViewDefinition` per page type, not per layout family. Each chunks separately. Templates compose them.

### 2.2 No `app.type` in cartridge config

**The trap:** dispatching on a `config.app.type` discriminator. The dispatcher then needs to know about every layout statically; adding a new layout means changing the dispatcher.

**The fix:** `pages[]` is the source of truth. The framework's `PageManager` dispatches on `page.type`. Templates declare which pages a widget exposes.

Cartridge config has no concept equivalent to `app.type`. Templates ARE the "type" — the studio shell picks one when composing a widget.

### 2.3 Shape pivot lives in `DataSource.fetch`, not `Transformer`

**The trap:** wire format is flat (`Product → SKU per retailer`); the cartridge schema is nested (`Product → Sku per variant → Offer per retailer`). Tempting to write a `Transformer` that pivots.

**Why it fails:** `Transformer` is `TData → TData`. Won't typecheck a different output shape.

**The fix:** pivot inside `DataSource.fetch`. The cartridge's `TData` is already nested when transformers see it.

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

**The trap:** a quickview is a modal that overlays the product page. Tempting to model it as a standalone page; navigate to it via `ctx.navigate({ page: 'quickview' })`.

**Why it gets weird:** if quickview's `parent: 'product'`, the framework dispatches via `ProductRenderer.activateSubpage(subpage)`, NOT by swapping to a `QuickViewRenderer`. A standalone `QuickViewRenderer` is dead at runtime — its `render()` never fires.

**The fix:** implement `activateSubpage(subpage)` on the parent renderer; instantiate the modal class there and overlay it. The cartridge ships a modal class (e.g. `QuickViewModal`), not a `QuickViewRenderer`.

**Caveat:** if you want quickview reachable from the products LISTING page too (not just product detail), the framework's single-parent dispatch only fires on the declared parent. Two patterns:

- Have `ProductsRenderer` instantiate the modal directly (bypasses framework subpage dispatch — works but loses URL routing for that case).
- Wait for multi-parent semantics to land in the contract.

### 2.5 Two-envelope pattern for browser/server bundle separation

**The trap:** the cartridge envelope holds references to everything (transformers, views, MCP tools, publication adapters). Tree-shaking can't help when the envelope itself is the import.

**Why it matters:** `PublicationAdapter`s and MCP tools are typically server-only — disapproval rules, taxonomy mapping, AI SDKs (10–50+ KB each). Shipping them to the browser is wasteful and exposes proprietary IP.

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

Co-location: tests next to source, page-specific CSS in the same folder, sub-views nested. The boundary mirrors the framework's `PageManager` dispatch boundary.

### 2.7 Page-config lives on `Page<T>`, not on cartridge config

**The trap:** storing per-page customisation on cartridge config (e.g. `MyConfig.pages[<pageId>]`). Duplicates what `Page.componentSettings` and `Page.styles` already offer on the framework's `AppConfig.pages`.

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
  // 1. componentSettings.visible override wins.
  // 2. Fall back to slot.visible.
  // 3. Default true.
}
```

### 2.8 Slot-id semantics: runtime simple, editor smart

**The trap:** synthesising slot ids (`<page>:<region>:<componentId>`) at runtime so an overlay editor can identify slots across pages.

**Why it's wrong:** runtime only mounts ONE page at a time. `data-airo-slot="<componentId>"` is unique enough — collisions don't happen because the other pages aren't in the DOM. The page-prefix is an editor-time concern (cross-render slot identity for layout drag-reorder).

**The fix:** runtime emits `data-airo-slot="<componentId>"` directly. When a studio overlay editor needs cross-page slot identity, it synthesises page-prefixed ids at edit time — runtime stays simple.

### 2.9 Cartridges with fixed templates have static page-graph navigation

**The trap:** walking `config.pages[]` dynamically (`resolveNextPageId(pages, currentPageId)`) to find the next non-self page. Useful for studios that compose page graphs dynamically. Tempting to lift verbatim.

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

This protects the rendering-only scope line: framework owns rendering; host apps own everything else.

---

## 3. Anti-patterns

### 3.1 Don't duplicate runtime orchestration in host-app code

If you find yourself writing ~200+ lines of "fetch data → run pipeline → mount" in your studio entry, that's `mountCartridge` from `@airo-js/runtime`. Use it.

If `@airo-js/runtime` doesn't yet do what you need, **flag the gap with the framework team before rolling your own**. The cost asymmetry is severe — studio-side roll-your-own gets factored back later, and the factor-back is more expensive than the original ask would have been.

### 3.2 Don't put cookie/storage/auth/scheduling in the cartridge

These are host-app concerns. The cartridge declares metadata (`Gate.persist`, `DataSource.cacheTtlMs`); the host app implements. If a cartridge primitive starts wanting to write cookies directly, push back — it's the camel's-nose-in-the-tent move.

### 3.3 Don't ship Zod schemas to the browser

Zod is ~12 KB gzipped. Cartridge browser bundles use type-only stubs (`SchemaDefinition<TData>` with identity `parse` / `safeParse`). Server bundles import the full Zod schema separately. Two-envelope pattern (see 2.5) handles this.

If you're audit-curious: `grep -c "z\." dist/runtime.js` should return 0 in browser builds.

### 3.4 Don't pivot data shape in a `Transformer`

Use `DataSource.fetch` (see 2.3). If you can't, your wire format is too far from your cartridge schema — fix the source side, not the transformer chain.

### 3.5 Don't lift legacy widget-runtime imports into the cartridge

Every cartridge file should import from `@airo-js/core`, `@airo-js/cartridge-kit`, your project's shared DOM utilities, or cartridge-local files only. Imports from a host app's existing widget-runtime tree are the legacy-leakage smell.

Audit: `grep -rn "from '@/widget-runtime" cartridges/` should return zero hits except in JSDoc comments explaining lift history.

### 3.6 Don't pre-emptively support studio composition you don't have

Dynamic page-graph walks (see 2.9), multi-cartridge `resolverFor` in single-cartridge studios, custom shell hooks for theme engines that don't exist yet — all "build the abstraction now in case we need it later" mistakes. **Build it when there's a real consumer.** Multi-cartridge support is real but most cartridges run in single-cartridge studios; design for the actual path.

### 3.7 Don't strip rationale comments during lifts

When porting code from one tree to another, preserve inline comments that explain *why* non-obvious decisions exist. They cost ~5 minutes to keep; the next maintainer pays days re-deriving them.

Common loss site: visual centering math via custom property, SSR HTML byte-equivalence, focus-trap ordering, container-query thresholds. The decision to use those patterns was non-obvious; stripping the comments means the next engineer "fixes" the working pattern. **Preserve inline rationale during lifts.**

### 3.8 Don't roll your own embed loader

Same trap as runtime. If `@airo-js/embed` doesn't ship the auth/fetch/cartridge-resolution shape your studio needs, **flag the gap**. Don't extend your existing v1 embed loader with a cartridge branch and call it "studio-specific" — most of that branch is generic plumbing that should live in `@airo-js/embed` via hooks.

---

## 4. Host app patterns

### 4.1 Translate studio config to cartridge config at the entry, not in the cartridge

Studios with their own React state / Zustand / Redux config shape translate to the cartridge's `TConfig` at the studio's mount entry. The cartridge itself only ever sees clean `TConfig`.

```ts
// studio's mount entry
function studioConfigToCartridgeConfig(input: Partial<StudioConfig>): { config: MyConfig; templateId: string } {
  return {
    config: { country: input.app?.country ?? 'GB', /* ... */ },
    templateId: appTypeToTemplateId(input.app?.type),
  };
}
```

When the studio's React state migrates to produce cartridge-shaped config directly, the translation layer goes away.

### 4.2 Use hooks (`onShellReady`, `onError`) for studio-specific extensions

`@airo-js/runtime`'s `mountCartridge` exposes `onShellReady(shell)` and `onError(phase, err, shell)`. Use these to inject:

- The studio's theme engine (CSS variable system, design-token bridge).
- The studio's analytics / observability hooks.
- Studio-branded error UI.
- Custom CSS for studio-specific chrome (debug overlays, slot-edit handles).

Don't fork `mountCartridge` to add studio behaviour. Hooks are the contract.

### 4.3 Multi-cartridge studios use `registry.resolverFor(cartridgeId)`

Single-cartridge studios let `mountCartridge` derive `resolveRenderer` from `cartridge.views[]` automatically. Multi-cartridge studios pass `resolveRenderer: registry.resolverFor(cartridgeId)` so the registry walks the right cartridge's chunk mailbox.

### 4.4 Element name + attribute prefix matches your brand

When you call `defineAiroApp({ elementName: 'my-app', idAttribute: 'my-id' })`, the customer pastes `<my-app my-id="…">`. Pick names that match your studio's identity — but be consistent; don't mix `my-` and `myapp-` prefixes across your bundle.

---

## 5. Update process

This guide grows when:

- A new cartridge surfaces a pattern not covered here. Add to Section 1 or 2.
- A common mistake repeats across two cartridges. Add to Section 3.
- A framework primitive ships that changes recommended usage. Update the relevant subsection.
- A legacy trap is recognised that wasn't documented. Add to Section 3.

**Process:**

1. Open a PR against `docs/best-practices.md` with the new finding/section.
2. Reference the cartridge that surfaced it.
3. Get sign-off from one framework contributor + one cartridge author who hit the pattern.
4. Merge; the next cartridge author / framework reviewer reads the updated guide.

---

## 6. Quick reference — cartridge primer

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

defineAiroApp({
  elementName: 'my-app',
  idAttribute: 'my-id',
  loadConfig: async (id) => fetch(`/widgets/${id}/load`).then((r) => r.json()),
  resolveCartridge: async (id) => (await import(`@my-org/${id}-cartridge`)).default,
  onError: (phase, err) => console.error(`[${phase}]`, err),
});
```

That's the v0 shape. Anything materially different from this is either a new pattern (update this guide) or a mistake (re-read this guide).
