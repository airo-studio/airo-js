# lynx-native

A two-page notes site from one airo-js cartridge, shown as native UI through [`@airo-js/lynx`](../../packages/lynx). The card renders its pages from an in-bundle stand-in for a server (`src/server.ts`), so it runs with no backend; a real host fetches the same `{ html, snapshot, nav }` from its server on the background thread.

What it exercises:

- **Build**: a stylesheet written for a browser — `body` font shorthand, type selectors, `[hidden]` and `[aria-expanded]` state, `inline-flex` buttons, a `calc()` radius token, `color-mix()` hovers, an `oklch()` literal, an `aspect-ratio` box with no width, dark mode in `@media` — through `pluginAiroLynx()`.
- **Runtime**: hydrate-only views (what a server-rendered site ships to the browser) running on device through the DOM facade: a delegated click counter, a `hidden` toggle with `aria-expanded`, a live echo of a search field, a search form (`get`), a subscribe form (`post`, hidden field), links between pages.

```sh
pnpm --filter @airo-js-examples/lynx-native build   # dist/main.lynx.bundle + dist/airo-lynx-report.{json,md}
pnpm --filter @airo-js-examples/lynx-native check   # the bundle carries what the plugin is for (CI runs this)
```

On a device: build with a collector and run the package's device check, then tap through the card in the Simulator.

```sh
AIRO_LYNX_COLLECTOR=http://localhost:3299/__collect pnpm --filter @airo-js-examples/lynx-native build
node packages/lynx/scripts/device-check.mjs --dist examples/lynx-native/dist --out .tmp/device-run --watch 60
```

Expected on tap: the counter counts, "More about these notes" shows and hides its panel, typing in the search field echoes below it, Search shows the results page, Subscribe shows the confirmation, and every link changes page. Every touch sends a report; the script prints what changed and the reports' `errors` stay empty.
