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
  - packages/core/src/mount-entry.ts
  - packages/runtime/src/mount-cartridge.ts
---

## Decided
- A same-page context change asks the renderer first: optional `PageRenderer.applyNavState(next, previous)`; only `=== true` skips the destroy and render. Chosen over a `navigate(state, { render: false })` flag because Back/Forward must reach the same path, and a call-site flag cannot.
- `navigate(state, { history: 'push' | 'replace' })`. Router-driven navigations write nothing (`RouterWrite = 'none'`), which replaced the old `suppressRouterPush` flag.
- The router path REPLACES state with the parsed entry, exactly: no merge over the current navState, and no `initialNavState` base. It is exact because every history entry is complete: each write is the whole state, and `initRouter` rewrites the mount entry (with `replace`) whenever the URL doesn't name exactly the mounted state. Programmatic navigate still merges.
- Every navigation runs through `runNavigation` (`navigationDepth`). A `navigate` requested during one, from a renderer, `activateSubpage`, a `postRender` hook or a `navigation:changed` listener, is queued as a copy and drained in order afterwards, capped at 16 (`MAX_DEFERRED_NAVIGATIONS`). Any throw drops the queue. A request from inside render, hydrate or applyNavState (`rendererCallDepth`) is a redirect and defaults to `history: 'replace'`. The earlier version pushed it, which made a Back trap; Codex reproduced that in the ship review.
- Routers' `replace` keeps `window.history.state`. It can belong to the host's router.
- QueryRouter erasing un-decoded prefixed params on its first write is intended. It is kept, and the comment is fixed.

- `navDefaults` (2026-11-20, from the consumer's test build) IS a base for router entries, and that does not contradict the line above. It is a separate, fixed option: a remount passes the same `navDefaults` again and passes its snapshot as `initialNavState`, so nothing replays. Keys listed there are left out of every URL write while they hold their default (`urlState`), and filled back in when an entry, the mount or `navigate` leaves them empty (`withNavDefaults` in mount-entry.ts, applied in `applyNavigation` and the router echo check). For values the host derives (a region from geo), which in `initialNavState` leaked into shared links. A mount-only opt-out would not have fixed it: every write encodes the whole state, so the first navigation wrote the key anyway.
- The size cost (+726 B gzip in core) is logic in `PageManager`, not log strings: shortening messages and folding the drain loop saved about 14 B. `#private` fields save about 155 B at es2022 but cost about 490 B when a consumer's build lowers to es2020, so they were rejected.
- Both cartridge-kit renderer factories (`defineSSRSafeRenderer`, `defineHydrateOnlyRenderer`) take `applyNavState(root, next, previous, ctx)` as an option, because only the factory holds root and ctx. A new optional `PageRenderer` hook needs the same treatment in both factories, or a factory-built view cannot use it. On a hydrate-only view a declined same-page navigation reaches `render`, which throws.

## Tried and ruled out
- Rebuilding history entries on `{ ...initialNavState, ...parsed }`. The runtime remount after `update()` (mount-cartridge.ts) passes the live navState as `initialNavState`, so that base replayed the remount snapshot's keys on every later Back. The user chose the complete-entry approach in the review (2026-11-19).
- QueryRouter tracking "owned" keys so that un-decoded prefixed params survive. Written back beside `<prefix>nav`, they would be decoded by a reload or a shared link but never by the viewer who wrote them.

## Watch out
- A hash-mode `push` assigns `location.hash`, and its `hashchange` echoes back through the router. `sameRouteState` drops the echo, treating `''` as absent because routers drop empty values. Remove that check and hash mode fires `navigation:changed` twice again.
- happy-dom does not bump `history.length` on a hash assignment. Assert a hash `replace` through a `history.replaceState` spy.
- `@airo-js/log`'s default threshold is `'warn'` (packages/log/src/index.ts `DEFAULT_LEVEL`, since 749e72b), so a test sink sees warn and error with no `setLogLevel`; asserting an info or debug line needs `setLogLevel('debug')`. (Corrected 2026-11-20: this line said the default was `'error'`.)
