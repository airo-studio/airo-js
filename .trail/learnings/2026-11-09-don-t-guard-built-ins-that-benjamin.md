---
title: "Don't guard built-ins that code feature-detects"
author: Benjamin
date: 2026-11-09
branch: lynx-adapter
cost: { minutes: 3, tokens: 22843 }
touches:
  - CHANGELOG.md
  - TODOS.md
  - packages/lynx/README.md
  - packages/lynx/src/runtime/errors.ts
  - packages/lynx/src/runtime/facade.ts
  - packages/lynx/test/facade.test.ts
  - device-run/mounted.json
  - device-run/navigated-1.json
  - device-run/navigated-2.json
  - device-run/navigated-3.json
---

## Decided
- A built-in method the main thread lacks (`String.prototype.normalize`) stays absent; a reported `TypeError` like "not a function" gets the missing built-ins appended to its message instead (`packages/lynx/src/runtime/errors.ts`).

## Tried and ruled out
- Installing a refusing method on `String.prototype`: it makes `typeof x.normalize === 'function'` true, so a consumer's working fallback (their search folding checks exactly that) would refuse at hydrate instead. Refusing guards suit globals page code calls outright, not built-ins code feature-detects.

## Watch out
- The global guards (`Intl`, `URL`, observers) are function proxies, so `typeof Intl` reads `function` while a mount runs. Code that feature-detects one of those globals with `typeof` takes the wrong branch on device.
