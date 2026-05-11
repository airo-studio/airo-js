# `@airo-js/runtime`

Cartridge mount orchestration for the airo framework. Single-call shell setup → optional data fetch → pipeline → mount via `createCartridgeApp`. Studio-side concerns (theme, error UI, debug observers) extend via hooks rather than forking the orchestration.

> Status: **v0.2.0**. CSR + SSR-hydrate single-mount surface. Per-page chunk loading and live `update()` still deferred (additive — current callers won't break).

## What's in here

- `mountCartridge(opts)` — the only entry point. Runs the full mount sequence.
- `MountCartridgeOptions<TData, TConfig>` — required: `cartridge`, `config`, `template`, `host`. Everything else optional.
- `MountCartridgeResult` — discriminated union: either `{ blocked: false, app, shell, destroy }` or `{ blocked: true, blockedBy, shell, destroy }`.
- `ShellHandle` — what `onShellReady` receives: `renderRoot`, `styleRoot`, `events`, `rootId`.
- `MountPhase` — phase identifier for `onError`: `'shell' | 'gate' | 'fetch' | 'pipeline' | 'mount'`.

## Why this exists

Without this package, every host app that runs a cartridge would inline the same ~75 LOC of orchestration:

1. Set up the isolation root + style root.
2. Pick a data source, run `dataSource.fetch()` (or skip if `preloadedData` was passed).
3. Run the cartridge's transformer chain via `createPipeline`.
4. Build `AppConfig` from the template's pages.
5. Delegate to `createCartridgeApp` (which handles gates, app context, and `createApp`).

That's generic plumbing. The studio-specific bits (theme injection, error UI, multi-runtime toggles, config translation) are the only things that vary between host apps. `mountCartridge` ships the plumbing; host apps extend via `onShellReady` and `onError`.

## Minimal usage

```ts
import { mountCartridge } from '@airo-js/runtime';
import { commerceCartridge } from '@your-org/cartridge-commerce';

const host = document.querySelector<HTMLElement>('#widget')!;
const template = commerceCartridge.templates.find((t) => t.id === 'quickshop')!;

const result = await mountCartridge({
  cartridge: commerceCartridge,
  config: { feed: { url: 'https://example.com/products.json' } },
  template,
  host,
});

if (result.blocked) {
  console.log(`Mount blocked by gate: ${result.blockedBy}`);
} else {
  console.log('Mounted:', result.app.state);
}
```

That's it for the inline-script case. No theme, no isolation tweaks, no error UI — just mount.

## Studio host with theme + error UI

```ts
const result = await mountCartridge({
  cartridge: commerceCartridge,
  config,
  template,
  host,
  styleIsolation: 'shadow',
  widgetId: 'preview-1',
  enableRouter: false,

  preloadedData: studio.cachedFeed, // skip dataSource.fetch when the studio has it

  onShellReady: (shell) => {
    // Inject the studio's global widget styles into the shadow root.
    injectGlobalStyles(shell.styleRoot);

    // Wire the studio's theme engine to the same event bus the renderers use.
    new ThemeEngine(themeConfig, shell.events, shell.rootId, {
      styleRoot: shell.styleRoot,
      containerEl: shell.renderRoot,
    }).init();
  },

  onError: (phase, err) => {
    // Studio-specific error UI — runtime stays presentation-agnostic.
    studio.showError(phase, err);
  },
});

// Later, on host unmount or re-init:
result.destroy();
```

## What lives where (the M13 line)

| Concern | Owner |
|---|---|
| Isolation root + style root setup | `@airo-js/runtime` (wraps `@airo-js/core`'s `setupIsolationRoot`) |
| Gate sequencing | `@airo-js/runtime` (delegates to `runGates` via `createCartridgeApp`) |
| Data fetch (or `preloadedData` shortcut) | `@airo-js/runtime` |
| Transformer pipeline | `@airo-js/runtime` (delegates to `createPipeline`) |
| `createCartridgeApp` invocation | `@airo-js/runtime` |
| Theme injection | **Host app** (via `onShellReady`) |
| Global / skeleton CSS | **Host app** (via `onShellReady`) |
| Config-shape translation (studio config → cartridge config) | **Host app** (upstream of `mountCartridge`) |
| Error UI | **Host app** (via `onError`) |
| SSR-hydrate fork (`mode: 'hydrate'`) | `@airo-js/runtime` (v0.2 — landed) |
| Per-page chunk loading | `@airo-js/runtime` (deferred) |
| Live `update(opts)` for studio chrome | `@airo-js/runtime` (deferred) |

## Hook contract

### `onShellReady(shell)`

Fires once, after the isolation root + style root are set up, **before** gates run. Sync. Use for:

- Injecting global widget CSS into `shell.styleRoot`.
- Attaching theme engines to `shell.events` + `shell.renderRoot`.
- Registering debug observers / mutation observers.

Do NOT use for content rendering — the runtime mounts page renderers later via `createCartridgeApp`.

### `onError(phase, err, shell)`

Fires when a phase throws. The error is then re-thrown — the runtime never silently swallows. `shell` is `null` only when phase 'shell' itself failed. Use for:

- Rendering studio-specific error UI in `host`.
- Logging / telemetry.
- Triaging by phase: `'fetch'` errors get a retry button, `'pipeline'` errors are likely cartridge bugs.

## Migration from inline orchestration

If your host app today does any of:

```ts
const { renderRoot } = setupIsolationRoot(host, 'shadow');
const events = new EventBus();
const gateResult = await runGates({ ... });
if (gateResult === 'block') return;
const data = await cartridge.dataSources[0].fetch(...);
const pipeline = createPipeline(cartridge.transformers, ...);
const snapshot = pipeline.runTransformers(data, ...);
const app = createApp(appConfig, { ..., resolveRenderer: cast }); // ← cast smell
```

Replace it with one call to `mountCartridge(opts)`. The cast disappears (the runtime calls `createCartridgeApp`, which handles the registry's heterogeneous typing internally).

## SSR-hydrate path (v0.2)

```ts
// Customer page already has SSR markup in `host`.
const result = await mountCartridge({
  cartridge,
  config,
  template,
  host,
  preloadedData: ssrSnapshot,    // same data the SSR render saw
  mode: 'hydrate',
});
```

What `mode: 'hydrate'` does:

- Preserves the existing markup in `host` (moves it inside the shadow wrapper when isolation is `'shadow'`).
- Drives the active page renderer's `hydrate()` instead of `render()` — listeners attach without repainting.
- Renderers without `hydrate()` fall back to `render()` (with a `[@airo-js/core]` warning); the SSR markup is repainted client-side. Cartridges that ship to SSR pages should implement `hydrate()` on every view that's allowed to be the entry page.

`mode: 'csr'` (the default) ignores any pre-existing markup and paints fresh — the v0.1 behaviour.

## Deferred (signature-compatible — additive)

- `chunkBase?: string` — CDN URL prefix for lazy-loaded per-page chunks.
- `MountCartridgeResult.update(opts)` — apply config / theme deltas without re-mount.
- async `onShellReady` — when a real use case (server-fetched theme tokens) shows up.

## License

Apache-2.0 — same as the rest of `@airo-js/*`.
