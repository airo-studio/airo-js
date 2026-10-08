# `@airo-js/lynx`

Show an airo-js cartridge's server-rendered pages as native UI on [Lynx](https://lynxjs.org), and run the cartridge's existing hydrate handlers there unchanged.

> Status: **0.1.0**, own version line (like `@airo-js/log`), outside the framework's 1.0 freeze. Proven end to end on the iOS simulator with the `lynx-native` example, including taps by hand: a delegated click handler counting, a `hidden` panel toggling with its `aria-expanded` style. A consumer's first page is the next milestone.

## How it works

The device does what a browser does with a server-rendered airo-js page. The server renders the page and the snapshot it rendered from; the device turns the HTML into Lynx elements and runs the cartridge's hydrate handlers over them. Templates and the data pipeline stay on the server.

```
BUILD (Node)                                    DEVICE (Lynx main thread)
cartridge CSS ─► @airo-js/lynx/build ─► bundle   host: { html, snapshot, nav } ─► mountLynx
                 normalise · inheritance ·                 tokenize (strict) → Lynx elements + node model
                 report                                    createCartridgeApp(hydrate) → hydrate handlers
                                                           run through the DOM facade
                                                 tap <a> / submit <form> ─► onNavigate ─► host fetches
                                                 ◄─ next { html, snapshot, nav } (newest request wins)
```

Three entries, because they run in different places:

| entry | runs in | what |
|---|---|---|
| `@airo-js/lynx/build` | Node, inside the native build | `pluginAiroLynx()` — rsbuild plugin: CSS normaliser, CSS-inheritance switch, per-cartridge report |
| `@airo-js/lynx/runtime` | Lynx main thread | `mountLynx()` — tree pass, DOM facade, links and forms |
| `@airo-js/lynx/device` | a card built for a device check | `sendDeviceReport`, `reportOnTouch`, `relayDeviceReports` — never in a production bundle |

## Build

```ts
// rsbuild.config.ts
import { pluginAiroLynx } from '@airo-js/lynx/build';
import { pluginLynx } from '@lynx-js/rsbuild-plugin';
import { pluginVanillaLynx } from '@lynx-js/vanilla-rsbuild-plugin';

export default defineConfig({
  source: { entry: { main: './src/main-thread.ts' } }, // style.css and background.ts beside it
  plugins: [pluginLynx(), pluginVanillaLynx({ engineVersion: '3.9' }), pluginAiroLynx()],
  environments: { lynx: {} },
});
```

`pluginAiroLynx()` must come after `pluginVanillaLynx()`. Engine 3.9 is the newest the encoder in `@lynx-js/rsbuild-plugin` 0.1.3 accepts.

### What the normaliser rewrites

Every rewrite answers a gap measured on device:

| your CSS | on device | why |
|---|---|---|
| `html`, `body` | `.airo-lynx-page` (the page element) | there is no `<body>` |
| `h1`, `img`, … | `.tag-h1`, `.tag-img`, … (the tree pass adds these classes) | Lynx type selectors match Lynx tags (`view`, `text`) |
| `[n]`, `[n="v"]` | `.a-n`, `.a-n--v` (the runtime mirrors attributes into these classes) | attribute selectors parse but never match |
| a selector list holding one the encoder rejects | the rest of the list, kept | the encoder drops the whole rule otherwise |
| `display: inline-flex` | `display: flex` | falls back to linear layout |
| `display: none` | plus `overflow: hidden` | the box is 0×0 but its text still paints |
| `font: …` | the longhands | the encoder removes the shorthand |
| static `calc()` in `:root` tokens and `border-radius` | its value | `calc()` in a radius reads as 0 |
| `aspect-ratio` with no width | plus `width: 100%` | Lynx applies it only to an explicit width |
| literal `oklch()` | sRGB | not parsed in a declaration |
| `color-mix()` | sRGB, light in place, dark in a twin rule | not parsed at all |
| `@media (prefers-color-scheme: dark)` | `.airo-lynx-dark …` | `@media` is dropped at 3.9; the host passes `colorScheme` |

Everything else that does not reach the device — properties the encoder removed, selectors it rejects or that never match, dropped `@media`, values left as written — is listed in `airo-lynx-report.json` and `.md` next to the bundle, and summarised in one line at the end of the build.

A colour that reads a custom property the build cannot see (one declared on an element, not on `:root`) fails the build with its file, line and column.

### The headless rule

airo-js ships no visual policy, and the normaliser emits CSS your stylesheet did not contain. That is allowed only as browser semantics: every declaration it **adds** is the value a browser would use in the same case, and the report lists each with its source:

| added | browser behaviour it reproduces |
|---|---|
| `.airo-lynx-page { font-size: 16px }` | the root's `font-size: medium` (16px), so `rem` means the same |
| `.a-hidden { display: none; overflow: hidden }` | the HTML UA rule `[hidden] { display: none }` |
| `.airo-lynx-viewport { width: 100%; height: 100% }` | the viewport being the size of the screen, so the page scrolls inside it |
| `width: 100%` next to `aspect-ratio` | the used width of `width: auto` for a block in normal flow |
| `font-style`, `font-weight`, `line-height: normal` from a `font` shorthand | the shorthand resetting the longhands it omits |
| `overflow: hidden` next to `display: none` | `display: none` rendering no descendants |

A test holds every emitted declaration to that table.

### Restrictions

- **Tokens are read at build time.** `color-mix()` results and resolved radius tokens are baked from your `:root` tokens and the dark tokens inside `@media (prefers-color-scheme: dark)`. `Theme` from `@airo-js/core` and runtime token overrides do not reach a native page.
- **`@media` other than the colour scheme is dropped** at engine 3.9. Write mobile-first: the unconditioned base is what a phone shows.
- **Pseudo-elements** do not render; `:hover` and `:focus` do not apply on a touch screen; `:first-child` and `nth-*` never match.
- **Only the page scrolls.** An element your CSS makes scrollable (`overflow: auto` or `scroll`, such as a horizontal row of chips) is clipped on device, not scrolled.

## Runtime

```ts
// main-thread.ts
import { mountLynx } from '@airo-js/lynx/runtime';

lynx.getEngine().addEventListener('__RenderPage', () => {
  const mount = mountLynx({
    cartridge,                 // its views: the hydrate-only halves your browser bundle ships
    config,                    // the cartridge config, as mountCartridge takes it
    template,                  // the page graph `nav.page` names
    baseUrl: 'https://example.com/', // relative <img src> resolve here
    colorScheme: 'dark',       // from the OS; there is no media query on device
    onNavigate: (request) => askBackgroundThread(request), // yours: → { html, snapshot, nav } or nothing
    onError: ({ phase, member, error }) => report(phase, member, error),
  });
  // The first page usually arrives from the background thread (your plumbing):
  onFirstPage((page) => mount.show(page));
});
```

### What the host provides

For every page — the first, and each answer to `onNavigate` — the host provides:

```ts
interface LynxPage {
  html: string;     // the markup the server writes inside the mount element
  snapshot: unknown; // the post-Transformer snapshot it rendered from
  nav: { page: string; [key: string]: string | undefined }; // the navigation state it rendered for
}
```

A server that renders airo-js pages already has all three: answer native requests with them as JSON. The network call belongs to the host (it owns auth, cookies and redirects); on Lynx that is the background thread, so `onNavigate` posts the request there and resolves with the JSON that comes back. `nav.page` must name an enabled entry page of the template; if it does not, the page is shown without behaviour and `onError` says why, rather than hydrating the wrong handlers over it.

### Links and forms

A tap on `<a href>` and a submitted `<form>` (a submit button, or return in a text field) become one `NavigateRequest`:

```ts
{ url: '/search', method: 'get', fields: { q: 'chair' }, source: 'form' }
```

`url` is as written in the markup. Fields follow the HTML form rules: named, enabled controls; hidden inputs; the submitter button's name and value; a repeated name keeps every value. Hydrate handlers see `click`, then a cancellable `submit`, first: `preventDefault()` keeps the page. When two navigations overlap, only the newest one's answer is shown. An answer of nothing, or an error, leaves the page as it is.

### The DOM facade

Hydrate handlers receive element objects that implement this subset over a JS model of the page:

| member | |
|---|---|
| `querySelector`, `querySelectorAll`, `closest`, `matches`, `contains` | type, `#id`, `.class`, `[attr]`, `[attr="v"]`, descendant, child, comma lists |
| `getAttribute`, `setAttribute`, `removeAttribute`, `hasAttribute`, `toggleAttribute`, `dataset`, `hidden`, `disabled`, `id`, `className`, `classList` | every write updates the element's mirror classes, so attribute-keyed styles apply |
| `textContent`, `innerHTML`, `insertAdjacentHTML` | re-parsed and re-projected |
| `value` | text inputs and textareas, mirrored from typing |
| `addEventListener`, `removeEventListener` | `click` (a tap), `input`, `change` (on blur or return, when the value changed), `submit`, `focus`, `blur` |
| `tagName`, `nodeName`, `nodeType`, `parentElement` | read-only |

**Everything else is refused by name**: the call throws `LynxRefusalError` (`member` says what: `Element.getBoundingClientRect`, `Element.showModal`, `window.location`, `localStorage.getItem`, `selector "li:first-child"`, …), after logging it on the `lynx` channel and passing it to `onError`. That includes the browser globals that are host capabilities, not DOM — `window`, `document`, `location`, `history`, storage, `navigator`, `fetch`, observers, `matchMedia` — which the mount defines as refusing objects when the main thread lacks them. A hydrate call that throws has the listeners it attached removed again, so a page is never half wired; the painted page stays.

Run a page on device, read the refusals in `onError`, and rewrite those parts of the handler for native or move them to the host. Mutations are flushed once per task, however many a handler makes.

### Markup the tree pass accepts

| HTML | Lynx |
|---|---|
| text-level tags with only text and inline tags (`p`, `h1`–`h6`, `li`, `span`, …) | `text`, inline tags nested |
| other containers; `a` and `button` outside running text | `view`, loose text wrapped in `text` |
| `img` | `image` (`scaleToFill`: `object-fit` does not reach the device) |
| `svg` | `svg` with its markup as `content`; `currentColor` follows the CSS `color` around it where the engine reports computed colour (verified on iOS) |
| `input` (text, search, url, email, tel, password, number), `textarea` | `input`, `textarea` |
| `input type="hidden"`, `script`, `template`, `noscript` | the model only |
| the mount's root (what the server rendered into) | a vertical `scroll-view` with `.airo-lynx-viewport`: the browser's viewport scrolls, a Lynx `view` does not |
| anything else (`select`, `details`, `dialog`, tables, checkboxes, …) | refused: `UnmappedElementError` |

The tokenizer is strict on purpose. It reads what `escapeHtml` writes — the five entities `&amp; &lt; &gt; &quot; &#39;`, numeric references, void elements, raw-text `script`/`style`, `svg` as foreign content — and refuses a named entity such as `&nbsp;`, an unclosed or mis-nested element, or a stray `<` with an `HtmlParseError` that gives line and column. A conformance test holds its trees equal to a browser-grade parser's on real pages.

## Device check

`scripts/device-check.mjs` runs a built card on the iOS simulator and writes what the engine did: element tags, classes, computed colours, layout boxes, `onError` output, a screenshot.

```sh
AIRO_LYNX_COLLECTOR=http://localhost:3299/__collect pnpm --filter @airo-js-examples/lynx-native build
node packages/lynx/scripts/device-check.mjs --dist examples/lynx-native/dist --out .tmp/device-run --watch 60
```

It serves the bundle and a report collector, launches Lynx Explorer on the booted simulator (or `--udid`) through the `lynx_initial_url` launch environment, and with `--watch` keeps collecting while you tap through the card (open the Simulator app to tap). It refuses, before launching, a bundle that does not contain the collector's url, whose reports would go nowhere.

Your card sends reports with `sendDeviceReport(lynx, label, extra)` on the main thread, `reportOnTouch(lynx, extra)` adds one after every touch, and `relayDeviceReports(lynx, fetch, url)` on the background thread posts them; pass the thread's own `lynx` and `fetch`, which are not on `globalThis`. Each report is printed with what changed since the one before it (new text, elements whose classes changed), so a tap's effect is on record.

The check is manual by design, run at milestones and whenever a `@lynx-js/*` dependency changes. Taps cannot be scripted: `simctl` has no tap, and an event made with `__CreateEvent` and sent with `__DispatchEvent` does not reach `__AddEventListener` listeners on iOS (Lynx Explorer 4.1.0).

## Errors

| error | when |
|---|---|
| `LynxRefusalError` | a DOM member or browser API outside the facade |
| `UnmappedElementError` | markup with an element the tree pass has no mapping for |
| `UnsupportedSelectorError` | a selector feature the device matcher does not have |
| `HtmlParseError` | markup outside the tokenizer's contract |
| `LynxEnvironmentError` | `mountLynx` called somewhere that is not a Lynx main thread |
| `NormaliseError` | (build) a colour that depends on something the build cannot see |
| `InheritanceTapError` | (build) the vanilla plugin's template plugin was not found, or a bundle still has CSS inheritance off |

All runtime errors reach `onError` with the phase (`render`, `hydrate`, `event`, `navigate`) they happened in, and the log.
