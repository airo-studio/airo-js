# TODOS

Work deliberately not done yet, with the trigger that would start it. Anything
that has a consumer waiting on it lives on the bridge, not here; anything that
is a decision already taken lives in `docs/designs/`. This file holds only the
follow-ups that have neither.

## Runtime

### Abort an in-flight mount on destroy(), and thread an AbortSignal into DataSource.fetch

**What:** `mountCartridge` gets an `AbortController` per mount attempt: `destroy()` during an in-flight remount (gate phase or data phase) aborts it, the attempt discards the App it would have produced, and `ds.fetch` receives `ctx.signal`.

**Why:** Today `result.destroy()` during a remount's async gate phase or fetch destroys the already-destroyed handle and the remount then completes — router listeners attach, renderers paint, nothing tears them down. The gate phase made the window "however long a visitor leaves a modal open". The runtime also never supplies `ctx.signal`, so cartridges that thread it through (the convention) get `undefined`.

**Context:** Surfaced by the 0.11.0 pre-landing adversarial review. A `destroyed` flag checked after each `await` in `doMountInner` plus one controller per attempt; ~30 LOC in `packages/runtime/src/mount-cartridge.ts`. The convention "always thread `ctx.signal`" in best-practices §1.2 is written as if the runtime supplied one.

**Effort:** M
**Priority:** P2
**Depends on:** None

### Make the runtime's entry resolution authoritative for PageManager

**What:** `createApp` / `PageManager` accept the runtime's already-resolved `MountEntry` and skip their own URL re-parse, so the page the gates were scoped against is the page that mounts by construction.

**Why:** The gate phase is async and the URL can change under it; today the runtime narrates a disagreement (`log.warn`, phase `'gate'`) but cannot prevent it. The docblock claim "by construction" was corrected to describe the narration.

**Context:** `resolveMountEntry` in `packages/core/src/mount-entry.ts` is shared by both sides; what is missing is a way for `PageManager`'s constructor to take the result instead of recomputing it. Changes a core constructor's options — a 1.0 shape question.

**Effort:** M
**Priority:** P2
**Depends on:** 1.0 surface review

## SSR

### Let renderAppWithPublication take the snapshot lazily

**What:** `snapshot: TData | (() => Promise<TData>)`, resolved only after the entry-resolution and private/csr-only decisions, so a private refusal never touches it.

**Why:** The two-call "refuse first, then ask who is asking" host shape builds the public snapshot and a Document before the first call, which for a private entry is a refusal that reads neither. With an in-memory DataSource that is nothing; with a real one every anonymous or bot hit on a private URL is an upstream fetch.

**Context:** `examples/full-site/src/server.ts` already builds the Document lazily inside its `render` closure; the snapshot cannot be, because the runner's option is a value. Surfaced by the 0.11.0 performance specialist.

**Effort:** S
**Priority:** P3
**Depends on:** None

## Examples

### Extract the demo OAuth provider into `examples/demo-oauth-provider`

**What:** A standalone stand-in identity provider (authorization code + PKCE, one registered client, `demo` / `demo`) that other examples point `AUTH_ISSUER` at, instead of the in-process router in `examples/full-site/src/auth/oauth-provider.ts`.

**Why:** `full-site` would then read as "gate + relying party" only, and the `shopify-edge-worker` example could reuse the provider the day it grows a login without copying 200 lines.

**Context:** Kept in-process now so `pnpm dev` runs alone with no second process. The provider is already a self-contained Express router whose only import from the rest of the example is `DEMO_USER`, so the extraction is mechanical. Decision D25 in `docs/designs/gate-reshape-0.11.md`.

**Effort:** M
**Priority:** P3
**Depends on:** A second example that wants a login

## Lynx

Follow-ups for the planned `@airo-js/lynx` native render adapter (one package, `./build` and `./runtime`; plan reviewed 2026-10-08). The spike evidence and the review live in the local, gitignored `.claude/plans/airo-js-lynx-spike-findings.md`.

### Static scan of refused DOM members and browser APIs per hydrate module

**What:** `@airo-js/lynx/build` reads each hydrate module's source and lists, per module, the DOM members and browser APIs the on-device DOM facade refuses (layout reads, dialogs, location, history, storage, fetch, share, clipboard, canvas, IntersectionObserver).

**Why:** the facade refuses those calls at runtime with a named, logged error, so today the rewrite list for a consumer's pages appears only as each page is exercised on a device. A scan turns that into a known budget before the work starts.

**Context:** start from the facade's supported-member table. The first consumer's hydrate code already shows the shape of the output: location.assign 10, location.reload 7, history.replaceState 8, localStorage 8, fetch 7, showModal 14, getBoundingClientRect 6, canvas 16. A static scan misses dynamic access (`el[name]`) and over-reports dead code; treat it as a budget, not a guarantee. Trigger: before the step that extends the adapter beyond the tracer page.

**Effort:** S
**Priority:** P2
**Depends on:** The facade's supported-member subset being fixed

### Upstream CSS-option forwarding in `@lynx-js/vanilla-rsbuild-plugin`

**What:** open a pull request on lynx-family/lynx-stack so `pluginVanillaLynx()` accepts and forwards the template plugin's CSS page options (`enableCSSInheritance`, `customCSSInheritanceList`, `enableCSSSelector`, `enableRemoveCSSScope`), then remove the adapter's chain tap.

**Why:** CSS inheritance into `<text>` is off by default, and the vanilla plugin forwards only `targetSdkVersion`. The adapter switches inheritance on by tapping the internal chain entry `lynx:vanilla:template:<entry>` in a 0.1.x package, guarded by a build-time assertion. With inheritance on, text colours matching the browser went from 4 of 43 to 42 of 43 in the spike.

**Context:** the workaround and its assertion keep the adapter safe in the meantime. Opening an external pull request needs its own go-ahead. Trigger: after the tracer review on device.

**Effort:** S
**Priority:** P3
**Depends on:** Explicit approval to open the external pull request

### Time HTML parsing and tree building on the UI thread

**What:** add one timing row (tokenize plus tree build, per render and per facade `innerHTML` write) to the adapter's manual device script, and run it on the consumer's largest page.

**Why:** pages arrive as server HTML, so every navigation and every `innerHTML` write from hydrate code is parsed on the thread that draws the screen. The tracer page has 84 elements; the consumer's largest page has 276, and its hydrate code writes `innerHTML` 18 times and `insertAdjacentHTML` 9 times. Nothing has been timed.

**Context:** wrap the tokenizer and tree pass with a performance mark reported through the device script's collector. A simulator timing is indicative, not a phone measurement. Include the class strings in what is measured: the runtime mirrors every attribute into one or two classes (an `<img>` on the tracer page carries nine), and if that shows up, mirroring only the attribute names the build saw in selectors is the lever. Trigger: the step that extends the adapter beyond the tracer page.

**Effort:** S
**Priority:** P3
**Depends on:** The manual device script in `@airo-js/lynx`

### Scroll containers inside the page

**What:** make an element the cartridge's CSS makes scrollable (`overflow: auto` or `scroll` on either axis) scroll on device, as the page itself does.

**Why:** a Lynx `view` never scrolls. `mountLynx` puts the whole page in a vertical `scroll-view`, so long pages scroll, but a horizontal row of chips or categories inside the page is clipped. The first consumer has several (`*-scroll-x`, category rows).

**Context:** the runtime cannot read CSS, so this needs the build's help: the normaliser knows which selectors set `overflow` to `auto`/`scroll` and on which axis, and could emit that list for the tree pass to project those elements as `scroll-view` with `scroll-orientation`. That is the first piece of build-to-runtime data; weigh it against a marker attribute in the markup. Trigger: the step that extends the adapter beyond the tracer page.

**Effort:** M
**Priority:** P2
**Depends on:** The tracer review

### Re-check `@media` when the Lynx encoder accepts engine 4.x

**What:** when `@lynx-js/rsbuild-plugin` accepts `engineVersion` 4.0 or later, rebuild at 4.x with the `enableCSSRule` page option and re-run the `@media` probes on the iOS simulator.

**Why:** the encoder in `@lynx-js/rsbuild-plugin` 0.1.3 refuses anything above 3.9 ("current compiler only support lynx version [1.0, 3.9]"), and at 3.9 media queries are dropped. Mobile-first stylesheets keep their phone layout, but breakpoint rules for tablets and landscape are lost. `prefers-color-scheme` is already handled by the normaliser as a page class.

**Context:** the spike's probes `probe-media-max` and `probe-media-min` show the result in one run. Afterwards the normaliser's per-cartridge report should stop listing `@media` as dropped. Trigger: an `@lynx-js/rsbuild-plugin` release whose encoder accepts 4.x.

**Effort:** S
**Priority:** P3
**Depends on:** An upstream encoder release

## Completed
