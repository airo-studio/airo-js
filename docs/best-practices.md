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

**Capabilities are honest declarations.** `'csr-only'` triggers the SSR runner to skip the view server-side (full mechanics in Section 5.5). `'ssr-safe'` claims your renderer satisfies the SSR-safe discipline (Section 5.1). Don't claim `'ssr-safe'` if you import `window` or `document.cookie` at module scope; don't claim `'hydratable'` unless `hydrate(root, ctx)` adopts existing DOM without re-painting. The honest declaration is load-bearing — the framework dispatches on it.

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

### 3.9 Don't ship helper defaults that ignore part of the contract

When a helper has a default for a contract field — e.g. `resolveRenderer` in `createCartridgeApp` and `renderAppWithPublication` — that default must handle every shape the contract supports. The mailbox/chunk pattern is on the `Cartridge` contract via `mailboxName`; helpers that only walk `views[]` have undocumented contract limitations and turn `mailboxName` into a "phantom" field — declarative but unsupported by the very helpers consumers reach for.

This bug class is hard to spot in review because the helper *looks* complete from the call site. Audit framework helper defaults against the full contract surface — especially when the contract grows new fields. If a contract field is genuinely opt-in, the default's failure mode should be a clear error, not silent "works for the static case only."

Where bugs in helper defaults get fixed: in the helper, not papered over a layer up. Wrapping a broken default in the orchestration layer above creates a precedent — every helper defect becomes runtime's problem, and copy-pasted defaults (the `createCartridgeApp` ↔ `renderAppWithPublication` pair) drift independently.

### 3.10 Don't use `Date.now()` / `Math.random()` / `crypto.randomUUID()` during render

`renderSSR` runs on the server; `render` (CSR fresh-mount) and `hydrate` (SSR-adopt) run in the browser. Time, randomness, and UUIDs diverge between the two environments — hydration mismatch follows. The client paints over the server's HTML, listeners attach to nodes that don't quite match, the page flashes or breaks.

**Pull non-deterministic values up.** If a card needs a stable id, compute it from a stable input (`product.id`, slugified title) — not `crypto.randomUUID()`. If a timestamp is the content, generate it server-side (in `DataSource.fetch` or upstream) and pass it through `ctx.app.data`. The renderer treats it as a string, not a clock read.

```ts
// ❌
function template(ctx) {
  return `<div data-render-id="${crypto.randomUUID()}">…</div>`;
}

// ✅ — stable identity derived from ctx
function template(ctx) {
  return `<div data-product-id="${ctx.app.data.product.id}">…</div>`;
}
```

If you genuinely need a per-mount id (focus management, ARIA live regions), generate it inside `hydrate(root, ctx)` and attach it to the DOM there — `hydrate` runs once per mount, not twice; no SSR/CSR divergence.

### 3.11 Don't serialize derived state into the SSR HTML

The SSR HTML should be the same DOM `renderSSR` produced — nothing more. Don't inline a `<script>` block with `{ selectedCategoryIndex: 3, expandedGroup: 'cpg', cartItems: [...] }` and have the client hydrate from it.

**Why it's wrong:**
- Derived state is recomputable from `(config, snapshot)`. Recomputation is cheap (the same work `renderSSR` did, no DOM).
- The serialized blob round-trips through the customer's page — an attacker who controls the page can tamper with it. The framework removes this attack surface by never trusting a state blob.
- Drift sneaks in: when `selectedCategoryIndex` is in two places (server-serialized + client-recomputed), they can disagree. Recomputation is the only source of truth.

Inline only recomputable signals — `config`, `snapshot` (the post-Transformer data) — never derived state. Document the discipline at the inline-script call site so future maintainers don't add a "convenience" state field.

### 3.12 Don't ship parallel runtime allowlists for SSR / CSR / auth

If your cartridge code or host-app code contains a constant like `CSR_ONLY_PAGE_TYPES = ['store-finder', 'live-feed']` parallel to the `capabilities` declarations on `ViewDefinition`, that's a drift trap. The `// keep in sync with views[].capabilities` comment that inevitably gets added IS the smell — the comment is doing the work the type system should do.

The pattern accumulates: a single allowlist becomes two (`AIRO_SSR_SKIP_PAGE_TYPES` and `AIRO_CSR_ONLY_PAGE_TYPES` are the same data with opposite sign), then three when an auth gate ships (`REQUIRES_AUTH_PAGE_TYPES`). Each new capability needs N+1 sync points. The `capabilities` array on `ViewDefinition` was designed to be the one place this information lives.

**The fix:** derive the runtime set from the cartridge at use site.

```ts
// ❌ — parallel list, drifts silently when capabilities change
const CSR_ONLY_PAGE_TYPES = new Set(['store-finder', 'live-feed']);
// keep in sync with views[].capabilities  ← this comment is the smell

// ✅ — server-side filter at the import boundary
import { filterServerSafeCartridge } from '@airo-js/ssr';
const serverSafeCartridge = filterServerSafeCartridge(myCartridge);

// ✅ — client-side derivation when you need the page-type set
const csrOnly = new Set(
  myCartridge.views
    .filter((v) => v.capabilities?.includes('csr-only'))
    .map((v) => v.pageType),
);
```

The capability declarations on `views[]` are the source of truth. Parallel constants are technical debt with a sync comment attached. When a new capability ships (`'requires-auth'`, `'requires-feed'`), extending `excludeCapabilities` or the filter predicate is a one-place change; extending three parallel constants is three opportunities to forget.

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

### 4.5 Host-server SSR — pre-rendering widgets in your page response

Host apps that already render markup server-side (Next.js / Astro / SvelteKit / edge functions / classic templating engines) skip embed's `fetchSsrHtml` round-trip via the `airo-ssr="hydrate"` attribute. Inject the widget HTML directly inside the custom element; embed detects the attribute and hydrates the existing DOM. Full mechanics in Section 5.6.

```html
<!-- in your host-rendered page response -->
<my-app my-id="wgt_abc" airo-ssr="hydrate">
  <!-- host-server-rendered SSR HTML -->
  <article class="product-card">…</article>
</my-app>
```

The cartridge's renderer hydrates against the existing markup — no re-paint, no flash, no extra HTTP round-trip.

---

## 5. SSR-safe rendering

SSR-safe rendering is the discipline that lets a cartridge produce identical HTML on a server (Node, Deno, edge function — anywhere with a DOM polyfill) and in a browser, then hydrate listeners against that server-painted markup without re-rendering. Three audiences benefit:

- **End users** — page is meaningful immediately; no flash of empty content while the JS bundle loads.
- **Search engines** — crawlers see real content + structured data, not an empty shell.
- **AI agents** — language models parsing the page see content + JSON-LD (from `PublicationAdapter`s), not waiting for a JS runtime.

The rendering tree that preceded the cartridge contract taught us the load-bearing rule: the three lifecycle methods (`render` / `renderSSR` / `hydrate`) MUST produce byte-identical DOM. Drift → hydration mismatch → listener loss, repaint flash, or both. The framework's `@airo-js/cartridge-kit` v0.4.1+ ships primitives that make drift impossible by construction. Use them.

### 5.1 The three discipline rules

Every SSR-safe cartridge renderer follows three rules:

1. **`template(ctx)` is pure.** Same `RenderContext` in, same string out. No DOM reads, no global state, no time/random sources during render:
   - ❌ `Date.now()`, `Math.random()`, `crypto.randomUUID()` in the template (server time/randomness ≠ client time/randomness)
   - ❌ `window.innerWidth`, `document.cookie`, `localStorage` in the template (server has none of these)
   - ❌ Reading the existing DOM in the template (server has no existing DOM)
   - ✅ Anything that's a pure function of `ctx.app`, `ctx.page`, `ctx.navState`

2. **Listener attachment lives in `hydrate(root, ctx)`.** This one handler runs on BOTH the CSR fresh-mount path AND the SSR-hydrate path. Code is shared by construction — drift between "what the CSR path does" and "what the hydrate path does" is structurally impossible.

3. **State is NEVER serialized into the SSR HTML.** The client recomputes from the same `(config, snapshot)` the server saw. Two reasons: (a) recomputation is cheap — the same work `renderSSR` did, no DOM; (b) removes the entire class of tampering bugs from trusting a serialized state blob round-tripped through the customer's page.

Inline payloads (the `<script type="application/json">` that ships data alongside the markup) MUST carry recomputable signals only — `config`, `snapshot` — never derived state like `selectedIndex`, `expandedGroups`, `cartItems`. The client re-derives state from the same inputs the server saw; output matches because the function is pure.

### 5.2 `defineSSRSafeRenderer` — the canonical factory

`@airo-js/cartridge-kit` ships `defineSSRSafeRenderer({ template, hydrate })` to make the three rules structural — you can't accidentally break them. One pure template + one hydrate handler:

```ts
import { defineSSRSafeRenderer } from '@airo-js/cartridge-kit';
import type { RenderContext } from '@airo-js/core';

type AppCtx = { /* whatever your cartridge threads through */ };

// Rule 1: pure render. Same ctx → same string. No DOM, no globals.
function productCardTemplate(ctx: RenderContext<string, AppCtx>): string {
  const product = ctx.app.data.product;
  return `
    <article class="my-product-card" data-product-id="${escapeHtml(product.id)}">
      <h2>${escapeHtml(product.title)}</h2>
      <p>${escapeHtml(product.description)}</p>
      <button class="my-buy-btn">Buy</button>
    </article>
  `;
}

// Rule 2: listeners only. CSR + SSR-hydrate share this code.
function attachProductCardListeners(
  root: HTMLElement,
  ctx: RenderContext<string, AppCtx>,
): () => void {
  const btn = root.querySelector<HTMLButtonElement>('.my-buy-btn');
  const handler = () => ctx.events.emit('product:buy-click', { productId: ctx.app.data.product.id });
  btn?.addEventListener('click', handler);
  return () => btn?.removeEventListener('click', handler);  // cleanup runs on destroy()
}

export const productCardRenderer = defineSSRSafeRenderer({
  template: productCardTemplate,
  hydrate: attachProductCardListeners,
});
```

The factory derives:
- `render(target, ctx)` — paints `template`, then runs `hydrate`.
- `renderSSR(target, ctx)` — paints `template`, NO `hydrate` (server has no client to hear).
- `hydrate(target, ctx)` — DOM already painted (SSR HTML or pre-injected light DOM); runs `hydrate` only. No re-paint, no listener loss, no `template` call at all.
- `destroy()` — invokes the cleanup function returned by `hydrate`.

Drift between the three lifecycle methods is structurally impossible — they all consume the same `template` and `hydrate` inputs. Wire it into a `ViewDefinition`:

```ts
const views: ViewDefinition<MyData, MyConfig>[] = [{
  id: 'product-card',
  displayName: 'Product Card',
  pageType: 'product',
  factory: productCardRenderer,
  capabilities: ['ssr-safe', 'hydratable'],
  stylesheet: productCardCss,  // cartridge-owned; framework injects no default CSS
}];
```

### 5.3 `parseHtml` / `parseHtmlFragment` — env-agnostic seam

When you need to parse HTML into DOM nodes (rather than assign `innerHTML`), use the framework helpers from `@airo-js/core`:

```ts
import { parseHtml, parseHtmlFragment } from '@airo-js/core';

// Single root
const node = parseHtml('<div>x</div>', host.ownerDocument);
host.appendChild(node);

// Multi-root
const fragment = parseHtmlFragment('<li>a</li><li>b</li>', host.ownerDocument);
list.appendChild(fragment);
```

Both helpers:
- Parse via `<template>` element — no script execution, safer than `innerHTML` on a generic element when input is feed-derived.
- Resolve `Document` via explicit arg → `globalThis.document` → throw with a useful error (the message names `host.ownerDocument` as the recommended source).
- Work with any DOM implementation: browser, jsdom, happy-dom, linkedom, deno-dom.

### 5.4 `host.ownerDocument` over `globalThis.document`

Pass `host.ownerDocument` to `parseHtml` when you have a host element. Three reasons:

- **Shadow DOM-safe.** Inside a shadow root, `host.ownerDocument` returns the document that owns the shadow tree. `globalThis.document` may not match if the host element lives in a different frame.
- **No global state.** Functions that take `host.ownerDocument` explicitly are testable without setting up a global polyfill.
- **Multi-frame correctness.** A widget mounted into an iframe's host gets the iframe's document, not the parent's.

```ts
// ✅
function paint(host: HTMLElement, html: string): void {
  const node = parseHtml(html, host.ownerDocument);
  host.appendChild(node);
}

// ❌ — globally-coupled; breaks in iframe + multi-document setups
function paint(host: HTMLElement, html: string): void {
  const node = parseHtml(html);  // falls back to globalThis.document
  host.appendChild(node);
}
```

If you need a `Document` without a host element (a pure utility that emits markup), accept the document as a parameter. Never read `globalThis.document` directly from cartridge code — make the environment the caller's concern.

### 5.5 Capability flags — when a view can't SSR

Some renderers can't run server-side: they depend on `IntersectionObserver`, `requestAnimationFrame`, `window.navigator.geolocation`, third-party libraries that need a real browser (maps, video players, WebGL canvases). Declare the limitation honestly on the `ViewDefinition`:

```ts
const views: ViewDefinition<MyData, MyConfig>[] = [{
  id: 'map-view',
  pageType: 'store-finder',
  factory: storeFinderRenderer,
  capabilities: ['csr-only'],  // honest declaration; framework reads this
}];
```

`@airo-js/ssr`'s `renderAppWithPublication` reads the flag at the dispatch boundary. When the entry page's view is `'csr-only'`, the runner:

- Skips the renderer call (no server-side DOM crash).
- Returns `{ skipped: { pageType, reason: 'csr-only' }, html: inlineScripts, adapterResults }`.
- **Still runs all `PublicationAdapter`s and inlines JSON-LD** — the SEO partial-win. Crawlers see the structured data; the widget itself mounts client-side as usual via `mountCartridge`.

**Server-side: use `filterServerSafeCartridge` + `templateToAppConfig` at the SSR entry.** Two helpers; `mountCartridge` uses both internally, SSR callers should use the same two so the server- and client-side translations stay in lock-step:

```ts
// Server-side entry (Node / Deno / edge function)
import { filterServerSafeCartridge, renderAppWithPublication } from '@airo-js/ssr';
import { templateToAppConfig } from '@airo-js/cartridge-kit';
import { myCartridge } from '@my-org/my-cartridge';

// 1. Drop csr-only views — type-narrowed cartridge ready for SSR.
const serverSafe = filterServerSafeCartridge(myCartridge);

// 2. Build AppConfig from the same Template the client mounts.
//    `templateToAppConfig` is the canonical translator — `mountCartridge`
//    uses it too, so the server and client see identical page graphs.
const template = serverSafe.templates.find((t) => t.id === templateId)!;
const appConfig = templateToAppConfig(template, widgetId);

// 3. Render.
const result = await renderAppWithPublication({
  cartridge: serverSafe,
  appConfig,
  snapshot,
  publicationCtx,
});
```

Don't hand-roll the `Template → AppConfig` translation. `mountCartridge` and `templateToAppConfig` ship the same mapping (subset → `AppConfig.pages` with empty layout placeholders); duplicating the logic in your SSR entry is exactly the parallel-list anti-pattern (Section 3.12) one layer up.

Default-excludes `['csr-only']`. Compose additional capability gates via `excludeCapabilities`:

```ts
const anonymouslySafe = filterServerSafeCartridge(myCartridge, {
  excludeCapabilities: ['csr-only', 'requires-auth'],
});
```

Two reasons to filter at import (not just rely on the dispatch gate):

- **Discoverability.** The helper lives next to `renderAppWithPublication` in `@airo-js/ssr`; the cartridge author finds it on their first import. The dispatch gate is invisible until a server-side crash surfaces it.
- **Forward-compat by default.** Adding a new server-unsafe capability to the framework's default exclusion set (a future release) extends every caller's filter automatically. Hand-rolled `views.filter(...)` calls don't pick up the new default.

**Client-side: derive the same set from the cartridge.** When client code needs to know which page types are CSR-only (e.g., to skip server hydration for those entries on initial paint), derive from the cartridge — never from a parallel allowlist:

```ts
const csrOnlyPageTypes = new Set(
  myCartridge.views
    .filter((v) => v.capabilities?.includes('csr-only'))
    .map((v) => v.pageType),
);
```

One source of truth (`ViewDefinition.capabilities`) — no drift, no sync comment, no parallel list to maintain. See Anti-pattern 3.12 for why parallel runtime allowlists are a smell.

**Mailbox-only cartridges** (views registered via `pushToMailbox` on chunk load, no static `views[]`) skip the capability check at this layer — the flag isn't available before the chunk loads. Cartridges that need the gate must ship a static `ViewDefinition` placeholder in `views[]` with `capabilities` set; `filterServerSafeCartridge` and the dispatch gate both read from that array.

Don't claim `'ssr-safe'` if your renderer imports `window` or third-party browser-only libs at module scope. The honest declaration is a feature, not a failure.

### 5.6 Host-server SSR — `airo-ssr="hydrate"`

For host apps that already render the widget HTML server-side (Campaign Pages, Next.js / Astro / SvelteKit integrations, edge-rendered pages), the embed flow has a fast path. Set the SSR-mode attribute on the custom element and inject the markup directly:

```html
<my-app my-id="wgt_abc123" airo-ssr="hydrate">
  <!-- host-server-rendered SSR HTML for this widget -->
  <article class="my-product-card">…</article>
</my-app>
```

When `@airo-js/embed` (v0.4.2+) sees the attribute AND non-empty `innerHTML` at `connectedCallback` time, it:

- **Skips `fetchSsrHtml`** — no extra round-trip; the host server already paid the cost.
- **Preserves `innerHTML`** — no re-paint that would wipe user-attached listeners or burn parser work.
- Mounts in hydrate mode — the cartridge renderer's `hydrate(root, ctx)` runs against existing DOM.

Without the attribute, embed treats existing `innerHTML` as a loading skeleton (the v0.4.1 behaviour) and overwrites it on mount. Empty `innerHTML` plus the attribute falls back to `fetchSsrHtml`. Both patterns are supported; the opt-in attribute disambiguates.

Configure the attribute name per host-app brand:

```ts
defineAiroApp({
  elementName: 'my-app',
  idAttribute: 'my-id',
  ssrModeAttribute: 'my-ssr',  // default: 'airo-ssr'
  // ...
});
```

Customers then paste `<my-app my-id="…" my-ssr="hydrate">…SSR HTML…</my-app>`. Consistent with your existing `elementName` / `idAttribute` branding.

### 5.7 Testing the byte-identical-HTML invariant

The hydration-correctness rule: `template(ctx)` produces the same string given the same `ctx`, in any environment. When the template is a pure function, testing reduces to string equality:

```ts
import { describe, expect, test } from 'vitest';
import { productCardTemplate } from './product-card-template.js';
import { renderAppToHTML } from '@airo-js/ssr';
import { Window } from 'happy-dom';

test('template is pure — same ctx produces same output', () => {
  const ctx = buildCtx({ /* deterministic inputs */ });
  expect(productCardTemplate(ctx)).toBe(productCardTemplate(ctx));
});

test('SSR HTML contains the template output verbatim', () => {
  const window = new Window();
  globalThis.document = window.document;
  const { html } = renderAppToHTML(appConfig, deps);
  // template output is a substring of the full SSR HTML
  expect(html).toContain('<article class="my-product-card"');
});
```

No DOM round-trip needed for the purity check — the template is the unit. The cross-environment parity test (jsdom vs happy-dom vs linkedom vs deno-dom) collapses to "did `template(ctx)` return the same string under each runtime" — which is trivially true if `template` is pure. **This is why purity matters operationally**, not just philosophically.

### 5.8 When to drop to raw `PageRenderer`

`defineSSRSafeRenderer` covers the common case — pure template + hydrate handler. Some renderers need more:

- **Subpages** (`activateSubpage`) — modals, drawers, overlays that ride on a parent page (see Section 2.4).
- **`applyPageStyles` / `applyComponentStyles`** — live style edits from a studio overlay editor.

For those, implement `PageRenderer` directly:

```ts
import type { PageRenderer, PageRendererFactory } from '@airo-js/core';

const productRenderer: PageRendererFactory<'product', AppCtx> = () => {
  let quickViewModal: QuickViewModal | null = null;
  let detachListeners: () => void = () => undefined;

  return {
    render(target, ctx) {
      target.innerHTML = productTemplate(ctx);
      detachListeners = wireProductListeners(target, ctx);
    },
    renderSSR(target, ctx) {
      // Same template — drift caught at code-review time, not at runtime
      target.innerHTML = productTemplate(ctx);
    },
    hydrate(target, ctx) {
      // Same listener wiring as render path
      detachListeners = wireProductListeners(target, ctx);
    },
    activateSubpage(subpage) {
      if (subpage.type === 'quickview') {
        quickViewModal = new QuickViewModal(/* … */);
      }
    },
    destroy() {
      quickViewModal?.destroy();
      detachListeners();
    },
  };
};
```

The same discipline applies — `render` and `renderSSR` call the same `productTemplate`; `hydrate` runs the same `wireProductListeners` as the CSR path. Hand-write the three methods, but keep the inputs pure. The factory is sugar, not a contract: any `PageRenderer` that follows the discipline is correct.

You can also wrap `defineSSRSafeRenderer` for the lifecycle base and override only the methods you need:

```ts
const base = defineSSRSafeRenderer({ template, hydrate });
const withSubpages: PageRendererFactory<'product', AppCtx> = () => {
  const inner = base();
  return {
    ...inner,
    activateSubpage(subpage) { /* … */ },
  };
};
```

Either pattern is correct.

### 5.9 Zero-FOUC SSR via Declarative Shadow DOM

The `airo-ssr="hydrate"` pattern (§5.6) ships SSR HTML as light-DOM children of the custom element. embed lifts that markup into a shadow wrapper at mount time. Trade-off: between initial page paint and the embed lift, the browser shows the light-DOM SSR HTML unstyled by any shadow-scoped CSS — a flash of unstyled content (FOUC).

**Declarative Shadow DOM** (DSD — Chrome 111+ / Firefox 123+ / Safari 16.4+) closes that window. The server emits the shadow root *as HTML*, the browser attaches it during initial parse, and shadow-scoped styles apply before the first paint. embed and the runtime adopt the existing shadow root at mount — no lift, no flash.

**The server output shape:**

```html
<my-app my-id="wgt_abc123">
  <template shadowrootmode="open">
    <article class="my-product-card" data-product-id="prod_42">
      <h2>Title</h2>
      <p>Description</p>
      <button class="my-buy-btn">Buy</button>
    </article>
    <style>
      .my-product-card { padding: 16px; border: 1px solid #ddd; }
      .my-buy-btn { background: #06f; color: white; }
    </style>
  </template>
</my-app>
```

The browser parses `<template shadowrootmode="open">`, attaches a shadow root on `<my-app>`, and moves the template's content into it. CSS inside the template is shadow-scoped from the first paint. No FOUC.

**What embed does** (`@airo-js/embed@0.4.3+`):

- Detects `this.shadowRoot !== null` at `connectedCallback` time.
- Skips `fetchSsrHtml` (DSD presence implies the SSR work already happened).
- Skips the light-DOM-lift `innerHTML` assignment (DSD content lives in the shadow, not in `innerHTML`).
- Forces `mode: 'hydrate'` so the cartridge renderer adopts the existing DOM.

**What the runtime does** (`@airo-js/runtime@0.4.2+`):

- `mountCartridge` detects `host.shadowRoot !== null` and skips the light-DOM lift block entirely.
- `setupIsolationRoot` (`@airo-js/core@0.4.3+`) reuses the existing shadow root. If the DSD content isn't wrapped in `.airo-shadow-root`, the framework auto-wraps it (transparent to the cartridge author — the wrapper class is a framework implementation detail).
- `renderer.hydrate(root, ctx)` runs against the auto-wrapped content. Listeners attach to existing nodes.

**Cartridge author's responsibilities:**

1. Ship a deterministic `template(ctx)` (already required for SSR-safe renderers — see §5.1).
2. Ensure `hydrate(root, ctx)` works against existing DOM without re-painting (already required — see §5.2).
3. **Don't** rely on `:host > .my-content` CSS selectors that assume the first child of the shadow root is your content. The framework's auto-wrap places your content inside `.airo-shadow-root` if you didn't ship the wrapper yourself. Scope by class (`.my-content`) instead — shadow boundary already isolates from page CSS.

**Server-side wrapper convention.** Two equivalent emit shapes:

```html
<!-- Option A: content directly under <template> — framework auto-wraps -->
<template shadowrootmode="open">
  <article>…</article>
  <style>…</style>
</template>

<!-- Option B: emit the framework wrapper class explicitly — no auto-wrap -->
<template shadowrootmode="open">
  <div class="airo-shadow-root">
    <article>…</article>
  </div>
  <style>…</style>
</template>
```

Both produce identical post-mount DOM. Option A is simpler for hand-authored SSR; Option B is one DOM op cheaper if your build pipeline already knows about the wrapper.

**When DSD isn't an option.** Older browsers (Chrome <111, Firefox <123, Safari <16.4) parse `<template shadowrootmode>` as a plain `<template>` and ignore the attribute — the SSR content stays inside the template element, invisible to users. Two fallback paths:

- **Server-detect.** If the request's User-Agent is too old, server emits the light-DOM SSR shape (§5.6) instead of DSD. Both paths work simultaneously — embed handles whichever is present.
- **Polyfill.** `@oddbird/dsd` is a small polyfill that walks the document on load and attaches shadow roots from `<template shadowrootmode>` declarations. Adds ~1 KB; works in every evergreen browser.

The framework supports both with no code change — DSD detection is a runtime check on `host.shadowRoot`, not a build-time flag.

---

## 6. Update process

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

defineAiroApp({
  elementName: 'my-app',
  idAttribute: 'my-id',
  loadConfig: async (id) => fetch(`/widgets/${id}/load`).then((r) => r.json()),
  resolveCartridge: async (id) => (await import(`@my-org/${id}-cartridge`)).default,
  onError: (phase, err) => console.error(`[${phase}]`, err),
});
```

That's the v0 shape. Anything materially different from this is either a new pattern (update this guide) or a mistake (re-read this guide).
