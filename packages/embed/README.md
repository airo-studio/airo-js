# `@airo-js/embed`

Customer-facing browser bootstrap loader. The script host pages paste into their HTML to mount an Airo app.

> Status: **v0.2.0**. Custom-element registration + lazy runtime load + SSR-hydrate path + per-page chunk loading via the `resolveView` hook.

## What this does

1. Registers a custom element (default: `<airo-app airo-id="…">`; configurable).
2. When an element appears in the DOM:
   - Calls your `loadConfig(id, token)` to fetch the widget config from your studio backend.
   - Calls your `resolveCartridge(id)` to dynamic-import the cartridge module.
   - Optionally calls `fetchSsrHtml(id, token)` to fetch pre-rendered HTML.
   - Lazy-imports `@airo-js/runtime` (peer dependency).
   - Calls `mountCartridge(...)` with `mode: 'hydrate'` if SSR HTML was provided, else `'csr'`.
   - When the active page's renderer isn't in the bundle yet, calls your optional `resolveView(cartridgeId, pageType)` to load the chunk, then recovers in place (see [Per-page chunk loading](#per-page-chunk-loading)).
3. On disconnect, tears down the mount.

Generic plumbing (custom-element registration, lifecycle, runtime lazy-load, mount handoff) lives here. Studio-specific concerns (auth, LoadResponse shape, cartridge module location, error UI, telemetry) live behind hooks. Same M13 line as `@airo-js/runtime`.

## Bundle size

```
minified: 5.00 KB  /  budget: 5.00 KB
gzip:     2.18 KB  /  budget: 2.50 KB
```

`pnpm size:check` enforces the budget. The runtime is **not** counted — it's loaded lazily via `import('@airo-js/runtime')` when an element mounts, so customer pages with N widgets pay the runtime cost once, and pages with no widget elements never pay it. `EventBus` (used by the `resolveView` recovery path) is pulled off that same lazy runtime import rather than statically imported from `@airo-js/core`, so it adds nothing to the entry bundle.

> The minified figure now sits at the 5 KB ceiling (gzip — the real wire cost — has ~330 B of headroom). The next entry-bundle addition needs a trim pass or a budget revisit.

## Minimal host-app setup

```ts
import { defineAiroApp } from '@airo-js/embed';

defineAiroApp({
  loadConfig: async (id, token) => {
    const res = await fetch(`https://my-studio.example/widgets/${id}/load`, {
      headers: token ? { 'X-Embed-Token': token } : undefined,
    });
    if (!res.ok) throw new Error(`load failed: ${res.status}`);
    const body = await res.json();
    return {
      config: body.config,
      cartridgeId: body.cartridgeId,
      templateId: body.templateId,
      styleIsolation: body.styleIsolation,
      preloadedData: body.preloadedData,
    };
  },

  resolveCartridge: async (id) => {
    if (id === 'commerce') {
      return (await import('@my-org/commerce-cartridge')).commerceCartridge;
    }
    throw new Error(`unknown cartridge: ${id}`);
  },

  onError: (phase, err, host) => {
    console.error(`[my-embed] ${phase} failed:`, err);
    host.innerHTML = '<div class="my-error">Sorry — couldn\'t load.</div>';
  },

  onMounted: (id) => {
    window.dispatchEvent(new CustomEvent('my-embed:mounted', { detail: { id } }));
  },
});
```

Then on a customer page:

```html
<script type="module" src="https://cdn.my-studio.example/embed.js"></script>
<airo-app airo-id="wgt_abc123"></airo-app>
```

## Configuring element + attribute names

```ts
defineAiroApp({
  elementName: 'shop-app',
  idAttribute: 'shop-id',
  tokenAttribute: 'shop-token',
  // ...rest
});
```

Customer pastes: `<shop-app shop-id="app_abc" shop-token="…">`. Custom element names must contain a hyphen (HTML spec).

## SSR-hydrate path

When `loadConfig` returns `ssrHtml` (or `fetchSsrHtml` does), embed paints the SSR markup into the host element AND tells `mountCartridge` to hydrate over it (`mode: 'hydrate'`). The runtime preserves the markup inside the shadow wrapper and the active page renderer's `hydrate()` runs in place of `render()`.

```ts
defineAiroApp({
  loadConfig: async (id, token) => {
    const body = await fetch(`/widgets/${id}/load-with-ssr`, /* ... */).then((r) => r.json());
    return {
      config: body.config,
      cartridgeId: body.cartridgeId,
      preloadedData: body.snapshot,
      ssrHtml: body.html, // ← drives mode: 'hydrate' end-to-end
    };
  },
  resolveCartridge,
});
```

Or fetch SSR opportunistically (errors fall through to CSR):

```ts
defineAiroApp({
  loadConfig: /* ... */,
  resolveCartridge: /* ... */,
  fetchSsrHtml: async (id, token) => {
    const res = await fetch(`/widgets/${id}/ssr`);
    return res.ok ? res.text() : null;
  },
});
```

For hydration to actually skip the repaint, the cartridge's view renderers must implement `hydrate(targetEl, ctx)` — without it, the runtime warns and falls back to `render()`. Cartridges that ship to SSR pages should implement `hydrate()` on every view that's allowed to be the entry page.

## Per-page chunk loading

A multi-page cartridge doesn't have to bundle every page renderer into one module. Ship one chunk per page type, lazy-load only the chunk for the page a given widget actually renders, and you pay ~one renderer's bytes per mount instead of the whole cartridge.

The mechanism: a page chunk **self-registers** its renderer factory to the cartridge mailbox on load (via `pushToMailbox` from `@airo-js/core`). When the active page's factory isn't in the mailbox yet, the runtime emits `'renderer:missing'`; embed routes that to your `resolveView(cartridgeId, pageType)` hook, waits for it to settle, then recovers in place — `hydratePage()` on an SSR miss (keeps the server markup) or `navigate()` on a CSR miss (fresh paint).

```ts
defineAiroApp({
  loadConfig,
  resolveCartridge,
  // Load the chunk that owns `pageType`. Resolve AFTER it has registered
  // its factory to the mailbox. The resolved value is discarded — embed
  // re-resolves through the registry.
  resolveView: (cartridgeId, pageType) =>
    import(`https://cdn.my-studio.example/${cartridgeId}/${pageType}.js`),
});
```

The chunk itself, loaded by that import, self-registers:

```ts
// quickshop.js — a per-page chunk
import { pushToMailbox } from '@airo-js/core';
import { QuickShopRenderer } from './quickshop-renderer.js';

pushToMailbox('__AIRO_PRODUCT_PAGES__', { key: 'quickshop', factory: () => new QuickShopRenderer() });
```

### `resolveView` is transport-agnostic

embed **never assumes ESM module semantics** — it only awaits the returned `Promise<void>` and then re-resolves through the mailbox. A dynamic `import()` is one way to load a chunk; a `<script>`-tag injection with Subresource Integrity is equally valid (and is what hosts that ship IIFE bundles or can't rely on import-map SRI use):

```ts
resolveView: (cartridgeId, pageType) =>
  new Promise((resolve, reject) => {
    const { url, integrity } = chunkManifest[`${cartridgeId}-${pageType}`];
    const s = document.createElement('script');
    s.src = url;
    s.integrity = integrity;       // SRI — no import-map dependency
    s.crossOrigin = 'anonymous';
    s.onload = () => resolve();     // chunk's pushToMailbox already ran
    s.onerror = () => reject(new Error(`chunk failed: ${pageType}`));
    document.head.appendChild(s);
  }),
```

Contract notes:

- **`cartridgeId` is always the resolved `cartridge.id`** (the key the chunk registry uses) — reconstruct your own transport/manifest key from `(cartridgeId, pageType)` as the SRI example does.
- **embed singleflights per `(cartridgeId, pageType)` with delete-on-reject.** Concurrent misses for the same view collapse to one `resolveView` call; a rejected load is evicted so the next miss retries. Your hook does **not** need its own dedup map.
- **The hydrate-vs-navigate recovery dispatch is embed's job, not yours** — getting it wrong (navigating on a hydrate miss) wipes the SSR DOM. Without a `resolveView` hook, a missing renderer soft-fails (no paint) and emits `'renderer:missing'` for observability only — the pre-0.2.0 behaviour.

See [`docs/best-practices.md` §2.5b](../../docs/best-practices.md) for the underlying chunked-client cartridge pattern.

## Error phases

`onError(phase, err, host)` fires once per mount-attempt failure. Phases:

| Phase | When |
|---|---|
| `'load-config'` | Your `loadConfig` rejected. |
| `'resolve-cartridge'` | Your `resolveCartridge` rejected. |
| `'fetch-ssr'` | Your `fetchSsrHtml` rejected. **Mount continues** (CSR fallback). |
| `'resolve-view'` | Your `resolveView` rejected (chunk failed to load). The page stays unpainted until a later miss retries. |
| `'mount'` | Template not found, runtime import failed, or `mountCartridge` rejected. |

Without an `onError` hook, embed logs to `console.error` and leaves the host element empty. For customer-visible errors, supply a hook that paints a studio-branded fallback into `host`.

## What lives where (the M13 line)

| Concern | Owner |
|---|---|
| Custom element class + lifecycle | `@airo-js/embed` |
| Runtime lazy-import + handoff | `@airo-js/embed` |
| SSR HTML paint + `mode: 'hydrate'` wiring | `@airo-js/embed` |
| Chunk-recovery dispatch (singleflight + hydrate-vs-navigate) | `@airo-js/embed` |
| Element name + attribute names | host app (config knob) |
| Auth + LoadResponse fetch | host app (`loadConfig` hook) |
| Cartridge module resolution | host app (`resolveCartridge` hook) |
| SSR HTML fetch endpoint | host app (`fetchSsrHtml` hook) |
| Page-chunk loading (transport) | host app (`resolveView` hook) |
| Error UI / fallbacks | host app (`onError` hook) |
| Telemetry | host app (`onMounted` hook) |
| Per-page chunk loading | `@airo-js/embed` (deferred) |

## Idempotent registration

`defineAiroApp` is idempotent for the same `elementName`: a second call with a name already registered logs a warning and no-ops. Different element names can coexist — one bundle can register both `<shop-app>` (v1) and `<airo-app>` (cartridge) during a transition.

## Peer dependency

`@airo-js/runtime` is a **peer** dep, not a regular one. The embed bundle is intentionally tiny and dynamic-imports the runtime on first mount. Host apps must install the runtime alongside:

```bash
pnpm add @airo-js/embed @airo-js/runtime
```

The peer range is `^0.1.0 || ^0.2.0` — embed works with either runtime line. The catch: `mode: 'hydrate'` is a v0.2 option, so behaviour differs by runtime version when SSR HTML is supplied:

| Runtime | SSR HTML behaviour |
|---|---|
| `^0.1.0` | embed paints `ssrHtml` into the host, then runtime overwrites with a fresh CSR mount. SSR HTML acts as a load skeleton; the renderer's `hydrate()` is **not** called (the option is silently ignored). |
| `^0.2.0` | embed paints `ssrHtml`, then runtime preserves it inside the shadow wrapper and the renderer's `hydrate()` runs. True hydration. |

CSR-only widgets (no `ssrHtml`) behave identically across both runtime lines.

Recommendation: pin the runtime at `^0.2.0` if your cartridges implement `hydrate()` on their views and you ship SSR HTML. Otherwise either range works.

## License

Apache-2.0 — same as the rest of `@airo-js/*`.
