---
title: Lynx ignores max-width none; percentage max-width collapses SVGs in grid items
author: Benjamin
date: 2026-11-09
branch: lynx-adapter
cost: { minutes: 12, tokens: 334993 }
touches:
  - CHANGELOG.md
  - TODOS.md
  - examples/lynx-native/scripts/check-build.mjs
  - examples/lynx-native/src/style.css
  - packages/lynx/README.md
  - packages/lynx/src/build/normalise.ts
  - packages/lynx/src/runtime/facade.ts
  - packages/lynx/src/runtime/tree.ts
  - packages/lynx/test/controls.test.ts
  - packages/lynx/test/facade.test.ts
---

## Decided
- `max-width: none` / `max-height: none` → `auto` in the normaliser. Lynx ignores `none` (a box capped at 30px stayed 30px with a `.free { max-height: none }` override); `auto` lifts the cap (72px).
- An SVG `<img>` laid out 0 wide with a height, whose parent has a width, gets inline `max-width: auto` and is measured again before pinning. Cause: Lynx resolves a percentage `max-width` (the common `img, svg { max-width: 100% }`) to 0 for an SVG inside an auto-width grid item (grid > a > aspect-ratio box > svg). The rect is 0 too, so it is a real layout, not a misread. Identical cards came out either way for the consumer.
- A pinned image whose width changes is unpinned and measured again, not given a height derived from the first ratio: the first read can be a partly clamped width.

## Tried and ruled out
- Inline `max-width: none` as the lift: ignored, as in CSS.
- Dropping `display: block` or the `max-width` alone in probes outside the card structure: the collapse needs the deeper chain (auto-width grid item), so a one-level `aspect-ratio` box probe looked fine and misled.

## Watch out
- An SVG `<img>` carrying `aspect-ratio` itself under a percentage `max-width` still lays out narrower than its box (151 in 169). A wrapper with `aspect-ratio` around a filling SVG is fine.
- `String.prototype.normalize` is missing from the main thread (Unicode data, like `Intl`). It is now guarded as a refusing method on `String.prototype` while a mount runs.
