# `@airo-js/core`

The runtime engine for the airo framework. Pure rendering primitives — no domain knowledge, no opinions about data shape.

> Status: **v0.x**. Surface still subject to refinement; consumers should target `^0.1` until `1.0` ships.

## What's in here

- **App lifecycle** — `createApp`, `App`, `AppDeps`, lifecycle FSM
- **Page rendering** — `PageManager`, `PageRenderer`, `PageRendererFactory`, `RenderContext`
- **Schema** — `Page`, `PageLayout`, `Region`, `Slot`, `AppConfig`, `ComponentSettings`
- **Navigation** — `HashRouter`, `NavigationState`, `buildCrumbs` (data-only trail helper; cartridges render their own breadcrumb DOM)
- **Events** — `EventBus`, `IEventBus` (snapshot-semantics observer)
- **Style isolation** — `IsolationRoot`, `setupIsolationRoot`, `wrapInShadow` (Shadow DOM strategies: `light` / `shadow`; framework ships zero CSS — cartridges own every rule inside the shadow root)
- **Theming** — `Theme` (CSS custom-property injection + `customCSS` escape hatch)
- **Pipeline orchestration** — `Transformer`, `PostProcessor`, `RuntimePipeline`, `createPipeline`
- **Plugin discovery** — `Registry`, `createRegistry`, `pushToMailbox` (stub-queue self-registration for late-loading chunks)

## Scope

Rendering, lifecycle, style isolation, page routing, theme injection, pipeline orchestration. **That's it.** No data fetching, no auth, no tenancy, no drafts, no persistence. Those belong in the host application.

## Use with `@airo-js/cartridge-kit`

`@airo-js/core` is the runtime; `@airo-js/cartridge-kit` is the plugin contract built on top of it. Most consumers use them together — see [`@airo-js/cartridge-kit`](../cartridge-kit/README.md) for the cartridge boot sequence.

## Install

```bash
pnpm add @airo-js/core
```

## License

Apache 2.0.
