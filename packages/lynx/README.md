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

The plugin also makes the build one a vanilla card can load, which rsbuild's defaults are not once `@airo-js/*` comes from `node_modules`: it transpiles the framework's packages like your own source (the encoder's main-thread compiler rejects them as published), and turns chunk splitting off (a split chunk is CommonJS the loader runs on neither thread, and the card never starts). If your card imports another package that ships modern syntax, add it to `source.include` yourself.

It also leaves the normaliser the last word on your CSS: no CSS minification, and no lightningcss-loader, which rspack runs after the normaliser and which merges `top`/`right`/`bottom`/`left` back into an `inset` the encoder removes. lightningcss used to lower `oklch()` tokens to hex as a side effect of rsbuild's default browserslist; the normaliser now does that itself, whatever your targets are.

**Installing before a release:** from airo-js, `pnpm yalc:publish`; then in the card's own folder run `yalc add @airo-js/lynx` with `yalc` itself (installed globally). Through `npx`, one consumer's `yalc add` wrote to the enclosing project's `package.json` instead of the card's.

### What the normaliser rewrites

Every rewrite answers a gap measured on device:

| your CSS | on device | why |
|---|---|---|
| `html`, `body` | `.airo-lynx-page` (the page element) | there is no `<body>` |
| a `font-size` in `rem`, `em` or `%` on `html` or `body` | px: `html`'s against 16px, `body`'s against `html`'s | both are the page, which `rem` follows, so `body { font: 1rem/1.5 … }` would refer to itself and fall back to 14px |
| `:empty`, `:modal`, `:checked` | `.airo-lynx-empty`, `.airo-lynx-modal`, `.airo-lynx-checked` (the runtime keeps these classes current) | they parse and never match |
| `.sheet::backdrop` | `.airo-lynx-backdrop--sheet`: one class per class of the dialog, its tag and mirrored attributes included | `::backdrop` is rejected; a modal's backdrop is an element on device |
| `h1`, `img`, … | `.tag-h1`, `.tag-img`, … (the tree pass adds these classes) | Lynx type selectors match Lynx tags (`view`, `text`) |
| `[n]`, `[n="v"]` | `.a-n`, `.a-n--v` (the runtime mirrors attributes into these classes) | attribute selectors parse but never match |
| a selector list holding one the encoder rejects | the rest of the list, kept | the encoder drops the whole rule otherwise |
| `display: inline-flex` | `display: flex` | falls back to linear layout |
| `display: block`, `flow-root`, `list-item` | `display: linear` | `block` lays out as a flex row (a card's photo beside its body); `linear` stacks, as a box with no `display` does |
| `place-items`, `place-content`, `place-self` | their `align-*` and `justify-*` longhands | the encoder removes the shorthands |
| `max-width: none`, `max-height: none` | `auto` | Lynx ignores `none`, so the cap it was meant to lift stays; `auto` lifts it |
| `display: none` | plus `overflow: hidden` | the box is 0×0 but its text still paints |
| `font: …` | the longhands | the encoder removes the shorthand |
| `inset: …` | `top`, `right`, `bottom`, `left` | the encoder removes the shorthand |
| `env(name, fallback)` | the fallback; a `safe-area-inset-*` with none is `0px` | not parsed, and it takes the whole declaration with it, a `calc()` round it included |
| static `calc()` in `:root` tokens and `border-radius` | its value | `calc()` in a radius reads as 0 |
| `aspect-ratio` with no width | plus `width: 100%` | Lynx applies it only to an explicit width |
| `oklch()`, `oklab()`, `lab()`, `lch()`, `hwb()`, `color()`, `hsl()`, space-separated `rgb()`, in declarations and tokens | `rgb()` / `rgba()` | `oklch()` paints nothing, through `var()` as well; hex and `rgb(r, g, b)` read |
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
| `.airo-lynx-closed { display: none }` | the HTML UA rule `dialog:not([open]) { display: none }` |
| `.airo-lynx-modal { overflow: auto }` | the HTML UA rule `dialog:modal { overflow: auto }` |
| `.airo-lynx-backdrop { position: fixed; top/right/bottom/left: 0 }` | the top layer's `::backdrop { position: fixed; inset: 0 }` |
| `z-index: 2147483647` on the backdrop | the top layer painting above every stacking context |
| `display: flex; flex-direction: column; align-items: flex-start` on the backdrop | a modal placed by its margins in a fixed box the size of the viewport: Lynx honours `auto` margins only on a flex item, so the backdrop lays the dialog out as one |

The dialog's paint (UA border, `padding: 1em`, Canvas colours), its centring `margin: auto` and the backdrop's tint are not emitted: under the headless rule the normaliser adds no colour and no spacing. Set them in the cartridge: a `margin` on the dialog, a `background` in `::backdrop`.

A test holds every emitted declaration to that table.

### Restrictions

- **Tokens are read at build time.** `color-mix()` results and resolved radius tokens are baked from your `:root` tokens and the dark tokens inside `@media (prefers-color-scheme: dark)`. `Theme` from `@airo-js/core` and runtime token overrides do not reach a native page.
- **`@media` other than the colour scheme is dropped** at engine 3.9. Write mobile-first: the unconditioned base is what a phone shows.
- **Pseudo-elements** do not render, except `::backdrop` (above); `:hover` and `:focus` do not apply on a touch screen; `:first-child` and `nth-*` never match.
- **Sibling selectors match, and the runtime keeps them current.** `input:checked + .track` matches on device, but Lynx does not restyle a following sibling when an element's classes change, so the runtime sets every following sibling's classes again after a change.
- **A grid row around an `aspect-ratio` box that is not an image is sized 0.** Lynx's grid sizes an auto row from its content at an unknown width, so content whose height comes from `aspect-ratio` contributes nothing; the runtime fixes it for images (above), which it knows from the markup. Computed style does not report `aspect-ratio`, so another box with one cannot be found: a `div` with `aspect-ratio` in a grid row overlaps what follows.
- **`html` and `body` are one element.** When they set different font sizes (`html { font-size: 62.5% }` with `body { font-size: 1.6rem }`), `rem` on device follows `body`'s, and the report says so.
- **One stylesheet per card.** Tokens are read per stylesheet, and the browser defaults above head each one, so a second stylesheet would repeat them after the first one's rules. Concatenate into one file.
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
    onPick: (request) => showPicker(request),               // yours: a tapped <select> → a value; a file input → files
    fetch: (url, init) => askBackgroundThread(url, init),   // yours: fetch for hydrate code, run on the background thread
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

A server that renders airo-js pages already has all three: answer native requests with them as JSON. The network call belongs to the host (it owns auth, cookies and redirects); on Lynx that is the background thread, so `onNavigate` posts the request there and resolves with the JSON that comes back.

**Know where a form landed from the page itself.** Lynx's `fetch` on iOS follows a redirect without saying so: `response.url` stays the request's, `redirected` is undefined, and `redirect: 'manual'` is ignored. So a host cannot read the landing url off the response; the page data should carry its own url (the first consumer reads its snapshot's path), and the host asks for that page. The same `fetch` keeps the session cookie across requests and launches, so a server's own cookie sign-in works from the background thread. `nav.page` must name an enabled entry page of the template; if it does not, the page is shown without behaviour and `onError` says why, rather than hydrating the wrong handlers over it.

### Selects and file inputs

Lynx has no picker, and the framework draws no UI, so a tapped `<select>` or `<input type="file">` (or its label) asks the host. `onPick` receives one of

```ts
{ kind: 'select', name: 'sort', value: 'old', options: [{ value: 'new', label: 'Newest', disabled: false }, { value: 'az', label: 'A to Z', disabled: false, group: 'Other' }, …] }
{ kind: 'file', name: 'photo', accept: 'image/*', multiple: false }
```

and returns (or resolves with) the value picked for a select, the files picked for a file input, or nothing to leave it. A file is an object of the host's own (a photo-library item, a path): hydrate code reads it from `input.files` and hands it back to the host through the host's `fetch` or a `FormData`; the framework never reads it. A form holding a picked file cannot be posted through `onNavigate` (its fields are strings): that is reported, and the upload belongs in the host's `fetch`. Show your own action sheet or wheel; the example card, with no native picker to call, takes the next option. A picked value changes the select and fires `input` then `change`, as a browser's does; a value that is not an enabled option is reported. Without `onPick`, a tap on a select is reported and changes nothing.

### Network, timers, `FormData`, `location` for hydrate code

The main thread has no network, no `setInterval`, no `FormData`, no `URLSearchParams`, no `URL` and no `Intl`.

- **`fetch` is the host's, when it lends one** (`mountLynx({ fetch })`), as `onNavigate` is (M13): post the request to the background thread, run it there, and resolve with what browser code reads of a `Response` (`ok`, `status`, `json()`, `text()`). The url is as written. Without it, `fetch` is refused by name.
- **Timers are the mount's.** `window.setTimeout`, `setInterval` and their clears work, as globals too where the engine lacks them; `destroy()` clears what is left, and a callback that throws is reported.
- **`FormData` is the mount's**, where the engine has none: `new FormData(form)` takes the entries a submission would, a file input's files included.
- **`URLSearchParams` is the mount's**, where the engine has none, by the URL Standard's form-urlencoded rules.
- **`location` and `history` read the page's url**, the `url` the host gives `LynxPage` (absolute, or a path resolved against `baseUrl`): `location.search`, `pathname`, `href` and the rest. `history.replaceState(state, '', url)` changes that url without a request, and the host reads it back from the mount's `url`. `location.assign`, `replace`, `reload` and setting `href` are a navigation, as a tapped link is: `onNavigate` gets `{ url, method: 'get', fields: {}, source: 'location' }`. The device keeps no history of its own, so `pushState`, `back` and the rest are refused by name, and so is `location` on a page with no `url`.
- **`URL` and `Intl` are refused by name** (`Intl.DateTimeFormat is not available on device`).
- **`String.prototype.normalize` stays absent** where the engine lacks it, so `typeof '…'.normalize === 'function'` still tells page code to fall back. A call without that check fails as a bare "not a function"; the runtime appends the built-ins this engine lacks to such a `TypeError`'s message, so `onError` and the log name it. Only once the mount has started: a module that builds an `Intl.DateTimeFormat` as it is imported runs before any mount and fails with the engine's own `ReferenceError`, which only the device log shows. Build those on first use.

### Links and forms

A tap on `<a href>` and a submitted `<form>` (a submit button, or return in a text field) become one `NavigateRequest`:

```ts
{ url: '/search', method: 'get', fields: { q: 'chair' }, source: 'form' }
```

`url` is as written in the markup. Fields follow the HTML form rules: named, enabled controls; hidden inputs; a select's selected option; the submitter button's name and value; a repeated name keeps every value. A `method="dialog"` form makes no request: it closes its dialog, with the submitter's value as `returnValue`. Hydrate handlers see `click`, then a cancellable `submit`, first: `preventDefault()` keeps the page. When two navigations overlap, only the newest one's answer is shown. An answer of nothing, or an error, leaves the page as it is.

### The DOM facade

Hydrate handlers receive element objects that implement this subset over a JS model of the page:

| member | |
|---|---|
| `querySelector`, `querySelectorAll`, `closest`, `matches`, `contains` | type, `#id`, `.class`, `[attr]`, `[attr="v"]`, descendant, child, comma lists |
| `getAttribute`, `setAttribute`, `removeAttribute`, `hasAttribute`, `toggleAttribute`, `dataset`, `hidden`, `disabled`, `id`, `className`, `classList` | every write updates the element's mirror classes, so attribute-keyed styles apply |
| `textContent`, `innerHTML`, `insertAdjacentHTML` | re-parsed and re-projected |
| `value` | text inputs and textareas, mirrored from typing; a select's selected option; an option's value |
| `open`, `show()`, `showModal()`, `close(result)`, `returnValue` | `<details>` and `<dialog>`; a modal makes the page below inert, and a tap outside it is a click on the dialog, as on its backdrop |
| `options`, `selectedIndex`, `selected`, `text` | `<select>` and `<option>`, by HTML's selectedness rules; a script's change fires nothing, as in a browser |
| `checked` | checkboxes and radios; a checked radio unchecks the rest of its group; a script's change fires nothing |
| `files` | file inputs: the host's objects from `onPick`; `value = ''` clears them, as in a browser |
| `addEventListener`, `removeEventListener` | `click` (a tap), `input`, `change` (on blur or return, when the value changed; on a pick), `submit`, `focus`, `blur`, `toggle` (a details opened or closed), `close` (a dialog closed) |
| `tagName`, `nodeName`, `nodeType`, `parentElement` | read-only |

**Everything else is refused by name**: the call throws `LynxRefusalError` (`member` says what: `Element.getBoundingClientRect`, `<div>.showModal()`, `window.location`, `localStorage.getItem`, `selector "li:first-child"`, …), after logging it on the `lynx` channel and passing it to `onError`. That includes the browser globals that are host capabilities, not DOM — `window` (apart from its timers, `location`, `history`, `URLSearchParams`, and `fetch` and `FormData` when present), `document`, storage, `navigator`, `fetch` unless the host lends one, observers, `matchMedia` — which the mount defines as refusing objects when the main thread lacks them. A hydrate call that throws has the listeners it attached removed again, so a page is never half wired; the painted page stays. A refusal hydrate code catches is still reported, and the call carries on with its listeners: wrapping a convenience the page works without (a `keydown` shortcut, `visibilitychange`) in a `try` keeps the rest of the page's behaviour.

Run a page on device, read the refusals in `onError`, and rewrite those parts of the handler for native or move them to the host. Mutations are flushed once per task, however many a handler makes.

### Markup the tree pass accepts

| HTML | Lynx |
|---|---|
| text-level tags with only text and inline tags (`p`, `h1`–`h6`, `li`, `span`, `pre`, …) | `text`, inline tags nested; a `pre`'s text keeps its spaces and line breaks, since Lynx's `white-space` has no `pre`. A text-only `span` your CSS makes a grid or flex container is still a `text`, which lays nothing out: `place-items: center` does not centre its label. Use a `div`, or give it a child element |
| other containers; `a` and `button` outside running text | `view`, loose text wrapped in `text` |
| `img` | `image` (`scaleToFill`: `object-fit` does not reach the device). After the first layout each image gets its laid-out height inline, because a parent with no height of its own does not count a height that comes from `aspect-ratio`: a grid row around the photo is 0 tall, and so is a card around a square cover box. An image with no height of its own (`height: auto`) first gets its `width` / `height` attributes' ratio, as a browser maps them; one whose width comes from the picture (a logo sized by its height) is rebuilt with `auto-size`. An SVG source (`.svg`, an `image/svg+xml` data url) is an `svg` with that `src`, since `image` draws no SVG, sized by the attributes' ratio and pinned the same way; one laid out 0 wide with a height gets `max-width: auto`, because Lynx collapses a percentage `max-width` (`img, svg { max-width: 100% }`) to 0 on an SVG inside an auto-width grid item. A pinned image whose width changes is laid out again and pinned anew. Still gaps: a box with `aspect-ratio` and no image inside it is not counted by its parent (give it a height), and an SVG `<img>` with `aspect-ratio` of its own under a percentage `max-width` can come out narrower than its box (151 wide in 169); put the ratio on a wrapper |
| `svg` | `svg` with its markup as `content`; `currentColor` follows the CSS `color` around it where the engine reports computed colour (verified on iOS) |
| `input` (text, search, url, email, tel, password, number), `textarea` | `input`, `textarea` |
| `details`, `summary` | `view`s (`text` when the summary is only text); closed, only the first `summary` is on screen; a tap on it toggles `open` |
| `dialog` | closed: an empty `view` with `.airo-lynx-closed`. `showModal()`: inside a backdrop `view` that covers the screen, with `.airo-lynx-modal` |
| `select` | a `view` holding the selected option's label; a tap asks `onPick`. `multiple` and `size` > 1 are refused |
| `input type="file"` | an empty `view` the stylesheet draws; a tap on it or on its `<label>` asks `onPick` for files, then fires `input` and `change` |
| `input type="checkbox"`, `"radio"` | an empty `view` the stylesheet draws, with `.airo-lynx-checked` while checked. A tap on it or on its `<label>` toggles it before its `click`, then fires `input` and `change`; a cancelled click puts it back |
| `input type="hidden"`, `script`, `template`, `noscript`, `option`, `optgroup` | the model only |
| the mount's root (what the server rendered into) | a vertical `scroll-view` with `.airo-lynx-viewport`: the browser's viewport scrolls, a Lynx `view` does not |
| anything else (tables, `range`, `date`, `color` inputs, `video`, …) | refused: `UnmappedElementError` |

The tokenizer is strict on purpose. It reads what `escapeHtml` writes — the five entities `&amp; &lt; &gt; &quot; &#39;`, numeric references, void elements, raw-text `script`/`style`, `svg` as foreign content — and a bare `&` exactly as the HTML parser does, so `href="/g?a=1&so=x"` keeps its `&`. It refuses a named entity such as `&nbsp;`, a bare `&copy` a browser would turn into ©, an unclosed or mis-nested element, or a stray `<`, with an `HtmlParseError` that gives line and column. A conformance test holds its trees equal to a browser-grade parser's on real pages.

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
