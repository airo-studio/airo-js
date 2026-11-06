---
title: "Lynx layout: block is a row, max-width hides width, aspect-ratio heights don't count"
author: Benjamin
date: 2026-11-06
branch: lynx-adapter
cost: { minutes: 40, tokens: 421144 }
touches:
  - CHANGELOG.md
  - TODOS.md
  - examples/lynx-native/README.md
  - examples/lynx-native/scripts/check-build.mjs
  - examples/lynx-native/src/cartridge.ts
  - examples/lynx-native/src/server.ts
  - examples/lynx-native/src/style.css
  - packages/lynx/README.md
  - packages/lynx/src/build/normalise.ts
  - packages/lynx/src/runtime/facade.ts
---

## Decided
- `display: block` (and `flow-root`, `list-item`) is rewritten to `display: linear` by the normaliser. On iOS Lynx (engine 3.9) `block` lays out as a flex row; `linear` and no `display` stack. Flex-column was rejected: a later `display: flex` rule on the same element would inherit the column direction.
- `place-items/-content/-self` are expanded to their align/justify longhands: the encoder removes the shorthands, and Lynx's grid honours `align-items` + `justify-items` (measured with a 32px centred box).
- Every `<img>` (raster and SVG) gets its laid-out height inline after the first layout. A parent with no height of its own does not count a height that comes from `aspect-ratio`, in a grid AND in a plain linear card. Pinning the image also fixes an `aspect-ratio` wrapper whose child image fills it (card 64 → 233 tall, measured).

## Tried and ruled out
- Trusting `__GetComputedStyleByKey('width')` on an image with `max-width: 100%`: it reads 0 while `height` follows the real width (0 × 128.3 for a 171 × 128.3 photo). So "height but no width" cannot tell a misread width from a logo sized by its height; both are rebuilt with `auto-size` and keep their measured height inline.
- `auto-size` alone on a styled image: the grid row takes the picture's natural height (768).
- `text-align` + `vertical-align` to centre a text-only `span` that CSS makes a grid: horizontal only. A Lynx `text` ignores display; only `line-height` = height or making it a view (`div`, or a child element) centres it.
- `aspect-ratio` on an SVG `<img>` without pinning: not counted either.

## Watch out
- The encoder stores property names as ids, so a "string X is not in the bundle" check is vacuous for property names (`place-items`, `align-items`). Check `removedProperties` in the report instead. Values (e.g. `linear`) do appear as strings.
- A box with `aspect-ratio` and no image inside is still not counted by its parent. Fixing it needs the build to tell the runtime which selectors declare `aspect-ratio`, because computed style returns '' for `aspect-ratio` and `display`.
- Probe layout on device with a temporary example page and `data-probe` attributes: mirrored as `a-data-probe--<name>` classes, they show up in the device report's rows with rects.
