---
title: "Publication adapters are told the resolved page: ctx.page and ctx.navState"
author: Benjamin
date: 2026-11-18
branch: publication-page-context
touches:
  - packages/ssr/src/render-app.ts
---

## Decided
- `PublicationContext` gains flat, optional, read-only `page` and `navState`, set by `renderAppWithPublication` only. Flat because the render, transformer and gate contexts all spell it `ctx.navState`; `page` is the full `Page` because `componentSettings` decide what the widget shows. On the context, not a third `generate()` argument: every wrapper forwards the context (`defineCrawlerSurfaceAdapter` passes it to eleven selectors) and would drop a new argument.
- The entry is resolved once per render (`resolveEntry` + `renderResolvedEntry` in `packages/ssr/src/render-app.ts`, internal, not in the barrel) and that one value goes to the adapters and the renderer. The adapters' navState is frozen; the renderer gets a plain copy because it always had one.
- `page` is passed by reference like the snapshot. No clone on the hot path.
- An adapter returns `null` to publish nothing; `validate()` is still called with it. Neither `renderAppWithPublication` nor `headFromPublication({ includeJsonLd })` emits a null or undefined output.
- Ships as a patch on each package (cartridge-kit for the type, ssr for the runner), bumped together; `CONTRACT_VERSION` unchanged because nothing a consumer wrote must change.

## Tried and ruled out
- A nav-dependent Transformer narrowing the snapshot to the deep-linked product: the runtime runs the chain once at mount (`mount-cartridge.ts`), so the snapshot stays narrowed after client navigation, and a list of one still cannot say it is a product page.
- The host passing the page through `tenantOverrides`: untyped, and every multi-page consumer would rebuild it.
- A grouped `view: { page, navState }` key (the consumer's sketch): cannot be half-set, but is a fourth spelling of a value three contexts already name, and "view" means `ViewDefinition` here.
- Promising "adapter mutation cannot reach the renderer" for `page`: would need a deep clone per request.

## Watch out
- After a fallback, `page` is the default entry while `navState` keeps the rejected request's other keys. Adapters must branch on `page.type` before reading a key.
- "Never private" and "page-less" are true only inside `renderAppWithPublication`. A direct `runPublicationAdapters` caller can put anything in the context, so docs promise only what the runner enforces, and `page` must never be used to withhold.
- `headFromPublication` skips null only for non-JSON-LD formats at its shape check; the JSON-LD fold is a separate line. A review claimed it was covered and a second opinion caught it.
- `Object.isFrozen(undefined)` is true: a "frozen" assertion passes on code that never set the value unless it asserts definedness first.
- Test fixtures for `renderAppWithPublication` need a unique `mailboxName`, or the default renderer resolver throws.
- The consumer takes the framework from npm, not yalc. Test builds go as `pnpm pack` tarballs with sha256 into `~/workspace/biz/airo-js-beta`, which leaves the shared yalc store (used by other consumers' in-flight builds) alone.
