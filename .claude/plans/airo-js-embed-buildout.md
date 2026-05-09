---
name: @airo-js/embed — buildout plan
description: Build the @airo-js/embed package out of placeholder so host apps don't roll their own (lesson learned from @airo-js/runtime). Provides the customer-facing custom element + lazy load of runtime + chunk + cartridge. Generic where it can be (web component, chunk loading); hooks for studio-specific concerns (auth, LoadResponse fetch, cartridge resolution).
---

# `@airo-js/embed` — buildout plan

## Why now (not Phase 2)

We left `@airo-js/runtime` as a placeholder and the monorepo team rolled their own studio-specific equivalent (`cartridge.ts`, 340 LOC, ~70% generic logic that should have lived in the framework). Three weeks later the runtime buildout is now ~3.5 days of catch-up work to factor that duplication out.

`@airo-js/embed` is on the same trajectory. Currently 1-export placeholder. Two host apps are already brushing against the production-embed problem:

- `dotter-widget-studio/src/embed/index.ts` (546 LOC) — dual-runtime (v1 + airo), `chunkBaseFor()` fork, fully studio-aware
- `dotter-monorepo/apps/dotter-studio/src/embed/index.ts` (256 LOC) — production auth (HMAC tokens, LoadResponse from `/widgets/:id/load`), v1-only today

When the monorepo team needs cartridge production embed (next ~2-4 weeks based on roadmap), they'll either:
- (a) extend their existing v1 embed loader with a cartridge branch, OR
- (b) consume `@airo-js/embed`

**Option (a) repeats the runtime mistake.** Studio owns its own embed loader forever; second cartridge consumer reimplements the same generic plumbing.

**This plan ships option (b) ahead of demand.** Build `@airo-js/embed` now using the two existing loaders as the corpus; consumer migrates when production cartridge embed becomes a real ticket.

## What @airo-js/embed owns vs what stays host-app-side

Same M13 line as runtime. **Embed owns generic orchestration; host apps own auth + fetch + cartridge resolution.**

| Concern | Owner |
|---|---|
| Custom element registration (`<airo-app id="..." token="...">`) | embed |
| `connectedCallback` / `disconnectedCallback` lifecycle | embed |
| Script-src derivation for chunk base URL | embed |
| Lazy load `@airo-js/runtime` + `@airo-js/cartridge-kit` | embed |
| Lazy load per-page chunks via `<script>` | embed |
| CSR ↔ SSR-hydrate fork | embed |
| Mount handoff to `mountCartridge` | embed |
| Element name + attribute names (e.g. `dotter-app` / `dtr-id`) | **host app** (config knob) |
| Fetch widget config + runtime metadata from studio | **host app** (`loadConfig` hook) |
| HMAC token validation, embed-protocol auth | **host app** (token shape is studio-specific) |
| Cartridge module resolution by id | **host app** (`resolveCartridge` hook) |
| SSR HTML fetch endpoint | **host app** (`fetchSsrHtml` hook, optional) |
| Studio-specific error UI / fallbacks | **host app** (`onError` hook) |

Bundle size budget: **~5 KB minified, ~2.5 KB gzip**. Matches v1's `dotter-embed.js` (5.99 KB / 2.38 KB). Anything bigger and we're shipping logic that should be lazy-loaded.

## Public surface

```ts
// @airo-js/embed

import type { Cartridge } from '@airo-js/cartridge-kit';
import type { StyleIsolation } from '@airo-js/core';

export interface LoadConfigResult<TConfig> {
  /** Cartridge config — shape declared by the cartridge's TConfig. */
  config: TConfig;
  /** Cartridge id used to resolve the cartridge module via `resolveCartridge`. */
  cartridgeId: string;
  /** Template id picked for this widget. Defaults to cartridge.defaultTemplateId. */
  templateId?: string;
  /** Style isolation strategy. Default: 'partial'. */
  styleIsolation?: StyleIsolation;
  /** CDN base URL for runtime + chunk loading. */
  runtimeBase: string;
  /** Pinned runtime version. e.g. '0.1.0'. */
  runtimeVersion: string;
  /** Optional pre-rendered HTML for SSR-hydrate path. */
  ssrHtml?: string;
  /** Optional preloaded data — skips dataSource.fetch in mountCartridge. */
  preloadedData?: unknown;
}

export interface DefineAiroAppOptions {
  /**
   * Custom element tag name. e.g. 'airo-app' (default), 'dotter-app',
   * 'commerce-widget'. Host apps pick a name that fits their brand.
   */
  elementName?: string;
  /**
   * Attribute name for the widget id. e.g. 'airo-id' (default), 'dtr-id'.
   * Customer pastes `<airo-app airo-id="dw_abc123">` to mount.
   */
  idAttribute?: string;
  /**
   * Attribute name for the auth token. Optional — same-origin previews
   * skip. e.g. 'airo-token' (default), 'dtr-token'.
   */
  tokenAttribute?: string;

  /**
   * Fetch widget config from the host app's studio backend. Called once
   * per element mount with the id + (optional) token attribute values.
   * Host app handles auth headers, allowed-domain checks, LoadResponse
   * envelope unwrapping — embed only sees the result.
   */
  loadConfig: <TConfig>(
    id: string,
    token: string | null,
  ) => Promise<LoadConfigResult<TConfig>>;

  /**
   * Resolve a cartridge by id. Host app typically dynamic-imports the
   * cartridge module here:
   *
   *   resolveCartridge: async (id) => {
   *     if (id === 'commerce') return (await import('@my-org/commerce-cartridge')).commerceCartridge;
   *     throw new Error(`unknown cartridge: ${id}`);
   *   }
   *
   * The dynamic import keeps the embed bundle tiny — cartridge code only
   * loads when an element with that id renders.
   */
  resolveCartridge: (id: string) => Promise<Cartridge<unknown, unknown>>;

  /**
   * Optional SSR-hydrate path. When implemented AND `loadConfig` returns
   * `ssrHtml`, the embed injects the SSR HTML, then mountCartridge hydrates
   * over it. Without this hook, all widgets CSR.
   */
  fetchSsrHtml?: (id: string, token: string | null) => Promise<string | null>;

  /**
   * Hook called when mount fails at any phase. Host app supplies the
   * studio-branded error UI. Default: console.error + leave host element
   * empty.
   */
  onError?: (
    phase: 'load-config' | 'resolve-cartridge' | 'fetch-ssr' | 'mount',
    err: unknown,
    host: HTMLElement,
  ) => void;

  /**
   * Hook called when an element mounts successfully. Observability /
   * analytics anchor. Host app emits to its own telemetry from here.
   */
  onMounted?: (id: string, host: HTMLElement) => void;
}

/**
 * Register the custom element. Idempotent — calling twice with the same
 * `elementName` is a no-op (logs a warning). Different element names can
 * coexist (one host app may register both `dotter-app` for v1 widgets
 * and `airo-app` for cartridge widgets during the transition).
 */
export function defineAiroApp(opts: DefineAiroAppOptions): void;
```

## Framework side — work units

**Estimate:** ~2 days, single dev. No external dependencies; all primitives are shipped (`mountCartridge` once runtime buildout lands; `Cartridge` type from cartridge-kit).

### WU-E1 — Public surface design (~3 hours)

Lock the `defineAiroApp(opts)` signature. Specifically resolve:

1. **Should `loadConfig` return the runtime version, or should embed pin to its own version?** If embed bundle is `0.1.0` and config returns `runtimeVersion: '0.2.0'`, do we load the newer runtime? (Probably yes — runtime version comes from config; embed bundle is just the entry point.)

2. **How does embed handle runtime version mismatches?** If `mountCartridge`'s signature changes between runtime versions, embed needs to fork on what the loaded runtime exports. (Approach: embed declares a `RUNTIME_API_VERSION` constant; runtime exports the same; embed checks at load time and falls back / throws.)

3. **Cartridge dynamic-import vs embed dynamic-import?** When a customer pastes `<airo-app id="dw_abc">`, embed needs to load BOTH the runtime AND the cartridge module. Two separate dynamic imports? One bundled? Probably two — `resolveCartridge` does the cartridge import, embed does the runtime import.

**Acceptance:** signature reviewed against both `dotter-widget-studio/src/embed/index.ts` and `dotter-monorepo/apps/dotter-studio/src/embed/index.ts`. No silent assumption about studio auth scheme, LoadResponse shape, or cartridge module location.

### WU-E2 — Custom element class implementation (~5 hours)

```ts
// packages/embed/src/define-airo-app.ts

import type {
  Cartridge,
  Template,
} from '@airo-js/cartridge-kit';

const REGISTERED_ELEMENTS = new Set<string>();

export function defineAiroApp(opts: DefineAiroAppOptions): void {
  const elementName = opts.elementName ?? 'airo-app';
  const idAttribute = opts.idAttribute ?? 'airo-id';
  const tokenAttribute = opts.tokenAttribute ?? 'airo-token';

  if (typeof customElements === 'undefined') return;       // SSR safety
  if (REGISTERED_ELEMENTS.has(elementName)) {
    console.warn(`[@airo-js/embed] '${elementName}' already registered; skipping.`);
    return;
  }

  class AiroAppElement extends HTMLElement {
    private result: { destroy: () => void } | null = null;

    async connectedCallback(): Promise<void> {
      const id = this.getAttribute(idAttribute);
      if (!id) {
        console.error(`[@airo-js/embed] <${elementName}> missing required ${idAttribute} attribute`);
        return;
      }
      const token = tokenAttribute ? this.getAttribute(tokenAttribute) : null;

      // Phase 1 — load config from host app.
      let loaded: LoadConfigResult<unknown>;
      try {
        loaded = await opts.loadConfig(id, token);
      } catch (err) {
        opts.onError?.('load-config', err, this);
        return;
      }

      // Phase 2 — resolve cartridge.
      let cartridge: Cartridge<unknown, unknown>;
      try {
        cartridge = await opts.resolveCartridge(loaded.cartridgeId);
      } catch (err) {
        opts.onError?.('resolve-cartridge', err, this);
        return;
      }

      // Phase 3 — fetch SSR HTML if requested.
      let ssrHtml: string | null = loaded.ssrHtml ?? null;
      if (!ssrHtml && opts.fetchSsrHtml) {
        try {
          ssrHtml = await opts.fetchSsrHtml(id, token);
        } catch (err) {
          opts.onError?.('fetch-ssr', err, this);
          // Fall through to CSR — SSR is opportunistic.
        }
      }

      // Phase 4 — dynamic-import the runtime.
      const { mountCartridge } = await import('@airo-js/runtime');

      // Phase 5 — pick template.
      const templateId = loaded.templateId ?? cartridge.defaultTemplateId;
      const template = cartridge.templates.find((t) => t.id === templateId);
      if (!template) {
        opts.onError?.('mount', new Error(`unknown template: ${templateId}`), this);
        return;
      }

      // Phase 6 — if SSR HTML, inject before mount; mountCartridge then hydrates.
      if (ssrHtml) {
        this.innerHTML = ssrHtml;
        // mountCartridge knows how to hydrate when host already has DOM.
      }

      // Phase 7 — mount.
      try {
        const result = await mountCartridge({
          cartridge,
          config: loaded.config,
          template,
          host: this,
          styleIsolation: loaded.styleIsolation,
          widgetId: id,
          preloadedData: loaded.preloadedData,
        });
        if (result.blocked) {
          // Gate UI is in place; no app to track. destroy() on unmount no-ops.
          this.result = result;
          return;
        }
        this.result = result;
        opts.onMounted?.(id, this);
      } catch (err) {
        opts.onError?.('mount', err, this);
      }
    }

    disconnectedCallback(): void {
      this.result?.destroy();
      this.result = null;
    }
  }

  customElements.define(elementName, AiroAppElement);
  REGISTERED_ELEMENTS.add(elementName);
}
```

**Acceptance:**
- Tests cover load-config error, resolve-cartridge error, fetch-ssr error fall-through, mount error, gate-blocked path, normal CSR mount, SSR-hydrate path
- Bundle size ≤ 5 KB minified / 2.5 KB gzip (excluding lazy-loaded runtime + cartridge)
- Idempotent registration: calling `defineAiroApp` twice with same elementName warns and no-ops

### WU-E3 — Tests (~3 hours)

Same fake-cartridge fixture pattern as runtime tests. ~8 tests:

```
[ ] Happy path: <airo-app airo-id="x"> mounts, onMounted fires
[ ] loadConfig throws → onError('load-config', ...) fires; no mount
[ ] resolveCartridge throws → onError('resolve-cartridge', ...) fires
[ ] fetchSsrHtml throws → falls through to CSR; mount succeeds
[ ] Gate blocks → result.blocked: true; no onMounted
[ ] Custom element disconnect → destroy() called
[ ] Element name collision → warn + skip second registration
[ ] No id attribute → error logged; no mount attempted
```

Use jsdom for custom element registration. Module mocking for the dynamic `import('@airo-js/runtime')` call.

### WU-E4 — Bundle size verification (~1 hour)

Add to `packages/embed/package.json`:

```json
{
  "scripts": {
    "size": "esbuild --bundle --minify --format=iife src/index.ts | wc -c",
    "size:gzip": "esbuild --bundle --minify --format=iife src/index.ts | gzip -c | wc -c"
  }
}
```

Acceptance gate: minified < 5 KB, gzip < 2.5 KB. CI fails the build if either is exceeded.

The lazy-imported `@airo-js/runtime` is NOT counted in this budget — it loads on demand when an element mounts, not when the embed script loads.

### WU-E5 — Barrel + package wiring (~30 min)

```ts
// packages/embed/src/index.ts

export type {
  LoadConfigResult,
  DefineAiroAppOptions,
} from './define-airo-app.js';
export { defineAiroApp } from './define-airo-app.js';

export const PACKAGE_NAME = '@airo-js/embed';
```

Update `packages/embed/package.json`:
- Add `@airo-js/cartridge-kit` as devDep (type-only import; no runtime cost)
- Add `@airo-js/runtime` as **peerDep** (loaded dynamically; not bundled)
- Build target: IIFE for direct script-tag inclusion; ESM for bundler consumers

### WU-E6 — README + yalc push (~1 hour)

`packages/embed/README.md` covering:
- 30-line "minimum viable host app embed" example
- The hook contract
- The script-tag deployment story (host app builds embed bundle, customer pastes `<script src=".../embed.js">`)
- Runtime + cartridge dynamic-import diagram
- Bundle size budget + how to verify

### Acceptance gate (framework side complete)

```
[ ] WU-E1: defineAiroApp signature merged
[ ] WU-E2: implementation merged
[ ] WU-E3: 8+ tests passing
[ ] WU-E4: bundle ≤ 5 KB min / 2.5 KB gz; CI gate added
[ ] WU-E5: package surface + dep wiring landed
[ ] WU-E6: README + yalc push
[ ] Type-check + build clean across all 7 packages
[ ] @airo-js/embed depends on @airo-js/cartridge-kit (type-only) + @airo-js/runtime (peer)
```

---

## Consumer side — recommended migration path

Not in scope for this plan to LAND consumer-side. But documenting the migration shape so the framework team designs the surface against a real consumer scenario.

### When the monorepo team needs cartridge production embed

Today the monorepo's `apps/dotter-studio/src/embed/index.ts` is v1-only. When cartridge widgets need to ship to customer pages, the team has two options:

#### Option (a) — extend existing embed.ts with cartridge branch

```ts
// apps/dotter-studio/src/embed/index.ts (current shape)

if (config.app.runtime === 'airo' || isAiroCartridge(config)) {
  // Cartridge path — load @airo-js/runtime, mount via mountCartridge
  await loadCartridgeRuntime(loaded);
} else {
  // Existing v1 path
  await loadV1Runtime(loaded);
}
```

Reasonable next move; keeps everything studio-side. Cost: studio owns its own embed loader forever; second cartridge consumer (Restaurant studio, future host app) reimplements.

#### Option (b) — consume `@airo-js/embed`

```ts
// apps/dotter-studio/src/embed/index.ts (post-buildout)

import { defineAiroApp } from '@airo-js/embed';

defineAiroApp({
  elementName: 'dotter-app',
  idAttribute: 'dtr-id',
  tokenAttribute: 'dtr-token',

  loadConfig: async (id, token) => {
    // Hit /widgets/:id/load with HMAC auth — studio's existing endpoint
    const headers: Record<string, string> = {};
    if (token) {
      headers['X-Embed-Token'] = token;
      headers['X-Embed-Origin'] = window.location.origin;
    }
    const res = await fetch(`${STUDIO_API_BASE}/widgets/${id}/load`, {
      headers,
      credentials: token ? 'omit' : 'include',
    });
    if (!res.ok) throw new Error(`load failed: ${res.status}`);
    const body = await res.json();
    return {
      config: body.config,
      cartridgeId: body.config.cartridge?.id ?? 'commerce',
      templateId: body.config.cartridge?.templateId,
      styleIsolation: body.config.app?.styleIsolation,
      runtimeBase: body.runtime?.url ?? RUNTIME_BASE,
      runtimeVersion: body.runtime?.version ?? '0.1.0',
      ssrHtml: body.ssrHtml,
    };
  },

  resolveCartridge: async (id) => {
    if (id === 'commerce') {
      const mod = await import('@/cartridges/commerce');
      return mod.commerceCartridge;
    }
    throw new Error(`unknown cartridge: ${id}`);
  },

  onError: (phase, err) => {
    console.error(`[dotter-embed] ${phase} failed:`, err);
    // Studio-specific error UI lives here
  },

  onMounted: (id) => {
    // Studio analytics: emit widget-mount event
    window.dispatchEvent(new CustomEvent('dotter:widget-mounted', { detail: { id } }));
  },
});
```

Net change: ~256 LOC of studio-side embed logic → ~50 LOC of hooks. Auth + LoadResponse handling stays studio-side (host-app concerns); chunk loading + element registration + lifecycle moves into `@airo-js/embed`.

### V1 widgets during the transition

Cartridge embed lands; v1 widgets keep shipping for a while. Two patterns work:

**Pattern A — single embed loader, fork on config:** `loadConfig` returns either a cartridge config or a v1 config. The studio's `loadConfig` includes a discriminator (`cartridge: { id, ... }` for cartridge widgets, missing for v1). Studio-side code branches:

```ts
loadConfig: async (id, token) => {
  const body = await fetch(`/widgets/${id}/load`, ...).then(r => r.json());
  if (body.config.cartridge?.id) {
    return mapToCartridgeLoadResult(body);
  }
  // v1 widget — return synthetic LoadConfigResult that resolves to a "v1-bridge" cartridge
  return mapV1ConfigToCartridgeShape(body);
}
```

The "v1-bridge" cartridge wraps v1 widget rendering inside the cartridge contract. ~100 LOC of bridge code, sunsets when v1 widgets retire.

**Pattern B — two embed loaders, two element names:** Customer pastes `<dotter-app>` (v1) or `<dotter-cartridge-app>` (cartridge); two separate `defineAiroApp` calls register both elements. v1 element uses the existing v1 mount path; cartridge element uses `@airo-js/embed`'s default cartridge path.

Pattern A is cleaner long-term; pattern B is faster to migrate. Recommend B during transition, A after v1 sunset.

---

## Migration sequence

```
Day 1 (framework, parallel with runtime):
  ├─ AM  WU-E1 (signature design)
  └─ PM  WU-E2 start (custom element class)

Day 2 (framework):
  ├─ AM  WU-E2 finish + WU-E3 (tests)
  └─ PM  WU-E4 (bundle size CI) + WU-E5 (barrel) + WU-E6 (README + yalc push)
         ⇒ framework gate cleared
```

Total framework work: **~2 days**, can run in parallel with runtime buildout (different package, no shared files).

Consumer work: **deferred** until cartridge production embed becomes a real ticket. Estimated ~half day when triggered (auth + fetch logic mostly already in their existing embed.ts; just rewires through `defineAiroApp` hooks).

## What this closes

- **Prevents the runtime mistake from repeating.** Embed package ships a real surface before the consumer needs it; when they do, they consume rather than roll their own.
- **Establishes the M13 line for embed concerns:** chunk loading + custom element + lifecycle = framework; auth + fetch + cartridge resolution = host app. Hooks (`loadConfig`, `resolveCartridge`, `fetchSsrHtml`, `onError`, `onMounted`) are the contract.
- **Locks the bundle size budget at ~5 KB.** Bigger embed bundles = slower customer page loads. The size gate in CI keeps the framework honest.

## Open questions for the framework team

1. **Where does `mountCartridge` live, and how does embed import it?** Embed has `@airo-js/runtime` as a peerDep (not bundled, dynamic-imported). Means the customer's HTML has to load runtime separately. Two ways:
   - **(a) Customer loads both:** `<script src=".../embed.js">` + browser fetches `.../runtime.js` lazily when the element mounts. Standard. Recommended.
   - **(b) Embed bundles runtime:** embed.js contains runtime statically. Bigger bundle (~30 KB combined) but one HTTP request. Worse for customers with multiple widgets per page (runtime ships once vs N times).

   **Recommendation:** (a). Matches v1 (`dotter-embed.js` lazy-loads `dotter-core.js`); customer pages with N widgets pay runtime cost once; matches the yalc dev workflow.

2. **Should `defineAiroApp` register both v1 + cartridge elements, or only cartridge?** Per Pattern B above, host apps may want one bundle that registers `<dotter-app>` (v1) and `<dotter-cartridge-app>` (cartridge). Embed could either:
   - **(a) Only register one element per call.** Host app calls `defineAiroApp` twice with different `elementName`. Simple.
   - **(b) Accept an array of element configs.** One call, multiple registrations. Saves a few lines of host code.

   **Recommendation:** (a). Simpler API; host app composing two `defineAiroApp` calls is honest about what's happening.

3. **Should embed ship a default `loadConfig` that hits a conventional studio endpoint?** Saves host apps writing fetch boilerplate. But: every studio's auth + LoadResponse shape is different, and a default would force a convention nobody actually follows.

   **Recommendation:** no default. Force host apps to implement `loadConfig` explicitly. The hook contract is the documentation; a default would mask studio-specific concerns.

## Verification

This is a plan doc. Acceptance:

1. Framework team reviews the proposed `defineAiroApp` signature, signs off (or pushes back) on the open questions above.
2. WU-E1 → WU-E6 land; framework gate cleared.
3. Bundle size CI passes (≤ 5 KB / 2.5 KB).
4. yalc-pushed package available for the monorepo team to pull when they trigger consumer-side migration.
5. The plan doc gets a "consumer landed" addendum when the monorepo team migrates.

When all five steps pass, `@airo-js/embed` is shipped + ready for production cartridge embed work whenever the monorepo team triggers it.
