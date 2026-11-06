---
title: Lynx layout quirks the adapter works round (measured on the iOS simulator)
author: Benjamin
date: 2026-11-06
branch: lynx-adapter
cost: { minutes: 209, tokens: 4605144 }
touches:
  - TODOS.md
  - device-run/mounted.json
  - device-run/navigated-1.json
  - device-run/navigated-2.json
  - device-run/navigated-3.json
  - device-run/navigated-4.json
  - device-run/navigated-5.json
  - device-run/navigated-6.json
  - device-run/navigated-7.json
  - device-run/screen-after.png
---

## Decided
- Images: no `auto-size` at creation. After the first layout, an image the stylesheet sizes gets its laid-out height inline (follows width changes); one with a side at 0 is rebuilt with `auto-size` (`syncImages` in packages/lynx/src/runtime/tree.ts).
- After any class change, the runtime re-sets the classes of every following sibling (`restyle`), because Lynx does not restyle a `+`/`~` sibling by itself.
- Colour lowering and the page font-size live in the normaliser; lightningcss-loader stays off (it re-merges `inset` and only lowered `oklch` tokens by browserslist accident).

## Tried and ruled out
- Setting `auto-size` after the image exists, even with `src` set again: Lynx ignores it; it is read only at creation.
- CSS-only fixes for a grid row around `aspect-ratio` content: explicit 1-col/2-col templates, `align-items: start`, wrappers, `height: auto`, ratio on the figure. Every variant sizes the row 0; only an explicit height works.
- Detecting grid parents or `aspect-ratio` boxes at runtime: `__GetComputedStyleByKey` returns '' for `display` and `aspect-ratio` (width/height/colours do work, and are layout-ready right after `__FlushElementTree`).

## Watch out
- A non-image `aspect-ratio` box in a grid row is still sized 0 (TODO: report upstream, needs approval).
- Pseudo-elements never render, so a switch knob drawn with `::after` is missing on device.
- Taps cannot be scripted, and the iOS 27 Xcode on this machine ships no Simulator.app: device checks are static unless someone can tap.
