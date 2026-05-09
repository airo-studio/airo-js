# `@airo-js/embed`

Customer-facing browser bootstrap loader. The script host pages paste into their HTML to mount an Airo app.

> Status: **v0.1.0**. Custom-element registration + lazy runtime load + SSR-hydrate path. Per-page chunk loading deferred to a future minor.

## What this does

1. Registers a custom element (default: `<airo-app airo-id="…">`; configurable).
2. When an element appears in the DOM:
   - Calls your `loadConfig(id, token)` to fetch the widget config from your studio backend.
   - Calls your `resolveCartridge(id)` to dynamic-import the cartridge module.
   - Optionally calls `fetchSsrHtml(id, token)` to fetch pre-rendered HTML.
   - Lazy-imports `@airo-js/runtime` (peer dependency).
   - Calls `mountCartridge(...)` with `mode: 'hydrate'` if SSR HTML was provided, else `'csr'`.
3. On disconnect, tears down the mount.

Generic plumbing (custom-element registration, lifecycle, runtime lazy-load, mount handoff) lives here. Studio-specific concerns (auth, LoadResponse shape, cartridge module location, error UI, telemetry) live behind hooks. Same M13 line as `@airo-js/runtime`.

## Bundle size

```
minified: 2.51 KB  /  budget: 5.00 KB
gzip:     1.14 KB  /  budget: 2.50 KB
```

`pnpm size:check` enforces the budget. The runtime is **not** counted — it's loaded lazily via `import('@airo-js/runtime')` when an element mounts, so customer pages with N widgets pay the runtime cost once, and pages with no widget elements never pay it.

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
    if (id === 'wtb') {
      return (await import('@my-org/wtb-cartridge')).wtbCartridge;
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
  elementName: 'dotter-app',
  idAttribute: 'dtr-id',
  tokenAttribute: 'dtr-token',
  // ...rest
});
```

Customer pastes: `<dotter-app dtr-id="dw_abc" dtr-token="…">`. Custom element names must contain a hyphen (HTML spec).

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

## Error phases

`onError(phase, err, host)` fires once per mount-attempt failure. Phases:

| Phase | When |
|---|---|
| `'load-config'` | Your `loadConfig` rejected. |
| `'resolve-cartridge'` | Your `resolveCartridge` rejected. |
| `'fetch-ssr'` | Your `fetchSsrHtml` rejected. **Mount continues** (CSR fallback). |
| `'mount'` | Template not found, runtime import failed, or `mountCartridge` rejected. |

Without an `onError` hook, embed logs to `console.error` and leaves the host element empty. For customer-visible errors, supply a hook that paints a studio-branded fallback into `host`.

## What lives where (the M13 line)

| Concern | Owner |
|---|---|
| Custom element class + lifecycle | `@airo-js/embed` |
| Runtime lazy-import + handoff | `@airo-js/embed` |
| SSR HTML paint + `mode: 'hydrate'` wiring | `@airo-js/embed` |
| Element name + attribute names | host app (config knob) |
| Auth + LoadResponse fetch | host app (`loadConfig` hook) |
| Cartridge module resolution | host app (`resolveCartridge` hook) |
| SSR HTML fetch endpoint | host app (`fetchSsrHtml` hook) |
| Error UI / fallbacks | host app (`onError` hook) |
| Telemetry | host app (`onMounted` hook) |
| Per-page chunk loading | `@airo-js/embed` (deferred) |

## Idempotent registration

`defineAiroApp` is idempotent for the same `elementName`: a second call with a name already registered logs a warning and no-ops. Different element names can coexist — one bundle can register both `<dotter-app>` (v1) and `<airo-app>` (cartridge) during a transition.

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
