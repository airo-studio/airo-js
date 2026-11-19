---
title: "PageManager navigation: in-place apply, the router path replaces, render-time navigate is deferred"
author: Benjamin
date: 2026-11-19
branch: navigation-in-place
touches:
  - packages/core/src/page-manager.ts
  - packages/core/src/page.ts
  - packages/core/src/router.ts
  - packages/cartridge-kit/src/define-ssr-safe-renderer.ts
  - packages/cartridge-kit/src/define-hydrate-only-renderer.ts
---

## Decided
- A same-page context change asks the renderer first: optional `PageRenderer.applyNavState(next, previous)`; only `=== true` skips the destroy and render. Chosen over a `navigate(state, { render: false })` flag because Back/Forward must reach the same path, and a call-site flag cannot.
- `navigate(state, { history: 'push' | 'replace' })`. Router-driven navigations write nothing (`RouterWrite = 'none'`), which replaced the old `suppressRouterPush` flag.
- The router path REPLACES state with the parsed entry, exactly: no merge over the current navState, and no `initialNavState` base. It is exact because every history entry is complete: each write is the whole state, and `initRouter` rewrites the mount entry (with `replace`) whenever the URL doesn't name exactly the mounted state. Programmatic navigate still merges.
- Every navigation runs through `runNavigation` (`navigationDepth`). A `navigate` requested during one, from a renderer, `activateSubpage`, a `postRender` hook or a `navigation:changed` listener, is queued as a copy and drained in order afterwards, capped at 16 (`MAX_DEFERRED_NAVIGATIONS`). Any throw drops the queue. A request from inside render, hydrate or applyNavState (`rendererCallDepth`) is a redirect and defaults to `history: 'replace'`. The earlier version pushed it, which made a Back trap; Codex reproduced that in the ship review.
- Routers' `replace` keeps `window.history.state`. It can belong to the host's router.
- QueryRouter erasing un-decoded prefixed params on its first write is intended. It is kept, and the comment is fixed.

- Both cartridge-kit renderer factories (`defineSSRSafeRenderer`, `defineHydrateOnlyRenderer`) take `applyNavState(root, next, previous, ctx)` as an option, because only the factory holds root and ctx. A new optional `PageRenderer` hook needs the same treatment in both factories, or a factory-built view cannot use it. On a hydrate-only view a declined same-page navigation reaches `render`, which throws.

## Tried and ruled out
- Rebuilding history entries on `{ ...initialNavState, ...parsed }`. The runtime remount after `update()` (mount-cartridge.ts) passes the live navState as `initialNavState`, so that base replayed the remount snapshot's keys on every later Back. The user chose the complete-entry approach in the review (2026-11-19).
- QueryRouter tracking "owned" keys so that un-decoded prefixed params survive. Written back beside `<prefix>nav`, they would be decoded by a reload or a shared link but never by the viewer who wrote them.

## Watch out
- A hash-mode `push` assigns `location.hash`, and its `hashchange` echoes back through the router. `sameRouteState` drops the echo, treating `''` as absent because routers drop empty values. Remove that check and hash mode fires `navigation:changed` twice again.
- happy-dom does not bump `history.length` on a hash assignment. Assert a hash `replace` through a `history.replaceState` spy.
- Tests that assert warn-level logs need `setLogLevel('warn')`; the default threshold is `'error'`.
