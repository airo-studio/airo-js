<!-- Design doc, status: PROPOSED (not yet reviewed), 2026-10-08. Decides the render contract that freezes at 1.0. Consumer names are anonymised: "the marketplace consumer" is the downstream team whose site the native adapter was proven on. Numbers from that consumer's source are counts only. -->

# One tree, three walkers: a render contract for 1.0

## Proposal

A view's `template(ctx)` returns a **render tree**: plain data describing elements, text and trusted raw HTML. The framework owns three **walkers** that turn one tree into output for each target:

| Walker | Target | Where it runs | Lives in |
|---|---|---|---|
| `toHTML(tree)` | SSR: an HTML string | server, edge, build | `@airo-js/render` |
| `toDOM(tree, el)` | CSR: browser DOM | browser | `@airo-js/render` |
| `toLynx(tree, parent)` | NSR: native elements through Lynx's Element PAPI | device main thread | `@airo-js/lynx` |

Strings stay valid. `template` accepts `string | RenderNode`, so every existing view keeps working unchanged. What changes at 1.0 is what the docs, the examples and the `create-airo` scaffold **teach**: a view returns a tree, the framework escapes it, and the same tree paints on every target.

**Recommended rollout: ship it before 1.0** (Option B below). The rest of this doc is the case, the shape, and six open decisions (R1–R6) for review.

## Why now: the 1.0 freeze

`defineSSRSafeRenderer` freezes at 1.0 with `template: (ctx: RenderContext<TPageType, TAppContext>) => string;` ([define-ssr-safe-renderer.ts:59](../../packages/cartridge-kit/src/define-ssr-safe-renderer.ts#L59)). Widening that type after 1.0 would still compile for every author, because only the factory calls `template` ([L103](../../packages/cartridge-kit/src/define-ssr-safe-renderer.ts#L103), [L109](../../packages/cartridge-kit/src/define-ssr-safe-renderer.ts#L109)). So adding trees later is not an API break.

The cost of waiting is the story, not the types. A developer who installs airo-js at 1.0 learns "a view returns an HTML string you escape by hand". If trees arrive at 1.1, the docs carry two ways to write a view, and the scaffold teaches the older one until it is rewritten. Deciding the vocabulary before the freeze is cheap; changing what every tutorial and scaffold says after it is not.

## Context: three paths, three representations

| Path | Today | Representation |
|---|---|---|
| SSR | `renderSSR(container)` sets `container.innerHTML = template(ctx)` on a document from linkedom or deno-dom, then reads `container.innerHTML` back ([render-app.ts:254-264](../../packages/ssr/src/render-app.ts#L254-L264)) | HTML string, round-tripped through a server-side DOM |
| CSR | `targetEl.innerHTML = opts.template(ctx)` ([define-ssr-safe-renderer.ts:103](../../packages/cartridge-kit/src/define-ssr-safe-renderer.ts#L103)) | HTML string, parsed by the browser |
| NSR | `@airo-js/lynx` parses server HTML with a strict tokenizer into `ParsedNode`s, then builds Lynx elements and a JS node model ([tokenize.ts](../../packages/lynx/src/runtime/tokenize.ts), [tree.ts](../../packages/lynx/src/runtime/tree.ts), [node-model.ts](../../packages/lynx/src/runtime/node-model.ts)) | HTML string, parsed back into a tree on the UI thread |

The HTML string is the only shared format, and every target either parses it or round-trips it through a DOM. Three costs follow from that:

- **Escaping is the author's job.** The marketplace consumer's templates call the escape helper 1,109 times in 5,393 lines. Its button helper carries the rule "`label` is trusted markup only when the caller built it; plain strings are escaped by the caller". The `create-airo` scaffold teaches the same pattern: `escapeHtml(p.title)` and `escapeAttr(p.slug)` on every interpolated value.
- **Native parses what the server just printed.** Every page and every hydrate `innerHTML` write (18 plus 9 `insertAdjacentHTML` in that consumer) is tokenized on the device's UI thread. The tokenizer is strict by design: it refuses named entities beyond the five `escapeHtml` emits.
- **SSR needs a DOM implementation** only to set `innerHTML` and read it back.

## Design

### The node

```ts
export type RenderNode = ElementNode | TextNode | RawNode;

export interface ElementNode {
  kind: 'element';
  tag: string;                                // lowercase for HTML; as written inside <svg>
  attrs: [name: string, value: string | true][]; // source order; `true` = boolean attribute
  children: RenderNode[];
  foreign: boolean;                           // true for <svg> and its descendants
}
export interface TextNode { kind: 'text'; text: string }      // escaped by every walker
export interface RawNode  { kind: 'raw'; html: string }       // trusted HTML, escaped by nobody
```

This is the Lynx tokenizer's `ParsedNode` ([tokenize.ts:27-43](../../packages/lynx/src/runtime/tokenize.ts#L27-L43)) plus `RawNode` and boolean attributes. That shape is already conformance-tested against a browser-grade parser on real pages, so the 1.0 node is not a new design: `@airo-js/render` owns the type and `@airo-js/lynx` imports it.

The tree is plain, JSON-serialisable data. That keeps templates pure (rule 1 of the SSR-safe shape), makes trees comparable in tests, and leaves room to send a tree to a device instead of HTML (R5).

### Authoring: the `html` tagged template

```ts
import { html, raw } from '@airo-js/render';

template(ctx) {
  const posts = ctx.app.data.posts;
  return html`
    <div class="site-page">
      <h1 class="site-title">${site.name}</h1>
      <ul>${posts.map((p) => html`
        <li><a class="site-card__link" href="/post/${p.slug}">${p.title}</a></li>`)}
      </ul>
      <section>${raw(post.sections[0].html)}</section>
    </div>`;
}
```

- **Interpolations are slots, not text.** `${p.title}` becomes a `TextNode`; `href="/post/${p.slug}"` becomes an attribute value. Walkers escape both, so authors never call `escapeHtml`.
- **Children compose.** A slot accepts a node, a string, a number, an array, or `false`/`null`/`undefined` (rendered as nothing). Lists are `map`, conditionals are `&&` or a ternary.
- **Trusted HTML is explicit.** `raw()` is the only way to insert markup, so a grep for `raw(` lists every trust decision. The scaffold's `Section.html` field ("Trusted HTML you authored. It is inserted as-is, never escaped") becomes `raw(section.html)`.
- **Parsed once per call site.** The tag parses its static parts on first use and caches the result on the template-strings array (the technique htm uses), so steady-state cost is filling slots, not parsing.

The tag was chosen over JSX and hyperscript because it reads like today's templates. Migration is mostly adding `html` before the backtick and deleting escape calls, and it needs no build configuration, which matters for the scaffold's first run. JSX can be added later as a second front end that produces the same `RenderNode` (R2); because the node is the contract, the syntax is not a one-way door.

### The walkers

- **`toHTML(node): string`** escapes text and attribute values with exactly `escapeHtml`'s five entities ([escape.ts:53-57](../../packages/core/src/escape.ts#L53-L57)), prints void elements without a closing tag, prints `raw` verbatim, and keeps foreign (SVG) names as written. About 60 lines.
- **`toDOM(node, el)`** is `el.innerHTML = toHTML(node)` in its first version. Same output by construction, no second serialiser to keep in step, smallest browser bytes. A node-by-node DOM builder is an optimisation for later, if one is ever needed.
- **`toLynx(node, parent)`** is the existing Lynx tree builder fed `RenderNode`s directly instead of the tokenizer's output. `RawNode`s still go through `tokenize`, so the tokenizer stays, for trusted HTML only.

Hydrate-only browser views (`defineHydrateOnlyRenderer`) never render in the browser, so sites built the way the marketplace consumer is ship no template, no `html` tag and no walker to visitors.

### How it plugs into today's contract

1. `@airo-js/core` exports `type Renderable = string | RenderNode`. `SSRSafeRendererOptions.template` returns `Renderable`.
2. `defineSSRSafeRenderer` paints through one helper, `paint(target, renderable)`:
   - a string is assigned to `innerHTML`, exactly as today;
   - a node is handed to the target's tree method if the target has one (the Lynx native target does), otherwise `innerHTML = toHTML(node)`.
3. `renderAppToHTML` and `renderAppWithPublication` are unchanged. A tree view's `renderSSR` produces the same container HTML through `toHTML`. Skipping the server-side DOM for tree views is a later optimisation, not part of this doc.
4. `@airo-js/lynx`'s native target implements the tree method, so a template that runs on the device paints without a string round trip. Today no template runs on the device: the marketplace consumer's server sends HTML (eng review D11). The method is there for when one does.

### Hydrate is out of scope

One tree unifies **painting**. It does not unify **behaviour**: `hydrate(root: HTMLElement, ctx)` stays as it is, and on native the bounded DOM facade in `@airo-js/lynx` still runs browser hydrate code. In the marketplace consumer that is 3,735 lines of DOM code.

A target-neutral hydrate would give the full "write once" (sketch: elements named in the tree, `ref="join"`, arrive in hydrate as handles with tap and value events instead of an `HTMLElement` to query). It is a larger design with its own consumer validation, and it does not need to freeze at 1.0: it would be a new, optional hydrate signature. This doc says so up front so "one tree" is not oversold at 1.0.

## Rollout options

**Option A — strings at 1.0, tree later.** Cheapest now. 1.1 adds trees as a widening, and the docs and scaffold then teach two ways until rewritten.

**Option B — tree at 1.0, strings still accepted.** **Recommended.** Ship `@airo-js/render` on the framework line. Widen `template` to `Renderable`. Move the scaffold, the examples and best-practices §5 to `html` templates, with strings documented as accepted, not taught. Existing consumers migrate when they choose.

**Option C — vocabulary at 1.0, tree later.** Type `template` as returning `Renderable` (= `string` at 1.0), and write the docs around "a view returns renderable output". Ship the tree after 1.0 as a widening of that alias.

I'd recommend B, which updates my earlier lean towards C. Three reasons:

1. **No consumer is forced to move.** With `string | RenderNode`, B's cost is the framework, the scaffold, the docs and the examples, not every consumer's templates. That was the largest cost I attributed to B before.
2. **The node is already proven.** It is the tokenizer's tree, conformance-tested on real pages. What is genuinely new is the `html` tag, and its semantics (slots, `raw`, caching) are well-trodden ground.
3. **The syntax is not a one-way door.** JSX, or anything else, can produce the same `RenderNode` later. The freeze locks the node and the walkers' output rules, which are the parts with evidence behind them.

C stays defensible if the 1.0 date is fixed and tight. It locks the vocabulary in the docs and scaffold and spends nothing else.

**Size of B** (estimates, for review):

| Work | Size |
|---|---|
| `@airo-js/render`: node types, `html` tag with call-site cache, `raw`, `toHTML`, `toDOM`, tests | ~400 LOC + tests |
| `@airo-js/core` `Renderable`; `defineSSRSafeRenderer` `paint` | ~40 LOC |
| `@airo-js/lynx`: accept `RenderNode` in the tree builder; native target tree method | ~60 LOC |
| Scaffold (`create-airo` site template: 2 views) and repo examples (12 views across 3 examples) | migration |
| best-practices §5 (SSR-safe rendering) and the escaping guidance | docs |
| Human / CC | ~1.5–2 weeks / ~1 day, before migrations |

## Performance

The tree must not make any path slower. A benchmark measured each path on the marketplace consumer's largest page: 276 elements, 736 dynamic slots, 21,592 characters of HTML. It used Node 24 (V8), took the median of 25 batches × 200 renders, and ran three times. Both template forms were generated from the same parsed page with the same slots, and the benchmark asserts they print identical HTML before timing anything.

| Path | Median per render (range over 3 runs) | Relative |
|---|---|---|
| A — string template, as authors write today | 73–199 µs | baseline |
| B — tree build (`html` tag after its first call) | 26–92 µs | — |
| C — tree build + `toHTML` | 95–214 µs | **1.07–1.29× A** |
| D — `tokenize(html)`, the device parse today | 360–453 µs | — |
| E — `JSON.parse` of the tree as JSON | 179–344 µs | **0.47–0.76× D** |
| F — linkedom `innerHTML` set + get, the SSR round trip today | 2,460–5,032 µs | **20–40× A** |

Absolute times moved with machine load; the ratios held. What they say:

- **Producing a string through a tree costs 7–29% more than concatenating one**, which is tens of microseconds on the largest page measured. That is the tree's real overhead, and it applies to SSR and to CSR-only views.
- **Server rendering is dominated by the DOM round trip, not the template.** Today's SSR is A + F; with a tree it is C + F, which is 0.3–0.7% slower end to end.
- **Skipping the server DOM is a separate, much bigger win, and it is not a tree feature.** A pure template's output can be returned directly instead of being set on a linkedom container and read back. That cuts the page from about 2.6–5.2 ms to about 0.1–0.2 ms, and string templates qualify as much as trees do. The tree only makes it safe by construction, because a tree view cannot touch the DOM in `render`. See R7.
- **On the device, a tree beats HTML.** Parsing tree JSON costs half to three-quarters of tokenizing HTML, though the JSON is 2.1× the bytes on the wire (44,657 against 21,592 characters). A template that builds its tree on the device costs 0.07–0.21× the tokenize. These are V8 numbers; the device runs PrimJS, so absolute times there are unmeasured.

**Gates the implementation must hold** (a ratio check in `@airo-js/render`'s benchmark, run before each release, not in CI, because absolute timings are noisy):

1. Tree build + `toHTML` stays within **1.3×** the equivalent string template on the benchmark page.
2. SSR end to end (`renderAppWithPublication`) is not slower than the string path by more than **2%**.
3. On the iOS simulator, the manual device script times `tokenize`, tree-JSON parsing and an on-device tree build on the largest page. This extends the existing parse-timing TODO; no device path ships until it has a number.

The benchmark needs a vendor-neutral page fixture in the repo of comparable size (about 250–300 elements), so it runs without any consumer's code.

## Open decisions (R1–R7)

| ID | Decision | Options | Recommendation |
|---|---|---|---|
| R1 | Rollout | A strings at 1.0 · B tree at 1.0, strings accepted · C vocabulary only | B |
| R2 | Taught syntax | `html` tag · JSX · both | `html` tag at 1.0; JSX later as an additive front end if asked for |
| R3 | Package home | new `@airo-js/render` on the framework line · inside `@airo-js/core` | new package: the name is the concept a 1.0 developer meets; core re-exports `Renderable` |
| R4 | Native paint seam | target tree method · always through `toHTML` | target tree method: it is the only path that avoids parsing on the UI thread |
| R5 | What a server sends a device | HTML (today, eng review D11) · tree JSON for templated output | keep HTML at 1.0; tree JSON is a later, additive option for the `@airo-js/lynx` line, decided on the device timing (gate 3), since it parses faster but sends 2.1× the bytes |
| R6 | Hydrate at 1.0 | out of scope (stated in docs) · design a target-neutral hydrate now | out of scope; design it after 1.0 with a second native consumer |
| R7 | SSR fast path: skip the server DOM for pure templates | do it with this work · separate change · not at all | separate change, string and tree templates alike: it is the largest speed-up measured (about 20–40× on the page) and does not depend on R1 |

## Tests

- **`toHTML` golden tests:** text and attribute escaping (the five entities), boolean attributes, void elements, `raw` verbatim, SVG names preserved.
- **`html` tag table tests:** slots in text, whole attributes and partial attribute values; arrays, numbers, `false`/`null`/`undefined`; nested templates; `raw`; malformed static markup throws at first use with the call site named.
- **One-tree invariant on web:** for every example view, `toHTML(tree)` equals the container `innerHTML` after `toDOM` in happy-dom.
- **One-tree invariant on native:** `toLynx(tree)` builds the same node model as `toLynx(tokenize(toHTML(tree)))`. This proves the direct path and the HTML path paint the same thing.
- **Migration safety net:** each migrated example view's tree output equals its former string output, byte for byte.

## Risks

- **Double escaping during migration.** `${escapeHtml(x)}` inside an `html` template escapes twice, so the user sees `&amp;amp;`. Mitigation: a test in the repo, and a lint rule offered to consumers, that flags `escapeHtml`/`escapeAttr` inside `html` slots.
- **Markup-returning helpers.** A helper that returns a markup string (the consumer's `button()`) renders as escaped text inside `html`. It fails visibly, not unsafely. Mitigation: helpers return nodes; `raw()` is the stopgap.
- **Speed.** Measured, not assumed (see Performance): 7–29% more to produce a string through a tree, 0.3–0.7% end to end in SSR, faster than today on the device. Gates 1–3 keep it that way.
- **Bundle size.** The tag and walkers are about 1–2 KB minified and ship only where templates run. Hydrate-only browser views ship none of it. The embed size gate (2.5 KB gzip) is unaffected, because embed carries no templates.

## Not in scope

- A target-neutral hydrate contract (R6).
- A JSX front end, unless R2 chooses it.
- SSR without a server-side DOM for tree views.
- Sending tree JSON to devices (R5).
- Android and non-Lynx native engines.

## Eng review (2026-10-08)

Target: this document. Reviewer: /plan-eng-review. Report file: this document; review records follow, and the terminal `## GSTACK REVIEW REPORT` closes the file.

### Scope record (Step 0 B)

feature answers: D1 = B "Keep it in 1.0" (user answer, 2026-10-08): the native tree path stays in the pre-1.0 work, meaning R4's paint seam in `defineSSRSafeRenderer` plus `@airo-js/lynx`'s native target accepting a `RenderNode` directly, with the native one-tree test; structure: B "Smaller arrangement" (D2, user answer, 2026-10-08): the same API as a subpath export of core, `@airo-js/core/render` (`packages/core/src/render/*`), used by cartridge-kit and lynx through their existing core peer, with no new package, peer edge or publish.sh entry (about 20 files); accepted scope: the proposal's feature list (node types, `html` tag, `raw`, `toHTML`, `toDOM`, `Renderable` accepted by `defineSSRSafeRenderer`, the paint seam with the native tree method, migration of the scaffold, examples and best-practices §5), arranged under `@airo-js/core/render`, rollout timing pending R1; pending remedies: none.

**Scope Challenge result:** scope accepted as-is (D1 kept the native path; D2 changed arrangement, not scope). MODE: FULL_REVIEW.

### Scope Challenge C: findings

1. **S1 [P1] (confidence: 9/10) docs/designs/render-tree-contract.md "Rollout options"** — The proposal's central choice is open: "**Recommended rollout: ship it before 1.0** (Option B below)". Everything else in the review depends on whether the tree is taught at 1.0. Reviewer: plan-eng-review. → R1.
2. **S2 [P2] (confidence: 9/10) scaffold distribution** — The proposal counts "Scaffold (`create-airo` site template: 2 views)" as migration, but the scaffold's source is not in this repository: it ships as beta tarballs (`create-airo-1.0.0-beta.2.tgz`) built outside it, and its site template teaches `escapeHtml(p.title)` / `escapeAttr(p.slug)` on every slot and a trusted `Section.html` field. Disposition: required implementation of whichever rollout R1 picks: the scaffold change follows the beta ritual (bump the beta, run its end-to-end check, repack, re-verify, reply on its bridge thread).

## Decision ledger

### R1: Rollout timing
Finding: S1, P1, confidence 9/10, docs/designs/render-tree-contract.md "Rollout options", plan-eng-review
Plan baseline: the proposal recommends Option B (tree at 1.0, strings still accepted); Options A and C are described as alternatives. Scope record D1/D2 fixes what ships and where, not when.
Runtime evidence: `template: (ctx: RenderContext<TPageType, TAppContext>) => string;` freezes at 1.0 (define-ssr-safe-renderer.ts:59) and only the factory calls it (L103, L109), so widening after 1.0 compiles for every author; the cost of waiting is that docs and the scaffold teach strings at 1.0. Measured cost of the tree: 1.07–1.29× the string template to produce HTML, +0.3–0.7% end to end in SSR (Performance section).
Comparison grid:
| Choice | Current | A) Strings at 1.0, tree after | B) Tree at 1.0, strings accepted | C) Vocabulary at 1.0, tree after |
|---|---|---|---|---|
| R1 rollout | undecided (proposal: B) | 1.0 freezes `template: (ctx) => string`; the docs and scaffold teach strings; the tree lands later as a widening, and the docs then carry two ways | `@airo-js/core/render` ships before 1.0; `template` returns `Renderable = string \| RenderNode \| RenderNode[]`; the scaffold, examples and best-practices §5 teach `html` templates; strings documented as accepted | 1.0 types `template` as returning `Renderable` (= `string` at 1.0); docs and scaffold say "a view returns renderable output"; the tree ships after 1.0 as a widening of that alias |
| D1, D2 | approved | the native path and the core subpath wait until the tree ships | unchanged | wait until the tree ships |
| 1.0 date | not fixed in this doc | unchanged | moves by the framework work (~1.5–2 weeks human / ~1 day CC) plus scaffold and docs migration | unchanged |
Question D3:
D3 — When should the tree reach developers: taught at 1.0, after 1.0, or only its vocabulary at 1.0?
Project/branch/task: airo-js, reviewing docs/designs/render-tree-contract.md on lynx-adapter.
ELI10: This is the decision the whole doc exists for. Option B teaches the tree from 1.0: the scaffold and docs show html templates that escape for you, and old string templates keep working. Option A freezes string templates as the 1.0 story and adds the tree later, which means two ways to write a view in the docs after that. Option C is the middle path: 1.0 only changes the words in the docs and the type name, and the tree itself comes later. The measured cost of the tree is small (tens of microseconds per page), so the trade is mostly time before 1.0.
Stakes if we pick wrong: shipping strings at 1.0 makes every tutorial and scaffold teach the pattern you want to replace; shipping the tree at 1.0 delays the freeze by the framework and migration work.
Recommendation: B because no consumer is forced to migrate (strings stay valid), the node is already proven in the tokenizer, and the developer you described meets one concept from day one.
Note: options differ in kind, not coverage — no completeness score.
Pros / cons:
A) Strings at 1.0, tree after
  ✅ 1.0 ships on its current timeline with no new render work in front of it
  ✅ The tree can be designed with more real use before anything about it freezes
  ❌ After 1.0 the docs and scaffold teach strings while the framework adds a second way
B) Tree at 1.0, strings accepted (recommended)
  ✅ A 1.0 developer meets one model: a view returns a tree, the framework escapes it
  ✅ No consumer migration is forced; string templates keep compiling and rendering
  ❌ 1.0 waits for ~1.5–2 weeks of framework work plus scaffold, examples and docs changes
C) Vocabulary at 1.0, tree after
  ✅ The words developers learn at 1.0 already fit the tree, at almost no cost now
  ✅ Keeps the 1.0 date while avoiding a later change of story
  ❌ The 1.0 developer still writes and escapes strings by hand until the tree arrives
Net: one model from day one against an earlier 1.0 with the tree to follow.
Header: Rollout
Options:
A) Strings at 1.0, tree after
Freeze `template: (ctx) => string` at 1.0; docs and scaffold teach strings; ship @airo-js/core/render after 1.0 as a widening. No pre-1.0 render work.
B) Tree at 1.0, strings accepted
(recommended) Ship @airo-js/core/render before 1.0 with the scope recorded above; `template` returns `Renderable`; scaffold, examples and best-practices §5 teach `html` templates; strings documented as accepted. Human ~1.5–2 weeks / CC ~1 day, plus migrations.
C) Vocabulary at 1.0, tree after
1.0 types `template` as returning `Renderable` (= string), and docs and scaffold say "renderable output"; the tree ships after 1.0 as a widening. Human ~0.5 day / CC ~15 min now.

State: approved
Actual answer: B) Tree at 1.0, strings accepted (D3, user answer, 2026-10-08)
Accepted scope: ship @airo-js/core/render before 1.0 with the scope recorded above; `template` returns `Renderable`; the scaffold, examples and best-practices §5 teach `html` templates; strings documented as accepted.
History: none

Approval readiness: PASS. Checked: scope record D1, D2; R1 (D3), R2 (D4), R3 (D5), R4 (D6), R5 (D7, mechanism corrected by T3), R6 (D8), R7 (D9), R9 (D11), R10 (D12), R11 (D13); carried remedies cite the approved decision they prove or complete (A2, A3, A6, Q2, Q4, T2–T6, F1, F2, F4, F5, O4, O5); T4's regression contract is carried exactly from D3. Unresolved: R8 (D10, investigating).

## Section 1: Architecture review

1. **A1 [P1] (confidence: 9/10) docs/designs/render-tree-contract.md "Authoring: the `html` tagged template"** — The taught syntax is open decision R2, and it is what every 1.0 developer types. Nothing in the repo or the scaffold is configured for JSX: no `"jsx"` key in any tsconfig, 0 `.tsx` files, and the scaffold's own rule is written for template strings (`//   2. Listeners go in \`hydrate\`, never in \`template\`.`, scaffold cartridge.ts:184). → R2.
2. **A2 [P1] (confidence: 9/10) docs/designs/render-tree-contract.md "Tests", one-tree invariant on web** — The proposed test "`toHTML(tree)` equals the container `innerHTML` after `toDOM`" fails on the first apostrophe. Probe (linkedom, the SSR document): text `a & b < c > d " e ' f \u00a0g` serializes as `a &amp; b &lt; c &gt; d " e ' f &#160;g`, and in attributes `&`, `<` and `>` stay raw while `"` becomes `&quot;`; `escapeHtml` writes `&#39;` and `&quot;` everywhere (escape.ts:53-57). Disposition: factual correction to the test, no behaviour change. The web invariant becomes DOM equivalence (parse `toHTML(tree)` and the DOM output into the same DOM implementation and compare their serializations); the migration test (tree output equals the former string output) stays byte-exact, because both use `escapeHtml`'s five entities. SSR bytes do not change, since `renderSSR` still sets and reads `innerHTML` on the server document.
3. **A3 [P2] (confidence: 9/10) docs/designs/render-tree-contract.md "The node"** — Templates with several root elements have no node: `RenderNode = ElementNode | TextNode | RawNode` has no fragment, while the tokenizer the node is taken from already returns a list (`export function tokenize(html: string): ParsedNode[]`, packages/lynx/src/runtime/tokenize.ts:118). Disposition: required completion of the approved contract (D3): `html` returns `readonly RenderNode[]`, slots accept arrays, and `Renderable = string | RenderNode | readonly RenderNode[]`.
4. **A4 [P2] (confidence: 8/10) docs/designs/render-tree-contract.md "Escaping by construction"** — Escaping does not make URL and event-handler slots safe. A slot value `javascript:alert(1)` in `href`, `src` or `action` is escaped and still runs, and an `on*` attribute in a template would run on CSR. The first native consumer's templates have 0 `on*` attributes and 96 URL slots (`href="${` 59, `src="${` 28, `action="${` 9). The proposal's own rule already keeps listeners out of templates (scaffold cartridge.ts:184). → R3.
5. **A5 [P2] (confidence: 9/10) docs/designs/render-tree-contract.md R7** — Skipping the server DOM (R7) changes SSR bytes: today's output is linkedom's serialization (A2 probe: `'` and `"` raw in text, `&#160;` for U+00A0, `&` raw in attributes), while a direct `toHTML` writes `escapeHtml`'s entities. The first native consumer pins three server-rendered pages byte for byte in its tests. Disposition: factual note carried into R7's TODO context, no change to this plan (R7 stays a separate change).
6. **A6 [P2] (confidence: 8/10) packages/runtime/scripts/size-check.mjs, packages/embed/scripts/size-check.mjs** — The paint seam puts `toHTML` (and, with D1, the native tree check) inside `defineSSRSafeRenderer`, which every CSR bundle using it imports; embed is gated at ≤ 2.5 KB gzip (`const MAX_GZIP = 2.5 * 1024;`, embed size-check.mjs:24). Disposition: required proof of D3: `@airo-js/core/render` must tree-shake so hydrate-only bundles pull none of it, and both size checks are re-run and reported after the change (prior learning airo-review-loop-cost-drift).

Production failure per new path: an `html` template with malformed static markup throws at its first render, in production if no test rendered that view (covered in Failure modes and Section 3); a native target missing the tree method falls back to `innerHTML = toHTML(node)`, so a version skew between core and lynx paints through the tokenizer instead of failing.

### R2: Taught template syntax
Finding: A1, P1, confidence 9/10, docs/designs/render-tree-contract.md "Authoring", plan-eng-review
Plan baseline: the proposal teaches an `html` tagged template at 1.0 and lists JSX as a later, additive front end (R2 recommendation: "`html` tag at 1.0; JSX later as an additive front end if asked for"); D3 approved teaching the tree at 1.0.
Runtime evidence: no JSX configuration in the repo or the scaffold (0 `.tsx`, no `"jsx"` key); today's templates are template strings (scaffold cartridge.ts:190 `const page = (inner: string) => \`<div class="site-page">${inner}</div>\`;`); TypeScript supports a custom JSX runtime through `jsx: "react-jsx"` and `jsxImportSource`, which needs `.tsx` files and the setting in every cartridge's tsconfig.
Comparison grid:
| Choice | Current | A) `html` tag | B) JSX | C) Both at 1.0 |
|---|---|---|---|---|
| R2 syntax | undecided (proposal: `html` tag) | `html\`...\`` tagged templates in `.ts` files; parse once per call site; no build configuration; migration is adding `html` and deleting escape calls | `.tsx` files with `jsx: "react-jsx"` and `jsxImportSource: "@airo-js/core/render"`; compile-time element calls, typed attributes possible; every cartridge, example and the scaffold gains the tsconfig setting and file renames | both produce the same `RenderNode`; docs teach one primary form and document the other |
| D1, D2, D3 | approved | unchanged | unchanged | unchanged |
| migration of string templates | — | near-mechanical | rewrite into JSX syntax (`class`/`className` choice, attribute quoting, conditionals) | as A or B per file |
Question D4:
D4 — Which syntax does airo-js teach for writing a view at 1.0?
Project/branch/task: airo-js, reviewing docs/designs/render-tree-contract.md on lynx-adapter.
ELI10: Developers will type this every day, so it is the most visible choice in the whole design. An html tagged template looks almost exactly like today's templates, works in a plain .ts file with no build settings, and existing templates convert by adding the word html and deleting the escape calls. JSX is what React users know, gives editor checking of tags and attributes, but needs .tsx files and a tsconfig setting in every project, and existing templates must be rewritten. Both produce the same tree, so the other can be added later without breaking anything.
Stakes if we pick wrong: teaching JSX makes every first project need build configuration and every migration a rewrite; teaching the tag gives up editor type-checking of markup.
Recommendation: A because it keeps the first-run scaffold free of build configuration and makes migration near-mechanical, and JSX can be added later on the same node.
Note: options differ in kind, not coverage — no completeness score.
Pros / cons:
A) html tag (recommended)
  ✅ Reads like today's templates, so the scaffold and every migration change only a few characters per line
  ✅ Works in a plain .ts file with no tsconfig or bundler setting, which keeps the first run simple
  ❌ No editor type-checking of tag or attribute names; mistakes show up at the first render instead
B) JSX
  ✅ Familiar to React developers, with editor completion and type-checking of attributes
  ✅ Parsed at compile time, so there is no runtime parse even on the first call
  ❌ Every cartridge needs .tsx files and jsx settings, and every string template must be rewritten
C) Both at 1.0
  ✅ Developers choose the form they know; both produce the same RenderNode
  ✅ React teams adopt with JSX while string-template users migrate with the tag
  ❌ Two ways to write a view at 1.0, which is the confusion this design set out to avoid
Net: zero-config, near-mechanical migration against editor type-checking of markup.
Header: Syntax
Options:
A) html tag
(recommended) Teach `html\`...\`` tagged templates at 1.0 (plain .ts, no build settings); JSX stays a possible later front end on the same node. Human ~2 days for the tag / CC ~30 min.
B) JSX
Teach JSX at 1.0 with `jsxImportSource: "@airo-js/core/render"`; scaffold, examples and docs move to .tsx with the tsconfig setting; the tag is not shipped. Human ~2 days for the runtime + per-project config / CC ~30 min.
C) Both at 1.0
Ship the tag and a JSX runtime at 1.0, both producing RenderNode; docs pick one as primary and document the other. Human ~3 days / CC ~45 min.

State: approved
Actual answer: A) html tag (D4, user answer, 2026-10-08)
Accepted scope: teach `html\`...\`` tagged templates at 1.0 (plain .ts, no build settings); JSX stays a possible later front end on the same node.
History: none

### R3: URL and event-handler slots
Finding: A4, P2, confidence 8/10, docs/designs/render-tree-contract.md "Escaping by construction", plan-eng-review
Plan baseline: the proposal escapes text and attribute values in the walker and treats `raw()` as the only trust decision; it says nothing about URL schemes or `on*` attributes. D4 approved the `html` tag.
Runtime evidence: the first native consumer's templates have 0 `on*` attributes and 96 URL slots (`href="${` 59, `src="${` 28, `action="${` 9), all escaped today but none scheme-checked; the scaffold's rule is "Listeners go in `hydrate`, never in `template`" (scaffold cartridge.ts:184).
Comparison grid:
| Choice | Current | A) Refuse on*, neutralise script URLs | B) Refuse on* only | C) Document only |
|---|---|---|---|---|
| R3 `on*` attributes | unspecified | the `html` tag throws a named error at first use for any `on*` attribute, static or slot, pointing to `hydrate` | same as A | allowed; docs say "use hydrate" |
| R3 URL slots | escaped only | a slot value in `href`, `src`, `action`, `formaction` or `xlink:href` whose scheme (after trimming whitespace and control characters, case-insensitive) is `javascript:` or `vbscript:` renders as `about:invalid` and logs an error naming the attribute; other schemes and relative URLs pass | escaped only; docs tell authors to validate URLs | escaped only; docs mention the risk |
| D3, D4 | approved | unchanged | unchanged | unchanged |
Question D5:
D5 — Should the html tag also block event-handler attributes and javascript: links, beyond escaping?
Project/branch/task: airo-js, reviewing docs/designs/render-tree-contract.md on lynx-adapter.
ELI10: Escaping stops data from turning into markup, but two holes remain. A link whose address comes from data can be javascript:something, which escaping leaves intact and which runs when tapped. And an onclick written into a template runs in the browser, even though airo-js's own rule says listeners belong in hydrate. The tag can refuse onclick-style attributes outright (none exist in the first consumer's templates), and replace script links with a harmless about:invalid while logging an error, so one bad link in user data does not break the whole page.
Stakes if we pick wrong: without the checks, user-supplied links can run script in visitors' browsers; with them, an author who really wanted a script link gets a logged error instead.
Recommendation: A because the safety promise of the tree is the reason to teach it, both checks are cheap, and neither affects any existing template.
Completeness: A=10/10, B=7/10, C=4/10
Pros / cons:
A) Refuse on*, neutralise script URLs (recommended)
  ✅ Closes the two script paths escaping leaves open, so the escaping promise holds in practice
  ✅ No existing template breaks: the first consumer has no on* attributes and its URLs are ordinary
  ❌ A scheme check runs on every URL slot render, a small cost on pages with many links
B) Refuse on* only
  ✅ Enforces the existing listeners-in-hydrate rule at no runtime cost
  ✅ Leaves URL handling entirely to authors, who know their data
  ❌ A javascript: value from user data still reaches the page and runs when tapped
C) Document only
  ✅ No new behaviour to test or explain; the tag stays a pure escaper
  ✅ Authors keep full control over every attribute they write
  ❌ Both script paths stay open, and the docs' safety claim is only partly true
Net: closing the remaining script paths against a small per-render URL check.
Header: Safety
Options:
A) Refuse on*, neutralise script URLs
(recommended) The `html` tag throws at first use for any `on*` attribute; URL slots (`href`, `src`, `action`, `formaction`, `xlink:href`) with a `javascript:` or `vbscript:` scheme render `about:invalid` and log an error naming the attribute. Human ~0.5 day / CC ~15 min, with tests.
B) Refuse on* only
The tag throws at first use for any `on*` attribute; URL slots are escaped only and the docs tell authors to validate them. Human ~2 h / CC ~5 min.
C) Document only
No enforcement; best-practices §5 documents both risks. Human ~30 min / CC ~5 min.

State: approved
Actual answer: A) Refuse on*, neutralise script URLs (D5, user answer, 2026-10-08)
Accepted scope: the `html` tag throws at first use for any `on*` attribute (static or slot), pointing to `hydrate`; URL slots (`href`, `src`, `action`, `formaction`, `xlink:href`) whose scheme, after trimming whitespace and control characters and case-insensitively, is `javascript:` or `vbscript:` render `about:invalid` and log an error naming the attribute; with tests.
History: none

**Section 1 dispositions:** A1 → R2 approved (D4). A2 → carried factual correction (web invariant is DOM equivalence; migration test stays byte-exact). A3 → carried (`html` returns `readonly RenderNode[]`; `Renderable = string | RenderNode | readonly RenderNode[]`). A4 → R3 approved (D5). A5 → carried note for R7's TODO. A6 → carried proof (tree-shaking; runtime and embed size checks re-run and reported).

## Section 2: Code quality review

1. **Q1 [P2] (confidence: 9/10) packages/lynx/src/runtime/tokenize.ts:118** — The `html` tag needs a parser for its static parts, and the proposal is silent on which. The repo already has one: `export function tokenize(html: string): ParsedNode[]`, with no imports, foreign (SVG) handling (`*   - \`<svg>\` subtrees as foreign content: case kept, \`/>\` closes;`, L14), raw-text elements (`const RAW_TEXT = new Set(['script', 'style']);`, L73), its own tests and a conformance test against a browser-grade parser. Callers today: `const nodes = fromParsed(tokenize(page.html));` (mount.ts:217) and `const nodes = fromParsed(tokenize(html));` (facade.ts:197). → R4.
2. **Q2 [P2] (confidence: 8/10) docs/designs/render-tree-contract.md "Authoring"** — Slot semantics are defined for children only. Attribute slots are undefined: whole-value `disabled=${cond}`, partial values `class="card ${active && 'card--active'}"`, and non-string values. Disposition: required definition of the approved tag (D4): a whole-value slot renders `null`, `undefined` or `false` as an omitted attribute, `true` as a boolean attribute, a number as its string, a string as the value; in a partial value, `null`, `undefined` and `false` render as empty text; a node, array or `raw()` in any attribute position throws a named error at render. Tests cover each row.
3. **Q3 [P2] (confidence: 8/10) docs/designs/render-tree-contract.md "Risks", double escaping** — The proposed mitigation offers consumers "a lint rule ... that flags `escapeHtml`/`escapeAttr` inside `html` slots". The first native consumer lints with ESLint (`@typescript-eslint/eslint-plugin, @typescript-eslint/parser, eslint`), while this repo lints with Biome, so one rule does not reach both. The proposal's own migration test ("each migrated example view's tree output equals its former string output, byte for byte") already fails on any double escape. → R5.
4. **Q4 [P3] (confidence: 8/10) packages/core/src/escape.ts:81** — `toHTML` must escape with the existing `export function escapeHtml(value: string): string {` rather than a second copy, now that the walker lives in core (D2). Disposition: carried as implementation detail of D2/D3.

### R4: One tokenizer for the html tag and the native path
Finding: Q1, P2, confidence 9/10, packages/lynx/src/runtime/tokenize.ts:118, plan-eng-review
Plan baseline: D2 put the render API in `@airo-js/core/render`; D4 chose the `html` tag; the proposal does not name the tag's parser; the tokenizer lives in `@airo-js/lynx` (own version line).
Runtime evidence: `tokenize` is self-contained (no imports), has two lynx callers (mount.ts:217, facade.ts:197) and its own tests (tokenize.test.ts, papi-conformance.test.ts). Shared-code rubric: callers are the existing native path (authored) and the proposed tag compiler (assumption, motivated by D4); same language, same output type, no deployment boundary (lynx already peers on core); estimated saving ~200–250 implementation lines (a second parser not written) against ~20 lines of sentinel handling added; blast radius: a tokenizer defect affects template compilation and native parsing together, which the native one-tree test (D1) requires to agree anyway.
Comparison grid:
| Choice | Current | A) Move tokenizer to core/render | B) Separate tag parser |
|---|---|---|---|
| R4 parser for the `html` tag | unspecified | `tokenize` moves to `packages/core/src/render/tokenize.ts` (exported from `@airo-js/core/render`); the tag compiles each call site by joining its static parts with a private sentinel per slot, tokenizing once, and recording slot positions in text and attribute values; `@airo-js/lynx` imports it from core; its tests move with it | a new purpose-built tag parser (htm-style state machine, ~200–250 LOC) in core/render; `@airo-js/lynx` keeps its own tokenizer |
| entity rule in static template text | — | strict, as the tokenizer: the five `escapeHtml` entities and numeric references; anything else throws at first use with the call site | defined separately for the tag |
| D1, D2, D4 | approved | unchanged | unchanged |
Question D6:
D6 — Should the html tag reuse the native path's tokenizer, moved into core, instead of a parser of its own?
Project/branch/task: airo-js, reviewing docs/designs/render-tree-contract.md on lynx-adapter.
ELI10: The html tag has to read the fixed parts of each template once, to know where the slots go. The repo already has a strict, tested HTML reader: the one @airo-js/lynx uses to turn server HTML into native elements. Moving it into @airo-js/core/render lets the tag and the native path share it: one reader, one set of tests, and the guarantee that a template and its HTML are read the same way. The catch is that it is strict: a template that types &nbsp; or &mdash; directly gets an error at first use telling the author to type the character itself.
Stakes if we pick wrong: two readers can disagree on edge cases like SVG or entities, so a page could look different natively than on the web; one shared strict reader rejects named entities authors may be used to typing.
Recommendation: A because one reader means the web and native paths cannot drift, and it avoids writing and testing a second parser of about 200 lines.
Completeness: A=10/10, B=8/10
Pros / cons:
A) Move tokenizer to core/render (recommended)
  ✅ One HTML reader for templates and native pages, already tested against a browser-grade parser
  ✅ Saves writing and testing a second parser of roughly 200–250 lines
  ❌ Templates that type named entities like &nbsp; fail at first use until the author uses the character
B) Separate tag parser
  ✅ The tag can accept a wider entity set without changing the native reader
  ✅ The lynx package stays untouched, with its tokenizer where it is today
  ❌ Two readers to keep in agreement, the drift D1's native one-tree test exists to catch
Net: one strict, shared reader against a second parser with looser rules.
Header: Tokenizer
Options:
A) Move tokenizer to core/render
(recommended) Move `tokenize` and its tests to `@airo-js/core/render`; the `html` tag compiles each call site with per-slot sentinels through it; `@airo-js/lynx` imports it from core; static template text follows the tokenizer's strict entity rule. Human ~1 day / CC ~20 min.
B) Separate tag parser
Write a purpose-built tag parser in `@airo-js/core/render` with its own entity rules and tests; `@airo-js/lynx` keeps its tokenizer. Human ~2 days / CC ~40 min.

State: approved
Actual answer: B) Separate tag parser (D6, user answer, 2026-10-08)
Accepted scope: a purpose-built `html` tag parser in `@airo-js/core/render` with its own entity rules and tests; `@airo-js/lynx` keeps its tokenizer. Carried consequence: the native one-tree test (D1) runs over every example view, since it is now the check that the two readers agree.
History: none

### R5: Double-escape protection during migration
Finding: Q3, P2, confidence 8/10, docs/designs/render-tree-contract.md "Risks", plan-eng-review
Plan baseline: the proposal mitigates double escaping with "a test in the repo, and a lint rule offered to consumers, that flags `escapeHtml`/`escapeAttr` inside `html` slots"; D3 kept string templates valid, so migration is per view and optional.
Runtime evidence: the repo lints with Biome (`pnpm lint` is Biome, CLAUDE.md Health Stack); the first native consumer lints with ESLint; the proposal's migration test compares each migrated view's tree output with its former string output byte for byte, and a double escape (`&amp;amp;`) makes that comparison fail. New code written with `html` never calls an escape helper, so the risk exists only while migrating.
Comparison grid:
| Choice | Current | A) Migration test + docs | B) Lint rules for Biome and ESLint | C) Dev-time warning in the tag |
|---|---|---|---|---|
| R5 double-escape protection | repo test + one consumer lint rule (proposal) | no lint rule; the migration byte test is published as a documented recipe in best-practices §5 ("migrating a string template"), and the repo's examples use it | ship and maintain a Biome GritQL rule and an ESLint rule that flag escape helpers inside `html` slots | the tag logs a warning once per call site when a slot string already contains one of `escapeHtml`'s five entities |
| D3, D4, D6 | approved | unchanged | unchanged | unchanged |
Question D7:
D7 — How should airo-js catch templates that escape a value twice during migration?
Project/branch/task: airo-js, reviewing docs/designs/render-tree-contract.md on lynx-adapter.
ELI10: When someone converts an old template to the html tag but forgets to delete an escape call, the value gets escaped twice and the page shows &amp;amp; instead of &. It is visible, not dangerous, and it can only happen while converting old templates. The doc proposed a lint rule, but this repo uses Biome and the first native consumer uses ESLint, so one rule reaches only one of them. The migration check the doc already plans, comparing each converted view's output with its old output byte for byte, fails on any double escape anyway.
Stakes if we pick wrong: with too little, a converted page ships showing &amp;amp;; with too much, the team maintains two lint plugins or a runtime check that can warn on legitimate text.
Recommendation: A because the byte comparison already catches every double escape deterministically, and the problem only exists during migration.
Completeness: A=9/10, B=9/10, C=8/10
Pros / cons:
A) Migration test + docs (recommended)
  ✅ Catches every double escape in a migrated view, with no false positives and nothing to maintain
  ✅ Works for any lint setup, because it is a test recipe rather than a lint plugin
  ❌ Only catches views whose author runs the comparison while migrating them
B) Lint rules for Biome and ESLint
  ✅ Flags the mistake in the editor as it is typed, before any test runs
  ✅ Covers both the repo's linter and the first consumer's
  ❌ Two lint plugins to write and keep working across Biome and ESLint versions
C) Dev-time warning in the tag
  ✅ Reaches every project at runtime with no tooling setup at all
  ✅ Catches double escapes in new code as well as migrated code
  ❌ Warns on legitimate text that contains an entity, such as a page explaining HTML
Net: a deterministic, maintenance-free migration check against editor-time or runtime coverage.
Header: Double escape
Options:
A) Migration test + docs
(recommended) No lint rule; the migration byte test becomes a documented recipe in best-practices §5 and is used for every example the repo migrates. Human ~1 h / CC ~5 min.
B) Lint rules for Biome and ESLint
Ship a Biome GritQL rule and an ESLint rule that flag `escapeHtml`/`escapeAttr` inside `html` slots, maintained alongside the tag. Human ~1.5 days / CC ~40 min.
C) Dev-time warning in the tag
The tag logs a warning once per call site when a slot string already contains one of `escapeHtml`'s five entities. Human ~2 h / CC ~10 min, with tests.

State: approved
Actual answer: A) Migration test + docs (D7, user answer, 2026-10-08)
Accepted scope: no lint rule; the migration byte test becomes a documented recipe in best-practices §5 ("migrating a string template") and is used for every example the repo migrates.
History: Section 3 T3 corrected the comparison from bytes to DOM equivalence (both outputs parsed into linkedom, serializations compared), because `toHTML` normalises static markup such as `<img />`; intent and answer unchanged.

**Section 2 dispositions:** Q1 → R4 approved (D6; carried consequence: the native one-tree test runs over every example view). Q2 → carried definition of attribute-slot semantics, with a test per row. Q3 → R5 approved (D7). Q4 → carried (`toHTML` escapes with core's `escapeHtml`).

## Section 3: Test review

Framework: vitest (`pnpm test`, Health Stack). Environments: core `happy-dom`, cartridge-kit and lynx `node` (lynx has jsdom and linkedom as dev dependencies for its conformance test). Root `pnpm test` runs `./packages/*` only (package.json:23); CI also runs the full-site example's tests (ci.yml:187) and the shopify-edge-worker smoke (ci.yml:178). Existing tests for the code this plan changes: `define-ssr-safe-renderer.test.ts` (8 cases), `facade.test.ts` (25, of which `innerHTML` and `insertAdjacentHTML` at L129–155), `mount.test.ts` (17, all hydrate-only views), `tokenize.test.ts` (3) and `papi-conformance.test.ts` (over `invite.html` and the three `example-*.html` fixtures, L60).

```
CODE PATHS (planned unless a test is cited)                         USER (DEVELOPER / VISITOR) FLOWS
[+] core/src/render/html.ts — html`…` (D4, separate parser D6)       [+] Writing a new view with html``
  ├── first call per call site: parse the static parts                 ├── [GAP] malformed markup → error at first render names the template text
  │   ├── [GAP] well-formed → cached template                          ├── [GAP] onclick in a template → error pointing to hydrate (D5)
  │   ├── [GAP] malformed → throws, message quotes the static text     └── [GAP] a javascript: link from data → about:invalid, logged, page renders
  │   ├── [GAP] entity rule for static text (D6)                     [+] Migrating a string view
  │   ├── [GAP] whitespace-only text kept verbatim (T2)                ├── [GAP] leftover escapeHtml → &amp;amp; → migration check fails (D7, T3)
  │   ├── [GAP] static on* attribute → throws (D5)                     ├── [GAP] markup-returning helper → shown as escaped text → raw() or a node helper
  │   ├── [GAP] SVG: case kept, /> closes, xlink:href                  └── [GAP] dynamic heading level, attribute helper → R6
  │   └── [GAP] slot as tag name / attribute / in script,style,comment → R6
  ├── later calls: slots filled, no parse (perf gate 1; no unit test) [+] Visitor on device
  ├── [GAP] text slot: string, number, null/undefined/false, node,     ├── [GAP] [→E2E] in-app page switch paints the tree, no parse (fake PAPI; device: gate 3)
  │         array, nested html, raw()                                  └── [GAP] core newer than lynx (no tree method) → paints through toHTML
  ├── [GAP] whole-value attribute slot (Q2 rows)
  ├── [GAP] partial attribute value (Q2), joined before the URL check
  ├── [GAP] on* name with a slot value → throws at first use (D5)
  └── [GAP] URL attributes: javascript:/vbscript: after trim + case fold → about:invalid + log.error (D5)
[+] core/src/render/to-html.ts
  ├── [GAP] string → returned unchanged
  └── [GAP] goldens: five entities in text and attributes, boolean attribute, void, SVG void-named with children, raw verbatim, nested arrays
[+] core/src/render/to-dom.ts — [GAP] innerHTML of toHTML; web one-tree invariant as DOM equivalence (A2)
[+] cartridge-kit/src/define-ssr-safe-renderer.ts — paint seam
  ├── render(): string → innerHTML unchanged  [★★ TESTED :45, :123]  CRITICAL (T4)
  ├── [GAP] render(): tree, target has the native tree method → method(tree), no toHTML
  ├── [GAP] render(): tree, no method → innerHTML = toHTML(tree)
  ├── renderSSR(): string unchanged  [★★ TESTED :63]   [GAP] tree → toHTML always, never the native method
  ├── hydrate(): template never called  [★★★ TESTED :78]
  └── destroy() / per-instance cleanup  [★★★ TESTED :97, :111, :140]
[+] lynx/src/runtime/facade.ts — native tree method (D1)
  ├── [GAP] tree → node model without tokenize → validate → replace children
  ├── [GAP] RawNode inside a tree → tokenize(raw.html), today's strict rule
  ├── [GAP] refused element in a tree → named refusal, page untouched (innerHTML path: ★★★ facade.test.ts:152–155)
  └── [GAP] one-tree: toLynx(tree) ≡ toLynx(tokenize(toHTML(tree))) over every example view (D1, D6)
[+] lynx/src/runtime/mount.ts — [GAP] ctx.navigate on device → PageManager render (page-manager.ts:423, :552) on the facade
[+] ssr — [GAP] renderAppWithPublication over a tree view equals its string twin
[+] examples (6 views in repo) + scaffold (2 views, beta ritual) — [GAP] migration check per view (D7, T3)

COVERAGE: 4/37 paths tested (11%)  |  Code paths: 4/29 (14%)  |  User flows: 0/8 (0%)
QUALITY: ★★★:2 ★★:2 ★:0  |  GAPS: 33 (1 E2E-style, 0 eval)
```

Legend: ★★★ behaviour + edge + error | ★★ happy path | ★ smoke | [→E2E] integration across packages. No LLM or prompt code is touched, so no eval scope.

1. **T1 [P1] (confidence: 9/10) examples/full-site/src/cartridge.ts:330, examples/shopify-edge-worker/src/shopify/cartridge.ts:174** — The `html` tag defines slots in text and in attribute values (Q2), but today's templates also put slots where neither applies: a tag name (`<h${s.depth}>${escapeHtml(s.title)}</h${s.depth}>`) and an attribute position (`${product.availableForSale ? '' : 'aria-disabled="true"'}`). The first native consumer has 4 dynamic heading tags in 2 files and at least 4 attribute-string slots inside open tags, one of them an attribute helper. Slots inside `<script>`, `<style>` and comments are also undefined. → R6.
2. **T2 [P1] (confidence: 9/10) docs/designs/render-tree-contract.md "Authoring"** — Whitespace in static parts is unspecified. Tag parsers of this kind commonly drop whitespace-only text that contains a newline; every example template is indented across lines (full-site cartridge.ts:326–332), so a trimming parser makes every migrated view differ from its string twin and fails D7's migration check. Disposition: required definition of the approved tag (D4, D7): static text, including whitespace-only runs, is kept exactly as written. Test row in the tag table.
3. **T3 [P2] (confidence: 9/10) examples/shopify-edge-worker/src/shopify/cartridge.ts:165, examples/shopify-edge-worker/src/wp/cartridge.ts:111** — A byte comparison between a migrated view and its string twin fails on correct migrations, because `toHTML` writes static markup in one canonical form: `<img … loading="lazy" />` comes back as `<img … loading="lazy">` (2 of the 6 example views); quoting and whitespace inside tags normalise the same way. Disposition: factual correction of D7's mechanism (and of A2's sentence "the migration test stays byte-exact"), intent unchanged: the migration check parses both outputs into the SSR document implementation (linkedom) and compares the serializations. A double escape still fails it (text `&` against `&amp;` survives the parse), and so does dropped whitespace. Recorded in R5's History.
4. **T4 [P1] CRITICAL regression (confidence: 9/10) packages/cartridge-kit/test/define-ssr-safe-renderer.test.ts:45, :63, :123** — The string path must not change, and today's tests would not notice if it did: they assert markup like `<div data-count="3">root</div>`, whose parse-and-serialize round trip is identical, so a seam that parsed strings would still pass. Carried exact contract from D3 ("strings accepted"): a string returned by `template` reaches `innerHTML` unchanged on `render` and on `renderSSR`, also when the target has the native tree method; nothing parses or escapes it; intentional differences: none. Acceptance: extend the existing file with a string holding `a&nbsp;b`, an apostrophe, `<img />` and an unclosed `<p>`, asserted byte for byte on both paths, plus a target carrying the tree method whose method is not called.
5. **T5 [P2] (confidence: 8/10) package.json:23, .github/workflows/ci.yml:178, :187** — The checks D1, D6 and D7 require over "every example view" have no home yet: root `pnpm test` skips examples, shopify-edge-worker has no test script, and lynx's converters (`tokenize`, `fromParsed`) are internal, so an example test cannot call them without a production export no production caller needs. Disposition: required proof mechanism, no new export: each example view's tree, rendered from a fixed ctx, is checked in as JSON under `packages/lynx/test/fixtures/trees/` (precedent: the `example-*.html` fixtures that papi-conformance.test.ts:60 runs over); the example's own test fails when a view's tree no longer equals its fixture; lynx's one-tree test runs over every fixture; shopify-edge-worker gains a `test` script for its two views and a CI step beside ci.yml:187.
6. **T6 [P2] (confidence: 8/10) packages/lynx/test/mount.test.ts:21–27** — The paint seam's native branch runs on device only when a template renders there: `ctx.navigate` reaches `renderer.render(this.opts.container, ctx);` (page-manager.ts:423) with the facade as container. Every view in mount.test.ts is hydrate-only, so nothing renders a template on device today. Disposition: required proof of D1: a mount test navigates with `ctx.navigate` to a `defineSSRSafeRenderer` view returning a tree, asserts the screen equals its string twin's, and asserts through `vi.mock('../src/runtime/tokenize.js')` that the tree page was not tokenized.

Tests made obsolete by this plan: none. The lynx tokenizer keeps its tests (D6), and the eight renderer tests stay as they are, extended by T4.

### R6: Slot positions beyond text and attribute values
Finding: T1, P1, confidence 9/10, examples/full-site/src/cartridge.ts:330 and examples/shopify-edge-worker/src/shopify/cartridge.ts:174, plan-eng-review
Plan baseline: D4 approved the `html` tag and D5 its `on*` and URL checks; Q2 carried slot rules for text, whole attribute values and partial values. Nothing defines a slot used as a tag name, a slot in attribute position, or a slot inside `<script>`, `<style>` or a comment.
Runtime evidence: `<h${s.depth}>…</h${s.depth}>` (full-site cartridge.ts:330); `${product.availableForSale ? '' : 'aria-disabled="true"'}` (shopify cartridge.ts:174); the first native consumer: 4 dynamic heading tags in 2 files, at least 4 attribute-string slots inside open tags. A string in attribute position is markup: honouring it means parsing it at every render, outside the per-call-site cache and outside what escaping can protect.
Comparison grid:
| Choice | Current | A) Tag-name strings and attribute objects | B) Text and attribute values only | C) Also parse attribute strings |
|---|---|---|---|---|
| slot as tag name | undefined | accepted: a string matching `^[a-z][a-z0-9]*(-[a-z0-9]+)*$` other than `script` and `style`; the closing tag repeats the same slot; any other value is a named error at render | throws at first use; migration writes a helper that returns the right element | as A |
| slot in attribute position | undefined | accepted: a plain object spreads as attributes under Q2's whole-value rules, with D5's checks per key at render (an `on*` key throws, URL keys are checked); `null`, `undefined` and `false` add nothing; a string throws, naming the object form | throws at first use; migration lists each attribute as its own whole-value slot | a string is parsed as attributes at each render; objects as A |
| slot inside `<script>`, `<style>`, a comment | undefined | throws at first use: HTML escaping is the wrong escaping there | same | same |
| D4, D5, Q2 | approved / carried | unchanged | unchanged | unchanged |
| repo migration | — | full-site:330 keeps its shape; shopify:174 becomes `${available ? null : { 'aria-disabled': 'true' }}` | both sites rewritten | neither site rewritten |
Question D8:
D8 — Which extra slot positions should the html tag accept: dynamic tag names and attribute objects, or text and attribute values only?
Project/branch/task: airo-js, reviewing docs/designs/render-tree-contract.md on lynx-adapter.
ELI10: Today's templates sometimes put a value where the tag name goes, like a heading whose level comes from data (h2 or h3), or drop a whole attribute in or out with a condition. The html tag so far only defines values inside text and inside attribute quotes. It can accept a tag name if it looks like a real tag (never script or style), and an object of attributes it checks one by one like any other attribute. Or it can refuse both and make authors write those few places differently. A third route would accept raw attribute text, but that text would be re-read on every render and could smuggle in an onclick the safety checks never see.
Stakes if we pick wrong: refusing these turns a few lines of every migration into rewrites; accepting raw attribute text reopens the script hole D5 closed.
Recommendation: A because both patterns recur in the examples and in the first consumer, so accepting them keeps migration mechanical (the reason for D4), and an object keeps D5's checks per attribute.
Completeness: A=10/10, B=8/10, C=6/10
Pros / cons:
A) Tag-name strings and attribute objects (recommended)
  ✅ Dynamic heading levels and conditional attributes migrate with a one-line change or none at all
  ✅ Every attribute from an object still passes the on* refusal and the javascript: URL check
  ❌ Two more slot kinds to define, test and explain in best-practices §5
B) Text and attribute values only
  ✅ The smallest tag: two slot kinds, each easy to explain in one sentence
  ✅ Every attribute name is visible in the template source, which helps review
  ❌ Dynamic headings and attribute helpers need rewriting in the examples and the first consumer
C) Also parse attribute strings
  ✅ Existing attribute helpers keep returning strings, so those sites need no change at all
  ✅ Covers every pattern today's templates use, with nothing to migrate by hand
  ❌ Re-parses markup on every render and lets an on* attribute bypass the D5 refusal
Net: mechanical migration with checked attributes against the smallest possible tag.
Header: Slots
Options:
A) Tag-name strings and attribute objects
(recommended) A tag-name slot accepts a validated lowercase name (not script/style), repeated in the closing tag; an attribute-position slot accepts a plain object spread under Q2 rules with D5 checks per key; a string there throws naming the object form; slots in script, style or comments throw at first use. Human ~0.5 day / CC ~20 min, with tests.
B) Text and attribute values only
Every slot outside text and attribute values throws at first use; the two repo sites and the consumer's sites are rewritten during migration. Human ~2 h / CC ~10 min, plus rewrites.
C) Also parse attribute strings
As A, and a string in attribute position is parsed as attributes at each render. Human ~1 day / CC ~30 min.

State: approved
Actual answer: A) Tag-name strings and attribute objects (D8, user answer, 2026-10-08)
Accepted scope: a tag-name slot accepts a string matching `^[a-z][a-z0-9]*(-[a-z0-9]+)*$` other than `script` and `style`, repeated in the closing tag, and any other value is a named error at render; an attribute-position slot accepts a plain object spread under Q2's whole-value rules with D5's checks per key at render (`null`, `undefined` and `false` add nothing; a string throws, naming the object form); a slot inside `<script>`, `<style>` or a comment throws at first use; with a test row each.
History: none

**Section 3 dispositions:** T1 → R6 approved (D8). T2 → carried definition (static whitespace kept verbatim). T3 → carried correction of D7's mechanism (DOM equivalence, linkedom), recorded in R5's History. T4 → carried CRITICAL regression contract from D3 (strings reach `innerHTML` unchanged). T5 → carried proof mechanism (checked-in tree fixtures, shopify-edge-worker `test` script and CI step). T6 → carried proof of D1 (device `ctx.navigate` to a tree view, tokenizer not called).

## Section 4: Performance review

No database, network or per-request query paths are in scope; the per-render paths are the tag's slot fill, `toHTML`, the server DOM round trip and the device tree build. Scales below are from the Performance section's benchmark (276 elements, 736 slots, 96 URL slots on the consumer page).

1. **F1 [P2] (confidence: 9/10) scratchpad benchmark `treeFn`, Performance gate 1** — The measured tree cost (1.07–1.29× the string template) comes from a generated object literal per page, which is the floor, not the `html` tag. The real tag fills a cached template on every call and applies Q2's value rules, D5's URL check (96 URL slots on the measured page) and D8's tag-name and attribute-object checks per slot. Disposition: required proof of gate 1 as approved (D3 accepted the proposal's gates): the gate is measured with the real `html` tag on the in-repo fixture page, URL slots included, before the release that ships it. If it misses 1.3×, the levers are, in order: share slot-free static subtrees between renders (frozen, since no walker mutates a `RenderNode`), then a precomputed fill plan per call site.
2. **F2 [P3] (confidence: 8/10) per-call-site cache** — The cache is keyed by the template strings array, which is one object per call site. Disposition: carried implementation detail: a `WeakMap` keyed by that array, so modules reloaded in development release their entries; memory is bounded by the number of call sites, not by renders or data.
3. **F3 [P3] (confidence: 9/10) server DOM round trip** — With a tree, SSR still sets and reads `innerHTML` on linkedom (20–40× the template's cost on the measured page), so the tree changes SSR by +0.3–0.7% and does not remove the dominant cost. Disposition: R7 (skip the server DOM for pure templates) stays a separate change; it goes to the TODO question below, with A5's byte-change caveat.
4. **F4 [P3] (confidence: 7/10) device in-app page switch** — On device the tree path replaces `tokenize` (360–453 µs in V8 on the measured page) with a `RenderNode` → node-model conversion (0.07–0.21× in V8). PrimJS timings are unknown. Disposition: carried gate 3; no device path ships without its number.
5. **F5 [P3] (confidence: 8/10) bundle size** — A6 already requires tree-shaking and re-running the runtime and embed size checks; D8 adds two slot kinds to the tag, which stays inside the estimated 1–2 KB minified. Disposition: carried with A6.

**Section 4 dispositions:** F1 → carried proof (gate 1 on the real tag). F2 → carried detail. F3 → TODO question (R7). F4 → carried gate 3. F5 → carried with A6.

## Outside voice (Codex, plan review)

Reviewer: Codex (`codex exec`, model gpt-6-astra, reasoning high), read-only, over the proposal plus decisions D1–D8. OUTSIDE_STATUS: completed. Its recommendation was Option C (vocabulary only at 1.0) "because the proposed tree still lacks defined composition and serialization semantics, while its native performance benefit remains outside the shipping path". Each finding was checked against the code before disposition.

1. **O1 [High] packages/core/src/escape.ts:35** — `srcdoc`'s value is a document: escaping protects the attribute, then the browser parses the decoded value as HTML inside the iframe, so a slot there runs markup. Neither D5 check covers it. Verified; 0 `srcdoc` and 0 `<iframe>` in the examples and the first native consumer. → R8.
2. **O2 [High] packages/lynx/src/runtime/tokenize.ts:288–306, packages/lynx/test/tokenize.test.ts:174** — Neither the tokenizer nor a tag parser built the same way applies the HTML parser's repairs: `<p><div>x</div></p>` stays nested and `<table><tr>` gets no `<tbody>`, while a browser restructures both. The A2 web invariant parses both sides into a DOM, so both are repaired alike and the check passes while the web DOM differs from the tree. The tokenizer's conformance test compares against linkedom, which misses some of these repairs too. Verified (no implied-end-tag handling in the tokenizer's start-tag path). → R9.
3. **O3 [High] packages/lynx/src/runtime/tokenize.ts:253** — `const foreign = top().el.foreign || raw!.toLowerCase() === 'svg';` decides SVG from the enclosing element, so a fragment parsed on its own (a helper returning `<path d="…"/>`) is HTML: names are lowercased and `/>` on a non-void element is an error (L299). The first native consumer keeps 169 self-closing SVG children in strings separate from their `<svg>` (its icon table); the repo examples have 1. → R10.
4. **O4 [Medium] packages/lynx/src/runtime/tree.ts:309** — On the native direct path, adjacent text nodes from slots (`${a}${b}`) are each trimmed and wrapped: `const text = collapse(child.data).trim(); if (text) p.append(ref, this.wrapText(el, text));`, so "Hello " + "world" loses its space, while the tokenizer merges adjacent text (L205). Verified. Disposition: depends on R7. If the native branch stays, a required completion of D1: the tree-to-node-model conversion merges adjacent text nodes (across slots, arrays and spliced `raw()` fragments) before projection, with a row in the native one-tree test. If it is deferred, moot until it returns.
5. **O5 [Medium] packages/lynx/src/runtime/tokenize.ts:302, node-model.ts:119** — D8 forbids slots inside `<script>` and `<style>` but leaves their static bodies to `toHTML`, which would escape a JSON body's quotes. Verified (the tokenizer reads raw-text bodies verbatim). Disposition: factual correction, no question: `toHTML` follows the HTML serialization rule and writes the text of raw-text elements (`script`, `style`) verbatim; the tag parser reads their static bodies as raw text up to the closing tag; `toHTML` throws if such a text child contains its own closing tag (`</script`, `</style`, case-insensitive), which only hand-built nodes can produce. Golden rows for both.
6. **O6 [Medium] packages/lynx/src/runtime/mount.ts:217, :261; packages/cartridge-kit/src/define-hydrate-only-renderer.ts:111** — The native branch has no production caller: `mountLynx` tokenizes the server HTML and mounts with `hydrate: true`, device views are hydrate-only (mount.ts:7–8, "Templates and the data pipeline stay on the server; the device needs neither"), and a hydrate-only renderer's `render` refuses. T6's test would run a path no shipped configuration takes. Verified. Reopens D1. → R7.

Cross-model agreement: Codex and this review agree on the double-path risk D6 created (O3/O4 are concrete instances of reader drift) and on R7's byte-change caveat. Disagreement: Codex recommends Option C for rollout (D3). This review keeps D3 as answered: O1, O2, O3 and O5 each have a bounded fix, and O4/O6 shrink with R7; the user's D3 answer stands unless the user reopens it.

### R7: Native tree paint seam (reopens D1)
Finding: O6, Medium, packages/lynx/src/runtime/mount.ts:217 and :261, Codex outside voice
Plan baseline: D1 = Include ("Keep it in 1.0"): the paint seam's native branch, the facade's tree method, the native one-tree test, and T6's device test.
Runtime evidence: device views are hydrate-only and their `render` refuses (define-hydrate-only-renderer.ts:111–113); `mountLynx` reads server HTML (mount.ts:217) and hydrates (mount.ts:261); no shipped configuration runs a template on the device. A tree reaches the device in production only through the proposal's R5 (tree JSON over the wire), which waits for gate 3. Adding the branch later changes no public type: it is a branch inside `defineSSRSafeRenderer.render` and a facade method.
Comparison grid:
| Choice | Current | A) Include | B) Defer | C) Cut |
|---|---|---|---|---|
| native branch + facade tree method | D1 Include | built pre-1.0; T6 test; O4 merge rule required | not built; a tree on any target paints `innerHTML = toHTML(tree)`; TODO with trigger "a device setup that runs templates on device, or R5 tree JSON" | removed from the design; the device always reads HTML |
| device check over every example view (D6 consequence) | `toLynx(tree) ≡ toLynx(tokenize(toHTML(tree)))` | unchanged | becomes the round trip: `tokenize(toHTML(tree))` reads back as the tree, over the same fixtures | as B |
| T6, O4 | required | required | dropped; O4 moot until the branch returns | dropped |
Question D9:
D9 — Should the native shortcut stay in the pre-1.0 work, now that no shipped device setup runs a template on the device?
Project/branch/task: airo-js, reviewing docs/designs/render-tree-contract.md on lynx-adapter.
ELI10: In D1 you kept the native shortcut: when a view's template runs on the phone, paint its tree straight into native elements instead of printing HTML and reading it back. Codex checked where templates actually run on the phone, and the answer today is nowhere: the server renders each page, the phone receives HTML, and the phone's copies of the views only attach behaviour (they refuse to render). So the shortcut would be built and tested but never used by a shipped app. Adding it later changes nothing developers see, because it lives inside the framework.
Stakes if we pick wrong: keeping it adds pre-1.0 work and a text-merge rule for a path no app takes; cutting it outright loses a documented route for when templates do run on the phone.
Recommendation: B because no shipped device setup reaches it, adding it later changes no public type, and the round-trip check keeps the web and native readings of a page honest meanwhile.
Note: options differ in kind, not coverage — no completeness score.
Pros / cons:
A) Include (keep D1)
  ✅ The direct path is ready the day a device setup runs templates on the phone
  ✅ Keeps your D1 answer exactly as given, with its device test and merge rule
  ❌ Pre-1.0 work, a device test and a merge rule for a path no shipped app takes
B) Defer (recommended)
  ✅ Removes the T6 test and the O4 merge rule from the pre-1.0 work with nothing visible lost
  ✅ The round-trip check still proves the phone reads each page's HTML back as its tree
  ❌ If templates move onto the phone before R5 is decided, the shortcut has to be built then
C) Cut
  ✅ The design commits to one device model, server HTML read on the phone, with nothing pending
  ✅ No TODO to carry and nothing to revisit after the device timing
  ❌ Drops a cheap, measured speed-up for any future setup that renders on the phone
D) Hold
  ✅ Stops to talk through where templates should run on the phone before scope changes
  ✅ Leaves D1 exactly as approved while we discuss it
  ❌ Leaves D10–D12 and the rest of the review waiting on that conversation
Net: a built-but-unused native shortcut now against adding it the day something calls it.
Header: Native path
Options:
A) Include (keep D1)
Keep the native branch, the facade tree method, T6's test and the O4 merge rule in the pre-1.0 work.
B) Defer
(recommended) Do not build the native branch now; trees paint through `toHTML` on every target; the device check becomes the round trip over the same fixtures; TODO with its trigger. Saves human ~1 day / CC ~20 min pre-1.0.
C) Cut
Remove the native branch from the design; the device always reads HTML; the round-trip check stays.
D) Hold
Stop and discuss before changing D1.

State: approved
Actual answer: A) Include, keep D1 (D9, user answer, 2026-10-08)
Accepted scope: D1 unchanged: the native branch in the paint seam, the facade's tree method, the native one-tree test over every example view, and T6's device test; O4's merge rule becomes required (the tree-to-node-model conversion merges adjacent text nodes across slots, arrays and spliced `raw()` fragments before projection, with a row in the native one-tree test).
History: reopened D1 on O6's evidence; the user kept it (D9).

### R8: `srcdoc` slots
Finding: O1, High, packages/core/src/escape.ts:35, Codex outside voice
Plan baseline: D5 refuses `on*` attributes and neutralises `javascript:`/`vbscript:` URLs; `srcdoc` is not covered.
Runtime evidence: a `srcdoc` value is parsed as an HTML document after attribute decoding, so escaping does not stop it running markup; 0 uses in the examples and in the first native consumer.
Comparison grid:
| Choice | Current | A) Apply | B) Keep | C) Investigate | D) Defer |
|---|---|---|---|---|---|
| `srcdoc` with a slot | escaped only | a slot anywhere in a `srcdoc` value throws at first use, and a `srcdoc` key in an attribute object (D8) throws at render; a static `srcdoc` written in the template stays allowed; a test row each | escaped only; best-practices §5 warns | audit every attribute whose value a browser parses as markup or script before choosing | unresolved |
Question D10:
D10 — Should the html tag also refuse data in an iframe's srcdoc, which runs as HTML even when escaped?
ELI10: srcdoc is an iframe attribute whose value is a whole web page. Escaping keeps the value inside the quotes, but the browser then reads it as a page, so data placed there can still run script. No template in the repo or the first consumer uses it.
Recommendation: A because it closes the last script path the review found at almost no cost, and nothing uses it today.
Header: srcdoc
Options: A) Apply (recommended) · B) Keep · C) Investigate · D) Defer

State: investigating
Actual answer: C) Investigate (D10, user answer, 2026-10-08): "the primary cartridge consumer uses an iframe as its editor; ask that team what impact this has before deciding."
Accepted scope: none yet. Evidence gathered read-only: the consumer's editor preview sets `srcDoc` as a React property from a host-side string builder, not through an airo-js template, so the proposed refusal (slots in `srcdoc` inside `html` templates only; strings stay accepted under D3) does not reach that code. Pending: the consumer team's answer on the bridge.
History: posted to every consumer as an open item in the plan announcement, bridge msg_muzvpy3z_ff76b2 (2026-10-08); the targeted question to the primary consumer was held back at the user's request.

### R9: Markup a browser would restructure
Finding: O2, High, packages/lynx/src/runtime/tokenize.ts:288–306, Codex outside voice
Plan baseline: the tag keeps static structure as written (D6, own parser); A2's web invariant compares two DOM parses.
Runtime evidence: a browser closes `<p>` before a block element and inserts `<tbody>` under `<table>`; the tokenizer does neither; jsdom (a spec-conformant HTML parser) is already a dev dependency of `@airo-js/lynx`.
Comparison grid:
| Choice | Current | A) Apply | B) Keep | C) Investigate | D) Defer |
|---|---|---|---|---|---|
| structures the HTML parser repairs | kept as written | the tag throws at first use on a fixed list: a `p`-closing element inside `<p>`, `<tr>` directly in `<table>`, a cell outside a row, `<a>` in `<a>`, `<form>` in `<form>`; a nested template inserted at render is checked at its top level against the same list; a conformance test parses `toHTML(tree)` with jsdom for the tag corpus and every example tree fixture and requires the tree back | kept; best-practices §5 documents that such markup renders differently on web and device | count these structures in the examples and the first consumer before choosing | unresolved |
Question D11:
D11 — Should the html tag refuse markup that a browser would silently rearrange, such as a div inside a p?
ELI10: Browsers quietly fix some invalid markup: a div inside a p ends the p early, and a table row gets an invisible tbody wrapped around it. The tree keeps what the author wrote, so the web page, the native page and the author's hydrate code can each see a different structure. The tag can refuse those few shapes at first use, and a test can compare every page against a standards-following parser.
Recommendation: A because the tree's promise is one structure everywhere, the refused shapes are invalid HTML anyway, and the conformance test turns the promise into a check.
Header: Repairs
Options: A) Apply (recommended) · B) Keep · C) Investigate · D) Defer

State: approved
Actual answer: A) Apply (D11, user answer, 2026-10-08)
Accepted scope: the tag throws at first use on a fixed list (a `p`-closing element inside `<p>`, `<tr>` directly in `<table>`, a cell outside a row, `<a>` in `<a>`, `<form>` in `<form>`); a nested template inserted at render is checked at its top level against the same list; a conformance test parses `toHTML(tree)` with jsdom for the tag corpus and every example tree fixture and requires the tree back.
History: none

### R10: SVG fragments built apart from their `<svg>`
Finding: O3, High, packages/lynx/src/runtime/tokenize.ts:253, Codex outside voice
Plan baseline: `ElementNode.foreign` is set while parsing, from the enclosing element, as in the tokenizer.
Runtime evidence: a fragment such as `<path d="…"/>` parsed without an `<svg>` around it is read as HTML: lowercased names, and `/>` on a non-void element is an error (tokenize.ts:299). The first native consumer keeps 169 self-closing SVG children in strings separate from their `<svg>`; the repo examples have 1.
Comparison grid:
| Choice | Current | A) Apply | B) Keep | C) Investigate | D) Defer |
|---|---|---|---|---|---|
| SVG in fragments | parse-time `foreign` | the tag keeps element and attribute names as written and accepts `/>` on any element; `foreign` leaves the public node; walkers decide HTML or SVG from the ancestor chain as they walk (HTML names lowercased, SVG names kept); test rows for a fragment helper inserted into `<svg>` | fragments must include their own `<svg>`; a bare fragment with `/>` throws at first use; documented | prototype the walker rule before choosing | unresolved |
Question D12:
D12 — Should SVG pieces written outside their svg element work, by deciding SVG from where they end up rather than where they were written?
ELI10: Icon helpers often keep just the inner shapes, like path and circle, and put them inside an svg later. A parser that decides "is this SVG?" from the surrounding tag sees no svg around those shapes, treats them as HTML and rejects their self-closing slash. Deciding SVG at the moment the tree is printed, from the element the shapes landed in, makes those helpers work as written.
Recommendation: A because the first consumer's icon table is exactly this pattern (169 shapes), and deciding from ancestry is the rule browsers follow anyway.
Header: SVG pieces
Options: A) Apply (recommended) · B) Keep · C) Investigate · D) Defer

State: approved
Actual answer: A) Apply (D12, user answer, 2026-10-08)
Accepted scope: the tag keeps element and attribute names as written and accepts `/>` on any element; `foreign` leaves the public `ElementNode`; walkers (`toHTML`, the lynx tree conversion) decide HTML or SVG from the ancestor chain as they walk, lowercasing HTML names and keeping SVG names; the device tokenizes a `raw()` fragment inside SVG in SVG context; test rows for a fragment helper inserted into `<svg>`.
History: none

**Outside voice dispositions:** O1 → R8 investigating (D10, consumer input pending). O2 → R9 approved (D11). O3 → R10 approved (D12). O4 → required with D9 (adjacent-text merge). O5 → carried factual correction (raw-text bodies verbatim). O6 → R7 approved, D1 kept (D9).

## TODO decisions

The proposal's other deferred items are decisions already recorded in this document (a target-neutral hydrate, a JSX front end, tree JSON to devices: "Not in scope"), so by TODOS.md's own rule they stay here, not there. Tree JSON's measurement already sits in the TODOS.md entry "Time HTML parsing and tree building on the UI thread" (gate 3). One candidate remains.

### R11: TODO — SSR fast path (proposal table R7)
Finding: F3 and A5, P3, packages/ssr/src/render-app.ts:254–264, plan-eng-review
Plan baseline: the proposal recommends a separate change; F3 routed it here.
Runtime evidence: SSR sets the template's output on a linkedom container and reads `innerHTML` back; that round trip is 20–40× the template on the measured page (2,460–5,032 µs of each render). Skipping it changes SSR bytes, because linkedom serializes differently from `escapeHtml` (A5), and the first native consumer pins three server-rendered pages byte for byte.
Proposed entry (section `## SSR`): **What:** for views whose `renderSSR` only paints a pure template (string or tree), return the template's HTML directly instead of the linkedom set-and-read. **Why:** the round trip is 20–40× the template's cost on a 276-element page, the largest SSR speed-up measured. **Context:** render-app.ts:254–264; needs a purity marker the runner can trust (the `defineSSRSafeRenderer` factory can set one; hand-written renderers stay on the DOM path); bytes change as in A5, so the CHANGELOG entry must say so and consumers regenerate byte-pinned fixtures. **Effort:** M. **Priority:** P2. **Depends on:** nothing for string views; `@airo-js/core/render` for tree views.
Question D13: add it to TODOS.md, skip it, or build it in this work?

State: approved
Actual answer: C) Build it in this work (D13, user answer, 2026-10-08)
Accepted scope: the SSR fast path joins the pre-1.0 render work. `defineSSRSafeRenderer` marks its renderers with the template (a symbol from `@airo-js/core/render`); `renderAppToHTML` (render-app.ts:252–264) calls a marked renderer's template and returns its HTML directly (a string as is, a tree through `toHTML`) instead of setting and reading `container.innerHTML`; unmarked and hand-written renderers keep the DOM path. The CHANGELOG entry states the SSR byte change (A5) and that byte-pinned SSR fixtures must be regenerated; the bridge release note carries the same upgrade action.
History: D13 reverses the proposal's "separate change" and A2's sentence "SSR bytes do not change"; consequences carried: the SSR test compares a tree view with its string twin by DOM equivalence, and new SSR goldens pin the fast-path bytes.

## Working plan (after review)

This supersedes the proposal sections above where they differ, including the proposal's "Open decisions" table: R1 → D3, R2 → D4, R3 (package home) → D2, R4 (native paint seam) → D1/D9, R5 (tree JSON to devices) stays a later decision on gate 3, R6 (hydrate) stays out of scope, R7 (SSR fast path) → D13, built in this work. Before implementation starts, the proposal sections are rewritten to match this plan, so the doc does not teach two designs.

**Home.** `packages/core/src/render/*`, exported as `@airo-js/core/render` (D2). cartridge-kit, ssr and lynx use it through their existing core peer dependency. No new package, peer edge or publish.sh entry.

**Node.** `RenderNode = ElementNode | TextNode | RawNode`; `ElementNode = { kind: 'element'; tag: string; attrs: [name: string, value: string | true][]; children: RenderNode[] }`, with no `foreign` field (D12); `Renderable = string | RenderNode | readonly RenderNode[]` (A3).

**`html` tag** (D4, own parser D6):
- Parses each call site's static parts once, cached in a `WeakMap` keyed by the strings array (F2), and returns `readonly RenderNode[]`.
- Static text, whitespace-only runs included, is kept as written (T2).
- Element and attribute names are kept as written, and `/>` closes any element (D12).
- Entities: the five `escapeHtml` writes, numeric references, a bare `&` as the HTML parser reads it, and a short named list (`nbsp`, `ensp`, `emsp`, `thinsp`, `ndash`, `mdash`, `hellip`, `lsquo`, `rsquo`, `ldquo`, `rdquo`, `laquo`, `raquo`, `middot`, `bull`, `copy`, `reg`, `trade`, `deg`, `times`, `divide`, `euro`, `pound`). Any other named reference throws at first use and names the reference. This is a carried definition of D6's "own entity rules"; widen it when a consumer needs more.
- Throws at first use, quoting the template text, on:
  - malformed markup;
  - any `on*` attribute (D5);
  - a slot inside `<script>`, `<style>` or a comment (D8);
  - the structures in D11's list.
- Raw-text bodies (`script`, `style`) are read verbatim up to their closing tag (O5).

**Slots:**

| Position | Value | Renders |
|---|---|---|
| Text | string | escaped text |
| Text | number | its string |
| Text | `null`, `undefined`, `true`, `false` | nothing |
| Text | node, array, nested `html` | spliced in, checked at its top level against D11's list |
| Text | `raw()` | a `RawNode` |
| Whole attribute value (Q2) | `null`, `undefined`, `false` | attribute omitted |
| Whole attribute value (Q2) | `true` | boolean attribute |
| Whole attribute value (Q2) | number | its string |
| Whole attribute value (Q2) | string | the value |
| Whole attribute value (Q2) | node, array, `raw()` | throws |
| Partial attribute value | `null`, `undefined`, `false` | empty |
| Partial attribute value | anything else | joined into the value before the URL check |
| URL attribute (`href`, `src`, `action`, `formaction`, `xlink:href`) | `javascript:` or `vbscript:` after trimming and case folding | `about:invalid`, plus a logged error naming the attribute (D5) |
| Tag name (D8) | validated lowercase name, not `script`/`style` | repeated in the closing tag |
| Attribute position (D8) | plain object | spread under the whole-value rules, with D5 checks per key; an `on*` key throws at render |
| Attribute position (D8) | string | throws, naming the object form |
| `srcdoc` | any | pending (R8) |

`raw(html)` is the one trust decision.

**Walkers:**
- `toHTML`:
  - escapes with core's `escapeHtml` (Q4);
  - lowercases names in HTML context and keeps them as written in SVG context, deciding the context from the ancestor chain (D12);
  - omits closing tags for void elements in HTML context;
  - writes `raw` verbatim;
  - writes raw-text bodies verbatim, and throws on a text child that contains its own closing tag (O5);
  - returns a string unchanged.
- `toDOM(target, r)`: `target.innerHTML = toHTML(r)`.

**Paint seam** (`defineSSRSafeRenderer`):
- `template` returns `Renderable`.
- `render`:
  - a string goes to `innerHTML` untouched (T4, CRITICAL);
  - a tree goes to the target's native tree method when there is one (D1/D9);
  - otherwise `innerHTML = toHTML(tree)`.
- `renderSSR`: `innerHTML` set to the string or to `toHTML(tree)`.
- Hydrate is unchanged.
- Each renderer carries its template under a symbol from core/render (D13).

**SSR fast path** (D13): for a marked renderer, `renderAppToHTML` returns the template's HTML directly instead of setting and reading the container. Unmarked renderers keep the DOM path. The CHANGELOG and the bridge release note state the byte change and the fixture regeneration.

**Device** (D1/D9): the lynx facade's tree method turns a `RenderNode` into the node model:
- it decides SVG from ancestry (D12);
- it merges adjacent text across slots, arrays and spliced `raw()` (O4);
- it tokenizes `raw()` in its parent's context;
- it then validates and replaces the content atomically, leaving the page untouched on a refusal.

**Tests:** the saved test plan, `~/.gstack/projects/airo-js/smithbn-lynx-adapter-eng-review-test-plan-20261008-185825.md`. It covers:
- the T4 regression;
- the tag tables;
- goldens;
- the web one-tree check by DOM equivalence;
- the native one-tree check over checked-in example tree fixtures;
- jsdom conformance (D11);
- the device navigate test (T6);
- SSR fast-path goldens;
- the migration DOM-equivalence check (D7/T3).

**Migration and docs:**
- 6 example views (full-site 4, shopify-edge-worker 2);
- the create-airo `site` template's 2 views (beta ritual, S2);
- best-practices §5: `html`, `raw`, the slot table, the safety rules, and the migration recipe.

**Performance:**
- gate 1 on the real tag (F1);
- gate 2 SSR end to end, now expected to improve with D13;
- gate 3 on device before the device path ships (F4);
- runtime and embed size checks re-run (A6, F5).

## Budget against today's 0.11 line

Measured figures are from 2026-10-08 on `lynx-adapter`; estimates say what they are based on. The proposal's "about 1–2 KB minified" bundle estimate predates the review's safety, structure and SVG rules and is replaced here.

| Budget | 0.11 today | With this plan | Basis |
|---|---|---|---|
| Framework effort | — | ~9 working days human (~2 weeks) / ~5 h CC, plus one device run (gate 3) and a scaffold beta | sum of Implementation Tasks T1–T13 |
| `@airo-js/runtime` bundle (gate 9,728 B gzip) | 9,238 B gzip, 28,335 B minified; 490 B headroom | unchanged: the bundle lists cartridge-kit's renderer module as an input and tree-shakes it to 0 bytes today; the seam's `toHTML` import must keep that true (T10 re-measures) | `pnpm --filter @airo-js/runtime size:check`; esbuild metafile |
| `@airo-js/embed` bundle (gate 2,560 B gzip) | 2,253 B gzip, 5,159 B minified; 307 B headroom | unchanged: embed carries no templates | `pnpm --filter @airo-js/embed size:check` |
| Hydrate-only browser bundles | no template code | 0 B added | they import no template |
| Browser bundles that render templates on the client | template strings + `escapeHtml` (268 B minified / 199 B gzip) | tag + walkers estimated at ~6–8 KB minified, ~2.5–3.5 KB gzip; the seam alone (`toHTML` + mark) ~1–1.5 KB minified, ~0.6–0.8 KB gzip | estimate scaled from the device tokenizer, a parser of the same kind: 321 lines, 4,769 B minified / 2,368 B gzip measured; tag + walkers estimated at 400–500 lines |
| Device bundle (`@airo-js/lynx`, no gate) | tokenizer + node model | + facade tree method, estimated ~1–2 KB minified | estimate, ~80–120 lines |
| Producing a page's HTML (276-element page, V8) | string template 73–199 µs | tree ≤ 1.3× the string template (gate 1); measured floor 1.07–1.29× | benchmark in Performance; gate 1 re-measured on the real tag |
| SSR per render, same page | 2.6–5.2 ms (template + linkedom round trip) | ~0.1–0.2 ms with D13's fast path, string or tree views | benchmark rows A and C without F |
| Device parse per navigation | tokenize 360–453 µs (V8) | unchanged for server HTML; tree build 0.07–0.21× of that where the tree method runs | V8 only; PrimJS unmeasured until gate 3 |
| Consumer migration | — | none required for string templates; per migrated view ~15–30 min human / ~5 min CC including the migration check; SSR fixtures pinned byte for byte must be regenerated once (D13) | the repo's 6 example views; D13 |

## NOT in scope

- **A target-neutral hydrate.** Hydrate stays DOM-shaped at 1.0; it should be designed with a second native consumer (proposal R6).
- **A JSX front end.** D4 chose the tag, and JSX can be added later on the same node.
- **Tree JSON over the wire to devices.** Proposal R5: it waits for gate 3's device numbers, since it parses faster but sends 2.1× the bytes.
- **Lint rules for double escaping.** D7 chose the migration check.
- **Parsing attribute strings at render.** D8 rejected it: per-render parsing outside the cache, and an `on*` bypass.
- **Moving the lynx tokenizer into core.** D6 kept two readers, and the native one-tree test guards their agreement.
- **The full HTML named-entity table.** It is about 2,200 entries; a bounded list covers authored text, and other references throw with a clear message.
- **Android and non-Lynx native engines.** Unchanged from the proposal.

## What already exists

| Existing | Use in this plan |
|---|---|
| `escapeHtml` / `escapeAttr` (packages/core/src/escape.ts:81, :97) | reused by `toHTML` (Q4); no second escape table |
| `tokenize` (packages/lynx/src/runtime/tokenize.ts:118) | not reused by the tag (D6, rubric evidence in R4); stays the device's HTML reader; its conformance-test pattern is reused for the tag's jsdom check (D11) |
| `fromParsed`, `insertChildren`, `NativeTree.validate` (lynx node-model.ts, tree.ts) | reused by the facade's tree method; the refusal and atomicity rules stay the innerHTML path's |
| `defineSSRSafeRenderer` (packages/cartridge-kit/src/define-ssr-safe-renderer.ts:87) | extended in place: `Renderable`, the paint seam, the template mark; its 8 tests stay |
| `renderAppToHTML` container path (packages/ssr/src/render-app.ts:252–264) | kept for unmarked renderers; marked renderers take the fast path |
| `example-*.html` fixtures + papi-conformance.test.ts:60 | precedent for the checked-in example tree fixtures (T5) |
| jsdom (lynx dev dependency) | the spec-conformant parser for D11's conformance test |
| runtime and embed `size-check.mjs`, CI ci.yml:97, :105 | re-run and reported (A6) |

## Diagrams

```
                    template(ctx) ──► Renderable = string | RenderNode | RenderNode[]
                                              │
            ┌─────────────────────────────────┼────────────────────────────────────┐
            │ string                          │ tree (html`…`, parse once/site)    │
            ▼                                 ▼                                    │
   render: innerHTML (unchanged, T4)   render(target):                              │
   renderSSR: innerHTML                  target has tree method? ── yes ──► facade: │
            │                              │ no                    RenderNode → node model
            │                              ▼                       (SVG by ancestry, text
            │                        innerHTML = toHTML(tree)       merged, raw tokenized
            │                                                       in context) → validate
            │                                                       → atomic replace (D1/D9)
            ▼                                 ▼
   SSR runner (renderAppToHTML)
     marked by defineSSRSafeRenderer? ── yes ──► html = string | toHTML(tree)   (D13 fast path)
                                      └─ no ───► container.innerHTML set + read (linkedom)

   html`…` first call per call site                         later calls
   static parts ─► parser (D6): whitespace kept, names as written, entity list,
                   refuse on*, slots in script/style/comment, D11 shapes
                 ─► cached template (WeakMap by strings array) ──────────► fill slots:
                        text │ whole attr │ partial attr │ tag name │ attr object
                        Q2 rules → D5 URL check (joined value) → D8 checks → nodes
```

Inline diagrams to keep in the code: the parser's state machine in `packages/core/src/render/html.ts` (the slot-position states), and the paint-seam branches in `define-ssr-safe-renderer.ts`.

## Failure modes

| New path | Realistic production failure | Test | Handling | What the user sees |
|---|---|---|---|---|
| Tag parse | malformed static markup in a view no test rendered | tag table | throws at first render, quoting the template text | render error in the log and `onError`; the view does not paint |
| Tag parse | an unknown named entity | tag table | throws at first use, naming the reference | clear error |
| D11 shapes | a `div` in a `p`, a `tr` in a `table` | tag table, jsdom conformance | throws at first use or at render | clear error |
| D5 | `onclick` in a template | tag table | throws at first use, pointing to `hydrate` | clear error |
| D5 | a `javascript:` URL from data | URL table | `about:invalid` plus a logged error | dead link for the visitor; logged |
| D8 | an invalid tag-name value, or an `on*` key in an attribute object | slot tables | named error at render | clear error |
| `srcdoc` | data in a `srcdoc` slot runs as HTML in the iframe | none (R8 pending) | none (R8 pending) | **silent: critical gap until R8 is decided** |
| Migration | a leftover `escapeHtml`, which shows `&amp;amp;` | migration check | the check fails in CI | visible text defect if the check is skipped |
| Migration | a markup-returning helper | migration check | rendered as escaped text | visible, not unsafe |
| Paint seam | core is newer than lynx, so there is no tree method | seam test | paints through `toHTML` | correct page; no error |
| Device | a refused element in a tree | facade test | named refusal; page untouched | the old page stays; error reported |
| Device | adjacent slot text loses its space | native one-tree row (O4) | merge rule | covered; would be silent without the test |
| SSR fast path | a consumer's byte-pinned SSR fixtures fail | goldens | CHANGELOG and bridge note | the consumer's CI fails visibly; they regenerate |
| Raw-text | a hand-built text child containing `</script` | golden | `toHTML` throws | clear error |

Critical gaps: 1 (`srcdoc`, pending R8).

## Worktree parallelization strategy

| Step | Modules touched | Depends on |
|---|---|---|
| Node types, `raw`, `toHTML`, `toDOM` | packages/core/src/render | — |
| `html` tag (parser, slots, safety) | packages/core/src/render | node types |
| Paint seam + template mark | packages/cartridge-kit | node types, `toHTML` |
| SSR fast path | packages/ssr | template mark |
| Facade tree method | packages/lynx | node types |
| Docs (best-practices §5, doc rewrite) | docs | the tag's rules settled |
| Example migration + tree fixtures + one-tree and migration checks | examples, packages/lynx/test, .github/workflows | tag, seam, facade |
| Scaffold migration (beta ritual) | outside the repo | example migration |

**Parallel lanes:**
- Lane A: node types → `html` tag → paint seam → SSR fast path (shared core/render, then cartridge-kit and ssr).
- Lane B: facade tree method (packages/lynx), once the node types merge.
- Lane C: docs, once the tag's rules are written.
- Lane D: examples, fixtures and checks, then the scaffold.

**Execution order:**
1. Land the node types first.
2. Launch A, B and C.
3. Merge A and B.
4. Then run D, and the scaffold last.

**Conflict flags:**
- packages/lynx/test is touched by B (facade tests) and D (fixtures and one-tree tests), so sequence D after B.
- core/render is shared by every lane, so freeze the node types before launching B.

## Implementation Tasks
Synthesized from this review's findings. Each task derives from a specific finding above. Run with Claude Code or Codex; checkbox as you ship. Effort ratios assumed: features ~30×, tests ~50×, architecture ~5×.

- [ ] **T1 (P1, human: ~2h / CC: ~10min)** — core/render — Define `RenderNode` (no `foreign`), `Renderable`, `raw()`
  - Surfaced by: Section 1 A3; Outside voice O3 → R10 (D12)
  - Files: packages/core/src/render/node.ts, packages/core/src/render/raw.ts, packages/core/package.json (exports `./render`)
  - Verify: `pnpm typecheck`; `pnpm knip`
- [ ] **T2 (P1, human: ~2 days / CC: ~45min)** — core/render — Build the `html` tag parser and per-call-site cache
  - Surfaced by: R2 (D4), R4 (D6), T2 whitespace, R10 (D12), R9 (D11), R6 (D8) script/style/comment refusal, O5, F2
  - Files: packages/core/src/render/html.ts, packages/core/test/render/html.test.ts
  - Verify: `pnpm --filter @airo-js/core test`
- [ ] **T3 (P1, human: ~1 day / CC: ~30min)** — core/render — Implement slot semantics and safety checks
  - Surfaced by: Section 2 Q2; R3 (D5); R6 (D8)
  - Files: packages/core/src/render/html.ts, packages/core/test/render/html.test.ts
  - Verify: tag tables for text, whole and partial attributes, tag name, attribute object, `on*`, URLs
- [ ] **T4 (P1, human: ~0.5 day / CC: ~20min)** — core/render — Implement `toHTML` and `toDOM`
  - Surfaced by: Q4; O5; R10 (D12); A2
  - Files: packages/core/src/render/to-html.ts, packages/core/src/render/to-dom.ts, packages/core/test/render/to-html.test.ts
  - Verify: goldens; web one-tree DOM-equivalence test
- [ ] **T5 (P1, human: ~0.5 day / CC: ~20min)** — cartridge-kit — Add the paint seam and template mark; extend tests with the string regression
  - Surfaced by: Section 3 T4 (CRITICAL); D1/D9; R11 (D13)
  - Files: packages/cartridge-kit/src/define-ssr-safe-renderer.ts, packages/cartridge-kit/test/define-ssr-safe-renderer.test.ts
  - Verify: `pnpm --filter @airo-js/cartridge-kit test`
- [ ] **T6 (P1, human: ~0.5 day / CC: ~20min)** — ssr — Return marked templates' HTML directly in `renderAppToHTML`
  - Surfaced by: Section 4 F3; R11 (D13); A5
  - Files: packages/ssr/src/render-app.ts, packages/ssr/test/, CHANGELOG.md
  - Verify: `pnpm --filter @airo-js/ssr test`; SSR goldens; gate 2
- [ ] **T7 (P1, human: ~1 day / CC: ~30min)** — lynx — Add the facade tree method (SVG by ancestry, text merge, raw in context) and the device navigate test
  - Surfaced by: R7 (D9); O4; R10 (D12); Section 3 T6
  - Files: packages/lynx/src/runtime/facade.ts, packages/lynx/src/runtime/node-model.ts, packages/lynx/test/facade.test.ts, packages/lynx/test/mount.test.ts
  - Verify: `pnpm --filter @airo-js/lynx test`
- [ ] **T8 (P1, human: ~0.5 day / CC: ~20min)** — tests — Add the native one-tree and jsdom conformance checks over tree fixtures
  - Surfaced by: R4 (D6) consequence; R9 (D11); Section 3 T5
  - Files: packages/lynx/test/one-tree.test.ts, packages/lynx/test/fixtures/trees/, packages/core/test/render/
  - Verify: `pnpm test`
- [ ] **T9 (P2, human: ~1 day / CC: ~30min)** — examples — Migrate the 6 example views; add fixture staleness and migration checks; give shopify-edge-worker a test script and CI step
  - Surfaced by: R1 (D3); R5 (D7) with T3; Section 3 T5
  - Files: examples/full-site/src/cartridge.ts, examples/full-site/test/, examples/shopify-edge-worker/src/*/cartridge.ts, examples/shopify-edge-worker/package.json, .github/workflows/ci.yml
  - Verify: `pnpm --filter @airo-js-examples/full-site test`; the new shopify-edge-worker test
- [ ] **T10 (P1, human: ~0.5 day / CC: ~15min)** — perf — Benchmark the real tag on an in-repo ~276-element fixture; re-run the size checks
  - Surfaced by: Section 4 F1; A6; F5
  - Files: packages/core/bench/ (new), packages/core/test/fixtures/
  - Verify: gate 1 ≤ 1.3×; `pnpm --filter @airo-js/embed size:check`; `pnpm --filter @airo-js/runtime size:check`
- [ ] **T11 (P1, human: ~1h device / CC: ~10min)** — lynx — Run gate 3 on the iOS simulator before the device path ships
  - Surfaced by: Section 4 F4; existing TODOS.md entry "Time HTML parsing and tree building on the UI thread"
  - Files: packages/lynx/scripts/device-check.mjs
  - Verify: timing rows reported for tokenize, tree build and the tree method on the largest page
- [ ] **T12 (P2, human: ~0.5 day / CC: ~20min)** — docs — Write best-practices §5 (tag, `raw`, slot table, safety, migration recipe); rewrite this doc's proposal sections to the working plan
  - Surfaced by: R5 (D7); working plan; S2
  - Files: docs/best-practices.md, docs/designs/render-tree-contract.md
  - Verify: the vendor-neutral name check over docs/ returns no hits (no consumer or product names)
- [ ] **T13 (P2, human: ~0.5 day / CC: ~15min)** — scaffold — Migrate the create-airo `site` template's 2 views through the beta ritual
  - Surfaced by: Scope Challenge S2
  - Files: create-airo `templates/site/src/cartridge.ts` (outside this repo)
  - Verify: bump beta, e2e, repack, re-verify, reply on the beta bridge thread

## Unresolved decisions that may bite you later

- **R8 / D10: `srcdoc` slots.** State: investigating. Missing: the primary cartridge consumer team's answer on whether refusing slots in `srcdoc` inside `html` templates affects them. Read-only evidence says it does not reach their editor preview, which sets `srcDoc` as a React property from a host-side string. Until it is decided, a `srcdoc` slot is escaped only, and it is the one critical gap in Failure modes.

## Completion summary

- Step 0: Scope Challenge — scope accepted as-is (D1 kept the native path, D2 changed arrangement, not scope)
- Architecture Review: 6 issues found (A1–A6)
- Code Quality Review: 4 issues found (Q1–Q4)
- Test Review: diagram produced, 33 gaps identified (findings T1–T6; test plan saved)
- Performance Review: 5 issues found (F1–F5)
- NOT in scope: written
- What already exists: written
- TODOS.md updates: 1 item proposed to user (SSR fast path), answered "build it in this work" (D13), so TODOS.md is unchanged
- Failure modes: 1 critical gap flagged (`srcdoc`, pending R8)
- Unresolved decisions: 1 in this review (R8 / D10)
- Outside voice: Codex (`codex exec`, gpt-6-astra), completed. 6 findings (3 High, 3 Medium): 5 resolved (D9, D11, D12, O4 required, O5 corrected), 1 investigating (D10). Its rollout recommendation (Option C) is not adopted; D3 stands.
- Parallelization: 4 lanes, 3 parallel (A, B, C after the node types) / 1 sequential (D, then the scaffold)
- Lake Score: 2/4. Of the answers scored for completeness (D5, D6, D7, D8), D5 and D8 chose the 10/10 option.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Outside Review | Codex `codex exec` (auto, after eng review) | Independent 2nd opinion | 1 | completed (issues_found) | 6 findings (3 High, 3 Medium); 5 resolved, 1 investigating |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | ISSUES OPEN (PLAN) | 48 issues, 1 critical gap |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **OUTSIDE COVERAGE:** Codex, plan-review phase, completed. Its six findings were checked against the code: O1 → R8 investigating; O2 → D11; O3 → D12; O4 → required with D9; O5 → corrected; O6 → D9, which kept D1.
- **CROSS-MODEL:** the native review and Codex agree on the reader-drift risk that D6 created, and on R7's byte-change caveat. Codex alone found the `srcdoc`, browser-repair, SVG-fragment, adjacent-text, raw-text and no-production-path gaps. They disagree on rollout: Codex recommends Option C, and the user's D3 answer (Option B) stands.
- **VERDICT:** no review CLEAR. Eng Review is ISSUES OPEN: the 48 issues are mapped work, plus R8 pending. Eng review required.

**UNRESOLVED DECISIONS:**
- R8 / D10: whether a slot in `srcdoc` inside an `html` template throws. Investigating; open to every consumer on bridge msg_muzvpy3z_ff76b2.
