---
status: PROMOTED
source: /plan-ceo-review (gstack)
generated: 2026-05-08
mode: EXPANSION
supersedes: /office-hours design doc selecting Approach B1
---
# studio-lite (Approach B1) on airo-js

A schema-driven cartridge composer that proves AI Result Optimisation (AIO) authoring as a real, measurable, multi-surface experience.

## The Headline Thesis: AIO

"AI Result Optimisation" (AIO) is content optimization across three audiences from a single authoring action: humans, search engines, and AI agents. SEO optimized content for search-engine indexers; AIO optimizes for the surfaces an AI assistant queries when answering a user's question — Schema.org-backed AI Overviews, agent-driven shopping via MCP, AI-assistant context curation via llms.txt and similar artifacts, plus the existing search-crawler surface. airo-js is the first framework whose architecture *requires* multi-surface output: every cartridge emits Views (humans), MCP tools (agents), and PublicationAdapter outputs (Schema.org JSON-LD, vendor XML, etc.) from the same post-Transformer snapshot. studio-lite is the first product whose entire purpose is to make AIO authoring feel like normal content authoring.

The 60-second demo: a non-developer edits content in studio-lite. On save, three preview surfaces update simultaneously — the rendered human card, a Schema.org/AI-Overview-shape preview, and an agent-readable inspection of the cartridge's MCP tools and outputs. One save, three audiences served.

The shareable framing: *"Watch a non-developer update a page once and have it instantly become better for humans, Google's AI Overview, AND Claude querying via MCP. This is what AIO actually looks like."*

## Vision

### 10x Check

The 10x version makes AIO measurable, multi-surface, and visible in the moment of authoring. Three preview panes that update synchronously on save. An AIO Score (Lighthouse-for-AI) that names what's missing. A PublicationAdapter coverage panel that surfaces the framework's existing AIO machinery directly in the editor. Real cartridge content (doc-page family) so the previews render against meaningful structured data, not skeleton lorem-ipsum.

### Platonic Ideal (12-month state)

A non-technical author opens studio-lite, picks a "doc page" or "shoppable product" template, drops a cartridge, fills the schema-driven editor. The studio:
- Drafts initial copy via AI from any data sources the cartridge exposes
- Shows three live previews side-by-side on every keystroke
- Tells the author *"AIO score 87. Adding `aggregateRating` to the schema would lift Schema.org coverage. Your MCP tool descriptions are missing `returns_policy` which agent-shoppers will ask about."*
- One publish button updates the storefront, the JSON-LD feed, and (in a follow-on) the MCP server's tool catalog

In parallel, airo.you (the framework's own docs site, follow-on product) is built on these same cartridges and serves as the public AIO proof point: ask Claude / ChatGPT / Perplexity *"what is airo-js"* and the answer is detailed, accurate, and useful because the docs site exercises every AIO surface the framework provides.

## Scope

### In v0 (accepted)

| Item | Effort | Notes |
|---|---|---|
| B1 monolithic web studio | M-L | Single host app, SQLite, schema-driven editor, single-process preview iframe |
| Multi-surface preview pane | M (~1 wk) | In-app Lit components under `apps/studio-lite/src/editor/components/` (`<studio-preview-triple>` etc.) |
| AIO Score (Lighthouse-for-AI) | S-M (~3-5 d) | Five inputs across Schema.org, adapters, MCP, content, crawler |
| PublicationAdapter coverage display | S (~2-3 d) | Surfaces existing framework metadata in the editor |
| Doc-page cartridge family | M (~5-7 d) | DocPage, APIRef, Tutorial, Example, FAQ — reusable for the airo.you follow-on |

### Architectural commitments

- **B1 monolithic architecture, BUILT ON airo-js (decided 2026-05-08, /plan-eng-review)** — studio-lite's structural shell IS an airo-js app. Static `index.html` loads `@airo-js/embed` which bootstraps the airo-js shell. Structural cartridges (`Sidebar:Score`, `Sidebar:AdapterCoverage`, `Preview:Triple`, `EditorShell`) compose into a page layout. The `EditorShell` cartridge's View renders a Web Components mount-point (a custom element, e.g. `<studio-editor>`) hosting the interactive editor; that editor is host-app code (per the framework's hard scope line) built on Lit + signals — zero framework runtime, platform-native primitives. Hono server (Node/Bun) handles `/api/save`, `/api/preview`, `/api/score`, `/api/app-config`, plus the in-process MCP server. Repo location: `apps/studio-lite/` in the airo-js monorepo with isolated CI. SQLite for v0. Both web and MCP servers bind to 127.0.0.1 only with random port + strict Origin check.
- **State propagation: revision-id pattern** — `EventBus` is invalidation-only (synchronous, lossy). The save endpoint emits a monotonic `revision_id` (SQLite autoincrement). Cartridge listeners track the highest revision they've seen and discard in-flight fetches for older revisions. Eliminates preview-lag races during fast editing.
- **Real implementation footing** — `@airo-js/embed`, `@airo-js/runtime`, and `@airo-js/mcp` are stub packages at rc.4. studio-lite calls `createApp` (in `@airo-js/core`) and `createCartridgeApp` (in `@airo-js/cartridge-kit`) directly. Building studio-lite forces those three stub packages to mature.
- **Schema-driven editor** — renders the cartridge's `SchemaDefinition.toJsonSchema()` as the editor form. Cartridges that omit `toJsonSchema()` get a fallback raw-JSON editor. `DataSource.onboardingShape` is used only at first-run data-source connection (URL paste, file upload, OAuth, sheet picker), never for ongoing content edits.
- **Multi-surface preview pane** — three preview surfaces: human (iframe with `@airo-js/embed`), SEO-AIO (renders the cartridge's Schema.org JSON-LD output as a Google-AI-Overview-style snippet), agent (structured display of MCP tool inputs/outputs against the current snapshot, plus "open in Claude Desktop" copy-paste link with the studio's MCP server URL). All three update synchronously on save (via revision-id pattern). Implemented as in-app Lit components under `apps/studio-lite/src/editor/components/` (`<studio-preview-triple>`, `<studio-aio-score>`, `<studio-adapter-coverage>`, `<studio-editor>`) — studio-lite-specific UI, not a framework package.
- **Cartridge contract refinement (framework gap)** — Sidebar:Score, Sidebar:AdapterCoverage, EditorShell are presentation-only and stretch the existing self-contained-content cartridge contract. The framework needs a "presentation cartridge" variant or explicit optionality on `DataSource`/`Transformer`/`PublicationAdapter`. Captured as a v0.x cartridge-kit design item; first implementation surfaces the precise shape needed.
- **AIO Score** — sidebar component computing a 0-100 score from five inputs: (1) Schema.org field coverage, (2) PublicationAdapter readiness (% adapters that pass `validate()`), (3) MCP tool fillness, (4) content completeness, (5) crawler-surface completeness. Names the top 3 fixes inline.
- **PublicationAdapter coverage display** — sidebar component listing every adapter the cartridge declares with status (ready / partially-blocked / fully-blocked). For blocked adapters, surfaces the missing `requires` field paths.
- **Doc-page cartridge family** — `DocPage`, `APIRef`, `Tutorial`, `Example`, `FAQ`. Each declares: a `DataSource` (markdown/MDX file or JSON), a `Transformer` (frontmatter parsing, headings extraction, code-block annotation), 1-3 read-only `MCP tools`, and a `View`. PublicationAdapters per cartridge cover all four AIO surfaces: Schema.org JSON-LD, llms.txt fragment, AI-Overview microdata, classic crawler surface (sitemap, canonical, OG, Twitter card).

### Why these expansions are load-bearing for the AIO thesis

- **Multi-surface preview pane**: makes AIO visually true. Without it, studio-lite looks like Sanity-with-a-render-layer.
- **AIO Score**: makes AIO measurably true. Without it, AIO is a slogan — viewers can't see proof of progress.
- **PublicationAdapter coverage display**: makes airo-js's existing AIO machinery visible to authors.
- **Doc-page cartridge family**: gives the AIO surfaces something real to render against.

## Out of v0 (deferred)

- **airo.you docs site** — Public docs site for airo-js, built using airo-js itself, structured like react.dev. Acts as the public AIO proof point: ask Claude / ChatGPT / Perplexity "what is airo-js" and the answer is detailed and accurate because the docs site is built with the framework's AIO machinery. Recursive adoption loop. Likely uses the doc-page cartridge family from this plan, possibly authored via studio-lite once studio-lite is shipping. Gets its own design doc and CEO review when it's time.
- **Live MCP chat in studio** — Embed Claude (via Anthropic SDK) directly in the studio's agent preview pane. Skipped from v0 due to API cost + key UX complexity. Reconsider for v0.1 if user feedback says the structured-tool-inspection pane isn't doing the demo work.
- **`RecurringEditShape` v2 on cartridge-kit** — `DataSource.onboardingShape` is closed and first-run-only. The schema-driven editor in studio-lite v0 uses `SchemaDefinition.toJsonSchema()`, which gives functional but UX-thin forms (no field labels / ordering / groups / content-vs-config distinction). v2 designs against feedback, not upfront speculation.
- **Cartridge-kit builder** — Authoring kit for cartridge developers. The next product in the chain after studio-lite + airo.you ship.
- **VS plugin for cartridge dev** — Power-user cartridge development surface inside VS Code.
- **Embedded MCP write tools** — Agent-native authoring (Approach C from the original design doc). Returns when cartridge MCP tool surface stabilizes at v1+ with write semantics.
- **Zero-build static deploy primitives** — Approach D from the original design doc. studio-lite ships as a hosted app, not a CDN-deploy bundle.

## Hard v0 Constraints (non-negotiable)

- **Studio binds to `127.0.0.1` only.** The studio runs an MCP server (exposing the cartridge's MCP tools to the agent preview pane). That server is a data-readout surface. v0 refuses to bind to non-loopback addresses. Anything beyond v0 (hosted demo, multi-user) requires an auth + scoping design.
- **Random port + strict Origin allowlist** at startup (range 49152-65535). All `/api/*` and `/mcp/*` routes check Origin against the studio's own origin and reject everything else. Closes the browser-origin-attack-against-localhost gap.
- **State propagation uses revision-id pattern.** Save emits a monotonic revision_id; cartridge listeners discard fetches for older revisions. Eliminates preview-lag races.
- **No production secrets in v0.** Single-user, local. Cartridge data sources may pass credentials, but they live in the user's local config and never get checked in.

## Deferred Security (v0.1)

CSRF token in HTML head + middleware enforcement on writes. Session token in local config required on `/api/save` and `/mcp/*` writes. SQLite file mode 0600.

## Resolved at /plan-design-review (2026-05-08)

- **Design system:** see [DESIGN.md](./DESIGN.md). Monochromatic neutrals + signal-blue accent (`#2D70FF`). Inter Display + Inter + JetBrains Mono. 4px base spacing scale. The full system applies to studio-lite, airo.you, and every future host app.
- **Information hierarchy** (locked): top chrome bar (logo · cartridge selector · save state · screenshot capture button) → left sidebars (AIO Score panel above adapter coverage panel, 240px) → editor canvas (60% of remaining width) → three preview panes stacked vertically on the right (40% of remaining width: human / SEO-AIO / agent). The AIO Score number is the largest visual weight on the screen.
- **Interaction states** — every feature has a designed loading / empty / error / success / partial state. See the design system review's interaction state table; empty states have a primary action, never just "no items found."
- **Responsive scope:** desktop-only edit (≥1024px). Below that, read-only mobile preview shows cartridge selector + 3 preview panes stacked + AIO Score visible; editor hidden behind "Open on desktop to edit" message.
- **Accessibility scope:** baseline per DESIGN.md (contrast ratios met, focus rings on all interactives, touch targets, status indicators carry both color + non-color signal, `prefers-reduced-motion` honored). Full keyboard-shortcut flow + screen reader audit deferred to v0.1.
- **Share moment:** top-chrome screenshot capture button. Click produces a single PNG with studio canvas + all previews + AIO Score + small "airo-js studio-lite" watermark. No hosted-snapshot or live-URL share at v0 (deferred to airo.you-era infrastructure).
- **AIO Score animation:** count-up tween (350ms with `--ease`), accent-color flash on stabilize (200ms), then return to neutral. Single piece of choreographed motion in the product. `prefers-reduced-motion` swaps to a crossfade.
- **Cartridge selector:** top-chrome dropdown ("[▼ Cartridge: DocPage]"). Command palette (⌘K) deferred to v0.1.
- **Save status:** muted "Saved · just now" text top-right of chrome, fades 3s after success. No toast spam.

## Resolved at /plan-eng-review (2026-05-08)

- **Repo location:** `apps/studio-lite/` in the airo-js monorepo with isolated CI. `pnpm-workspace.yaml` to be updated to include `apps/*`.
- **Web stack:** Hono server (Node/Bun, runtime-agnostic) + airo-js shell via `@airo-js/embed` once that package matures (calls `createApp`/`createCartridgeApp` directly at v0) + Web Components (Lit + `@lit-labs/signals`) inside the EditorShell cartridge's View slot for the interactive editor. No framework runtime; the editor is a custom element. Rationale: stronger dogfooding alignment with airo-js's "use the platform" thesis — the entire studio is "airo-js cartridges + platform-native custom elements," with zero non-platform UI runtime in the bundle.
- **AIO Score formula:** equal weights (20% × 5 inputs) for v0; recompute on save with 300ms debounce. Iterate from feedback.
- **Sample data for doc-page cartridges:** 5 curated fixture pages (one per cartridge type) with clean frontmatter for v0. Importing the framework's own README/CONTRIBUTING was rejected — those files have drift and aren't structured docs.
- **Test stack:** `node:test` for unit + integration; Playwright for 5 critical-path E2E tests; no eval at v0.

## Failure Modes (plan-stage; specifics resolved at /plan-eng-review)

```
  CODEPATH (planned)        | FAILURE MODE              | RESCUED? | TEST? | USER SEES         | LOGGED?
  ──────────────────────────|───────────────────────────|──────────|───────|───────────────────|────────
  DataSource.fetch          | timeout/network fail      | Y(plan)  | TBD   | "Source failed"   | Y(plan)
  PublicationAdapter validate| validation fails         | Y(fwk)   | Y(fwk)| Adapter "blocked" | Y(plan)
  Editor save               | SQLite locked/disk full   | Y(plan)  | TBD   | Banner + retry    | Y(plan)
  Markdown/MDX parse        | invalid frontmatter       | Y(plan)  | TBD   | Inline error+line | Y(plan)
  MCP tool exec (agent pane)| tool throws / bad output  | Y(plan)  | TBD   | "Tool failed"     | Y(plan)
  AIO Score compute         | adapter throws            | Y(plan)  | TBD   | Score N/A + cause | Y(plan)
  Editor JSON-Schema render | schema malformed          | Y(plan)  | TBD   | Fallback raw JSON | Y(plan)
  Studio MCP server bind    | non-loopback HOST set     | Y(hard)  | Y(plan)| Refuse to start  | Y(plan)
```

No critical gaps at the plan stage.

## Architecture Sketch

```
   ┌────────────────────────────────────────────────────────────────┐
   │                         STUDIO-LITE B1                         │
   │                                                                │
   │  ┌─────────┐    ┌─────────┐    ┌──────────────────────────┐  │
   │  │ Editor  │───▶│ Snapshot│───▶│   Multi-surface preview  │  │
   │  │ (forms) │    │  store  │    │  ┌──────┬──────┬──────┐  │  │
   │  └─────────┘    │ (SQLite)│    │  │human │SEO/  │agent │  │  │
   │       ▲         └─────────┘    │  │      │AIO   │      │  │  │
   │       │              │         │  └──────┴──────┴──────┘  │  │
   │       │              │         └──────────────────────────┘  │
   │       │              ▼                                        │
   │       │         ┌────────────┐    ┌───────────┐               │
   │       │         │ AIO Score  │    │ Adapter   │               │
   │       └─────────│  + fixes   │    │ coverage  │               │
   │                 └────────────┘    └───────────┘               │
   │                                                                │
   │     uses: @airo-js/core, @airo-js/cartridge-kit, @airo-js/ssr │
   │           @airo-js/embed, @airo-js/mcp                         │
   │     loads: @airo-js-cartridges/doc-page  (+ store-loaded)      │
   └────────────────────────────────────────────────────────────────┘
```

## What Already Exists (reuses, no rebuilds)

| Sub-problem | Existing primitive | How studio-lite reuses |
|---|---|---|
| Cartridge contract | `Cartridge<TData, TConfig>` in `@airo-js/cartridge-kit` | Loaded as plugins |
| Schema → form data | `SchemaDefinition.toJsonSchema()` on each cartridge | JSON Schema piped into a form generator |
| First-run data-source UI | `DataSourceOnboardingShape` (5 closed kinds) | Studio renders the matching affordance per kind |
| Render to HTML | `renderAppToHTML` from `@airo-js/ssr` | "human" preview pane |
| Render with publication outputs | `renderAppWithPublication`, `runPublicationAdapters` | SEO-AIO and adapter-coverage panes |
| MCP tool emission | `@airo-js/mcp` + per-cartridge `McpToolDefinition` | Agent preview pane inspects these |
| Validation as hard gate | `PublicationAdapter.validate()` returning coverage metadata | Adapter-coverage display + AIO Score |
| Browser bootstrap | `@airo-js/embed` (~5KB) | "human" preview iframe |

## Next Skills

- `/plan-eng-review` (required gate): architecture specifics, error-map specifics, test plan, performance characteristics, deploy story.
- `/plan-design-review` (recommended): studio UI layout, empty/error states, AIO Score visual treatment, accessibility.

## History

- Generated by `/plan-ceo-review` (gstack) on 2026-05-08, EXPANSION mode.
- Supersedes the `/office-hours` design doc that explored four CMS shapes (A/B/C/D); selects Approach B at the B1 architectural shape.
- Spec-review iterations: 1 round, 3 issues caught and fixed, quality 8.5/10.
- Promoted from `~/.gstack/projects/airo-js/ceo-plans/2026-05-08-studio-lite.md` to this location on user approval.
- `/plan-eng-review` (gstack) on 2026-05-08, FULL_REVIEW mode: locked repo location (apps/), web stack (Hono + airo-js shell + React-in-EditorShell), pivot to studio-lite-on-airo-js, AIO Score formula defaults, fixture data sourcing, test stack. Codex outside voice run; 6 findings, 4 applied (revision-id state pattern, layered local-server defenses partial, real-implementation-footing note, curated-fixtures-not-README), 1 user-overruled (dogfood-shell vs dogfood-substrate; user chose to keep dogfood-shell), 1 partial (security additions partial: random port + Origin only at v0).
- Post-eng-review revision (2026-05-08): editor host-app stack flipped from React to Web Components (Lit + `@lit-labs/signals`). Rationale: stronger alignment with airo-js's platform-native ethos — "studio shell is airo-js cartridges, editor is platform-native custom elements" is a cleaner pitch than mixing in a non-platform UI runtime. ~1-2d added to Lane C for state-store wiring; bundle smaller; no transpiled-framework dependency.
