<!-- Design doc for the 0.11.0 line. Reviewed plan (engineering review + outside-model pass, 2026-09-10). Consumer names are anonymised: "the studio consumer" and "the site consumer" are the two downstream teams on the bridge; their message ids are preserved. -->

# Gate reshape for login/OAuth, private pages, and the full-site example — with the two consumer threads folded in

## Verdict

A Gate can carry a login flow that hands off to OAuth, but only once the framework signs one sentence both consumers are asking for: **a Gate decides whether to paint; whether to serve is the host's, per request.** Today's gate architecture contradicts it in two places (gates run after the data fetch and for the whole mount) and has two defects worth fixing before 1.0 freezes them. Both consumers posted on the bridge this morning — the site consumer ([msg_mtvaicmu_ad3aee](bridge)) built a sign-in Gate and never enabled it for exactly this reason; the studio consumer ([msg_mtva69kk_de152d](bridge)) paused its age-gate re-architecture on the same seams. Their asks converge with what the code reading found, and two of them correct my first design (below).

**Decisions taken (routine calls, stated not asked):**
- Private-ness is a **page-graph flag**, `TemplatePage.private?: true` round-tripped onto `Page` (eng review D13, outside voice), not a view capability: both sides already hold the page, so a mailbox-chunked cartridge with `views: []` needs no placeholder and nothing has to fail closed. The consumers quoted the docs' `'requires-auth'` capability; the semantics they asked for are identical, the location is simpler.
- One cartridge, **one template** (four pages, two private) — the shape the site consumer wants (`/me` inside the cartridge) and the shape the example's headline already claims. Gate scoping is therefore **entry-based**, not graph-based (correction #1 to my earlier draft).
- Private pages **can** SSR when the host says so explicitly (correction #2): `renderAppWithPublication` refuses a private entry unless the host passes `renderPrivate: true`, and renders it adapter-free when it does. `scope` stays pure data for views and is never consulted for the decision (eng review D3: a geo-only `scope` must not unlock a private page). The example does both: anonymous → 401 shell + client gate; signed in → server-rendered dashboard, `no-store`, `noindex`.
- The example extends `examples/full-site`; OAuth is authorization-code + PKCE against an in-process demo provider (user `demo` / password `demo`); every byte of auth lives in the Express host.
- Version: the **0.11.0 line**; `CONTRACT_VERSION` 0.9.0 → 0.10.0. **Publishing is separately authorised, not part of this plan.** Bridge responses are posted first, after this plan is approved (outward-facing).

## Context

The framework's thesis is multi-surface output from one snapshot. A members area is the opposite: one signed-in human, never indexed, never cached, never in `llms.txt` or the MCP manifest. The user asked whether the Gate primitive can host a login gate that facilitates OAuth, whether private pages can opt out of JSON-LD / snapshots / cacheability, and for a full-site example with a demo user. Then both consumers filed shaping requests titled "before you reshape Gate for OAuth".

### What the code says today

| Fact | Where |
|---|---|
| Gates are per-mount and see `{ config, events, scope }` — no page, no snapshot; header says gates "apply to ALL pages" | [gate.ts:40-51](packages/cartridge-kit/src/gate.ts#L40-L51), [gate.ts:9-11](packages/cartridge-kit/src/gate.ts#L9-L11) |
| Gates run at Phase 4, **after** `DataSource.fetch` and transformers; an anonymous member mount dies on the API's 401 before the gate paints | [mount-cartridge.ts:817-844](packages/runtime/src/mount-cartridge.ts#L817-L844) → [859-878](packages/runtime/src/mount-cartridge.ts#L859-L878) → [892-929](packages/runtime/src/mount-cartridge.ts#L892-L929) → [cartridge-app.ts:100-125](packages/cartridge-kit/src/cartridge-app.ts#L100-L125) |
| `runGates` returns only `'allow' \| 'block'`; the re-walk that names the blocker is **wrong**: it returns the first no-precheck gate unconditionally and replays prechecks against a stub bus | [run-gates.ts:35-62](packages/cartridge-kit/src/run-gates.ts#L35-L62), [cartridge-app.ts:173-206](packages/cartridge-kit/src/cartridge-app.ts#L173-L206) |
| `MountPhase` declares `'gate'`; nothing emits it | [mount-cartridge.ts:120](packages/runtime/src/mount-cartridge.ts#L120), [930-932](packages/runtime/src/mount-cartridge.ts#L930-L932) |
| Gate docblock says hydrate runs gates before adopting SSR DOM; the code lifts SSR HTML into `renderRoot` first and gates paint into it | [gate.ts:31-35](packages/cartridge-kit/src/gate.ts#L31-L35) vs [mount-cartridge.ts:485-489](packages/runtime/src/mount-cartridge.ts#L485-L489) |
| `capabilities` is a closed union of four; `'csr-only'` skips HTML but still inlines JSON-LD (adapters run first) | [view.ts:43](packages/cartridge-kit/src/view.ts#L43), [render-with-publication.ts:196-255](packages/ssr/src/render-with-publication.ts#L196-L255) |
| `'requires-auth'` is documented three times and exists nowhere; tests aren't typechecked so a fixture already declares it | [best-practices.md:675](docs/best-practices.md#L675), [filter-server-safe-cartridge.ts:28](packages/ssr/src/filter-server-safe-cartridge.ts#L28), [filter-server-safe-cartridge.test.ts:66](packages/ssr/test/filter-server-safe-cartridge.test.ts#L66) |
| `renderAppWithPublication` has no "who is asking" input; `CartridgeAppContext` is `{ cartridgeId, config, data }` | [render-with-publication.ts:60-113](packages/ssr/src/render-with-publication.ts#L60-L113), [view.ts:19-24](packages/cartridge-kit/src/view.ts#L19-L24) |
| A static `views[]` entry shadows the mailbox unconditionally, so a capability-only placeholder breaks chunk resolution (the site consumer A4) | [cartridge-registry.ts:87-96](packages/cartridge-kit/src/cartridge-registry.ts#L87-L96), [108-110](packages/cartridge-kit/src/cartridge-registry.ts#L108-L110) |
| Browser (mailbox-chunked) cartridges ship `views: []` — no capability metadata at gate time | [cartridge.ts:130-134](packages/cartridge-kit/src/cartridge.ts#L130-L134) |
| Cloning the cartridge to strip gates would defeat the WeakMap resolver memo | [cartridge-registry.ts:130-159](packages/cartridge-kit/src/cartridge-registry.ts#L130-L159) |
| `EventBus.emit(event, ...args)`; gates are the one lifecycle with no narration | [events.ts:20](packages/core/src/events.ts#L20) |
| PathRouter listens to `popstate` only — links are full page loads, so the server is the boundary | [path-router.ts:88](packages/core/src/path-router.ts#L88) |
| `full-site` references `/client.js` but never serves it; hydration has never run in a browser | [server.ts:101](examples/full-site/src/server.ts#L101), [:106](examples/full-site/src/server.ts#L106) |
| Prior design ("Gate × deeplink") recommended host-supplied scope to SSR; only the CSR half shipped | [airo-js-initial-nav-state.md:241-303](.claude/plans/airo-js-initial-nav-state.md#L241-L303) |

No login, session, OAuth or `Authorization` header exists in the repo; the only executable Gate is the 15-line always-blocking fixture at [fixtures.ts:148-161](packages/runtime/test/fixtures.ts#L148-L161); `runGates` and `createCartridgeApp` have no direct tests.

### What the consumers said (read in full)

| Ask | the site consumer (site-shaped, authorisation gate) | the studio consumer (studio-shaped, visibility gate) | Answer in this plan |
|---|---|---|---|
| Capability | A1: `requires-auth` that exists — adapters skip, SSR refuses without scope and reports a reason the host maps to 401, entry resolution derived from capability | — | **F1** `TemplatePage.private` (a page-graph flag, D13), all three semantics; the reason rides `skipped`, not `fellBack` (nothing is substituted) |
| Who is asking, on SSR | A2: `scope` on `renderAppWithPublication`, threaded to `CartridgeAppContext`; "client Gate is the UI half, server refusal the authorisation half" | #2: `scope` is input-only, a login gate *establishes* identity; no channel for "allow, and here is the session" | **F2** `renderPrivate` is the who-is-asking slot (D17: no `scope` side channel — identity rides the snapshot the handler builds for a verified session); identity is never a gate output — the session is a host cookie and the data fetch that now follows the gate (**F4**) runs authenticated. The framework remembers nothing across remounts (F11 cut, D19): freshness wins |
| Redirect round trip | keep in-page (SIWE) first-class | #1: `mount` never settles when OAuth leaves the page; nav state must survive | **F7** documented contract: re-entry is `precheck` on the next mount; the return URL is the nav state; no new hook. The example is the redirect case |
| Persist | Pattern B (host owns the cookie) must stay first-class | #4: pass→localStorage, fail→sessionStorage; one key/one scope covers no real gate | **F8** `persist` accepts an array with `outcome`; still metadata; Pattern B untouched |
| No-paint | — | #5: the hide must ship in the initial HTML; SSR needs to know a gate is pending | **F9** runner reports pending gate ids; host emits `data-airo-gate="pending"`; runtime flips it after gates resolve; cartridge CSS hides |
| Bots never gated | — | make it a documented guarantee | **Signed** in docs and gate.ts; the runner never runs gates |
| Chunking | A3: `resolveGate` / mailbox for gates; A4: capabilities without a factory | gate chunk ships on ungated widgets (theirs) | A4 → **F10** (`factory` optional, resolver falls through). A3 deferred: `await import()` in `mount` stays the pattern; **F6** gives the precheck/mount ratio to justify a hook later |
| Narration | A5: `gate:precheck` with decision + started/passed/blocked | same | **F6** four events |
| Config-driven instances / `GateInstance` | — | #3 | **Deferred with direction**: framework owns no gate config schema at 1.0; `Cartridge.gates` stays static; their one-gate-fan-out is blessed; if a second consumer needs instances, `gates` can become `Gate[] \| (config) => Gate[]` additively |
| Block + redirect | — | no channel | the gate calls `location.assign()` and returns `'block'`; documented, no channel needed |
| Cookie consent listed as a gate use case | — | docs correction | done in gate.ts + best-practices |
| OAuth for the MCP endpoint | "not this work" | — | agreed; stated in the response |

## Design

### Two sentences the framework signs

1. **A Gate decides whether to paint; whether to serve is the host's, per request.** The gate is UX. The API and the SSR handler are the security boundary.
2. **Bots are never gated.** SSR never runs gates; server-rendered HTML of a public page is un-gated by guarantee, not by accident. Private pages are the one exception and they are refused, not gated.

### Framework changes for 0.11.0

| # | Change | Packages | ~LOC |
|---|---|---|---|
| F1 | `TemplatePage.private` → `Page.private` page flag (D13); runner refuses / renders on `renderPrivate` | cartridge-kit, core, ssr | 35 |
| F2 | `renderPrivate` is the who-is-asking slot on the SSR path; identity rides the snapshot (D17: no `scope` on SSR, no `CartridgeAppContext.scope`) | ssr | 10 |
| F3 | `Gate.appliesTo: 'private'`, entry-based on `entryPage.private`; `selectGates` | cartridge-kit | 35 |
| F4 | Gates before the data fetch; `'gate'` phase; gates leave `createCartridgeApp` (D6) | runtime, cartridge-kit | 60 net |
| F5 | `RunGatesResult` names the blocker; delete `firstBlockedGateId` | cartridge-kit | −40 |
| F6 | Gate lifecycle events | cartridge-kit | 12 |
| F7 | Redirect round-trip contract (docs + example) | docs | — |
| F8 | `persist` with `outcome`, array form | cartridge-kit | 10 |
| F9 | No-paint mechanism: `gates.pending` on the SSR result, `data-airo-gate` flipped by the runtime | ssr, runtime | 25 |
| F10 | `ViewDefinition.factory` optional; resolver falls through to the mailbox (the site consumer A4, csr-only on mailbox-only page types; no longer carries private-ness) | cartridge-kit | 15 |
| F11 | **Cut (D19)** — no verdict cache across remounts; replaced by `MountCartridgeOptions.satisfiedGates` for the server-verified initial mount (D16) | runtime | 12 |
| F12 | `resolveMountEntry()` in core: the URL > `initialNavState` > default ladder as one exported function, used by `PageManager` and by the gate phase (D14) | core, runtime | 40 |

**F1 — `private` on the page graph (D13).** `TemplatePage.private?: boolean` at [template.ts:44-68](packages/cartridge-kit/src/template.ts#L44-L68) with JSDoc, `Page.private?: boolean` at [schema.ts:71-80](packages/core/src/schema.ts#L71-L80), and one line in `templateToAppConfig` ([template-to-app-config.ts:68-82](packages/cartridge-kit/src/template-to-app-config.ts#L68-L82)) so it survives the round trip the helper's own docblock warns about. `ViewDefinition.capabilities` is unchanged (still four members; `csr-only` stays a renderer property). In [render-with-publication.ts](packages/ssr/src/render-with-publication.ts) move entry resolution ([231-240](packages/ssr/src/render-with-publication.ts#L231-L240)) above the adapter run ([196](packages/ssr/src/render-with-publication.ts#L196)). If the resolved `entryPage.private` is true: adapters never run; unless `opts.renderPrivate === true` return `{ html: '', adapterResults: [], skipped: { pageType, reason: 'private' }, ...fellBack }`; with `renderPrivate: true` continue to render the HTML (JSON-LD/head-meta results empty by construction). `renderPrivate?: boolean` (default `false`) is a new option on `RenderWithPublicationOptions`, documented as "set only after your handler has verified a session for this request"; the framework never verifies it (M13) and never reads `scope` to decide. Precedence with the view's `'csr-only'` (D8): the page-level private check runs first and refusal wins; a private page whose view is csr-only, requested with `renderPrivate`, returns `skipped: { reason: 'csr-only' }` with `html: ''` and `adapterResults: []`, because adapters never run for a private entry. Four-row truth table in the JSDoc (page private × renderPrivate × view csr-only → reason / html / adapters) and one test per row; the csr-only docblock's "JSON-LD still inlined" gains "unless the page is private". Widen [line 127](packages/ssr/src/render-with-publication.ts#L127) to `reason: 'csr-only' | 'private' | (string & {})` (the 0.10.0 `AdapterSkipped` precedent) and document: a private skip is a 401, never a 404, never a fallback. `filterServerSafeCartridge` default unchanged; its docblock ([26-36](packages/ssr/src/filter-server-safe-cartridge.ts#L26-L36)) drops the `'requires-auth'` example and says private pages are a page-graph flag the runner handles, not a capability to filter. D7 resolves to "one source of truth" without a helper: every site reads `page.private` off the same `Page` object (runner: `entryPage`; runtime: `currentPages`; F9: the entry page; example server: the resolved entry). Adapters and MCP tools stay page-blind: private data never enters a snapshot the host builds for a machine route — the README names this as the fifth "easy to get wrong".

**F2 — who is asking, on SSR (D17).** The only new SSR input is `renderPrivate` (F1/D3). There is **no** `scope` option on `renderAppWithPublication` and **no** `CartridgeAppContext.scope`: after D3 the unlock is explicit, after D11 identity reaches views through the snapshot the handler builds for a verified session, and after D16 the server's verdict reaches the gate through an attribute, so nothing in the design would read `ctx.app.scope`, and a template that did would break byte-identical hydrate. `GateContext.scope` ([gate.ts:45-50](packages/cartridge-kit/src/gate.ts#L45-L50)) and `mountCartridge.gateScope` are unchanged. Docs state the rule: identity and any other per-request input reach views via the snapshot (DataSource input) or `config`, never a side channel.

**F3 — `appliesTo`, entry-based on the page flag (D13).** [gate.ts:53](packages/cartridge-kit/src/gate.ts#L53): `appliesTo?: 'all' | 'private'` (default `'all'`). A `'private'` gate runs when the **resolved entry page** carries `private: true` (same `describeEntryResolution` SSR uses, exported from core), and when no entry could be resolved at all (fail closed on the unknowable case only). Pure, in `packages/cartridge-kit/src/gate-phase.ts`:

```ts
export function selectGates<TConfig>(
  gates: readonly Gate<TConfig>[] | undefined,
  entryPage: Pick<Page, 'private'> | undefined,
): Gate<TConfig>[] {
  const all = gates ?? [];
  if (entryPage === undefined || entryPage.private === true) return [...all];
  return all.filter((g) => g.appliesTo !== 'private');
}
```

No views, no metadata gap, no warning. It is called from one place only: `runGatePhase` (below), which `mountCartridge` invokes with the entry resolved from `currentPages` (see D14 for how the entry is resolved when a router owns the URL). Docs: in-app navigation into a private page does not re-run the gate — a private view renders its signed-out state when the snapshot carries no member data, and the API stays the authority. Rewrite [gate.ts:9-11](packages/cartridge-kit/src/gate.ts#L9-L11) and [31-35](packages/cartridge-kit/src/gate.ts#L31-L35) to the two signed sentences plus the hydrate truth (a gate that paints must not `'allow'` in hydrate mode without restoring what it painted over).

**F4 — gates before data, and gates leave `createCartridgeApp` (D6).** `createCartridgeApp` has exactly one caller, `mountCartridge` ([892](packages/runtime/src/mount-cartridge.ts#L892)); gates were put inside it because it was the only mount helper when they shipped, and that is why they run after the snapshot. It becomes what its docblock describes: a **synchronous** typed wrapper that builds `CartridgeAppContext`, derives the resolver and returns `App`. `CartridgeAppResult`, the blocked branch, the `events`-required throw and `gateScope` on `CartridgeAppDeps` go with it. The gate phase becomes one exported helper in cartridge-kit, `runGatePhase({ cartridge, pages, entryPageType, host, ctx })` → `{ verdict: 'allow' | 'block'; blockedBy?; warning?; applied: Gate[] }` (wraps `selectGates` + `runGates`), called only by the runtime. `doMountInner` ([813](packages/runtime/src/mount-cartridge.ts#L813)) returns `InnerMount<TData> = { blocked: true; blockedBy } | { blocked: false; app; snapshot }`; the "no enabled entry page" check ([850-857](packages/runtime/src/mount-cartridge.ts#L850-L857)) moves first; then `runGatePhase` with `host: renderRoot` and `ctx: { config, events, scope: opts.gateScope }`, a throwing gate reported as `onError('gate', …)`; then data, pipeline, `createCartridgeApp`. **Hydrate + a painting gate (D15, outside voice gap 5):** when `mode === 'hydrate'` the runtime snapshots `renderRoot.innerHTML` before the gate phase and, if any gate ran `mount()` and the phase ended in allow, restores it before the data phase so PageManager hydrates the server's DOM, not the gate's; on block the gate's paint stays. This is the studio consumer's production shape (SSR products + F9 hide + age-gate modal + allow) and the [gate.ts:31-35](packages/cartridge-kit/src/gate.ts#L31-L35) docblock is rewritten to describe it as a guarantee. Adapt [699-712](packages/runtime/src/mount-cartridge.ts#L699-L712), [768-776](packages/runtime/src/mount-cartridge.ts#L768-L776), [941-957](packages/runtime/src/mount-cartridge.ts#L941-L957); `currentSnapshot` set only when unblocked; `signalMountReady(false)` on block; `onShellReady` ([518](packages/runtime/src/mount-cartridge.ts#L518)) still first. Phase docblock ([431-443](packages/runtime/src/mount-cartridge.ts#L431-L443)) and [runtime/README.md](packages/runtime/README.md) lines 20-25, 92, 131-132 updated. `test-harness` and embed need no change. Consumer effect (the studio consumer, always `preloadedData`): a blocked mount no longer runs transformers — changelog.

**F5 — `RunGatesResult`.** `{ verdict: 'allow' } | { verdict: 'block'; blockedBy: string }` at [run-gates.ts:35](packages/cartridge-kit/src/run-gates.ts#L35); `firstBlockedGateId` ([cartridge-app.ts:165-207](packages/cartridge-kit/src/cartridge-app.ts#L165-L207)) is deleted along with the whole gate block in that file (D6). No `runGates` caller outside cartridge-app.ts in this repo or in the studio consumer.

**F6 — events.** Inside `runGates`, on `ctx.events`: `gate:precheck { gateId, decision }`, `gate:mount { gateId }`, `gate:allowed { gateId, via: 'precheck' | 'mount' }`, `gate:blocked { gateId }`. Names follow `navigation:changed` / `mount:remounted`.

**F7 — redirect contract (docs).** `mount()` may never settle when the gate navigates away; re-entry is `precheck` on the next mount (the host session now exists, so no UI re-shows); the return URL carries the nav state in every router mode — the gate links to `/auth/login?next=<pathname+search>` and the host redirects back to `next` (same-origin paths only); memory-mode hosts serialise `app.getNavigationState()` into `next` and re-supply it as `initialNavState`. Popup flows resolve in-page like SIWE and are already first-class.

**F8 — persist.** `persist?: PersistHint | readonly PersistHint[]`; `PersistHint = { key; ttl?; scope: 'session' | 'persistent'; outcome?: 'pass' | 'fail' }` (default `'pass'`). Non-breaking for the studio consumer's object form at their `gates.ts:146`. Still metadata the framework never acts on; Pattern B stays first-class.

**F9 — no-paint, and the server's verdict handed to the client (D16).** `RenderWithPublicationResult.gates?: { pending: string[]; satisfied: string[] }` — `pending` = ids of the gates `selectGates(cartridge.gates, entryPage)` would run on the client **and** whose `isEnabled(publicationCtx.config)` is true (D5: the same predicate on both sides, so a private-scoped login gate is never pending on a public entry), **minus** `satisfied` = the `appliesTo: 'private'` gates among them when `renderPrivate: true` (the host verified the session this render is for, so the gate that exists to establish it is already met). The runner never runs gates. The host emits `data-airo-gates-satisfied="login"` on the mount root from `satisfied`, and its client entry passes those ids to `mountCartridge({ satisfiedGates })` (D19: an explicit option, not an attribute the runtime reads); the gate phase skips them on the initial mount and narrates `gate:allowed { via: 'server' }` — the client attaches listeners and never asks `/auth/session`. The attribute is trusted exactly as far as the `no-store` HTML it arrived in; remounts re-run every gate, and the API stays the only authority. Runner tests: private entry with and without `renderPrivate` → `satisfied` populated / empty; runtime tests are under F11. The host emits `data-airo-gate="pending"` on its host element and the cartridge's CSS hides under it. `mountCartridge` resolves the attribute on **every** exit of the gate phase, **only if the attribute is already present** on `opts.host` (zero change for existing consumers): zero applicable gates → `"passed"` before the data phase; all allow → `"passed"`; block → `"blocked"`; a gate throws → `"error"` then `onError('gate')`. Framework authors no CSS; this is DOM-lifecycle mechanism. Bots read un-gated markup with an attribute on it; JSON-LD is unaffected. Tests: one per exit, plus "attribute absent → runtime never writes it".

**F10 — capability-only declarations.** `ViewDefinition.factory?` optional (JSDoc: a factory-less entry carries capabilities for a mailbox-registered page type); [cartridge-registry.ts:87-96](packages/cartridge-kit/src/cartridge-registry.ts#L87-L96) and [108-110](packages/cartridge-kit/src/cartridge-registry.ts#L108-L110) become `if (staticView?.factory) return …; else mailbox`. Type change for consumers reading `views[].factory` — changelog. Serves the site consumer's A4 (`csr-only` on a mailbox-only page type) and nothing else now that private-ness lives on the page (D13).

**F11 — cut (D19); `satisfiedGates` instead.** No verdict cache, no `resetGates()`, no `gate:reset`, no `revalidateAfterMs`. In production a remount (`update()` / `updatePages()` outside the hot-swap keys) happens because fresh data is wanted, and freshness wins: gates re-run with it, as today. The studio is the one host that remounts per editor change; whether that deserves a dev-mode memo is a conversation to have with the studio consumer on their thread, not a framework surface at 1.0. What remains of D16 is one explicit option: `MountCartridgeOptions.satisfiedGates?: readonly string[]` — gate ids the host has already satisfied for **this initial mount** (it reads them off `data-airo-gates-satisfied`, which it emitted from the runner's `gates.satisfied`). `runGatePhase` skips those gates on the initial mount and narrates `gate:allowed { via: 'server' }`; remounts ignore the option and re-run everything. The runtime reads no input attributes itself (explicit over clever; F9's attribute *write* is still mechanism). Docs also show the first-mount trick for CSR shells: a host-set non-HttpOnly marker cookie makes `precheck` synchronous; the example keeps the async fetch as the reference. Tests in `mount-cartridge.test.ts`: `satisfiedGates: ['login']` → `precheck` never called on mount and `via: 'server'` emitted; the same handle's `update()` remount → `precheck` called; an id not among the applicable gates → ignored.

**F12 — `resolveMountEntry` (D14, outside voice gap 1).** Under `enableRouter` the URL is parsed inside `PageManager` — the constructor seeds `navState` from `initialNavState` ([page-manager.ts:282-293](packages/core/src/page-manager.ts#L282-L293)) and `initRouter` ([582-640](packages/core/src/page-manager.ts#L582-L640)) builds the router with `validPages` and lets its parse override — all inside `createApp`, which now runs after gates. Without a fix the gate phase on `/members` would resolve the entry as `home` and drop the private-scoped gate. Core exports `resolveMountEntry({ pages, isGatePage, enableRouter, initialNavState })` → `{ page: Page | undefined; navState: Partial<NavigationState>; fellBack? }` implementing the exact ladder (URL via the router's `parseCurrent()` when `enableRouter` is set and a `window` exists → `initialNavState` → `findEntryPage`), and `PageManager`'s constructor is refactored to call it so the runtime and PageManager agree by construction; `runGatePhase` receives the resolved page. Tests: PageManager's existing suite unchanged; a new runtime test mounts under `{ mode: 'path', basePath: '/' }` with `location` at `/members` and asserts the private gate ran, and again under `{ mode: 'hash' }`; the same helper is used by the `updatePages()` remount.

**Deferred, with direction in the response:** the studio consumer #3 gate config schema; the site consumer A3 `resolveGate`; a private-aware `isGatePage` (would change `fellBack` semantics and conflate `Gate` with the `'gate-page'` fallback — one clarifying sentence in docs); MCP manifest narrowing; a `robots` field on head types; embed `gateScope` parity (data, not a hook; ~40 bytes of budget); a `PageManager` navigation guard for in-app entry into private pages.

**1.0 review list additions:** open-union `capabilities`; typecheck `test/**`; `scope`/`gateScope` naming; `isGatePage` on `MountCartridgeOptions` (today only `createApp` callers can set it); `EntryFallbackReason 'gate-page'` vs `Gate` naming sentence.

### Example: `examples/full-site` becomes a mixed public/private site (~750 LOC)

One template, four pages: `home`, `doc` (public); `members` (`/members`), `note` (`/note/:slug`) declared `private: true` on the template (D13); every view stays `capabilities: ['ssr-safe', 'hydratable']`. Snapshot gains `member?: { user, notes: DocSummary[], note?: Doc }`, populated only when the resolved entry page is private (never keyed on session presence, see D18).

| File | Change | ~LOC |
|---|---|---|
| [content.ts](examples/full-site/src/content.ts) | `MEMBER_NOTES` (two), `findNote`, `DEMO_USER` | +45 |
| [cartridge.ts](examples/full-site/src/cartridge.ts) | `member` slice; `membersSource` (id `members`; client-side `fetch('/api/members/me?slug=…', { credentials: 'same-origin', signal: ctx.signal })`, used by every private mount, D20); `contentSource` unchanged (public content is a bundled module on both sides); one `signInPanel(next, { error? })` template (D9) used by the gate's `mount` and by both private views' signed-out branch; `membersView` (greeting from `ctx.app.data.member.user`, note list, `<form method="post" action="/auth/logout">`) and `noteView`, each rendering `signInPanel` when `member` is absent; `loginGate` (`appliesTo: 'private'`; `precheck` → `GET /auth/session`, 401 = `'gate-required'`, network error → `signInPanel` with a retry message per [gate.ts:78-81](packages/cartridge-kit/src/gate.ts#L78-L81); `mount` paints `signInPanel('<pathname+search>')` and returns `'block'`); template pages + `MEMBERS_CSS` + "Members" link on the home header | +200 |
| `src/auth/oauth-provider.ts` (new) | Demo IdP router with one registered client `{ client_id, redirect_uri }` (D4): `GET /oauth/authorize` rejects an unknown `client_id` or a `redirect_uri` that is not an **exact** string match (400 before any form renders), then renders the login form with `renderDocument`; `POST` checks `demo`/`demo`, mints a one-shot code bound to `code_challenge` + `redirect_uri` (60 s), redirects with `code` + `state`; `POST /oauth/token` requires `client_id`, the same `redirect_uri`, and a `code_verifier` that S256-hashes to the stored challenge (`node:crypto`), consuming the code; `GET /oauth/userinfo` needs the bearer. In-memory maps. Each check carries a one-line comment naming the attack it closes | +155 |
| `src/auth/session.ts` (new) | Cookie parse (~10 lines), session `Map`, `readSession(req)`; `/auth/login` (state + PKCE verifier in a short-lived `HttpOnly` cookie, 302 to authorize), `/auth/callback` (state → 400, code exchange via `fetch` to the token endpoint wrapped in `try/catch` → **502 "sign-in provider unavailable" with a retry link and no cookie** when the provider is unreachable (critical gap from the failure-modes pass), userinfo, `Set-Cookie: sid=…; HttpOnly; SameSite=Lax; Path=/` plus `Secure` when `req.secure` or `X-Forwarded-Proto: https` (D4; `app.set('trust proxy', 1)`), session id from `randomBytes(32)`, 302 to a same-origin `next`), `POST /auth/logout`, `GET /auth/session` (200 `{ user }` / 401). `AUTH_ISSUER` env defaults to self | +170 |
| [server.ts](examples/full-site/src/server.ts) | `express.urlencoded()`; serve `dist/public` before the wildcard; `robots.txt` `Disallow: /members /note/ /auth/ /api/ /oauth/`; mount both routers; one `memberSliceFor(userId, slug)` (D9) builds the `member` slice; `GET /api/members/me` (401 without session) returns it as JSON and `snapshotFor(entryPage, slug, session)` attaches it server-side **only when the resolved entry page is `private: true`** (D18: the page flag decides snapshot content and cache policy alike; the session only decides render-vs-refuse), so SSR and the API cannot disagree and a signed-in visitor's public pages are byte-identical to an anonymous visitor's; `renderPage` passes `renderPrivate: Boolean(session)`, maps `skipped.reason === 'private'` → **401** shell (`<div id="app" data-airo-mode="csr" data-airo-source="members">`, `noindex`, `no-store`, no adapters), and a rendered private page → 200 with `Cache-Control: private, no-store` + `X-Robots-Tag: noindex`, no canonical/OG, `data-airo-mode="hydrate"` and `data-airo-gates-satisfied="login"` from `result.gates.satisfied` (D16, so hydrate never calls `/auth/session`) — the header and `noindex` choice keyed on the resolved entry page's `private` flag (D7/D13), never on a path prefix; public pages wrap the fragment in `<div id="app" data-airo-mode="hydrate">` with `Cache-Control: public, max-age=60`. **No inline snapshot (D20 superseding D11):** no data script block anywhere; public content stays a bundled module on the client (its "refetch" is in-memory), and every private mount, hydrate or CSR shell, refetches through the members DataSource with the cookie, so no private byte ever appears in a response except as the markup the session earned. Private responses add `Vary: Cookie` beside `no-store`; the member slice is shaped to exactly the fields the views render | +100 |
| [client.ts](examples/full-site/src/client.ts) | Read `data-airo-mode` and `data-airo-gates-satisfied` from `#app`; public pages mount as today (`dataSourceInput` with the slug, in-memory content); private pages mount with `dataSourceId: 'members'` in the mode the server named (`hydrate` after a private render, `csr` for the 401 shell) and pass `satisfiedGates` (D16/D19), so a signed-in hydrate costs one `/api/members/me` fetch and no `/auth/session` call, and the 401 shell's gate runs before any fetch; single template; `gateScope` unused; `onError` paints `signInPanel` (session expired between the render and the hydrate fetch) | ~45 |
| [package.json](examples/full-site/package.json) | `esbuild` devDep (`^0.21.0`); `build` = `tsc … && esbuild src/client.ts --bundle --format=esm --target=es2022 --outfile=dist/public/client.js`; `ignoreBinaries` in `knip.json` if flagged | +3 |
| [smoke.mjs](examples/full-site/scripts/smoke.mjs) | Cookie-jar `fetch` with `redirect: 'manual'`; ~25 assertions: `/client.js` served as JS; anonymous `/members` → 401 + `no-store` + `noindex` + no `ld+json` + no canonical + empty `#app`; `/auth/session`, `/api/members/me` → 401; `/auth/login` 302 carries `code_challenge` + `state`; wrong password stays anonymous; `demo`/`demo` → callback → `HttpOnly` cookie → `/auth/session` 200; **signed-in `/members` → 200 SSR'd dashboard containing the user's name, still no `ld+json`, still `no-store`**; `/note/roadmap` 200, `/note/nope` 404; tampered `state` → 400; bad `code_verifier` → 400; unknown `client_id` → 400 at authorize and 401 at token; `redirect_uri` off by a trailing slash → 400; `Secure` present on the cookie when the callback is fetched with `X-Forwarded-Proto: https` and absent otherwise; a reused code → 400; a callback while `AUTH_ISSUER` points at a closed port (the smoke flips an env-driven override for one request) → 502 and no `Set-Cookie`; `/sitemap.xml`, `/llms.txt`, `/robots.txt`, `/mcp/tools`, `list_pages` free of member content; logout clears; public pages unchanged; **D16:** signed-in `/members` carries `data-airo-gates-satisfied="login"`, anonymous `/members` and every public page carry no such attribute; **D20:** no response anywhere contains a `data-airo-snapshot` block, private responses carry `Vary: Cookie`, and the `/api/members/me` JSON's `member` keys equal exactly the set the dashboard renders; **D18:** with the session cookie, `/` and `/doc/why-snapshots` carry no `Vary: Cookie` and are byte-identical to the anonymous responses | +135 |
| [README.md](examples/full-site/README.md) | "The members area: private pages, the login gate, and where OAuth lives"; URL table; demo credentials; the two signed sentences; fifth "easy to get wrong": member data never enters a snapshot built for a machine route, and it is keyed on the page flag, never on session presence (D18); sixth (D20): a server-rendered private page still refetches its data on hydrate, by design — no private byte rides a script block, and the cost is one same-origin call the session already earned | +70 |

CI: the examples job ([ci.yml:160-190](.github/workflows/ci.yml#L160-L190)) already builds then smokes; D10 adds the example's vitest run before the smoke and a Playwright Chromium install + `e2e` run after it, against the same :4317 server (see "Tests added by the eng review").

### Docs and changelog

- [best-practices.md](docs/best-practices.md): §1.5 Gate rewritten around the two signed sentences, `appliesTo`, gates-before-data, the redirect contract (F7), `persist` outcomes, cookie consent removed from the use-case list; §1.7 Template gains `private` on a page; §3.12 line 675 and §5.5 lines 966-971 replace the promised `'requires-auth'` capability with "private pages are a page-graph flag" (D13); §5.5 placeholder guidance replaced by F10; new §4.9 "Mixed public/private sites" (the `private` page flag, `renderPrivate`, 401 mapping, `no-store` + `Vary: Cookie` + `noindex`, the no-paint attribute and `data-airo-gates-satisfied`, session-aware SSR, the marker-cookie precheck for CSR shells, and — D26 — a paragraph on **not mounting pages that have no interactivity**: a renderer that attaches no listeners needs no `mountCartridge`, so the page ships no client data and no bundle work; flip back the day it gains a listener). ~135 lines. [cartridge-kit/README.md:116-154](packages/cartridge-kit/README.md#L116-L154) updated.
- [CHANGELOG.md](CHANGELOG.md): `## \`@airo-js/core\` 0.11.0` (Added `Page.private`), `## \`@airo-js/cartridge-kit\` 0.11.0` (Added F1 `TemplatePage.private` + round trip, F2 F3 F6 F8 F10, `runGatePhase`; Changed F5 shape, `factory` optional, **`createCartridgeApp` no longer runs gates: it is synchronous and returns `App`; `CartridgeAppResult` removed; gates are a runtime concern** — breaking for a direct caller, none known; Fixed wrong `blockedBy`; `CONTRACT_VERSION` 0.10.0), `## \`@airo-js/ssr\` 0.11.0` (Added F1 private skip + `renderPrivate`, F9 `gates.pending` / `gates.satisfied`; `skipped.reason` opened — consumers labelling by presence, e.g. `'skipped-csr-only'`, should branch on `reason`), `## \`@airo-js/runtime\` 0.11.0` (Changed F4: gates before data, no fetch/pipeline on block, `'gate'` phase emitted, F9 attribute flip, D15 SSR markup restored after a painting gate allows; Added `satisfiedGates` for the server-verified initial mount), core / embed / mcp sync revs; "Examples and docs" (members area; `/client.js` never served). Bump every `package.json` + `VERSION`; `./scripts/publish.sh` dry run must pass.
- CLAUDE.md is user-owned; suggested after landing — §3: the two signed sentences and "gates precede the data fetch"; §5 invariant: "Bots are never gated; a Gate paints, the host serves"; §7: "Don't make the Gate the security boundary."

### Bridge posts (step 0, after approval — D22, D27)

Three posts, in this order. First the plan itself is copied into the repo as `docs/designs/gate-reshape-0.11.md` and committed, so `readDoc` serves it and both consumers can evaluate the full text. Then one **new message** from `airo-js` carries the summary and points at the doc, and one **short reply** on each consumer thread points at the new message. Every post opens with: *"Direction is settled; every field name is proposed and becomes final at the 0.11.0 changelog. If the consumer tracer bullet (step 4) moves a name, a one-line follow-up lands here."* Both threads are set `in-progress`.

**New message (type `finding`, severity medium, consumer `airo-js`) — title:** *0.11.0 gate reshape — the reviewed plan, for both consumers to evaluate: a Gate paints, the host serves; private pages are a page flag; gates run before data*

**Body (condensed; full text in `docs/designs/gate-reshape-0.11.md`):**

> Both of your threads (`msg_mtvaicmu_ad3aee`, `msg_mtva69kk_de152d`) shaped this. The plan went through an engineering review with an outside model pass; 27 decisions, all recorded in the doc with their rationale. Evaluate it against your own code before we cut; nothing below is final until the changelog.
>
> **Two sentences the framework signs.** (1) A Gate decides whether to paint; whether to serve is the host's, per request — the gate is UX, the API and the SSR handler are the boundary. (2) Bots are never gated — SSR never runs gates; private pages are refused, not gated.
>
> **What lands in 0.11.0 (proposed names).** `TemplatePage.private: true` round-tripped onto `Page` (your `requires-auth`, as a page-graph flag rather than a view capability, so mailbox-only cartridges need no placeholder). `renderAppWithPublication` refuses a private entry with `skipped.reason === 'private'` (map it to 401 as you map `unknown-page` to 404) unless the host passes `renderPrivate: true` after verifying the session, and then renders it with no adapters; it also returns `gates: { pending, satisfied }` so a host can ship `data-airo-gate="pending"` for the no-paint case and `data-airo-gates-satisfied` for gates its render already met. Gates move **before** the data fetch and out of `createCartridgeApp` (which becomes a synchronous typed wrapper); one `runGatePhase` in cartridge-kit, called by the runtime; `runGates` now names the blocker (the old re-walk reported the wrong gate); `onError('gate')` is finally emitted; in hydrate mode the SSR markup is restored after a painting gate allows. `Gate.appliesTo: 'private'` scopes a gate to mounts whose resolved entry page is private, and a new core `resolveMountEntry` makes the runtime and PageManager agree on that entry under any router. `persist` accepts an array with `outcome: 'pass' | 'fail'` (still metadata). Gate lifecycle events `gate:precheck / mount / allowed / blocked`. `ViewDefinition.factory` becomes optional so a mailbox-only page type can declare `csr-only`. `mountCartridge({ satisfiedGates })` skips named gates on the initial mount only.
>
> **What we decided not to do, and why.** No identity side channel into views (`CartridgeAppContext.scope`): the snapshot your handler builds for a verified session is the per-request reference, and it stays byte-identical on hydrate. No gate verdict cache across `update()` remounts: a production remount exists to get fresh data, so gates re-run with it; the studio consumer, if editor remounts make precheck cost visible, send the remount frequency and we design a dev-mode memo with you. No gate config schema at 1.0 (one-gate-fan-out is blessed). No `resolveGate` hook yet (`await import()` in `mount` is the pattern; the events give the ratio). MCP OAuth is not this work. Cookie consent leaves the gate use-case list.
>
> **The redirect contract.** `mount()` may never settle when a gate navigates away; re-entry is `precheck` on the next mount; the return URL is the nav state (`next` = pathname + search, same-origin), memory-mode hosts round-trip `getNavigationState()` through it. The `full-site` example becomes the runnable reference: a members area behind a login gate with authorization-code + PKCE against an in-process demo provider (`demo` / `demo`), private pages server-rendered for a session and refused otherwise, smoke + happy-dom + Playwright coverage.
>
> **Order.** cartridge-kit → ssr → core/runtime (then a yalc tracer bullet against the studio consumer's suite) → docs/changelog → example. Reply on your own thread with anything the doc gets wrong for your code.

**Reply on the site consumer's thread (`msg_mtvaicmu_ad3aee`):** *Direction on A1–A5 is in the new message `<id>` and the full plan in `docs/designs/gate-reshape-0.11.md`. Short form: A1 + A2 land as one design (page flag + `renderPrivate` + `skipped.reason === 'private'` → your 401), we sign "a Gate paints, the host serves", A4 lands (`factory` optional), A3 is deferred with the `gate:precheck` ratio as the trigger, A5 lands. We are not threading `scope` into `CartridgeAppContext`; the doc says why (byte-identical hydrate; the snapshot is your per-request reference). Delete nothing yet: `/me` becomes a cartridge page on 0.11.0. Evaluate the doc against `web/gates/siwe.ts` and `web/routes/me.ts` and reply here.*

**Reply on the studio consumer's thread (`msg_mtva69kk_de152d`):** *Direction on 1–5 is in the new message `<id>` and the full plan in `docs/designs/gate-reshape-0.11.md`. Short form: (1) no new hook, re-entry is `precheck`, the URL carries nav state; (2) `scope` stays input-only, the session channel is the data fetch that now follows the gate; (3) the framework owns no gate config schema at 1.0, your fan-out is blessed; (4) `persist` takes an array with `outcome`; (5) the no-paint mechanism is framework-owned (`gates.pending` → `data-airo-gate`, runtime flips it, your CSS hides), and the runtime restores SSR markup after your modal allows. "Bots are never gated" is now a documented guarantee. Gates re-run on every remount by design; if your editor's per-change remounts make precheck cost visible, send us the frequency. Behaviour change to note: a blocked mount no longer runs transformers, and a throwing gate reports `onError('gate')`. Unpause the parts of your spec the doc does not touch; evaluate the rest against it and reply here.*

**To the site consumer (msg_mtvaicmu_ad3aee):** We sign "a Gate decides whether to paint; whether to serve is the host's, per request" — it goes into `gate.ts` and best-practices verbatim, and "bots are never gated" alongside it. A1 + A2 land as one design in 0.11.0: `TemplatePage.private: true` (your `requires-auth`, as a page-graph flag rather than a renderer capability, so your mailbox-only cartridge needs no placeholder and both sides read the same page object), and the who-is-asking slot on SSR is an explicit `renderPrivate: true` your handler sets after verifying the session. We are not adding `scope` to `renderAppWithPublication` or `CartridgeAppContext`: the snapshot your handler builds for that verified session is the per-request reference you asked for, it is byte-identical on hydrate, and a side channel a template could read would not be. A private entry without it returns `skipped.reason === 'private'` (nothing substituted, so not `fellBack`) which you map to 401 exactly as `unknown-page` maps to 404; with it the page renders adapter-free. Your (c) is subsumed — the runner checks the resolved entry; `isGatePage` keeps meaning "a page that is a gate". Gates now run before the data fetch and are entry-scoped via `Gate.appliesTo: 'private'`, fail-closed for `views: []`. Identity is never a gate output — the session is your cookie, and the fetch that follows the gate runs authenticated; that is your per-request reference. The framework remembers nothing across remounts: a remount exists to get fresh data, so gates re-run with it. The one hand-off is on hydrate of a page your server rendered privately: the runner reports which private-scoped gates that render satisfied, you print them on the mount root, and `mountCartridge({ satisfiedGates })` skips them once, so the client attaches listeners without asking `/auth/session` again. A4 lands (`factory` optional; the resolver falls through to the mailbox) so `/connect` can join the template. A3 stays deferred: `await import()` inside `mount` is the pattern we document, and the new `gate:precheck` event gives you the ratio that would justify a hook. Pattern B stays first-class. MCP OAuth is not this work. Delete nothing yet: `/me` becomes a cartridge page on 0.11.0.

**To the studio consumer (msg_mtva69kk_de152d):** Direction on 1–5, in order: (1) no new hook — `mount()` may never settle when the gate navigates away, re-entry is `precheck` on the next mount, the return URL carries the nav state (`next` = pathname + search, same-origin) and memory-mode hosts round-trip `getNavigationState()` through `next` into `initialNavState`; the full-site example is this case with a demo OAuth provider. (2) `scope` stays input-only by design; the channel for "allow, and here is the session" is the data fetch, which now runs **after** gates. Gates re-run on every remount, on purpose: in production a remount happens because fresh data is wanted. Your editor is the one host that remounts per change; if that makes precheck cost visible, tell us the remount frequency and we design a dev-mode memo with you rather than freezing a cache into 1.0. (3) Framework owns no gate config schema at 1.0 — your one-gate-fan-out is the blessed shape; send `GateInstance` when built. (4) `persist` accepts an array of `{ key, scope, ttl?, outcome: 'pass' | 'fail' }`, still metadata. (5) Framework-owned, small: the SSR result reports pending and already-satisfied gate ids, you emit `data-airo-gate="pending"` (and `data-airo-gates-satisfied` for gates your server already met), the runtime flips the first after gates resolve and seeds its verdict cache from the second, your CSS hides — your contribution welcome as the test case. "Bots are never gated" becomes a documented guarantee. Block + redirect needs no channel (`location.assign()` then `'block'`). Narration lands (`gate:precheck/mount/allowed/blocked`). Cookie consent leaves the use-case list. One behaviour change to note: a blocked mount no longer runs transformers, and a throwing gate reports `onError('gate')`.

### Tests added by the eng review (D10 and the coverage diagram)

**CRITICAL regression (no option):** `update()` and `updatePages()` remounts blocked by a gate must throw the documented error ([mount-cartridge.ts:699-709](packages/runtime/src/mount-cartridge.ts#L699-L709), [768-773](packages/runtime/src/mount-cartridge.ts#L768-L773)). [update-dispatcher.test.ts:362-369](packages/runtime/test/update-dispatcher.test.ts#L362-L369) defers this case today and the `InnerMount` refactor rewrites exactly that path. Add to `mount-cartridge.test.ts`: a gate that allows on first mount and blocks on the remount (precheck reads a counter) → `update()` rejects with `/blocked by gate "login"/` and the original app is destroyed; same for `updatePages()`.

**Framework gaps → tests:** `selectGates` with `entryPage === undefined` → every gate runs (`gate-phase.test.ts`); `templateToAppConfig` carries `private` through and omits it when absent (`template-to-app-config.test.ts`, D13); `persist` object and array forms compile (`packages/cartridge-kit/test/gate.test-d.ts`); default entry private + anonymous → `skipped.reason === 'private'` and `fellBack` absent (`render-with-publication.test.ts`); `initialNavState.page` naming a private page selects the private gate on the client (`mount-cartridge.test.ts`); hydrate + a `paintingGate` fixture (its `mount` overwrites the root, then allows) → the SSR markup is restored and the renderer's `hydrate()` sees it, and the same gate blocking → its paint stays (D15, `mount-cartridge.test.ts`); `appliesTo: 'private'` gate skipped when the entry page is public, run when it is `private: true`, run when no entry resolves (`mount-cartridge.test.ts`); under `{ mode: 'path' }` with `location` at `/members` and no `initialNavState` the private gate runs (D14, F12).

**Example test infrastructure (D10 A):**
- `examples/full-site/vitest.config.ts` (happy-dom, `airoAliases` from `vitest.shared.ts`) and `test/gate.test.ts`: mounts `docSiteCartridge` with `mountCartridge` under a mocked `globalThis.fetch` — `/auth/session` 401 → `signInPanel` painted into the root, result `blocked: true`, `blockedBy: 'login'`, and `/api/members/me` never requested; 200 → `blocked: false`, nothing painted before the data phase; network error → retry copy in the panel; 200 then `/api/members/me` 401 (expiry between precheck and fetch) → `onError('fetch')` and the client's panel; `data-airo-gate` present → flipped to `passed` / `blocked`.
- `examples/full-site/e2e/members.spec.ts` (Playwright, Chromium only): anonymous `/members` shows the panel and the network log has no `/api/members/me`; sign in `demo`/`demo` → dashboard; **no-flash hydrate** asserted by tagging the SSR root node before hydrate and checking the same node is still attached after `mountCartridge` resolves; deep link `/note/roadmap` → sign in → lands on `/note/roadmap`; provider "cancel" link → back on `/members`, still gated; public `/doc/why-snapshots` click sets `data-last-click` (hydration actually ran, for the first time in this example's history); sign out → gated again; `next=https://evil.example` → `/`.
- Smoke additions at the HTTP level: `next` round trip (`/auth/login?next=/note/roadmap` → callback `Location: /note/roadmap`); external `next` rejected; the API slice equals the SSR slice (rendered name in `/members` HTML equals `user.name` from `/api/members/me`).
- `package.json`: `vitest`, `happy-dom`, `@playwright/test` devDeps; scripts `test` and `e2e`. CI examples job: `pnpm --filter @airo-js-examples/full-site test` before the smoke, `npx playwright install --with-deps chromium` once, `pnpm --filter @airo-js-examples/full-site e2e` against the same :4317 server after the smoke. Root `pnpm test` keeps its `./packages/*` filter; the example's tests run only in the examples job, as the smokes do.

## Eng review outputs

### NOT in scope (considered, deferred)

- Gate verdict cache across remounts (F11) — cut, D19: production remounts exist to get fresh data; the studio case is a TODO to design with the studio consumer.
- `CartridgeAppContext.scope` and an SSR `scope` option — D17: nothing left reads it; identity rides the snapshot.
- Inline snapshot script block (D11) — superseded by D20: no private byte in a script block; the example's public content stays a bundled module.
- Page-scoped gates via a `PageManager` navigation guard — no consumer has in-app navigation across the boundary; links are full loads.
- Gate config schema / `GateInstance` (the studio consumer #3) — the framework owns no gate config at 1.0; their one-gate-fan-out is blessed.
- `resolveGate` chunking hook (the site consumer A3) — `await import()` inside `mount` is the documented pattern; F6 events give the ratio that would justify a hook.
- MCP manifest narrowing, and OAuth for the MCP endpoint — page-blind by design; MCP auth is host-side and not this work.
- A `robots` field on `CrawlerSurfaceOutput` / `DocumentHead` — the host emits the meta tag and the header today.
- Embed forwarding of `gateScope` — data, not a hook; the bundle is ~40 bytes from its ceiling.
- Playwright beyond Chromium — one browser proves the paint and hydrate claims.
- The marker-cookie fast path for `precheck` in the example — documented; the reference keeps the async verify.
- A private-aware `isGatePage` — would change `fellBack` semantics and conflate `Gate` with the `'gate-page'` fallback.

### What already exists (reused, not rebuilt)

- `describeEntryResolution` / `findEntryPage` (core) — the runner and F12 build on them; F12 adds the router step, it does not fork the ladder.
- `runGates` — kept as the sequential runner; only its result widens (F5).
- `templateToAppConfig` — extended by one line (F1); the helper's own docblock told us to.
- `filterServerSafeCartridge`, `headFromPublication`, `renderDocument` — unchanged and reused (login form, 401 shell, 404 page all compose `renderDocument`).
- `logger('runtime')`, `MountPhase.'gate'`, `PathRouter.parseCurrent()` — existing seams F4, F9 and F12 plug into.
- `vitest.shared.ts` `airoAliases`, esbuild (embed devDep), the CI examples job — reused for the example's test infrastructure.
- Removed as duplicates rather than rebuilt: `firstBlockedGateId` and the gate block in `createCartridgeApp` (D6).

### Diagrams

The boundary diagram in "Design" stays. Add the mount phase diagram to the plan (below) and to the [mount-cartridge.ts:431-443](packages/runtime/src/mount-cartridge.ts#L431-L443) docblock; the SSR decision table (page private × `renderPrivate` × view csr-only) as a comment above the capability gate in `render-with-publication.ts`; the precheck/mount/verdict state machine in the `gate.ts` header; the request flow (session → `renderPrivate` → 401 shell | 200 render) at the top of the example's `server.ts`; the authorization-code sequence at the top of `oauth-provider.ts`. Diagram maintenance is part of each of those edits.

```
mountCartridge
  shell ─► onShellReady ─► resolveMountEntry ─► gate phase ─► data ─► pipeline ─► createCartridgeApp ─► mounted
                          (URL > hint > default)   │ block ─► { blocked, blockedBy }; data-airo-gate="blocked"
                                                    │ throw ─► onError('gate');        data-airo-gate="error"
                                                    └ allow ─► hydrate? restore SSR DOM; data-airo-gate="passed"
  satisfiedGates: named gates skipped on the INITIAL mount only (gate:allowed via 'server')
  update()/updatePages(): hot-swap keys → replaceAppContext/replacePages (no gates)
                          otherwise      → re-run from resolveMountEntry (gates run again; freshness wins)
```

### Failure modes (one per new codepath)

| Codepath | Realistic failure | Test | Handling | User sees |
|---|---|---|---|---|
| `runGatePhase` | a gate's `precheck` throws (network) | yes | `onError('gate')`, attribute `error` | host's error UI, or the gate's own retry panel |
| `resolveMountEntry` | router mode set but no `window` (node test, SSR misuse) | yes | falls to hint > default | correct entry |
| `renderAppWithPublication` private branch | host sets `renderPrivate` on an anonymous request | yes (truth table) | renders — by contract the host verified first | host bug, documented as such |
| `satisfiedGates` | stale attribute from cached HTML (a proxy ignoring `no-store`) | yes (expiry path) | the data fetch answers 401 → `onError('fetch')` → sign-in panel | sign-in panel, no data |
| hydrate restore (D15) | gate mutated host attributes, not `innerHTML` | yes (restore path) | `innerHTML` restored; attributes are the gate's to undo | documented |
| `templateToAppConfig` | `private` dropped from the round trip | yes | pinned | — |
| `/auth/callback` | token endpoint unreachable (`AUTH_ISSUER` wrong, provider down) | **was missing — added** | `try/catch` around the token `fetch` → 502 with a plain message, no cookie set | a clear "sign-in provider unavailable" page with a retry link |
| `/auth/callback` | code minted for another `redirect_uri` / reused / expired | yes (D4) | 400 | error page |
| in-memory session and code maps | unbounded growth on a long-running demo | no | sessions get a 24 h TTL and a sweep on insert; codes already 60 s | — (demo limitation, documented) |
| `data-airo-gate="pending"` | client bundle fails to load | n/a (host CSS) | docs §4.9: pair the hide with a `noscript` reveal or a CSS timeout | content appears after the fallback |

One **critical gap** was found and folded: the provider-down callback path had no test and no handling and would have surfaced as an Express stack trace. It is now a 502 with a message, pinned by a smoke assertion that points `AUTH_ISSUER` at a closed port for one request.

### Worktree parallelization

| Step | Modules touched | Depends on |
|---|---|---|
| 1 cartridge-kit F5 + F6 | packages/cartridge-kit | — |
| 2 core + cartridge-kit F1, F3, F4, F8, F10 | packages/core (schema), packages/cartridge-kit | 1 |
| 3 ssr F1/F2/F9 | packages/ssr | 2 |
| 4 core F12 + runtime F4/F9/D15/satisfiedGates | packages/core (page-manager), packages/runtime | 2 |
| 5 docs + changelog + versions | docs/, CHANGELOG.md, packages/*/package.json | 3, 4 |
| 6a example public hydrate + test harness | examples/full-site | — |
| 6b example members area + OAuth | examples/full-site | 3, 4, 6a |

Lanes: **Lane A** 1 → 2 → 3 (cartridge-kit then ssr). **Lane B** 6a (independent of every framework change; can start on day one). **Lane C** 4, after 2, in parallel with 3. Then 5, then 6b. Launch A and B in parallel worktrees; after step 2 launch C beside A's step 3; merge; 5; 6b. Conflict flag: steps 2 and 4 both touch `packages/core` (`schema.ts` vs `page-manager.ts`, different files, low risk); step 5 touches every `package.json`, so run it alone.

### TODOS.md (create at implementation time, repo format)

- **Studio dev-mode gate memo, designed with the studio consumer** (D24). What: a studio-only way to skip re-running allowed gates on per-keystroke editor remounts. Why: D19 chose freshness for production remounts and deferred the editor case. Context: the studio consumer's `gates-rearchitecture/README.md`; the bridge reply asks them for remount frequency; candidate shapes are an `update()` option `{ skipGates: true }` or an editor-side hot-swap for style-only deltas. Depends on: 0.11.0 landing and the studio consumer's number.
- **Extract the demo OAuth provider into `examples/demo-oauth-provider`** (D25). What: a standalone stand-in server other examples point `AUTH_ISSUER` at. Why: full-site reads as gate + relying party; the edge-worker example can reuse it when it grows a login. Context: kept in-process now so `pnpm dev` runs alone; mechanical once 6b lands. Depends on: 6b; a second example wanting a login.

## Implementation Tasks
Synthesized from this review's findings. Each task derives from a specific finding above. Run with Claude Code or Codex; checkbox as you ship.

- [ ] **T1 (P1, human: ~20min / CC: ~3min)** — ssr — Add `renderPrivate` as the explicit unlock; `scope` never decides
  - Surfaced by: Architecture — D3
  - Files: packages/ssr/src/render-with-publication.ts, packages/ssr/test/render-with-publication.test.ts
  - Verify: private entry with a country-only input still refuses; `renderPrivate: true` renders adapter-free
- [ ] **T2 (P2, human: ~45min / CC: ~6min)** — example auth — Harden the demo provider: registered client, exact `redirect_uri`, `client_id` at token, conditional `Secure`
  - Surfaced by: Architecture — D4
  - Files: examples/full-site/src/auth/oauth-provider.ts, examples/full-site/src/auth/session.ts, examples/full-site/scripts/smoke.mjs
  - Verify: smoke assertions for wrong client, trailing-slash redirect, `X-Forwarded-Proto: https`
- [ ] **T3 (P1, human: ~40min / CC: ~6min)** — ssr + runtime — Define F9's edges: `pending` minus `satisfied`; attribute resolves on every exit (`passed` / `blocked` / `error`)
  - Surfaced by: Architecture — D5, D16
  - Files: packages/ssr/src/render-with-publication.ts, packages/runtime/src/mount-cartridge.ts, both test suites
  - Verify: five runtime exits + "attribute absent → never written"; runner `satisfied` with and without `renderPrivate`
- [ ] **T4 (P2, human: ~1h / CC: ~8min)** — cartridge-kit + runtime — Remove gates from `createCartridgeApp` (sync, returns `App`); one `runGatePhase` in `gate-phase.ts`
  - Surfaced by: Code quality — D6
  - Files: packages/cartridge-kit/src/cartridge-app.ts, packages/cartridge-kit/src/gate-phase.ts, packages/cartridge-kit/src/run-gates.ts, packages/cartridge-kit/src/index.ts
  - Verify: `cartridge-app.test.ts` (sync wrapper), `gate-phase.test.ts`, `run-gates.test.ts` two-gate `blockedBy`
- [ ] **T5 (P1, human: ~30min / CC: ~5min)** — core + cartridge-kit — `TemplatePage.private` → `Page.private` round trip; `selectGates` reads the entry page
  - Surfaced by: Outside voice — D13 (replaces D7)
  - Files: packages/core/src/schema.ts, packages/cartridge-kit/src/template.ts, packages/cartridge-kit/src/template-to-app-config.ts, packages/cartridge-kit/src/gate-phase.ts
  - Verify: round-trip test carries and omits `private`; `selectGates` public / private / unresolved entry
- [ ] **T6 (P1, human: ~25min / CC: ~4min)** — ssr — Page-private-first precedence over view csr-only; four-row truth table in JSDoc and tests
  - Surfaced by: Code quality — D8
  - Files: packages/ssr/src/render-with-publication.ts, packages/ssr/test/render-with-publication.test.ts
  - Verify: one test per row
- [ ] **T7 (P2, human: ~20min / CC: ~3min)** — example — Shared `signInPanel(next)` and `memberSliceFor(userId, slug)`
  - Surfaced by: Code quality — D9
  - Files: examples/full-site/src/cartridge.ts, examples/full-site/src/server.ts
  - Verify: smoke compares the rendered name with `/api/members/me`
- [ ] **T8 (P2, human: ~3h / CC: ~25min)** — example tests — happy-dom vitest + Playwright Chromium e2e wired into the CI examples job
  - Surfaced by: Test review — D10
  - Files: examples/full-site/vitest.config.ts, examples/full-site/test/gate.test.ts, examples/full-site/e2e/members.spec.ts, examples/full-site/package.json, .github/workflows/ci.yml
  - Verify: `pnpm --filter @airo-js-examples/full-site test` and `e2e` green in CI
- [ ] **T9 (P1, human: ~45min / CC: ~7min)** — runtime + example — `satisfiedGates` option; host emits `data-airo-gates-satisfied`; client passes it; initial mount only
  - Surfaced by: Outside voice — D16, D19
  - Files: packages/runtime/src/mount-cartridge.ts, examples/full-site/src/server.ts, examples/full-site/src/client.ts
  - Verify: `precheck` never called on a satisfied initial mount, called on the same handle's `update()`
- [ ] **T10 (P1, human: ~1.5h / CC: ~12min)** — core + runtime — `resolveMountEntry` implements URL > hint > default once; PageManager and the gate phase use it
  - Surfaced by: Outside voice — D14
  - Files: packages/core/src/page-manager.ts, packages/core/src/index.ts, packages/runtime/src/mount-cartridge.ts
  - Verify: path-router mount at `/members` with no `initialNavState` runs the private gate; PageManager suite unchanged
- [ ] **T11 (P1, human: ~30min / CC: ~5min)** — runtime — Snapshot `renderRoot.innerHTML` before gates in hydrate mode; restore on allow when a gate painted
  - Surfaced by: Outside voice — D15
  - Files: packages/runtime/src/mount-cartridge.ts, packages/runtime/test/fixtures.ts, packages/runtime/test/mount-cartridge.test.ts
  - Verify: `paintingGate` allow → SSR markup back; block → paint stays
- [ ] **T12 (P1, human: ~15min / CC: ~2min)** — example — Member slice keyed on the entry page's `private` flag, never on session presence
  - Surfaced by: Outside voice — D18
  - Files: examples/full-site/src/server.ts, examples/full-site/scripts/smoke.mjs
  - Verify: signed-in `/` byte-identical to anonymous, no `Vary: Cookie`
- [ ] **T13 (P2, human: ~10min / CC: ~2min)** — cartridge-kit + ssr — Do not add `CartridgeAppContext.scope` or an SSR `scope` option; docs state identity rides the snapshot
  - Surfaced by: Outside voice — D17
  - Files: docs/best-practices.md, packages/cartridge-kit/src/view.ts (unchanged), packages/ssr/src/render-with-publication.ts (unchanged)
  - Verify: `rg -n "CartridgeAppContext.*scope|opts\.scope" packages/*/src` returns nothing new
- [ ] **T14 (P2, human: ~10min / CC: ~2min)** — example — No inline snapshot block; private mounts refetch via `membersSource`; `Vary: Cookie` on private responses
  - Surfaced by: Outside voice — D20 (supersedes D11)
  - Files: examples/full-site/src/server.ts, examples/full-site/src/client.ts
  - Verify: smoke asserts no `data-airo-snapshot` anywhere
- [ ] **T15 (P1, human: ~30min / CC: ~5min)** — bridge — Post both responses with shapes marked proposed; set threads `in-progress`
  - Surfaced by: Outside voice — D22
  - Files: (bridge posts; text in "Bridge responses")
  - Verify: both threads show the reply and `in-progress`
- [ ] **T16 (P2, human: ~30min / CC: ~5min)** — example — Land 6a (serve `client.js`, esbuild, Playwright `data-last-click`) alone before 6b
  - Surfaced by: Outside voice — D23
  - Files: examples/full-site/package.json, examples/full-site/src/server.ts, examples/full-site/e2e/public.spec.ts
  - Verify: CI green on 6a's commit alone
- [ ] **T17 (P1, human: ~30min / CC: ~5min)** — runtime — CRITICAL regression test: `update()` / `updatePages()` blocked by a gate on remount throws the documented error
  - Surfaced by: Test review — regression rule
  - Files: packages/runtime/test/mount-cartridge.test.ts
  - Verify: both remount paths reject with `/blocked by gate/`
- [ ] **T18 (P1, human: ~20min / CC: ~3min)** — example auth — `/auth/callback` handles an unreachable token endpoint with a 502 and no cookie; session map TTL + sweep
  - Surfaced by: Failure modes — critical gap
  - Files: examples/full-site/src/auth/session.ts, examples/full-site/scripts/smoke.mjs
  - Verify: smoke points `AUTH_ISSUER` at a closed port for one callback and asserts 502 + no `Set-Cookie`
- [ ] **T19 (P1, human: ~40min / CC: ~6min)** — cartridge-kit — `RunGatesResult` names the blocker; delete `firstBlockedGateId`; gate lifecycle events
  - Surfaced by: Context — wrong `blockedBy` (F5), consumer A5 (F6)
  - Files: packages/cartridge-kit/src/run-gates.ts, packages/cartridge-kit/test/run-gates.test.ts
  - Verify: allower-then-blocker names the blocker; events in order

## Order of work (each step green on `pnpm build && pnpm typecheck && pnpm lint && pnpm knip && pnpm test`)

0. Copy this plan to `docs/designs/gate-reshape-0.11.md` and commit it (so the bridge's `readDoc` serves it); post the new bridge message and the two thread replies (after plan approval — outward-facing), shapes marked proposed (D22, D27); mark both threads `in-progress`.
1. cartridge-kit: F5 (`RunGatesResult`, delete the re-walk) + F6 events; new `run-gates.test.ts` with the two-gate `blockedBy` case first.
2. core + cartridge-kit: F1 `Page.private` / `TemplatePage.private` + round trip, F3 `appliesTo` + `gate-phase.ts` (`selectGates`, `runGatePhase`), F4 gates removed from `createCartridgeApp` (sync, returns `App`), F8 `persist`, F10 `factory?` + resolver fallthrough; barrel + `CONTRACT_VERSION`; tests (`gate-phase`, `cartridge-app` as a sync wrapper: context, resolver precedence, `cartridge-registry` fallthrough).
3. ssr: F1 private refusal/render before adapters + `renderPrivate` (F2), F9 `gates.pending` / `gates.satisfied`; tests in `render-with-publication.test.ts`; fixture rename in `filter-server-safe-cartridge.test.ts`.
4. core `resolveMountEntry` (F12) + PageManager refactor; runtime: F4 reorder + `InnerMount` + `'gate'` phase + D15 hydrate stash/restore, F9 attribute flip, `satisfiedGates` option (D16/D19); tests + fixtures (`privateTemplate()`, `loginGate(record)`, `paintingGate`, a counting precheck); README. **Tracer bullet:** `pnpm yalc:push` and run the studio consumer's repo's suite (their age gate, `preloadedData`, `persist` object form) before continuing.
5. Docs + changelog + version bump; `./scripts/publish.sh` dry run.
6a. Example, public site only (D23): serve `dist/public`, esbuild bundle, `<div id="app">` wrapper, `examples/full-site/vitest.config.ts` + Playwright harness in CI, and the `data-last-click` e2e green — the first time this example's hydrate path runs in a browser, landed alone so a hydrate bug has one suspect.
6b. Example, members area: content + cartridge (tracer: `membersView` + `loginGate`, then `noteView`), auth modules with D4 hardening, server routes, `satisfiedGates` wiring, smoke, `gate.test.ts`, `members.spec.ts`, README.

Commits: 1+2, 3, 4+5, 6a, 6b. Estimate: framework ~3 days, example ~3 days, docs + responses ~0.5 day.

## Verification

1. `pnpm build && pnpm typecheck && pnpm lint && pnpm knip && pnpm test` — green, including: two-gate `blockedBy` names the blocker; `DataSource.fetch` and transformers never run on a blocked mount; `precheck` runs once; `onError('gate')`; `appliesTo: 'private'` skipped on a public entry, run on a private entry and on `views: []`; private entry without `renderPrivate` → empty html, no adapter call, `skipped.reason === 'private'`; with `renderPrivate: true` → html, no adapters, `gates.satisfied` lists the private-scoped gate; `gates.pending` lists enabled gates; `data-airo-gate` flips only when present; capability-only view falls through to the mailbox; gate events in order; `satisfiedGates` skips the named gate on the initial mount only and the same handle's `update()` re-runs it.
2. `pnpm --filter @airo-js/embed size:check` — unchanged.
3. `cd examples/full-site && PORT=4317 pnpm dev` then `pnpm smoke` — 27 existing + ~25 new pass; the OAuth walk (authorize → code → PKCE token → session cookie) completes with `demo`/`demo`; anonymous `/members` is a 401 shell, signed-in `/members` is server-rendered with no JSON-LD and `no-store`.
4. Browser check via the `browse` skill: `/` → "Members" → gate paints, no `/api/members/me` request; sign in `demo`/`demo` → back on `/members` (server-rendered) → precheck allows, hydrate, no flash; open a note; sign out → gate again. Then `/doc/why-snapshots`: click a card and confirm `data-last-click` ([cartridge.ts:186-189](examples/full-site/src/cartridge.ts#L186-L189)) — hydration has actually run.
5. `curl -I localhost:4317/members` → `401`, `Cache-Control: private, no-store`, `Vary: Cookie`, `X-Robots-Tag: noindex`; `/sitemap.xml` and `/llms.txt` contain no `/members` or `/note/`; a signed-in `/members` page load shows exactly two requests in the browser network log besides `client.js`: the document and one `/api/members/me` (D20), and **no** `/auth/session` (D16/D19).
6. `./scripts/publish.sh` dry run green; optional `pnpm yalc:push` + the studio consumer's repo `pnpm test`.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | STALE (2026-05-08, different plan) | 7 proposals, 5 accepted, 7 deferred |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 2 | CLEAR (PLAN) | 25 issues, 0 critical gaps open (1 flagged, folded as T18) |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | STALE (2026-05-08, different plan) | score: 3/10 → 9/10, 8 decisions |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **CROSS-MODEL:** outside voice ran as a Claude subagent (Codex CLI could not use the configured model). 12 points: 7 accepted (page-graph `private`, `resolveMountEntry`, hydrate restore, F9 satisfied state, page-keyed slice, no `scope` side channel, split 6a/6b), 1 accepted as a cut (F11 verdict cache), 1 accepted against the reviewer's lean (no inline snapshot), 1 kept (OAuth provider), 1 middle path (post now, shapes marked proposed), 1 absorbed (precheck round trip, by D16/D19).
- **VERDICT:** ENG CLEARED — ready to implement. CEO and Design reviews on file predate this plan; neither gates shipping.

NO UNRESOLVED DECISIONS
