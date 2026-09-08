# Changelog

All notable changes to this repo are documented here. Format follows [Keep a Changelog](https://keepachangelog.com); each package versions independently per [SemVer](https://semver.org).

## Why the fix is `0.10.1` and not `1.0.0`

The typed `requires` below changes a published interface at compile time, which strict semver would call a major. It ships in the patch slot on purpose. `^0.10.0` reaches it automatically, and what it reaches consumers with is **loud**: a declaration the snapshot cannot satisfy stops compiling, naming the offending literal. That is the opposite of the failure 0.10.0's minor slot was guarding against — a silent runtime skip — and it is the check both consumers asked for after their audits. Both had already corrected their declarations against 0.10.0, so for them the bump is a no-op that proves the type agrees with their audit. The one migration a consumer may hit is a hoisted `SchemaFieldRef[]` constant, which now needs its snapshot type.

1.0.0 is next and freezes this surface. A patch first lets every consumer compile against the typed paths before the freeze, which is the whole point of shipping it separately.

## `@airo-js/cartridge-kit` 0.10.1 — 2026-09-08

**`CONTRACT_VERSION` 0.8.0 → 0.9.0** — `SchemaFieldRef` gains a type parameter and `requires` narrows on three interfaces.

### Changed
- **BREAKING (compile-time): `requires` paths are typed against the snapshot.** `SchemaFieldRef<TData>` — `path` is now `SnapshotPath<TData>`, the string-literal union of every dot-path `getByPath` can resolve on `TData`, and `PublicationAdapter.requires`, `McpToolDefinition.requires` and `CrawlerSurfaceAdapterOptions.requires` all carry it. A path the snapshot cannot have — `product.name` against `products: Product[]`; `artists.name` where `artists.0.name` was meant — is a compile error at the declaration site instead of a silently skipped adapter at publish time. Both consumers who audited against 0.10.0 found that **every** adapter they ship would have gone quiet, and both bugs were this exact class; a type makes the class unwritable where an upgrade note only describes it. The bare `SchemaFieldRef` (`TData = unknown`) keeps `path: string`. **Migration:** a hoisted constant must carry the type — `const REQUIRES: SchemaFieldRef<MyData>[]` — because an untyped `SchemaFieldRef[]` has `string` paths and no longer assigns into a typed adapter. Six segments are checked exactly; deeper paths are accepted as `string`. `${number}` is looser than the runtime's canonical-integer index grammar (`'01'` and `'-1'` typecheck and resolve absent), so the runtime stays authoritative for that edge.
- **Variance is structural, and that is load-bearing.** A typed ref widens to the bare ref, so erasure to `Cartridge<unknown, unknown>` — the registry, the default-resolver memo, embed's `resolveCartridge` — keeps compiling. `SchemaFieldRef<{ a }>` assigns to `SchemaFieldRef<{ a; b }>` (every declared path still exists) and the reverse is refused. A first draft with the `unknown` case as the *leading* conditional put `TData` in an extends position, which TypeScript measures as invariant, and cartridge-kit itself stopped building; the `unknown` case is now the fall-through of the last branch, and a comment says why. Pinned by `test/snapshot-path.test-d.ts` — the repo's first compile-time test, run by vitest's typecheck mode against a dedicated `tsconfig.typecheck.json`, because the package tsconfig (`composite`, `rootDir: ./src`) rejects a test file at the config level and vitest reports a config-error-only run as "no errors".

### Added
- **`SnapshotPath<TData>`** — exported for hosts that build coverage UIs or their own typed path helpers over the same grammar.

## `@airo-js/core` 0.10.1 — 2026-09-08

Sync rev; the line moves together. No source change.

## `@airo-js/runtime` 0.10.1 — 2026-09-08

Sync rev; the line moves together. No source change.

## `@airo-js/ssr` 0.10.1 — 2026-09-08

Sync rev; the line moves together. No source change — `runPublicationAdapters` reads `adapter.requires` through the unchanged `missingRequiredPaths` signature.

## `@airo-js/embed` 0.10.1 — 2026-09-08

Sync rev; the line moves together. No source change.

## `@airo-js/mcp` 0.10.1 — 2026-09-08

Sync rev; the line moves together. No source change — `McpToolDefinition.requires` is typed by cartridge-kit; `dispatchTool` is unchanged.

## Examples and docs — 2026-09-08

### Fixed
- **Three of the five publication adapters in this repo declared `requires` paths their snapshot never had.** `publication-adapter-skeleton` declared `product.gtin`, `offer.price`, … against `products: Array<…>`; `llms-txt-adapter` declared `product.title` and `category.name` against `products` and `categories` arrays; `full-site`'s llms-txt adapter declared `doc.sections` as `'always'`, which gated out the index snapshot whose `!data.doc` branch is the file's `# heading` — `/llms.txt` had been missing its first line since 0.10.0. The skeleton is the shape the first consumer's adapters were modelled on. All three were caught by the type the moment it landed; the full-site smoke now asserts the heading. `shopify-edge-worker`'s hoisted constants are re-typed `SchemaFieldRef<ProductSnapshot>[]` and `SchemaFieldRef<PostSnapshot>[]`.

### Changed
- **A path segment after an array is an index** — `artists.0.name`, not `artists.name`; if you mean "each", declare the array itself and check items in `validate()`. From the second consumer's finding. Best-practices §1.9 and the `SchemaFieldRef` docblock carry it, and the type enforces it. Also stated there: `'always'` only for what `generate()` genuinely cannot emit without — the collection, not a field of its items.

## Why this line is `0.10.0` and not `0.9.1`

The `requires` coverage gate below is a **behaviour change**, not a fix: an adapter whose `required: 'always'` paths are absent now yields no output where it previously yielded some, and `renderAppWithPublication` builds its inline JSON-LD from non-skipped adapters — so a page whose adapter over-declares `requires` silently loses its structured data from the `<head>`. No throw, no warning.

Under 0.x semver a `^0.9.0` range accepts `0.9.1` automatically but rejects `0.10.0`. Shipping this as a patch would have pushed a silent markup regression to every consumer without them choosing it, which is the exact failure the gate exists to prevent, arriving through the gate itself. The minor slot makes the upgrade deliberate.

The whole line moves together so 1.0.0 lands on every package at once. `@airo-js/log` keeps its independent `0.3.x` line.

**Upgrading:** audit your `PublicationAdapter.requires` declarations against a real snapshot before bumping. Any `required: 'always'` path your data does not actually populate now stops that adapter publishing.

## `@airo-js/ssr` 0.10.0 — 2026-09-05

### Changed
- **BREAKING (behaviour): `requires` is now enforced — contract guarantee #2 was documented from the start and never implemented.** `runPublicationAdapters` checks each adapter's `required: 'always'` paths against the snapshot before calling `generate()`. A starved adapter does not run; its result carries `included: false` plus `skipped: { reason, missing }`. Two deliberate narrowings. Only `'always'` gates — whether a missing `'preferred'` field should stop publication is a judgment the adapter makes in `validate()`, where it can see the output it produced. And **present means non-nullish**, not `hasByPath`'s declared-key semantic: `''`, `0`, `false` and `[]` count as present, because a feed cannot emit `undefined` either way. The gate ignores `onValidationFail` — that policy governs output that failed `validate()`, and a skipped adapter produced none — so a skip never throws even under `'fail-loud'`. **Blast radius:** `renderAppWithPublication` filters on `included`, so a skipped adapter's JSON-LD disappears from the rendered `<head>` silently.
- **`RunPublicationOptions` filter docs corrected — the JSDoc never matched the code.** All three filters said "Empty/undefined = include all"; the implementation is `opts.adapterIds ? new Set(...) : null`, and `[]` is truthy, so an empty array has always matched *nothing*. Behaviour is unchanged and deliberate — a caller whose filter produced nothing means "publish nothing", and widening that to "publish everything" could push adapters the host meant to exclude. Only the documentation was wrong. Same semantic now documented on `BuildToolManifestOptions.toolNames`.

### Added
- **`AdapterSkipped`** and **`AdapterRunResult.skipped`** — present only on an adapter coverage gating stopped, so a caller can tell "ran and failed validation" from "never ran", which `included: false` alone cannot. `reason` is an open union (`| (string & {})`) so future skip reasons are additive rather than a major bump.

## `@airo-js/cartridge-kit` 0.10.0 — 2026-09-05

**`CONTRACT_VERSION` 0.7.0 → 0.8.0** — `McpToolDefinition` gains a field.

### Added
- **`missingRequiredPaths(requires, snapshot)`** — the coverage predicate itself, extracted so `runPublicationAdapters` and `dispatchTool` cannot drift on what `'always'` and "present" mean. That drift is precisely what the snapshot-fidelity guarantee exists to prevent, so it is one function rather than one per consumer.
- **`McpToolDefinition.requires`** — optional coverage metadata, gated by the same shared predicate, so a feed and an agent answer reading the same field cannot reach opposite verdicts. Optional rather than required because most tools read the snapshot broadly, and because adding a required field to a published interface would be breaking. Typed `readonly SchemaFieldRef[]` to match the predicate's own parameter and `CrawlerSurfaceAdapterOptions.requires`.

### Fixed
- **`getByPath` walked the prototype chain.** Its record branch was a bare `cur[key]`, so `constructor`, `toString` and `valueOf` all resolved non-nullish against *any* object. With coverage gating now load-bearing, a cartridge declaring one of those as a `required: 'always'` path would have reported full coverage for a completely starved snapshot — the gate passing precisely when it should fire. Now an own-property read. Also hardens `hasByPath` and `resolveComponentProp`.
- Docstrings for guarantee #2 in `publication-adapter.ts`, `define-crawler-surface-adapter.ts` and the package README no longer say the framework "can" skip. The note claiming enforcement was blocked on schema-space→snapshot-space path resolution is retired: `SchemaDefinition<TData>.parse` returns `TData`, so both name the same place.

## `@airo-js/mcp` 0.10.0 — 2026-09-05

**First publish.** Previously a private 11-line stub.

### Added
- **The agent leg of the three-audience thesis, which was a 39-line interface.** `McpToolDefinition` shipped in cartridge-kit from the start and nothing in the framework ever read it — no manifest emitter, no dispatcher, no tests. So all three cartridges in this repo's own examples hand-rolled the missing runner; `examples/shopify-edge-worker` carried two near-identical private copies, and `examples/full-site` a third with a cast per field. That is the placeholder-package trap, shipped as the reference material people copy.
- **`buildToolManifest(cartridge, opts?)`** — MCP's `tools/list` payload and nothing more. `opts.snapshot` can filter on coverage but is **off by default**: MCP clients cache tool lists, and a tool that appears and disappears as data changes is worse for an agent than one always listed that sometimes answers `missing-required-fields`, which at least names what is absent.
- **`dispatchTool(cartridge, name, input, snapshot, opts)`** — resolve, gate on coverage, optionally validate, invoke. Returns a discriminated union and **never throws**: every outcome becomes a protocol response, and an agent calling a stale tool name is ordinary rather than exceptional. Both hand-rolls threw, so a stale name reached the edge worker as an unhandled rejection and a 500. `McpErrorCode` is an open union so new codes are additive.
- Input validation is a **seam** (`validateInput`), not a bundled JSON Schema validator — ajv is ~30 KB and the choice belongs to a host that already has one.

### Security
- **`error.message` never carries the thrown text.** A handler closing over server credentials is the normal case for this package, and every host wiring in our own docs forwards the error object to the caller — so a driver error carrying a connection string would have reached an agent. The detail lives on `cause`, documented as host-side-only, and both examples now log it rather than returning it.

## `@airo-js/runtime` 0.10.0 — 2026-09-05

### Fixed
- **`@airo-js/log` was a devDependency while `dist/mount-cartridge.js` imports it at module scope.** npm does not install devDependencies for consumers, and runtime was the only package on the line not declaring log as a peer (core, ssr and embed all did), so anyone installing `@airo-js/runtime` without another package resolving log for them hit a module-resolution failure at import. **Present in the published 0.9.0.** Now a peerDependency. *Migration:* consumers on strict peer resolution (pnpm's `strict-peer-dependencies`) should add `@airo-js/log` (`^0.3.1`) to their own dependencies. The peer is intentionally non-optional — the import is unconditional and unguarded.
- **`UpdateResult`'s back-compat re-export had been inert since 0.7.1.** A comment promised 0.7.0 consumers importing it from `@airo-js/runtime` kept working; the barrel never forwarded it and `exports` exposes only `.` and `./test-harness`, so the module path it lived on was unreachable. Now on the barrel, which also closes an ergonomics gap: `mountCartridge().update()` returns it, so typing your own call no longer means importing from a package you never called.

## `@airo-js/core` 0.10.0 — 2026-09-05

### Fixed
- A private `escape()` shadowed the deprecated global `escape()`, in the one file where a reader is most likely to wonder which they are looking at. Renamed `escapeEntities`; the exported `escapeHtml` / `escapeAttr` are unchanged in name and behaviour.

### Changed
- **`parseHtml` documents what it is NOT.** Blocking `<script>` execution is its only safety property; event-handler attributes (`onerror`, `onload`) and `javascript:` URLs pass through intact, and a browser fires them once the node is appended. The docblock previously invited the misreading ("safer than assigning `innerHTML`…") with no disclaimer. Both behaviours are now pinned in tests so the distinction cannot erode.
- 107 tests added for a package that had none of its own. Its integration paths were covered by 30 test files in other packages, but five public exports had zero mentions anywhere: `parseHtml`/`parseHtmlFragment`, `Theme`, `buildCrumbs`, `createPipeline`/`RuntimePipelineImpl`, plus `wrapInShadow` and `resolveStyleRoot`. Verified non-vacuous by mutation.

## `@airo-js/embed` 0.10.0 — 2026-09-05

### Removed
- `__resetRegisteredElementsForTesting` — a test-only escape hatch whose docstring said tests import it directly; none ever did (they use `uniqueElementName()`, which avoids the shared mutable state the hatch existed to reset). Never on the package barrel, so not a public-surface change.

## Repo tooling — 2026-09-05

Not published; recorded because it changes what the gates catch.

- **Lint gate.** `pnpm lint` runs Biome (`biome.jsonc`) with `--error-on-warnings`. Linter only — enabling the formatter would rewrite every file and bury real changes in whitespace. Four rules are off, each with its reason in the config; the short version is that correctness rules stay on and pure-style rules that fight `tsconfig.base.json` or the house style do not. It caught six real findings, all fixed.
- **Dead-code gate.** `pnpm knip` (CI mode) and `pnpm knip:audit` (`--include-entry-exports`, the "what are we freezing at 1.0" review). Added before 1.0 specifically because an accidental export becomes a semver commitment the moment the tag lands.
- **Tests now compile source, not a stale `dist`.** Cross-package imports in tests resolved through `node_modules` to the target's built output, so editing `cartridge-kit/src/coverage.ts` and running `pnpm test` exercised yesterday's copy — green while the source was broken, and failing outright on a fresh clone with no `dist/`. `vitest.shared.ts` aliases every `@airo-js/*` to its `src`. Proven by mutation: stubbing the source now fails 19 mcp tests where previously only stubbing `dist` did.
- `@airo-js/log`'s own tests moved into `@airo-js/log`, carrying their jsdom parity run with them.
- `scripts/publish.sh` now includes `@airo-js/mcp` in `PACKAGES`; it was absent, so the new package would have built, tested, passed both gates and been silently omitted from the release.
- best-practices §2.5c: the claim that typing a shared allowlist "moves the failure to your typecheck" is false under the `output.globals` externals mapping the section exists to serve, and cost a consumer a red e2e. Scoped, with the `importedBindings` guard that does work. Its measurements were also from that broken build and are corrected.

## `@airo-js/core` 0.9.0 — 2026-09-05

### Added
- **`escapeHtml` / `escapeAttr`** — the string-safety half of the env-agnostic seam whose other half is `parseHtml`. Cartridge templates and `renderDocument` both interpolate snapshot text into markup, and every consumer was re-implementing this: three private copies in the worker example, two more in the README. Both functions escape the same five characters (`& < > " '`), and `escapeAttr` must never be narrowed — attribute context needs the quotes, and an attribute value carrying `"` + `onload=` is a live XSS on the host's own origin. Not a sanitiser: a `javascript:` URL survives untouched, so validate schemes separately.
- **`PostRenderHook`** on `PageManagerOptions` / `AppDeps` — the seam `@airo-js/runtime` uses to run the post-processor chain. Pure mechanism; core learns nothing about pipelines or cartridges.
- **`joinPathFragment`** — the single path-mode URL encoder, now shared by `PathRouter.stateToUrl` and `routerHrefFor` so the two cannot disagree about which url a `RouteState` has.
- **`entryPageId`** on `PathRouterOptions` and the `mode: 'path'` `RouterOption` variant. Opt-in.
- **`decodeNavHint` JSDoc documents when NOT to use it.** Its `validPages` allowlist fails closed, and a `null` hint is indistinguishable from "no page requested" — so on a surface that owns its urls it hides the very rejection the host needs to see. Two gates in series, the outer silencing the inner. Decode with `fragmentToState` there and let the runner gate; keep `decodeNavHint` for embed and query surfaces where falling back is mandatory and there is nothing for a host to act on.
- **`describeEntryResolution()`** plus `EntryResolution` / `EntryFallbackReason` — `resolveEntryPage` with the reason it fell back (`'unknown-page' | 'disabled' | 'subpage' | 'gate-page'`). `resolveEntryPage` is now a thin wrapper over it, so there is one resolution path and the two cannot drift.

### Fixed
- **PostProcessors now run.** `PageManager` invokes the hook after every successful render — fresh mount, navigation swap, hydrate, and appContext re-render — and fires the returned teardown **before the next apply and before the renderer whose DOM it decorated is destroyed**. Per render rather than per mount, because a swap destroys the subtree a hook decorated: a mount-scoped hook silently stops applying the moment anyone navigates. Throwing hooks and throwing teardowns are logged and swallowed so one bad hook cannot take down its siblings or the render around them.
- **The entry page no longer answers on two urls.** `routerHrefFor` emitted `basePath + '/' + entryPageId` while the decoder already accepted a bare `basePath` as the entry page — an asymmetric round-trip, so the same page served 200 on both, and since `routerHrefFor` is what the docs steer canonical and sitemap construction at, it shipped as duplicate content. Set `entryPageId` and a **bare** entry state collapses onto `basePath`; `{page:'home', filter:'x'}` deliberately stays `/home?filter=x`, because `/?filter=x` would decode to a null tail and lose the filter. Also stops the `/` → `/home` rewrite on load. **Opt-in, not defaulted** — turning it on changes which url the entry page canonicalises to, which is an SEO event for anyone with `basePath/<entryPageId>` already indexed.
- `createRegistry` throws a named error on a missing or empty `mailboxName`. The name is used directly as a property key, so `undefined` stringified and the write landed on `globalThis['undefined']` — surfacing as `Cannot assign to read only property 'undefined'` three frames deep inside cartridge-kit under a DOM shim, or silently polluting a global under bare Node.

## `@airo-js/cartridge-kit` 0.9.0 — 2026-09-05

**`CONTRACT_VERSION` 0.6.0 → 0.7.0** — the `PublicationAdapter.format` union gains a member.

### Added
- **`defineCrawlerSurfaceAdapter()`** — the classic crawler bundle as a `PublicationAdapter`: canonical URL, OpenGraph, Twitter Card and a per-page sitemap entry, all derived from the post-Transformer snapshot, with `validate()` blocking publish on a missing **or relative** canonical. Field mapping is by selector FUNCTIONS, matching `defineSSRSafeRenderer`'s seam — a dot-path map cannot compute, and real canonicals are composed from a site url plus a slug. `requires` is required with no default, because coverage gating is metadata the factory cannot infer from opaque selectors and `[]` would silently disable the guarantee. Deliberately does not lint title/description length: that is content strategy.
- **`format: 'head-meta'`** on `PublicationAdapter`. It exists as its own union member rather than reusing `'custom'` because the default render filter is now `['json-ld', 'head-meta']` — a crawler bundle declared `'custom'` would silently never run, while widening the default to `'custom'` would drag every `llms.txt` and feed adapter onto the render hot path and then discard the output.
- Types: `CrawlerSurfaceOutput`, `CrawlerSurfaceSelectors`, `CrawlerSurfaceSelect`, `CrawlerSurfaceAdapterOptions`, `SitemapEntry`, `HreflangAlternate`.

### Changed
- **`getByPath` / `setByPath` / `hasByPath` descend into arrays by index** (`display.filters.0.layout`). Canonical non-negative integers only: `0` and `27` index; `01`, `-1`, `1e2` and `length` do not — leading zeros are ambiguous and `length` would drag array internals into the path grammar. Not a selector grammar: no `.first`, no by-id, no wildcard. `setByPath` **refuses** an out-of-range or non-index write into an existing array (returns the input unchanged) rather than clobbering it — extending leaves holes that `.map` skips and `JSON.stringify` emits as `null`, and replacing an authored array to hold a string key destroys declared config. `hasByPath` reports the same paths absent, so `validateGlobalConfigKeys` rejects them at registration.
- **`ViewDefinition.stylesheet` JSDoc corrected.** It claimed "SSR / publish pipelines inline this into the served HTML"; nothing anywhere reads the field. A consumer took it at face value, shipped no host-side CSS handling and got unstyled pages. The framework never injects it — hosts collect and inline it, via `resolveStyleRoot` on a client mount or `renderDocument`'s `head.inlineStyles` on an SSR path.

## `@airo-js/ssr` 0.9.0 — 2026-09-05

`@airo-js/ssr` moves from fragment-only to document-capable.

### Added
- **`renderDocument(opts)`** — assemble a complete `<!doctype html>` document around a fragment. **Composes with `renderAppWithPublication` rather than wrapping it**, so a document with no cartridge and no snapshot (a landing page, a 404) is served by the same helper, the fragment seam that `airo-ssr="hydrate"` depends on stays intact, and the function remains synchronous, pure and free of any `Document`. Framework-authored defaults are correctness only: doctype always, `<meta charset>` defaulted (the framework produces the byte stream, so a missing encoding declaration would make its own escaping unsound) with `charset: false` to omit — and **no viewport default ever**, because that string is responsive-design policy, and **`inlineStyles` defaults to `[]`**, because the framework authors no CSS. `openGraph` emits `property=` and `twitter` emits `name=`, decided by the field rather than by sniffing the key prefix. Inline `<style>` / `<script>` content is emitted verbatim and **throws** on a `</style` / `</script` sequence — escaping would corrupt the CSS or JS, so loud failure beats silent mangling.
- **`headFromPublication(results, opts?)`** — fold adapter output into a `DocumentHead` patch. Keys on output **shape**, never on adapter id, so a hand-written adapter works identically to a factory-built one and a rename cannot silently empty a `<head>`. Skips `included: false`, which is where `onValidationFail: 'block-publish'` reaches the document. Excludes `format: 'json-ld'` by default because `renderAppWithPublication` already inlines those into the fragment; `{ includeJsonLd: true }` for the compose-it-yourself path.
- **`buildJsonLdScript`** exported, and extracted to its own module so the two emitters in the package cannot drift apart — pinned by a byte-identical test.
- `"sideEffects": false`, ahead of the first consumer importing `renderDocument` into a bundler graph that also produces a client bundle.

### Changed
- **Default publication filter is now `{ formats: ['json-ld', 'head-meta'], deliveries: ['inline-in-host'] }`.** Behaviour is unchanged for every cartridge shipped before 0.9.0, since nothing declared `'head-meta'` until it existed.
- **`fellBack` on `RenderToHTMLResult` and `RenderWithPublicationResult`.** The entry resolver deliberately substitutes the default entry for a rejected page id so a tampered deeplink cannot crash a render — correct for an embedded widget whose host owns the URL and its status code. For an app that owns its own urls it is a trap: `/does-not-exist` renders the home page with a `200` and a canonical of `/`, a soft 404 that search engines penalise and that nothing errors about. The fallback is unchanged; the decision the runner already made is now reported so a host can answer 404. Present only when a page was requested AND rejected; threaded through the `csr-only` skip path too, so a 404 decision does not depend on whether the fallback page happened to be server-renderable. Requested after TWO independent consumers shipped the soft 404 without noticing — including a widget vendor, which is the case the fallback was thought to be unambiguously correct for. The right answer is per SURFACE, not per consumer: one codebase serves a crawlable domain (404) and a widget embedded on a customer's page (fall back — mandatory there, because the url belongs to the customer's router and a widget refusing to render an unrecognised tail would break their page). **Branch on `reason`, not on the presence of the field**: only `'unknown-page'` is a 404; `'disabled'` is a publisher config state and `'gate-page'` is a real page in the template, both legitimate 200s. HTTP status stays entirely host-side.
- **`renderAppToHTML` narrates an entry-page fallback.** `reason: 'unknown-page'` logs a `warn` naming the requested id and pointing at best-practices §5.10a; the other three reasons log at `debug`, being legitimate states. It fires only when a host actually requested a page, so a surface that gates upstream (the embed case, where `decodeNavHint`'s allowlist is the gate) stays silent and this cannot become spam on a customer's page. Requested after the soft 404 failed silently on one consumer **twice** — the second time after the fix had landed, because the wiring looked right and the page rendered.
- `renderAppWithPublication` **warns** when the cartridge it renders declares `postProcessors`. They are browser-only **by contract** — this path builds a string and there is no pipeline — and the alternative is the same silent-nothing the client wiring just fixed.

## `@airo-js/runtime` 0.9.0 — 2026-09-05

### Fixed
- **`mountCartridge` runs the cartridge's `postProcessors`.** It built the pipeline with them since 0.3 and then only ever called `runTransformers`; the local went out of scope unused, so a declared post-processor typechecked, mounted clean, emitted nothing and did nothing. Independently reproduced by a consumer against the published 0.8.8 tarballs. The runtime now supplies a `postRender` closure carrying the `config` and `data` halves of `PostProcessorContext`; `PageManager` owns the render cadence and the teardown. Cartridges declaring no post-processors wire nothing.

> **Upgrade note.** If you shipped a post-processor against 0.8.x it has never executed, and it starts executing on 0.9.0. Check that `apply` is re-entrant (it runs on every render) and that its teardown is correct.

## `@airo-js/embed` 0.9.0 — 2026-09-05

Sync rev for `workspace:^` peerDep coherence across the 0.9.0 line. No behavioural change; bundle unchanged at 5,081 B minified / 2,211 B gzip.

> **Scope note on that measurement.** The new core exports cost this bundle zero bytes because embed imports NAMED symbols and every package sets `"sideEffects": false`. It does **not** generalise to a consumer that re-exposes the framework to code the bundler never sees: `import * as core` on a global pins every export by construction, and one consumer measured **+1.6 KB gzip** on their core this way, with the new exports they will never call inlined in full. Curating a typed allowlist recovered **2.7 KB gzip** for them — leaving them 1.0 KB *below* their 0.8.8 baseline on a larger framework version, because the ratchet had been running for releases before 0.9.0 made it visible. If you share a framework instance with lazily-loaded chunks, see best-practices §2.5c.

## `@airo-js/log` 0.3.1 — 2026-09-05

### Fixed
- **Default threshold is `'warn'`, was `'error'`.** 0.3.0 moved every scattered `console.*` call in the framework behind this dispatcher and set the default to `'error'`, intending "narration is opt-in". It overshot by one rank. `debug` and `info` are narration and stay off — but `warn` is not narration, it is *"your configuration is wrong and we are degrading"*, and putting the threshold above it silenced **all eight framework warnings at once**, among them `Router (path) init failed; URL routing disabled`, `renderer does not implement hydrate()`, and both warns added in 0.9.0 specifically to stop silent failures.

  Nothing fails when that happens, which is exactly the failure mode this package exists to remove. A consumer measured it: the 0.9.0 warns shipped and could not fire. `isLevelEnabled('ssr', 'warn')` returned `false` out of the box.

  This also restores what the README has always claimed — that an app which never calls `setSink` sees the pre-0.3.0 `console.warn` behaviour. It did not; it saw strictly less.

  Deliberately **not** conditional on `NODE_ENV`: this package runs in browsers, Workers and Deno where `process` does not exist, so reading it here would trade a visibility bug for a portability bug. A host that wants production quiet calls `setLogLevel('error')` — one line, explicit, and unchanged in behaviour.

  If you pinned `0.3.0` and added a `setLogLevel('warn')` of your own, you can drop it.

> **Upgrade note — check any compensating workaround you wrote against the quiet default.** The natural shape is to raise your own channels when the global looks untouched:
>
> ```ts
> if (getLogLevel() === 'error') {          // "the framework's untouched default"
>   for (const ch of APP_CHANNELS) {
>     if (getChannelLevel(ch) === null) setChannelLevel(ch, 'warn');
>   }
> }
> ```
>
> On 0.3.0 that guard was correct but **unenforceable**: `getLogLevel() === 'error'` was true both for the untouched default and for an explicit `error` directive, and nothing could tell them apart. On 0.3.1 the untouched default is `'warn'`, so the condition can now only be true when someone **explicitly asked for `error`** — precisely the page-wide intent such a block is usually written to respect. It inverts from "restore visibility the framework took away" to "override an explicit directive", **without a line changing**.
>
> Delete the block rather than retarget it; the visibility it was compensating for is now the default. Reported by a consumer who found it in their own code while validating this release. Note the outcome is usually preserved either way — `effectiveLevelFor` is `channelLevels.get(channel) ?? currentLevel`, so a channel with no override inherits the new global — but a test asserting the *mechanism* (`getChannelLevel('x') === 'warn'`) will fail where one asserting the *outcome* (`isLevelEnabled('x', 'warn')`) will not.

### Changed
- README documents the level threshold as a filter that runs **before** the sink, so "replace the sink" is not confused with "lower the threshold".

## `@airo-js/log` 0.3.0 — 2026-07-24

The logging upgrade (bridge thread msg_mryrycuf). Four changes, one behavioral default flip.

### Changed
- **Default threshold is `'error'`** (was `'debug'`). Only genuine failures surface unprompted on any surface; all narration is opt-in via `?airo-log=` (below) or programmatic `setLogLevel`/`setChannelLevel`. `resetLogLevels()` resets to the new default.
- **`consoleSink` payload format defaults to `'clean'`**: payloads deep-clone as null-prototype objects before printing — DevTools shows expandable properties with no `[[Prototype]]: Object` row, and the print is a snapshot at log time (post-log mutation can't lie). Arrays stay arrays; structures that don't survive JSON (circular refs, DOM nodes) fall back to the raw reference. `setConsoleFormat('raw')` is the escape hatch (pass-through references, pre-0.3.0 behaviour). Algorithm contributed by a consumer's interim sink wrapper, adopted verbatim. Note: null-prototype clones have no `toString` — code that calls `String(payload)` on console args must use `JSON.stringify`.
- **`LogChannel` is an open union.** The named members stay for autocomplete, but any string is a valid channel: `logger('analytics')`, `setChannelLevel('analytics', 'debug')`, `?airo-log=analytics:v` all work without the framework blessing each host domain. `consoleSink` tags well-known channels `[@airo-js/<channel>]` and app-defined ones bare (`[<channel>]`) so host domains never print under framework branding.

### Added
- **`initLogControls()`** — the `?airo-log=` URL/storage convention, promoted from a consumer runtime. Grammar (comma-separated, case-insensitive): global levels (`debug|info|warn|error|silent`), aliases (`all|v|verbose` → debug, `off` → silent), `channel:level` pairs (`analytics:v`, `warn,app:debug`), and two ergonomic rules so the common reflexes don't silently no-op — a **bare non-level token is a channel → debug** (`analytics` == `analytics:debug`), and a **level alias in channel position** (`all:v`, `debug:v`) is the global intent applied via `setLogLevel`, not a channel literally named after a level. URL-supplied directives persist under `localStorage['__airo_log']` — the literal `__airo_`-prefixed key sanitized-bundle contexts allowlist, written with a **literal string at the call site** (not a const — a const survives minification as a variable and fails static allowlist proofs); overwrite-only semantics (`off` is a stored directive, never a `removeItem`). Fallback read order: `__airo_log`, then the manual `airo-log` console convention (read-only). Once-guarded so a second mount can't clobber programmatic levels; no-op outside browsers and under disabled storage. `mountCartridge` calls it on every mount, so every runtime/embed surface honors the param with zero host wiring.
- `applyLogDirective(directive)` — the parser behind `initLogControls`, exported for hosts that transport the directive another way (config flag, postMessage).
- `isLevelEnabled(channel, level)` — cheap threshold predicate (one map lookup + compare) for guarding an expensive payload build BEFORE calling the logger, so the assembly cost is paid only when it will emit. `EventBus.emit`'s per-emission bus narration uses it.
- `'json-pretty'` as a third `ConsoleFormat` — payloads render as indented `JSON.stringify` text inline (not a collapsed expandable object), for scanning event streams and copy/paste into a diff/ticket. Raw-reference fallback on circular structures, same as `'clean'`.
- `setConsoleFormat` / `getConsoleFormat`, `resetLogControls` (test hook), `VERSION` export.

## `@airo-js/runtime` 0.8.8 — 2026-07-24

Chunk-recovery log story + registration-failure guard. Originates from a consumer reading the deferred-hydrate `info` as an error in DevTools: the recovery flow now narrates deferred → recovered/failed instead of logging only the miss.

### Added
- Success `info` on the `runtime` channel after a recovery dispatch paints: `chunk loaded — page type "x" hydrated|rendered after recovery.` (meta: `pageType`, `pageId`, `phase`, `cartridgeId`). Suppressed when the dispatch itself re-misses.
- `error` log when a `resolveView` load rejects — previously the rejection was visible only to hosts that wired `onError('resolve-view')`; now the console tells the genuine-failure story either way. `onError` still fires.
- `mountCartridge` calls `initLogControls()` (log 0.3.0) on every mount — `?airo-log=` works on any runtime or embed surface with zero host wiring.
- `VERSION` export beside `PACKAGE_NAME` (publish preflight asserts it matches package.json) — completes consumer mount banners that want the framework version.

### Fixed
- A `resolveView` load that resolved WITHOUT registering a renderer for the missed page type (wrong `pushToMailbox` key / mailbox name) looped forever: dispatch → miss → cached resolved load → dispatch, with nothing above `info` ever logged. The engine now allows exactly one re-dispatch per resolved load; a re-miss after it is a hard failure — `error` log + `onError('resolve-view', err, shell)` — and the singleflight entry resets so a later miss starts a fresh load instead of replaying the stale one. `MountPhase` docs updated: `'resolve-view'` now also covers this resolved-but-unregistered case.

## `@airo-js/core` 0.8.8 — 2026-07-24

### Added
- **Native bus narration**: every `EventBus.emit` logs `bus: <event>` at debug on the `core` channel with `{ listeners, payload }` — `?airo-log=core:debug` narrates the whole bus. Replaces the emit-wrap consumers monkey-patched for the same trace. Invisible at the default `'error'` threshold, and guarded by `isLevelEnabled` so the template string + payload object are built ONLY when narration is on — `emit()` is the hottest path in the framework, so at the default threshold this is one map lookup + compare with zero allocation.
- **Navigation narration**: PageManager logs `navigation: page "x" (navigate|hydrate|subpage)` at debug — the trigger kind is the one thing the `navigation:changed` bus payload doesn't carry.
- `VERSION` export beside `PACKAGE_NAME` (publish preflight asserts it matches package.json).

### Changed
- The `renderer:missing` log with a recovery subscriber wired now says what it means: `page chunk for "x" not loaded yet — recovery in flight. Hydrate|Render resumes when the chunk registers.` (still `info`). The `no renderer registered … Hydrate skipped.` wording — which read as an error during normal lazy-chunk recovery — is now exclusive to the unwired `warn` path, where it IS a misconfiguration signal. Event payload and emission are unchanged: the event is the recovery trigger and always fires.

## `@airo-js/embed` 0.8.8 — 2026-07-24

Sync rev for `workspace:^` peerDep coherence with the 0.8.8 line. No source change — `defineAiroApp` inherits the recovery log story, registration-failure guard, and `?airo-log=` controls through the forward to `mountCartridge`. `VERSION` export added beside `PACKAGE_NAME`.

## `@airo-js/cartridge-kit` 0.8.8 — 2026-07-24

Sync rev for `workspace:^` peerDep coherence with the 0.8.8 line. `VERSION` export added beside `PACKAGE_NAME`; no other source change.

## `@airo-js/ssr` 0.8.8 — 2026-07-24

Sync rev for `workspace:^` peerDep coherence with the 0.8.8 line. `VERSION` export added beside `PACKAGE_NAME`; no other source change.

## `@airo-js/runtime` 0.8.7 — 2026-07-10

Editor-attach + chunk-recovery hardening. All three items originate from a production consumer's validation of the `MountCartridgeResult`-as-attach-handle pattern: two lifecycle gaps their overlay tooling hit, plus the Decision-1 recovery engine that 0.8.5 was meant to put on `mountCartridge` but landed embed-only.

### Added
- `resolveView?(cartridgeId, pageType): Promise<void>` on `SharedLifecycleHooks` ([`packages/runtime/src/mount-cartridge.ts`](packages/runtime/src/mount-cartridge.ts)) — the per-page chunk loader hook, previously available only via `defineAiroApp` (0.8.5). Direct `mountCartridge` callers now get the shared recovery engine: singleflight per `(cartridgeId, pageType)` with delete-on-reject (a cached rejection would permanently brick a chunk; the next miss retries), a mount-ready gate (a preloaded chunk settling on a microtask can no longer dispatch before the App exists; blocked or failed mounts release the gate so queued recoveries return instead of stranding), and the hydrate-vs-navigate dispatch split (`hydratePage()` preserves SSR DOM on a hydrate miss; `navigate()` repaints on a CSR miss). Dispatch reads the live App at fire time, so misses emitted after an `update()`/`updatePages()` remount recover against the current instance — an improvement over the 0.8.5 embed loop's mount-time capture. Same transport-agnostic contract as the embed hook: resolve after the chunk self-registers via `pushToMailbox`; the body may be dynamic `import()`, `<script>` + SRI, or a no-op.
- `'mount:remounted'` event on `shell.events` (payload: `UpdateResult`), emitted after either dispatcher takes a remount path. Remounts clear `renderRoot`, and renderer-initiated `ctx.update` remounts happen with no host in the call stack — live-attached tooling (editor overlays, inspectors) subscribes to re-inject. The bus instance survives remounts, so subscriptions hold. Hot-swap paths do not emit.
- `'resolve-view'` value on `MountPhase` — fires via `onError` when a `resolveView` load rejects. Async and post-mount, unlike the other phases: never accompanied by a `mountCartridge` throw; the failed load retries on the next miss.

### Fixed
- `update()` / `updatePages()` now serialize FIFO. Concurrent calls previously interleaved: both passed the mounted-guard during the other's await gap, both destroyed + remounted, last-writer-won on the live App (leaking the loser's) and config merges computed from stale state were lost. Hosts can delete dispatch queues they built in front of the result handle; a rejected dispatch does not stall the queue.

## `@airo-js/embed` 0.8.7 — 2026-07-10

### Changed
- The Phase-6.5 chunk-recovery loop is deleted; `defineAiroApp` now forwards `resolveView` to `mountCartridge` via `SharedLifecycleHooks` (whose mapped-type forwarding makes the wiring compile-enforced) and maps the runtime's `'resolve-view'` error phase to `EmbedPhase`. Behavior is unchanged — embed's existing `resolveView` tests pass through the forward — but the engine is now authored once, and the pre-mount subscription timing is owned by the runtime.

### Notes
- Entry bundle drops from the 5.00 KB minified ceiling (5,118 / 5,120 B) to 4.52 KB (4,632 B); gzip from 2.18 to 1.96 KB against the 2.50 KB budget. The recovery loop was the tightest thing under the budget; the forward restores real headroom.

## `@airo-js/core` 0.8.7 — 2026-07-10

Sync rev for `workspace:^` peerDep coherence with the 0.8.7 line. No source change.

## `@airo-js/cartridge-kit` 0.8.7 — 2026-07-10

Sync rev for `workspace:^` peerDep coherence with the 0.8.7 line. No source change.

## `@airo-js/ssr` 0.8.7 — 2026-07-10

Sync rev for `workspace:^` peerDep coherence with the 0.8.7 line. No source change.

## `@airo-js/cartridge-kit` 0.8.6 — 2026-06-11

> Backfilled 2026-07-10 — the 0.8.6 line commit (`27124a2`) shipped without a changelog entry.

Global↔component prop linking. Promotes a production consumer's studio-side global/component settings registry into a declarative cartridge-kit primitive.

### Added
- `PropSchema.globalConfigKey?: string` ([`packages/cartridge-kit/src/editor-schema.ts`](packages/cartridge-kit/src/editor-schema.ts)) — a dot-path into `TConfig` linking a component prop to a global config field. Shared key = one global bus; per-instance override stays independent.
- `resolveComponentProp(…, config?)` — additive global tier resolved between slot value and schema default.
- `getByPath` / `hasByPath` / `setByPath` path utilities (`setByPath` = immutable copy-spine).
- `deriveGlobalOptions(componentSchemas)` → `GlobalOption[]` — editor-side enumeration of linkable globals.
- `validateGlobalConfigKeys` / `assertGlobalConfigKeys` — author-time typo catcher; `hasByPath` in-walk distinguishes absent path from present-but-undefined.

### Changed
- `CONTRACT_VERSION` 0.5.0 → 0.6.0.

### Notes
- Same cut: `scripts/yalc-publish.mjs` rewrites `workspace:` ranges to concrete semver in the yalc flow (yalc copies package.json verbatim, so npm-based consumers of yalc builds previously hit `EUNSUPPORTEDPROTOCOL`); `publish.sh` drops the stale cartridge-kit `--tag rc`; `examples/llms-txt-adapter` added (llms.txt as one PublicationAdapter).

## `@airo-js/core` 0.8.6 — 2026-06-11

Sync rev for `workspace:^` peerDep coherence with the 0.8.6 line. No source change.

## `@airo-js/runtime` 0.8.6 — 2026-06-11

Sync rev for `workspace:^` peerDep coherence with the 0.8.6 line. No source change.

## `@airo-js/ssr` 0.8.6 — 2026-06-11

Sync rev for `workspace:^` peerDep coherence with the 0.8.6 line. No source change.

## `@airo-js/embed` 0.8.6 — 2026-06-11

Sync rev for `workspace:^` peerDep coherence with the 0.8.6 line. No source change.

## `@airo-js/embed` 0.8.5 — 2026-06-10

First-class per-page chunk loading. A multi-page cartridge can now ship one renderer chunk per page type and pay ~one renderer's bytes per mount instead of bundling every page. Resolves a production studio's adoption blocker (full `defineAiroApp` adoption was regressing customer bundles ~3.6×); contract validated against two production consumers before locking.

### Added
- `resolveView?(cartridgeId, pageType): Promise<void>` hook on `DefineAiroAppOptions` ([`packages/embed/src/define-airo-app.ts`](packages/embed/src/define-airo-app.ts)). Called when the active page's renderer factory isn't loaded yet (core emits `'renderer:missing'`). The host loads the chunk — which self-registers to the cartridge mailbox via `pushToMailbox` — and resolves; embed re-resolves through the registry. **Transport-agnostic**: embed never assumes ESM module semantics, so a dynamic `import()` and a `<script>`-tag injection with SRI are equally valid bodies. `cartridgeId` is always the resolved `cartridge.id`.
- embed-owned recovery dispatch: singleflight per `(cartridgeId, pageType)` with delete-on-reject (concurrent misses collapse to one load; a failed load retries on the next miss), plus the hydrate-vs-navigate split — `hydratePage()` on an SSR miss (preserves server markup) vs `navigate()` on a CSR miss (fresh paint). Hosts no longer hand-roll this loop.
- `'resolve-view'` error phase on `onError(phase, err, host)` — fires when `resolveView` rejects.

### Fixed
- Chunk-recovery dispatch now gates on a mount-ready signal rather than assuming the chunk fetch outlasts the synchronous tail of `mountCartridge`. A preloaded/cached chunk whose `resolveView` settles on a microtask previously could dispatch before the App handle existed and silently no-op; recovery is now correct regardless of chunk-resolution timing.

### Notes
- Entry bundle sits at the 5.00 KB minified ceiling (5,118 / 5,120 B); gzip — the real wire cost — has ~330 B headroom (2.18 / 2.50 KB). `EventBus` for the recovery path is pulled off the lazy `@airo-js/runtime` import, not statically imported from core, so it adds nothing to the entry bundle.

## `@airo-js/runtime` 0.8.5 — 2026-06-10

### Added
- Re-export `EventBus` from `@airo-js/core` ([`packages/runtime/src/index.ts`](packages/runtime/src/index.ts)). Lets lazy consumers (notably `@airo-js/embed`) construct a pre-mount event bus from the same dynamic `import('@airo-js/runtime')` they already pay for, without a static `@airo-js/core` import inflating their entry bundle. The runtime already bundles `EventBus` (it constructs one when none is passed), so the re-export adds nothing to the runtime chunk.

## `@airo-js/core` 0.8.5 — 2026-06-10

Sync rev for `workspace:^` peerDep coherence with the 0.8.5 line. No source change.

## `@airo-js/cartridge-kit` 0.8.5 — 2026-06-10

Sync rev for `workspace:^` peerDep coherence with the 0.8.5 line. No source change.

## `@airo-js/ssr` 0.8.5 — 2026-06-10

Sync rev for `workspace:^` peerDep coherence with the 0.8.5 line. No source change.

## `@airo-js/cartridge-kit` 0.8.4 — 2026-05-27

Sync rev for `workspace:^` peerDep coherence with the 0.8.4 line. No source change.

## `@airo-js/runtime` 0.8.4 — 2026-05-27

Sync rev for `workspace:^` peerDep coherence with the 0.8.4 line. No source change.

## `@airo-js/ssr` 0.8.4 — 2026-05-27

Sync rev for `workspace:^` peerDep coherence with the 0.8.4 line. No source change.

## `@airo-js/embed` 0.8.4 — 2026-05-27

Sync rev for `workspace:^` peerDep coherence with the 0.8.4 line. No source change.

## `@airo-js/core` 0.8.4 — 2026-05-27

`QueryRouter` — third router mode for customer-edge SSR. Discrete prefix-namespaced URL params (one slot per nav-state field), NOT a single opaque blob. Preserves SEO + AI-agent discoverability of individual filter dimensions; supports customer-site integration (host JS can write `pushState('?airo_category=' + value)` without knowing the framework's encoding format).

### Added
- `QueryRouter` class implementing `IRouter` ([`packages/core/src/router.ts`](packages/core/src/router.ts)). Reads `window.location.search` via `URLSearchParams`, writes via `history.pushState` / `history.replaceState`, listens for `popstate`. Each `RouteState` field maps to its own URL param under the configured prefix; the `page` selector lands at `<prefix>nav`. Host-page params (`utm_source`, `ref`, anything not matching the prefix) preserved across pushes. Stale prefixed slots from the prior state cleared on push (so removing a filter actually drops its URL slot).
- `QueryRouterOptions` interface — `paramPrefix` (default `'airo_'`), `validPages` (tampering gate, same semantic as `HashRouterOptions.validPages`).
- `RouterOption` discriminated union extends to a fourth variant: `{ mode: 'query'; paramPrefix?: string }`. `pathContextKey` is omitted from this variant (discrete-param shape has no path segments — making it accepted-but-ignored would be a footgun).
- `routerHrefFor(option, state)` — pure helper for cartridges building anchor hrefs. Returns the URL shape matching the active router:
  ```
  routerHrefFor(false, state)                          → '#'
  routerHrefFor({ mode: 'hash' }, state)               → '#quickshop?category=whiskey'
  routerHrefFor({ mode: 'path', basePath: '/c/x' }, state)
                                                       → '/c/x/quickshop?category=whiskey'
  routerHrefFor({ mode: 'query', paramPrefix: 'airo_' }, state)
                                                       → '?airo_nav=quickshop&airo_category=whiskey'
  ```
  Pure function — no DOM, no globals. Cartridges pass the same `RouterOption` they configured at mount time.
- `decodeNavParams(searchParams, options)` — server-side decoder for query mode. Pure URL parsing; same `(searchParams, paramPrefix, validPages)` triplet yields the same `RouteState` on both sides of the SSR-then-hydrate boundary. Worker pattern:
  ```ts
  import { decodeNavParams } from '@airo-js/core';
  const url = new URL(request.url);
  const navState = decodeNavParams(url.searchParams, {
    paramPrefix: 'airo_',
    validPages: appConfig.pages.map((p) => p.id),
  });
  ```

### Why this shape (discrete params, not single blob)
- **SEO discoverability.** Google indexes individual query params as meaningful filter dimensions and surfaces those URLs in search results. An opaque URL-encoded blob in one param looks like a tracking parameter to crawlers and isn't indexed. The entire customer-edge SSR initiative exists to make deep-linked content crawler-visible; single-blob would ship the plumbing without the SEO win.
- **AI shopping agent discovery.** Same reasoning — agents inspect URL structure to discover product / category / filter dimensions.
- **Customer-site integration.** Customer JS driving the widget from arbitrary host-page UI wants `history.pushState('?airo_category=' + value)` not "serialize through the framework's encoding format then double-escape."
- **Shareable / bookmarkable URLs.** Users land on readable URLs (`?airo_category=Tennessee+Whiskey&airo_retailer=walmart`) instead of walls of `%3F`/`%26`/`%2B`.

### Trade-off: QueryRouter does NOT share encoding with Hash/Path routers
- `QueryRouter` uses its own discrete-param serializer/parser instead of the shared `stateToFragment` / `fragmentToState`. Cross-mode round-trips (decoding a hash URL with `QueryRouter` or vice versa) won't work. Each widget picks one router mode for its lifetime; cross-mode preservation isn't a real use case.

### Field-name preservation (no case conversion)
- `productId` → `<prefix>productId`, NOT `<prefix>product_id`. Framework does no implicit case conversion. Cartridges that want different URL keys than internal field names (e.g. `airo_product_id` URLs but `productId` internal state) either rename the state field or add a cartridge-side mapping layer.

### Encoding scope
- String values only (matches `RouteState`'s typing — `{ page: string; [key: string]: string | undefined }`). Arrays / nested objects aren't part of the contract; cartridges wanting array values join/split themselves (`?airo_brands=walmart,target` → `value.split(',')`).

### prefix collision caveat
- `paramPrefix` should include its own separator (`'airo_'`, `'commerce-'`) — otherwise `dtr` would match `dtractually` during the decode scan and produce a stray state field. Default `'airo_'` includes the separator; consumer overrides should too.

### Why this exists
- Customer-edge SSR pattern (driven by a production consumer's edge-SSR spike): a customer installs an edge worker (Cloudflare Workers / Lambda@Edge / Shopify Oxygen) on their own CDN; the worker fetches a signed snapshot and runs per-request SSR to inject crawler-visible product HTML + JSON-LD on first paint. The worker only sees what the customer's CDN sends — `request.url.pathname + search`. Hash-mode routers fail closed in this topology because the fragment is stripped client-side before the HTTP request is built; the worker only ever sees the default view, then the client repaints after hydration → visible flicker for users and zero deep-link content for crawlers / AI shopping agents.
- Path-mode routers don't work either — on a customer's domain (`coolretailer.com/products/whiskey`) the path is owned by the customer's routing; widgets can't claim path segments.
- Query strings are the only viable primitive: sent to the server, namespaced via prefix, survive bookmarking + sharing + crawler discovery.

### Notes
- Zero impact on consumers using `HashRouter` / `PathRouter` — all four variants of `RouterOption` are additive; `false` (no router) and `true` (hash alias) preserved.
- Architecture note: `nav-encoding.ts`'s file-header JSDoc already mentioned "future QueryRouter or SearchParamsRouter" — this ship is the anticipated extension, with a more SEO-friendly serialization than the original "shared fragment encoding" sketch implied.

## `@airo-js/core` 0.8.3 — 2026-05-25

`App.hydratePage(pageId)` — close the chunked-SSR cold-hydrate race without wiping the SSR DOM. Plus two follow-ups from the commerce yalc smoke: `hydrateEntry` idempotency bug fix + `renderer:missing` log-level demotion when a subscriber is wired.

### Added
- `App.hydratePage(pageId: PageId)` — re-runs the SSR-hydrate path for `pageId` against the DOM already in `host`. Public-surface pass-through to `PageManager.hydrateEntry`. Intended pairing: catch `'renderer:missing'` with `phase: 'hydrate'`, wait for the missing chunk's `pushToMailbox` to land, then call `app.hydratePage(pageId)`. Listeners wire against the existing SSR DOM in place — no `swapRenderer`, no repaint, no flicker. Idempotent + tolerant: no-ops on destroyed app, disabled / missing / gate page; re-emits `'renderer:missing'` if the resolver still has nothing.
- `IEventBus.listenerCount(event: string): number` — subscriber-count introspection on the event bus. Used internally by PageManager to subscriber-gate the `'renderer:missing'` log level; available to consumers that want the same.

### Fixed
- `PageManager.hydrateEntry` is now actually idempotent for an already-hydrated `pageId`. Pre-0.8.3, a second `app.hydratePage(pageId)` for the same already-active page would call `factory()` a second time, build a fresh renderer over the live one, and orphan the previous renderer's listeners + cleanup. Manifested as duplicate DOM / double-fired handlers when consumers had two parallel recovery paths racing on the same chunk-load event. Now: when `activeRenderer && activeRendererPageId === pageId`, hydrateEntry returns immediately. Matches the documented JSDoc promise on `App.hydratePage`.

### Changed
- `'renderer:missing'` log demotes from `warn` to `info` when an `events.listenerCount('renderer:missing') > 0`. When a subscriber IS wired, the missing-factory case is a documented chunked-load recovery (§2.5b) — informational, not alarming. When no subscriber is wired, the log stays at `warn` (real signal: the host hasn't set up recovery). Same payload, same event emission — only the log level shifts. Affects both `hydrateEntry` (`phase: 'hydrate'`) and `swapRenderer` (`phase: 'navigate'`) emission sites.

### Why this exists
- Pre-0.8.3, the only public method that could "re-attempt hydrate after chunk arrival" was `app.navigate({ page })` — but `navigate` routes through `swapRenderer`, which calls `render()` and clobbers the SSR-painted DOM. Chunked-client cartridges (§2.5b) that ship enriched SSR markup were forced into a visible flicker on every cold hydrate, even with the `'renderer:missing'` subscription pattern.
- `hydratePage` is the symmetric primitive: `navigate` is for the CSR repaint path; `hydratePage` is for the SSR-preserve path. Use the one that matches the active page's first-paint origin.
- The two follow-up fixes came out of a production consumer's commerce smoke test against the 0.8.3 candidate. 3× duplicated carousel renderers exposed the idempotency gap; alarming-looking red triangles in DevTools during normal cold-hydrate recovery exposed the over-aggressive log level.

### Notes
- Zero impact on consumers that don't ship chunked SSR. All three changes are additive on the public surface (new method, new interface property, demoted log level — never tighter).
- Docs: `best-practices.md §2.5b` updated with the pre-subscribe + recovery snippet (the `EventBus` you pass via `MountCartridgeOptions.events` is the same instance PageManager emits on — late subscriptions via `result.app.events` miss the phase-5 emission). `§5.1` gains an explicit rule-4: `hydrate()` does NOT reconcile; SSR markup must reflect final visual state.

## `@airo-js/cartridge-kit` 0.8.3 — 2026-05-25

Sync rev for `workspace:^` peerDep coherence with the 0.8.3 line. One small source change: the dummy `IEventBus` fixture in `cartridge-app.ts`'s gate-id resolver gained a `listenerCount()` stub to satisfy the new interface property on `@airo-js/core@0.8.3`. No behaviour change.

## `@airo-js/runtime` 0.8.3 — 2026-05-25

Sync rev for `workspace:^` peerDep coherence with the 0.8.3 line. No source change. `@airo-js/log@0.2.0` added to `devDependencies` for the new test coverage on `setLogLevel` + subscriber-aware `renderer:missing` log demotion (does not affect the runtime's published surface — consumers picking up `@airo-js/runtime@0.8.3` continue to consume `@airo-js/log` transitively through `@airo-js/core`'s peerDep).

## `@airo-js/ssr` 0.8.3 — 2026-05-25

Sync rev for `workspace:^` peerDep coherence with the 0.8.3 line. No source change.

## `@airo-js/embed` 0.8.3 — 2026-05-25

Sync rev for `workspace:^` peerDep coherence with the 0.8.3 line. No source change.

## `@airo-js/log` 0.2.0 — 2026-05-25

Threshold-filter API on top of the existing sink primitive — apps can tighten log noise globally or per-channel without writing custom sink wrappers.

### Added
- `setLogLevel(level: LogLevel | 'silent')` — global threshold. Events below `level` are dropped before reaching the sink.
- `getLogLevel(): LogLevel | 'silent'` — read current threshold.
- `setChannelLevel(channel: LogChannel, level: LogLevel | 'silent')` — per-channel override. Wins over the global for that channel only.
- `getChannelLevel(channel: LogChannel): LogLevel | 'silent' | null` — read per-channel override; `null` means "inherit global."
- `resetLogLevels()` — reset global + clear all per-channel overrides. Tests' `afterEach` seam.

### Why this exists
- Driven by a production consumer's commerce smoke test. Three concrete consumer use cases: silence framework chatter in dev stages, `setLogLevel('warn')` for customer-facing prod consoles, `setLogLevel('silent')` for Lambda@Edge SSR where CloudWatch already owns structured logs. Filing a primitive instead of forcing every consumer to write the same ~20-line filter sink.

### Notes
- Default threshold is `'debug'` — every event flows through. Pre-0.2.0 behaviour preserved for apps that don't call `setLogLevel`.
- Composes with `setSink`: the threshold filter runs *before* the sink. Custom sinks installed via `setSink` keep working — they just see fewer events.
- Skipped the optional `hookupLogLevelFromEnv` helper. YAGNI until a consumer needs it; apps can call `setLogLevel` from their own boot path with whatever env signal they want.

## `@airo-js/cartridge-kit` 0.8.2 — 2026-05-20

Docs-only patch. Renames a terminology collision flagged on the bridge cross-check.

### Changed
- `Cartridge.views` JSDoc — the chunked-browser-bundle pattern is now called the **"chunked-client cartridge pattern"** (was: "two-envelope pattern", which collided with `docs/best-practices.md` §2.5's existing use of "two-envelope" for the `runtime.ts` / `full.ts` build-target split). The two patterns are orthogonal and frequently combined — added cross-link to §2.5b.

### Notes
- Zero contract surface change. `CONTRACT_VERSION` stays at `0.5.0`.

## `@airo-js/core` 0.8.2 — 2026-05-20

Docs-only patch.

### Changed
- `decodeNavHint` JSDoc broadened — previously framed as a "Server-side SSR helper" because of its first use case, but the function is pure URL/string parsing with a mandatory `validPages` allowlist gate and runs cleanly in any environment. JSDoc now documents both the SSR-runner and browser-bootstrap call sites alongside each other (symmetric trust gate is the design intent for SSR-then-hydrate).

## `@airo-js/runtime` 0.8.2 — 2026-05-20

Sync rev for `workspace:^` peerDep coherence with the 0.8.2 line. No source change.

## `@airo-js/ssr` 0.8.2 — 2026-05-20

Sync rev for `workspace:^` peerDep coherence with the 0.8.2 line. No source change.

## `@airo-js/embed` 0.8.2 — 2026-05-20

Sync rev for `workspace:^` peerDep coherence with the 0.8.2 line. No source change.

### Docs (not a package, but landed in this commit)
- `docs/best-practices.md` adds **§2.5b — Chunked-client cartridge for per-page browser splitting**, the canonical write-up the JSDoc on `Cartridge.views` cross-links into. Clarifies that the chunked-client pattern (factory-resolution axis) is orthogonal to §2.5's two-envelope pattern (build-target axis), and that a real cartridge often does both: `runtime.ts` carries the chunked-client cartridge (`views: []`); `full.ts` swaps in the full views list plus server-only publication adapters + MCP tools. Includes the placeholder-factory anti-pattern, server-only `capabilities`, multi-version-on-same-page semantics, and the `'renderer:missing'` event integration.

## `@airo-js/core` 0.8.1 — 2026-05-20

`'renderer:missing'` event — observability for lazy-loaded page chunks.

### Added
- `PageManager` emits `'renderer:missing'` on the App event bus when `resolveRenderer(pageType)` returns `undefined` and the framework soft-fails the paint. Fires on both the CSR `navigate` path and the SSR-hydrate path. Payload: `{ pageType: string; pageId: string; phase: 'navigate' | 'hydrate' }`.
- Studios that lazy-load page chunks subscribe to this event to render a skeleton / spinner while the chunk fetch is in flight, then re-navigate to the page once `pushToMailbox` registers the factory. Replaces the previous workaround of monkey-patching the warn-log line. Documented in the `PageManager` JSDoc alongside the existing `'navigation:changed'` event.

### Notes
- Event fires once per missing-resolve attempt; PageManager does NOT retry on its own. Subscribers re-navigate or invoke `app.navigate(state)` after their chunk-load callback resolves to drive the next attempt.

## `@airo-js/cartridge-kit` 0.8.1 — 2026-05-20

JSDoc clarifications on the two-envelope chunking pattern.

### Changed
- `Cartridge.views` JSDoc — documents both shapes: monolithic (`views: [...]` with factories) and chunked browser bundles (`views: []`, factories arrive via `pushToMailbox` from each page chunk; server cartridge keeps the full views list). Warns against shipping placeholder factories — the resolver checks `views[]` first and a placeholder permanently blocks the mailbox path for that `pageType`.
- `Cartridge.mailboxName` JSDoc — documents the mailbox-identity contract: mailbox identity = cartridge identity, not patch version. Patch versions of the same cartridge are assumed interchangeable (semver patch). If two majors must coexist on the same page, declare them as separate cartridges with different `id` and `mailboxName`.

### Notes
- Pure documentation patch — no surface change. `CONTRACT_VERSION` stays at `0.5.0`.

## `@airo-js/runtime` 0.8.1 — 2026-05-20

Sync rev for `workspace:^` peerDep coherence with the 0.8.1 line. No source change. The new `'renderer:missing'` event is observable through `mountCartridge` opts.events when consumers supply their own EventBus.

## `@airo-js/ssr` 0.8.1 — 2026-05-20

Sync rev for `workspace:^` peerDep coherence with the 0.8.1 line. No source change.

## `@airo-js/embed` 0.8.1 — 2026-05-20

Sync rev for `workspace:^` peerDep coherence with the 0.8.1 line. No source change.

## `@airo-js/cartridge-kit` 0.8.0 — 2026-05-18

Rich `TemplatePage` round-trip + `cartridge.pageHotSwapKeys` for live page-graph deltas. Closes the contract gap reported on the bridge: pre-0.8 `templateToAppConfig` dropped `componentSettings` / `styles` / `props` / `layout` on the floor, so `resolveComponentProp` had no path to honour per-page overrides — half-built feature.

### Added
- `TemplatePage` widened with optional `layout` / `props` / `styles` / `componentSettings` carriers. The four structural fields (`id` / `type` / `enabled` / `parent`) are still required; the new fields round-trip through `templateToAppConfig` onto `AppConfig.pages[]` when present. Hosts driving a Component-panel editor (per-page prop / visibility / style overrides) now thread the overrides through `template.pages[i].componentSettings` and the runtime sees them on `ctx.page`.
- `TemplatePage<TPageType extends string = string>` is now generic so cartridges that narrow page types keep the narrowing through `template.pages[]` → `AppConfig.pages[]`. Defaults to `string` — existing references continue to resolve.
- `Template<TConfig, TPageType extends string = string>` widens its second generic parameter for the same reason. `Template<TConfig>` continues to resolve.
- `Cartridge.pageHotSwapKeys?: Array<'componentSettings' | 'styles' | 'props' | 'layout' | (string & {})>` — per-page hot-swap allowlist. Same prefix-match semantics as the existing `hotSwapKeys` (which is scoped to cartridge config). `MountCartridgeResult.updatePages()` from `@airo-js/runtime` classifies the per-page diff against this list; covered diffs hot-swap, uncovered diffs (and any structural page-graph change) remount with NavigationState preserved.

### Changed
- `templateToAppConfig` round-trips all rich fields; `layout` falls back to `{ regionOrder: [], regions: {} }` when omitted, matching pre-0.8 behaviour for cartridges that paint via `RenderContext.targetEl` directly.
- `CONTRACT_VERSION` bumped to `0.5.0` — consumers can train on the constant; helper additions and internal refactors don't bump it, but this widens the cartridge envelope (new `pageHotSwapKeys`) and TemplatePage shape.

### Notes
- Backward-compatible: cartridges that only set the four structural `TemplatePage` fields still produce the same empty-layout `AppConfig.pages[]` they did pre-0.8. Add the rich fields opportunistically when you want per-page state to reach `ctx.page`.

## `@airo-js/core` 0.8.0 — 2026-05-18

`App.replacePages` / `PageManager.replacePages` — page-graph hot-swap primitive.

### Added
- `App.replacePages(newPages: unknown[]): void` — replaces the active page graph and re-renders the active page in place. Type-erased at the App surface (TPageType is generic at the PageManager layer); the cartridge runtime narrows on the way in when delivering `MountCartridgeResult.updatePages()`.
- `PageManager.replacePages(newPages: Page<TPageType>[]): void` — drives the hot-swap. Replaces (does not merge), looks up the active page by id, destroys + re-instantiates the active renderer with a fresh `RenderContext` reflecting the new `page` + `pages`. NavigationState preserved; no `navigation:changed` emission and no router push (cosmetic delta, not a navigation event).

### Changed
- `PageManager` introduces a private `pages` field initialised from `opts.pages`. `replacePages` reassigns this; every read site that previously walked `this.opts.pages` now reads `this.pages` so `ctx.pages` follows the swap.
- `RenderContext.pages` JSDoc updated: the reference is stable across `update(delta)` hot-swap (snapshot reuse path) but DOES change after a successful `updatePages()` call. Renderers that cache `ctx.pages` across renders won't see post-`updatePages` graphs — read on each render.

### Notes
- Sync rev for `workspace:^` peerDep coherence across the 0.8.0 line.

## `@airo-js/runtime` 0.8.0 — 2026-05-18

`MountCartridgeResult.updatePages()` — live page-graph dispatcher.

### Added
- `updatePages(nextPages: ReadonlyArray<TemplatePage<TPageType>>): Promise<UpdateResult>` on the unblocked `MountCartridgeResult` branch. Replaces `AppConfig.pages` with `nextPages` and classifies the per-page diff against `cartridge.pageHotSwapKeys`. Covered diff → hot-swap (re-render the active page in place with new `ctx.page` / `ctx.pages`, snapshot reused). Uncovered diff OR any structural change (added / removed / reordered pages, changed `id` / `type` / `enabled` / `parent`) → remount with NavigationState preserved.
- `pagesDiffIsCoveredByHotSwap(current, next, allowed)` + `diffLeafPaths(a, b, prefix?, skipKeys?)` exported for tests. Module-internal otherwise.

### Changed
- `MountCartridgeResult<TConfig, TPageType extends string = string>` is now generic over `TPageType` so `updatePages` can carry the narrowed type. Existing `MountCartridgeResult<TConfig>` references resolve unchanged via the default.
- `widgetId` is captured once at the top of `mountCartridge` and reused on every `doMountInner` call — eliminates the latent footgun where a no-`widgetId` mount would generate a fresh `Date.now()` appId on every remount.
- `currentPages` mirrors the live page graph; `doMountInner` builds `AppConfig` from it on remount paths, so an `updatePages()` remount carries the new graph and the entry-page resolution uses it.

### Notes
- `update(delta)` and `updatePages(nextPages)` are independent channels — cartridge config delta vs page-graph delta. Studios that change BOTH should call both methods.
- Backward-compatible: existing `update(delta)` callers continue to work unchanged.

## `@airo-js/ssr` 0.8.0 — 2026-05-18

Sync rev for `workspace:^` peerDep coherence with the 0.8.0 line. No source change — `renderAppWithPublication` and `renderAppToHTML` already consume `templateToAppConfig` from `@airo-js/cartridge-kit`, so the rich-field round-trip on the SSR path comes free.

## `@airo-js/embed` 0.8.0 — 2026-05-18

`el.updatePages(nextPages)` — page-graph delta forwarded to the runtime.

### Added
- `updatePages(nextPages: ReadonlyArray<TemplatePage>)` method on the `<airo-app>` element class. Forwards to the runtime's `MountCartridgeResult.updatePages()` when the element is mounted and not gate-blocked. Resolves with `{ mode, navState }` reporting whether the runtime hot-swapped or remounted; resolves with `null` for never-mounted / gate-blocked / disconnected elements (symmetric with `el.update()`).

### Changed
- `LoadConfigResult.templatePages` JSDoc updated: post-mount page-graph changes now go through `el.updatePages()`, which hot-swaps when the diff is covered by `cartridge.pageHotSwapKeys`. The two delta channels (`update` for cartridge config, `updatePages` for page graph) are independent.

## `@airo-js/embed` 0.7.3 — 2026-05-18

Per-widget page graph override + reconnect-bug fix.

### Added
- `LoadConfigResult.templatePages?: ReadonlyArray<TemplatePage>` — host-supplied page graph override that replaces the cartridge template's static pages for this mount only. Closes [msg_mpbhrhex_f07dda](https://github.com/airo-studio/airo-js — bridge thread). Use case: hosts that let customers customize the page graph (add / remove / reorder / enable / disable pages) persist those edits per-widget. Without this hook, SSR painted against the actual graph (server-side override) and client hydrate ran against the cartridge default — DOM mismatch → dead clicks.

### Changed
- Field name is `templatePages`, NOT `pages` (per Codex review: avoids collision with `loaded.config.pages` which lives at the cartridge-config layer).
- `TemplatePage` shape is re-exported from `@airo-js/cartridge-kit` rather than duplicated inline in embed — prevents silent cross-package drift when the template page shape grows.
- Page entries are deep-cloned when building the effective template (`{ ...p }` per entry). Host mutation of the array entries after `loadConfig` resolves cannot corrupt the runtime's view of the template, which closes over `opts.template` for remount paths.
- **Host validation responsibility** is documented on the JSDoc: no duplicate ids, no orphan subpages, at least one enabled non-subpage page, types matching registered `ViewDefinition.pageType`. The framework only catches missing-entry-page; everything else surfaces as navigation bugs at click time. Embed deliberately does not re-walk the graph the host just composed.

### Fixed
- `connectedCallback` now resets `this.disposed = false` at the top, allowing an element to be removed from DOM and reinserted (browser re-connection scenarios). Without the reset, the prior `disconnectedCallback()` latch left disposed=true forever and every post-async-phase check short-circuited silently — the element appeared mounted in DOM but no renderer was wired. Bonus fix surfaced during the Codex review of the 0.7.3 diff.

## `@airo-js/cartridge-kit` 0.7.3 — 2026-05-18

Shared component-resolution helpers + `TemplatePage` named export + JSDoc examples for category/FieldType extensions.

### Added
- `TemplatePage` interface — named export of the shape that `Template.pages` carries. Used by `@airo-js/embed`'s `LoadConfigResult.templatePages` to keep cross-package wire shape consistent without inline duplication.
- `resolveComponentProp(page, componentId, propKey, schema?)` — joins the three component-state layers (`page.componentSettings.props`, `Slot.props`, `ComponentSchema.props[k].default`) per the canonical precedence rule, returns the effective value. Pure; no DOM, no async, no consumer-specific logic.
- `resolveComponentVisibility(page, componentId)` — joins `page.componentSettings.visible`, `Slot.visible`, default `true` per the same precedence rule. Pure.

### Changed
- `Template.pages` is now typed as `TemplatePage[]` (was inline literal). Backward-compatible — structural shape is identical.
- `PropSchema.category` JSDoc adds `'data-binding'` as an example value alongside the existing `'behaviour' / 'layout' / 'style' / 'advanced'`. Explicitly NOT a blessed canonical enum — open string by design; studios are free to bucket however they want. Closes [msg_mpbhshsx_aacb20](https://github.com/airo-studio/airo-js Q1 question on the bridge).
- `FieldType` JSDoc expanded: `'attribute'`, `'reference'`, `'image'` documented as common cartridge-side extensions, NOT promoted to the core union. Per Codex review: promoting `'attribute'` to core would commit every downstream studio to rendering feed-attribute UI; that's a data-source semantics decision, not a UI-input-type decision. Cartridges keep using the `(string & {})` extension path. Closes Q2.

### Notes
- The component resolvers are scoped to **framework-defined precedence on framework-owned schema** (`Slot`, `Page.componentSettings`, `ComponentSchema`). Cartridge-specific computed logic (e.g., "show this prop only if the parent flag is on") stays in consumer code that wraps the resolved value. The helpers prevent two-place drift between the runtime renderer and the studio panel — both can now call the same precedence rule rather than each implementing it.

## `@airo-js/core` 0.7.3 — 2026-05-18

Sync rev for the 0.7.3 line. No API changes. The `Slot` / `Page.componentSettings` / `ComponentSchema` schema layers consumed by `@airo-js/cartridge-kit`'s new resolvers are unchanged from 0.7.2.

## `@airo-js/runtime` 0.7.3 — 2026-05-18

Sync rev for the 0.7.3 line. No API changes.

## `@airo-js/ssr` 0.7.3 — 2026-05-18

Sync rev for the 0.7.3 line. No API changes.

## `@airo-js/core` 0.7.2 — 2026-05-18

`RenderContext.pages` — renderer-readable page graph. Closes [msg_mpbfwheu_350d52](https://github.com/airo-studio/airo-js — the bridge thread that surfaced this gap during a production studio's commerce breadcrumb-component work).

### Added
- `RenderContext.pages: ReadonlyArray<Page<TPageType>>` — required field on every `RenderContext`. PageManager populates from its `opts.pages` (originally `AppConfig.pages`). Renderers reach the full page graph without re-deriving from `template.pages` via host-side `WeakMap`-on-event-bus workaround patterns. Use with the existing `buildCrumbs(pages, activePageId, navState)` helper.

### Changed
- `RenderContext` type widens by one required field. Existing renderers that don't reference `ctx.pages` keep working — they just have one more field available. Code outside the framework that constructs `RenderContext` manually (uncommon — only PageManager and the SSR renderer do this in-tree) needs to add `pages: appConfig.pages` to the literal.

### Notes
- Pages array reference is stable across hot-swap (PageManager's `opts.pages` doesn't change inside `update()`). A remount path technically carries the same reference too — `mountCartridge` doesn't swap templates inside `update()`. Tested in `packages/runtime/test/render-context-pages.test.ts`.
- Layering: this is framework state, not cartridge data — so it lives on bare `RenderContext`, not on `CartridgeAppContext`. Consistent with `ctx.page` (active page) and `ctx.navState` (current nav).

## `@airo-js/cartridge-kit` 0.7.2 — 2026-05-18

Sync rev for `workspace:^` peerDep coherence. No API changes — cartridge-kit re-exports `Page` from core, and `CartridgeRenderContext` inherits the new `pages` field via its `Omit<RenderContext, 'update'>` base.

## `@airo-js/runtime` 0.7.2 — 2026-05-18

Sync rev for the 0.7.2 line. No runtime change — `RenderContext.pages` is populated by `@airo-js/core`'s `PageManager` which runtime already delegates to via `createCartridgeApp`.

## `@airo-js/embed` 0.7.2 — 2026-05-18

Sync rev for `workspace:^` peerDep coherence with the 0.7.2 line. No API change.

## `@airo-js/ssr` 0.7.2 — 2026-05-18

Sync rev for the 0.7.2 line. `renderAppToHTML` now populates `RenderContext.pages` from `appConfig.pages` so SSR-rendered cartridges have access to the same page graph as client-side mounts.

### Changed
- `packages/ssr/src/render-app.ts` — adds `pages: config.pages` to the RenderContext literal at the renderer.renderSSR() / renderer.render() call site. Required to typecheck against the 0.7.2 `RenderContext` shape.

## `@airo-js/core` 0.7.1 — 2026-05-14

Renderer-callable update seam. `RenderContext` exposes `update`, so renderers can fire `MountCartridgeResult.update()` deltas from inside listener handlers without holding the host's mount handle. Closes [msg_mp58z77m_65d9ed](https://github.com/airo-studio/airo-js — the bridge thread that surfaced this gap during a production studio's D5 planning).

### Added
- `RenderContext.update?: (delta: Record<string, unknown>) => Promise<UpdateResult>` — optional field on every `RenderContext`. When the App is mounted via `mountCartridge` from `@airo-js/runtime`, the framework wires this to the host's `MountCartridgeResult.update()` closure on every mount. Raw `createApp` callers without a cartridge runtime can leave it `undefined` and renderers fall through their `?.()` guard.
- `UpdateResult` type — moved from `@airo-js/runtime` into core so `RenderContext.update`'s return type can be expressed without core depending on runtime. Re-exported from `@airo-js/runtime` for back-compat; existing imports unchanged.
- `AppDeps.hostUpdate?: ...` — wires the dispatcher through `createApp` → `PageManager` → `RenderContext`. Cartridge runtimes pass it; non-cartridge `createApp` callers omit.

### Notes
- Delta type at the core layer is `Record<string, unknown>` because `RenderContext` is generic over `TAppContext` but not over the cartridge's `TConfig`. Cartridge authors narrow via `CartridgeRenderContext` from `@airo-js/cartridge-kit` (see below).
- Existing renderers that don't reference `ctx.update` continue to work — the field is optional and additive.

## `@airo-js/cartridge-kit` 0.7.1 — 2026-05-14

Two type-utilities to make `update(delta)` ergonomic for cartridge authors.

### Added
- `DeepPartial<T>` — recursive partial type. Used as the delta type for `MountCartridgeResult.update()` and the typed `CartridgeRenderContext.update`, matching the runtime contract that already walked nested deltas via `leafPaths()`. Closes [msg_mp4hrxlk_954a8b](https://github.com/airo-studio/airo-js).
- `CartridgeRenderContext<TPageType, TData, TConfig>` — strongly-typed `RenderContext` for cartridge renderers. Extends `RenderContext<TPageType, CartridgeAppContext<TData, TConfig>>` with two narrowings: `app` is the typed cartridge envelope, and `update` accepts `DeepPartial<TConfig>` instead of `Record<string, unknown>`. Use this type in your renderer factories to get compile-time delta-shape checking on `ctx.update?.()` calls.

### Notes
- The core `RenderContext` stays generic. `CartridgeRenderContext` is an ergonomic extension cartridge-kit ships; both reference the same runtime function — no behavioral difference between them.

## `@airo-js/runtime` 0.7.1 — 2026-05-14

Widens `update(delta)` to `DeepPartial<TConfig>` (was shallow `Partial<TConfig>`), aligning the static type with the runtime contract. Wires `hostUpdate` through to `createCartridgeApp` so renderers receive `ctx.update`.

### Changed
- `MountCartridgeResult<TConfig>.update(delta)` parameter type: `Partial<TConfig>` → `DeepPartial<TConfig>` (from `@airo-js/cartridge-kit`). Backward-compatible — every shallow partial is a deep partial. Removes the cast that a production studio's Wave 0 smoke had to use.
- `UpdateResult` is now re-exported from `@airo-js/core` (the canonical home). Existing `import { UpdateResult } from '@airo-js/runtime'` keeps working unchanged.
- `mountCartridge` restructured to define the `update` closure before `doMountInner` runs, so `hostUpdate` (a type-erased wrapper around `update`) can be passed through `createCartridgeApp` → `createApp` → `PageManager`. State vars (`currentApp`, `currentSnapshot`, `currentConfig`) declared up-front; defensive guard in `update` throws if called before initial mount completes (impossible from a renderer in practice — renderers run after mount).

### Notes
- The `hostUpdate` wrapper casts `Record<string, unknown>` → `DeepPartial<TConfig>` at the boundary. Runtime walks the delta via `leafPaths` regardless of static type, so the cast is sound; cartridge-side type safety lives on `CartridgeRenderContext`.

## `@airo-js/embed` 0.7.1 — 2026-05-14

No public API changes. Sync rev for `workspace:^` peerDep coherence with the 0.7.1 line.

### Notes
- `el.update(delta: unknown)` stays type-erased at the embed boundary because attribute-driven mounts can't express `TConfig` at compile time. The 0.7.1 `DeepPartial<TConfig>` widening on the runtime side flows through structurally.

## `@airo-js/ssr` 0.7.1 — 2026-05-14

No API changes. Sync rev for `workspace:^` peerDep coherence with the 0.7.1 line.

## `@airo-js/runtime` 0.7.0 — 2026-05-13

Live config deltas + the cartridge test-harness. Closes the framework gap on a production studio team's tech-debt punch list (their D4 / D5 / D12 unblock with this rev).

### Added
- `MountCartridgeResult.update(delta: Partial<TConfig>): Promise<UpdateResult>` — live config delta dispatcher. Reads `cartridge.hotSwapKeys` (dot-path aware) to classify each path: covered paths hot-swap in place (existing snapshot reused, active page renderer torn down + re-rendered with fresh `ctx.app`), uncovered paths trigger a full remount with `NavigationState` preserved across the destroy/recreate. Studio chrome uses this to retire its own structural-fields lifecycle policy.
- `UpdateResult` — `{ mode: 'hot-swap' | 'remount'; navState: NavigationState }`. Lets studios decide whether to re-emit telemetry / scroll / refire preview-side effects per dispatch path.
- `@airo-js/runtime/test-harness` submodule — `mountCartridgeInMemory({ cartridge, config, fixtureFeed })` returns `{ dom, pipelineSnapshot, cleanup }`. Re-exports ONLY the harness types + function; the structural M13 boundary is the export surface, not magic. Cartridge authors write `cartridge.test.ts` that imports from `@airo-js/runtime/test-harness` + their own cartridge module and cannot transitively pull in studio shell types.
- `MountCartridgeOptions.registry?: CartridgeRegistry` — opt-in shared registry for multi-cartridge studios. When provided, renderer resolution goes through `registry.resolverFor(cartridge.id)`. When absent, the lazy WeakMap-memoised single-cartridge default runs unchanged.
- `MountCartridgeOptions.onPipelineComplete?: (snapshot) => void` — fires after the pipeline phase succeeds. Primarily test-harness facing; documented as harmless to use elsewhere.

### Changed
- `MountCartridgeResult` is now generic over `TConfig` (`MountCartridgeResult<TConfig = unknown>`). The default keeps existing call sites typing unchanged; consumers that pass `TConfig` get `Partial<TConfig>` typing on `update(delta)`.
- `MountCartridgeResult.app` is now a getter — always reflects the live `App` instance, including after a remount path runs inside `update()`. Destructuring (`const { app } = result`) still captures the value at destructure time and IS subject to the staleness footgun; documented on the type.
- Pipeline phase awaits transformer chain (transformers may return `Promise<TData>` — see `@airo-js/core` 0.7.0 + `@airo-js/cartridge-kit` 0.7.0).

### Notes
- Remount re-runs transformers — declared as the v0 cost on hot-swap-vs-remount classification. `// TODO 0.8` annotation in `mount-cartridge.ts` marks the optimization site (skip transformer re-run when only post-pipeline config fields changed).
- Test-harness defaults to `styleIsolation: 'light'` so `result.dom` is observable directly without shadow-root traversal. Pass `'shadow'` to test shadow-DOM-specific behaviour.

## `@airo-js/cartridge-kit` 0.7.0 — 2026-05-13

Cartridges declare hot-swap surface via `hotSwapKeys`; transformers may now be async.

### Added
- `Cartridge.hotSwapKeys?: Array<keyof TConfig | (string & {})>` — config paths that can hot-swap (re-render the active page in place without remount) when delivered via `MountCartridgeResult.update()`. Supports both top-level keys and dot-paths into nested config (`['theme', 'display.showPrices']`). Prefix-match semantics: a top-level key like `'display'` covers all of `display.*`; a dot-path like `'display.showPrices'` matches only that exact leaf. Cosmetic flags belong here; anything that affects what transformers produce should be omitted so the runtime triggers a remount + transformer re-run.
- `CartridgeAppDeps.registry?: CartridgeRegistry` — long-lived shared registry. When provided, `createCartridgeApp` derives the resolver via `registry.resolverFor(cartridge.id)`. Caller is responsible for `registry.register(cartridge)` before mount. Renderer resolution precedence: explicit `resolveRenderer` > `registry` > lazy WeakMap-memoised default.

### Changed
- `Transformer.transform` return type widened from `TData` to `TData | Promise<TData>`. Sync transformers keep working unchanged; async transformers (auth-token verification, lazy enrichment, IO-bound transforms) are now first-class. The pipeline awaits uniformly.
- `RuntimePipeline.runTransformers` return type widened to `Promise<TData>` (was `TData`). All callers must `await`. One in-tree caller (`@airo-js/runtime`'s `mountCartridge`) updated in this rev.

### Notes
- The `(string & {})` intersection on `hotSwapKeys` preserves keyof-autocomplete on top-level `TConfig` keys while leaving the type open for dot-path strings. A future `Paths<TConfig>` template-literal type can tighten compile-time path validation without breaking the surface.
- Removed the long-standing "Sync only at v0; async deferred to v0.3" note from the `Transformer` JSDoc.

## `@airo-js/core` 0.7.0 — 2026-05-13

App-level live appContext swap + the `SubpageActivation.page` type extension.

### Added
- `App.replaceAppContext(newAppContext: unknown): void` on the public `App` interface — replaces the opaque appContext bag and re-renders the active page with a fresh `RenderContext`. Type-erased on the public handle (TAppContext is opaque there); the cartridge runtime casts on the way in when delivering `MountCartridgeResult.update()`'s hot-swap path.
- `PageManager.replaceAppContext(newAppContext: TAppContext): void` — backing implementation. Destroys + re-instantiates the active page renderer with a fresh `RenderContext`. NavigationState preserved (no URL push, no `navigation:changed` emission — this is a config delta, not a navigation event). No-op when destroyed, no active page mounted, or the active page id no longer resolves.
- `SubpageActivation<TPageType>.page?: Page<TPageType>` — full `Page<T>` for the subpage. PageManager populates this when dispatching a subpage activation so parent renderers can apply page-config styles + componentSettings without re-walking the page graph. Resolves "Finding 3" from CLAUDE.md §3.

### Changed
- `SubpageActivation`'s index signature value type widens to `string | undefined | Page<TPageType>` to accommodate the new typed `page` field while preserving the legacy spread-of-navContext pattern. Consumers indexing by a navContext-shaped string key receive the union and should narrow via `typeof v === 'string'`.
- `Transformer.transform` return type widened to `TData | Promise<TData>`. Pipeline impl (`RuntimePipelineImpl.runTransformers`) is now async and awaits each transformer's result; both the fast-path and traced-path branches updated. Applies identically to sync throws and rejected promises under `errorPolicy: 'skip'`.

## `@airo-js/embed` 0.7.0 — 2026-05-13

Custom-element imperative `update(delta)` for live config deltas.

### Added
- `AiroAppElement.update(delta): Promise<{ mode; navState } | null>` — forwards to the runtime's `MountCartridgeResult.update()` when the element is mounted and not gate-blocked. Resolves with `null` when called against a never-mounted, gate-blocked, or already-disconnected element. Symmetric with the runtime's "no update on blocked" contract; callers can branch on null without try/catch.

### Notes
- The `MountHandle` interface (internal mirror of the destroy-only subset of `MountCartridgeResult`) widened to include `update?` so the custom-element path can forward. Type-erased at the embed boundary because attribute-driven mounts can't express `TConfig` at compile time; the runtime's `update(delta: Partial<TConfig>)` remains correctly typed for direct `mountCartridge` callers.

## `@airo-js/ssr` 0.7.0 — 2026-05-13

Sync-only rev — no API changes. Bumped so the `workspace:^` peerDeps on `@airo-js/core` + `@airo-js/cartridge-kit` resolve to `^0.7.0` in published tarballs and consumers can install the 0.7.0 line coherently.

### Notes
- The `RuntimePipeline.runTransformers` return-type change in `@airo-js/core` 0.7.0 is API-widening only (no current ssr caller); the SSR adapter pipeline path is unaffected.

## `@airo-js/embed` 0.1.0 — 2026-05-09

First public release. Replaces the v0.0.0 placeholder.

Customer-facing browser bootstrap loader. Ships ahead of demand to prevent the runtime mistake from repeating: every host app that needs production cartridge embed would otherwise inline ~250-540 LOC of generic plumbing (custom-element registration, lifecycle, runtime lazy-load, SSR-hydrate wiring). This package owns that plumbing; host apps extend via hooks (`loadConfig`, `resolveCartridge`, `fetchSsrHtml`, `onError`, `onMounted`).

### Added
- `defineAiroApp(opts)` — register a custom element that mounts a cartridge on `connectedCallback` and tears down on `disconnectedCallback`
- `DefineAiroAppOptions` — required: `loadConfig`, `resolveCartridge`. Optional: `elementName`, `idAttribute`, `tokenAttribute`, `fetchSsrHtml`, `onError`, `onMounted`
- `LoadConfigResult<TConfig>` — what `loadConfig` returns: `config`, `cartridgeId`, `templateId`, `styleIsolation`, `runtimeBase`, `runtimeVersion`, `ssrHtml`, `preloadedData`
- `EmbedPhase` — phase identifier for `onError`: `'load-config' | 'resolve-cartridge' | 'fetch-ssr' | 'mount'`
- Bundle-size CI gate (`pnpm size:check`): minified ≤ 5 KB, gzip ≤ 2.5 KB. Current: 2.51 KB / 1.14 KB.

### Notes
- `@airo-js/runtime ^0.2` is a **peer** dep — loaded dynamically on first element mount, not bundled. Customer pages with N widgets pay the runtime cost once. Pages with no widget elements never pay it.
- SSR-hydrate path: when `loadConfig` returns `ssrHtml` (or `fetchSsrHtml` does), embed paints the markup AND passes `mode: 'hydrate'` to `mountCartridge`. Cartridges intending to ship to SSR pages should implement `hydrate()` on every view.
- Idempotent registration — a second `defineAiroApp` call with the same `elementName` warns and no-ops; different names can coexist (e.g. `<shop-app>` v1 alongside `<airo-app>` cartridge during a transition).

## `@airo-js/runtime` 0.2.0 — 2026-05-09

Adds the SSR-hydrate fork. Additive minor — every v0.1 call site keeps working unchanged.

### Added
- `MountCartridgeOptions.mode: 'csr' | 'hydrate'` — when `'hydrate'`, the runtime preserves DOM already in `host` (moves it inside the shadow wrapper for `'partial'` / `'full'` isolation) and the active page renderer's `hydrate()` runs in place of `render()`. Renderers without `hydrate()` fall back to `render()` with a `[@airo-js/core]` warning.

### Notes
- `mode` defaults to `'csr'` — v0.1 behaviour is preserved verbatim. No code changes required for existing callers.
- The runtime's hydrate path delegates to `@airo-js/core`'s `pageManager.hydrateEntry` (already shipped); this release wires the fork into the cartridge mount surface.

## `@airo-js/runtime` 0.1.0 — 2026-05-09

First public release. Replaces the v0.0.0 placeholder (which exported only a `PACKAGE_NAME` constant).

Cartridge mount orchestration: every host app that runs a cartridge would otherwise inline ~75 LOC of phase-by-phase plumbing (shell setup → fetch → pipeline → mount). This package ships that plumbing as a single call and exposes studio-specific extensions via hooks.

### Added
- `mountCartridge(opts)` — single-call orchestration: shell setup → optional `dataSource.fetch` (or `preloadedData` shortcut) → transformer pipeline → mount via `createCartridgeApp` (which handles gates internally) → unified `destroy()`
- `MountCartridgeOptions<TData, TConfig>` — required: `cartridge`, `config`, `template`, `host`. Optional: `styleIsolation`, `widgetId`, `enableRouter`, `preloadedData`, `dataSourceId`, `dataSourceInput`, `credentials`, `gateScope`, `events`, `onShellReady`, `onError`
- `MountCartridgeResult` — discriminated union: `{ blocked: false, app, shell, destroy }` or `{ blocked: true, blockedBy, shell, destroy }`
- `ShellHandle` — passed to `onShellReady`: `renderRoot`, `styleRoot`, `events`, `rootId`
- `MountPhase` — phase identifier passed to `onError`: `'shell' | 'gate' | 'fetch' | 'pipeline' | 'mount'`

### Deferred (signature-compatible — additive in v0.2)
- Per-page chunk loading + `chunkBase` URL prefix
- SSR-hydrate fork (`mode: 'csr' | 'hydrate'`)
- Live `update(opts)` for studio chrome (theme + config deltas without re-mount)
- async `onShellReady`

## `@airo-js/cartridge-kit` 0.2.0-rc.4 — 2026-05-07

First public release candidate. The cartridge contract is the highest-stakes API surface; expect refinement based on feedback before `1.0`. Cartridges should target `^0.2`.

### Added
- `Cartridge<TData, TConfig>` envelope + `CartridgeRegistry` discovery
- `DataSource<TData, TConfig>` — schema-agnostic data loaders with discriminated `onboardingShape`
- `Transformer<TData, TConfig>` + `PostProcessor` (re-exported from `@airo-js/core`)
- `ViewDefinition<TData, TConfig>` + `CartridgeAppContext<TData, TConfig>`
- `Template<TConfig>` — pre-composed view-set + default config bundle
- `McpToolDefinition<TData, TConfig>` — agent-facing tools, post-Transformer data
- `PublicationAdapter<TData, TOutput, TConfig>` — fan post-pipeline data to surface-specific outputs (Schema.org JSON-LD, vendor XML, etc.); coverage gating + validation as a hard gate
- `Gate<TConfig>` — pre-render guards (age verification, geo, auth, paywall, cookie consent); first-blocking-gate short-circuits and the framework refuses to mount any view
- `createCartridgeApp(cartridge, config, snapshot, cartridgeConfig, deps)` — cartridge-aware wrapper around `createApp` that runs gates first, then mounts views with the typed `CartridgeAppContext`
- `createCartridgeRegistry(cartridges)` — registry with two resolution paths (static `views[]`, then per-cartridge chunk mailbox via `cartridge.mailboxName`)
- `runGates({ gates, host, ctx })` — gate executor with sequential precheck/mount semantics

### Changed (breaking)
- `PublicationAdapter['delivery']`: literal `'studio-decides'` renamed to `'host-decides'` (consistent vendor-neutral vocabulary)
- `PublicationContext`: `customerOverrides` field renamed to `tenantOverrides` (matched the JSDoc which already said "Tenant-side toggles")

### Deprecated
- `JsonLdMapper<TData>` — use `PublicationAdapter` with `format: 'json-ld'`. Kept for one minor version (removed in `0.3`).

## `@airo-js/core` 0.1.0 — 2026-05-07

First public release. Pure rendering primitives — no domain knowledge, no opinions about data shape.

### Added
- App lifecycle: `createApp`, `App`, `AppDeps`
- Page rendering: `PageManager`, `PageRenderer`, `PageRendererFactory`, `RenderContext`
- Schema types: `Page`, `PageLayout`, `Region`, `Slot`, `AppConfig`, `ComponentSettings`
- Navigation: `HashRouter`, `NavigationState`, `Breadcrumb`, `mountBreadcrumb`
- Events: `EventBus`, `IEventBus` (snapshot-semantics observer)
- Style isolation: `IsolationRoot`, `setupIsolationRoot`, `wrapInShadow`, `resolveStyleRoot` — three modes (`none` / `partial` / `full`) for Shadow DOM strategy
- Theming: `Theme` — CSS custom-property injection + `customCSS` escape hatch
- Pipeline orchestration: `Transformer`, `PostProcessor`, `RuntimePipeline`, `RuntimePipelineImpl`, `createPipeline`
- Plugin discovery: `Registry`, `createRegistry`, `pushToMailbox` (stub-queue self-registration for late-loading chunks)

### Deprecated
- `TransformerPipeline<TData, TConfig>` — renamed to `RuntimePipeline` (covers both transformer and post-processor chains). Type alias kept for one minor version.

## `@airo-js/ssr` 0.1.0 — 2026-05-07

First public release. Runtime-agnostic edge SSR — pure functions, no DOM globals required (pass a document from `linkedom` or `deno-dom` server-side).

### Added
- `renderAppToHTML(config, deps)` — pure App → HTML; no listeners attached, no state serialised into output
- `runPublicationAdapters(cartridge, snapshot, ctx, opts?)` — execute a cartridge's `PublicationAdapter`s and return per-adapter results with validation; filterable by `id`, `format`, `delivery`
- `renderAppWithPublication(opts)` — combined SSR + inline JSON-LD output, with `</script>` breakout escaping for snapshot-field XSS safety
