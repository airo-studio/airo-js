---
status: APPROVED
source: /design-review (gstack) + iteration
generated: 2026-05-08
parent: studio-lite.md
mockup: docs/designs/studio-lite-editor-mockup.html
---

# studio-lite editor UI

The editor surface for `apps/studio-lite/`. Companion to `studio-lite.md` (the product plan). This doc is the contract between design and engineering for the v0 editor cartridges.

## TL;DR

A multi-page CMS for cartridge instances. Markdown body is the source of truth; the rendered preview is click-to-edit and syncs back to the markdown. Three resizable columns: page list (left), compose drawer (center), preview stage (right). Generate-with-Claude is a first-class affordance because authors will paste agent-written content.

Not building: a block editor with nested expand-to-edit rows. That direction was explored and dropped as too complex for v0.

## Surface map

### Topbar (60px)

| Slot | Content |
|---|---|
| Left | `chilopod-mono.png` 34×34 (8px radius) + `studio lite` sublabel (Geist 13px / 500). No `AIRO` text — icon carries the brand. |
| Left+ | Brand divider 1px / 22px tall, then cartridge selector pill: `DocPage v0.0.0 ▾`. Opens a list of cartridge types in the loaded plugins. |
| Center | Audience nav: `Human` / `SEO · AIO` / `Agent`. Pill nav. Active state has dark fill, an accent dot, white text. |
| Right | Saved-state pill (`Saved · just now`, mono small) → screenshot button (icon) → Publish button (dark, with a small `2 fields` tag inside when surfaces are incomplete). |

### Body grid

```
[ Pages 240 ][ Compose 413 (draggable 300–720) ][ ⫶ 6 ][ Stage flex ]
```

The drawer divider is keyboard-focusable (`tabindex="0"`, arrow keys nudge in 16px steps), double-click resets to 413, `⇧⌘\` global resets both panes.

### Page list (240px)

- Header: `PAGES` label (Geist 11px / 500 / uppercase / +0.06em) + count.
- Filter input (search icon, 12px text).
- Per-row:
  - Page name (Geist 13px / 500 / -0.01em)
  - Type chip in mono (`DocPage`, `APIRef`, `Tutorial`, `Example`, `FAQ`)
  - Edit recency (`2m`, `1d`, `never`)
  - AIO score (Geist 18px / 600 / -0.03em / tabular-nums). Color: ≥85 jade, 70–84 ink-soft, <70 amber.
  - Status dot: filled jade = published, hollow = draft.
- Active row: white fill + 2px ink rail on the inner left.
- Footer: `+ New page` opens a cartridge picker modal (deferred design, see Open Questions).

### Compose drawer (default 413px)

Stack, top to bottom:

1. **Drawer head**: `COMPOSE` label + crumb (`what-is-airo-js`).
2. **Title** input (Geist 13px). Required.
3. **Description** textarea, 2–4 lines. Renders as the lede in the preview. Required.
4. **Metadata** `<details>` collapsed by default. Inside: Slug, Author, OpenGraph image, Tags. Pill on the summary lists what's inside.
5. **Body · markdown** section header with sync badge (see Interaction model). Below: monospace `<textarea>` (Geist Mono 12.5px / 1.65), min height 280px, plain plaintext editing. Tab inserts 2 spaces.
6. **md-toolbar** under the textarea: hint text on the left, `Generate with Claude` link on the right.
7. **Coverage strip** at the bottom of the drawer: 6 single-letter dots in mono — JSON-LD, llms.txt, MCP 2/2, sitemap, ogImage, tags. Jade dot = ready. Hollow amber = missing.

### Stage (flex)

A standard rendered preview, max-width 720px, centered, generous top padding. Top meta line carries the `PUBLISHED` tag (jade), update date, and a `View live ↗` link out to the public URL once the cartridge has been published.

Headings are scroll-targets (`scroll-margin-top: 24px`). The TOC anchors the locked-in nesting: `##` lines become flat TOC entries, `###` lines become indented sub-entries.

Every text element (`h1`, `.lede`, `h2`, `h3`, `p`, `pre`) is `contenteditable`. See Interaction model.

### Status bar (32px)

Mono, ink-faint. Left side: save state, SQLite revision id, page counts. Right side: keyboard shortcuts (`⌘K` jump · `⌘P` publish · `⌘G` generate · `⇧⌘\` reset panes).

## Interaction model

### Source of truth

The markdown body is canonical. SQLite stores one row per cartridge instance with `body` as plain markdown text. Typed metadata fields (title, description, slug, author, ogImage, tags, dates, status) are columns; H1 and lede in the rendered preview render from `title` and `description`, NOT from the markdown body. The markdown body starts at H2.

### Click-to-edit on the preview

Every preview text node has `contenteditable="true"`.

| State | Visual |
|---|---|
| Idle | Default rendered styling. |
| Hover | Subtle jade rail on the inside-right edge (`box-shadow: inset -8px 0 0 -6px rgba(31,111,78,0.4)`) + jade-tinted background. Cursor becomes text. |
| Focus | Left accent rail (`inset 3px 0 0 var(--accent)`) + soft-jade background + outer 1px jade glow. Padding shifts so the rail sits in the gutter. |
| Active editing | Same as focus, plus an `editing · synced to markdown` pill above the element (mono 9.5px, jade fill). |

### Sync indicator

When a preview element is focused, the `Body · markdown` section header in the drawer flips its count chip to a sync badge: `↔ line N · h2 focused` (or `↔ Title field` / `↔ Description field` when the focused element is the typed H1 or lede). Implementation: focus listeners on the contenteditable elements update the badge text + classlist.

### Round-trip rules

When a user edits an element inline and blurs (or types-debounces 200ms), serialize back to markdown:

- **H2/H3 edit** → overwrite the matching `## …` / `### …` line. Preserve trailing inline attributes (`{#anchor}`) by parsing and reapplying.
- **P edit** → replace the corresponding paragraph block (one or more contiguous non-blank lines).
- **Code block edit** → contenteditable on `<pre>` is disabled in v0. Code blocks edit through the markdown drawer.
- **Bold/italic** → preserve raw markdown syntax (`**bold**`, `*italic*`) in the body — we do not parse and re-emit inline markup.
- **Ambiguous edits** (e.g. user collapses two paragraphs by deleting the blank line in contenteditable) → accept and rewrite the markdown to match. Add round-trip fixture tests.

### Markdown drawer → preview

Textarea `input` event → debounce 300ms → POST `/api/save` → server emits new `revision_id` (per `studio-lite.md` revision-id pattern). Stage subscribes to revision and re-renders. Cartridge listeners discard fetches for stale revisions.

### Resize

The drawer↔stage divider supports mouse drag, double-click reset, arrow-key nudging (16px when focused), and `⇧⌘\` global reset. Drawer width must persist to `localStorage` keyed by user (TODO for v0 implementation — current mockup resets on reload).

### Publish

The Publish button always shows the count of incomplete surfaces inside its pill (`2 fields`, `0 fields`, etc.). Click opens a publish sheet (deferred design — see Open Questions) that lists each surface, its state, and any blocking validation.

After publish, the preview meta line gains a `PUBLISHED` tag and a `View live ↗` link to the public URL emitted by the routing cartridge.

### Generate with Claude

Link sits below the markdown textarea, right-aligned. Click opens a modal (deferred design):

1. Modal collects intent ("a tutorial on building your first cartridge", etc.).
2. Sends the cartridge schema + intent + 2–3 sibling pages as context to Claude via the API.
3. Streams generated markdown into a preview pane.
4. User picks `Insert above`, `Insert below`, or `Replace body`. No silent overwrite.

## Visual language

The editor uses a typography and palette pair distinct from the rest of `DESIGN.md`. See the amendments section below for the proposal to unify or scope.

### Typography

- **Display + UI:** Geist (Vercel typeface, free via Google Fonts).
- **Mono:** Geist Mono.
- **Letter-spacing:** -0.04em on H1 (56px display), -0.03em on H2 (26px), -0.02em on H3 (18px), -0.005em on body, +0.06em on uppercase labels.
- **Weights:** 400 body / 500 emphasis + buttons + chips / 600 headings + AIO scores / 700 reserved.
- **Line-height:** 1.0 display, 1.25 headings, 1.5 body chrome, 1.65 reading body.

### Color

| Token | Value | Use |
|---|---|---|
| `--bg` | `#FAF7F2` | Stage background (warm off-white). |
| `--surface` | `#FFFFFF` | Drawer, topbar, statusbar. |
| `--surface-2` | `#F4F0E6` | Page list rail. |
| `--ink` | `#1A1A1F` | Headings, primary text. Not pure black. |
| `--ink-soft` | `#4A4A52` | Body copy in stage. |
| `--ink-faint` | `#8B8B92` | Labels, hints, mono metadata. |
| `--rule` | `#E8E4DA` | Hairlines. |
| `--accent` | `#1F6F4E` | Jade. Live / valid / published / focus. |
| `--accent-soft` | `#E6F0EA` | Editing-state background. |
| `--warn` | `#B66C1F` | Amber. Missing surfaces, low scores. |

### Iconography

Lucide line set (1.75–2.25 stroke weight). Used for: code brackets, chevrons, trash, pencil, sparkle (Generate with Claude). Sized 11–14px inline. Status dots are filled circles.

### Motion

Restrained per `DESIGN.md`. The contenteditable hover/focus transitions are 120ms. Saved-pill flash on save is 200ms jade. AIO Score count-up animation per `studio-lite.md` is honored.

## DESIGN.md amendments (proposed)

The current `DESIGN.md` locks Inter Display + Inter + JetBrains Mono and signal-blue `#2D70FF`. The editor surface uses Geist + Geist Mono and jade `#1F6F4E`. Two paths to resolve:

1. **Unify on Geist + jade across all surfaces** (studio-lite, airo.you, future). Simpler. Updates `DESIGN.md`. Stronger brand coherence with the `chilopod` mark which is already a geometric sans.
2. **Scope by surface.** Editor uses Geist + jade (this doc). System chrome on airo.you + future hosted dashboards stays Inter + signal-blue per `DESIGN.md`.

Recommendation: option 1. The chilopod wordmark, the AIRO mark, and Vercel-style geometric typography are visually congruent. Inter + signal-blue read as "generic SaaS" next to those marks.

If option 2 is preferred, this doc's tokens are the editor's local design system and `DESIGN.md` adds a section noting the deviation.

## Implementation hand-off

### Cartridge boundaries

Following the "structural cartridges + Web Components" decision in `studio-lite.md`:

```
apps/studio-lite/src/cartridges/
  editor-shell/        # topbar + body grid + statusbar; <studio-editor> custom element
  sidebar-pages/       # the 240px page list rail
  sidebar-compose/     # the 413px (default) compose drawer; <studio-compose>
  preview-stage/       # the rendered stage; <studio-preview>
```

Each cartridge has its `View` slot a Web Component built with Lit + `@lit-labs/signals`. No framework runtime in the bundle.

### Web Components

| Element | Owns |
|---|---|
| `<studio-editor>` | Layout grid, divider drag, keyboard shortcuts, signal store wiring. |
| `<studio-compose>` | Title/Description/Metadata inputs; markdown textarea; coverage strip. Emits `compose:change` (debounced). |
| `<studio-preview>` | markdown-it render, contenteditable handlers, focus-to-sync events. Emits `preview:edit`. |
| `<studio-pages>` | Page list with filtering, "+ New page" picker. |

### Markdown engine

- **Parse:** `markdown-it` 14+ with `markdown-it-anchor` (auto-id headings).
- **Render targets:** HTML for the human preview; the same parsed AST feeds the SEO-AIO and Agent panes.
- **Serialize round-trip:** custom serializer in `preview-stage/md-serialize.ts`. Replaces matching line ranges in the source. Round-trip fixtures in `apps/studio-lite/test/md-roundtrip/`.
- **Code highlighting:** deferred to v0.1 (shiki preferred — generates static HTML, no runtime cost).

### Server endpoints (existing branch already has `publish.ts`)

```
GET   /api/pages                 list cartridge instances + meta
GET   /api/pages/:id             load one
POST  /api/pages                 create
PATCH /api/pages/:id             save (typed fields + body); emits revision_id
POST  /api/pages/:id/publish     run PublicationAdapters; transition to published
GET   /api/pages/:id/score       compute AIO score
POST  /api/generate              Claude streaming proxy (Generate with Claude)
```

### Data model

```sql
create table pages (
  id            text primary key,
  cartridge     text not null,        -- DocPage | APIRef | Tutorial | Example | FAQ
  slug          text not null unique,
  title         text not null,
  description   text not null,
  author        text,
  og_image      text,
  tags          text,                 -- comma-separated v0; tags table v0.1
  body          text not null,        -- markdown
  status        text not null,        -- draft | published
  published_at  datetime,
  updated_at    datetime not null,
  revision_id   integer not null      -- monotonic
);

create index pages_status_updated on pages(status, updated_at desc);
create unique index pages_slug on pages(slug);
```

### Test plan

- `node:test` unit tests for markdown serializer round-trip on 20 fixture pages.
- `node:test` integration test for click-to-edit → markdown body sync.
- Playwright E2E for the 5 critical flows already named in `studio-lite.md`, plus: drag divider, click-to-edit a heading, paste markdown into body, publish, view live.

### Performance budget

- Cold load to first interactive: <1.2s on M-series Mac, local SQLite.
- Markdown re-render on save: <100ms for a 5KB body.
- Click-to-edit focus → editing pill visible: <16ms (one frame).

## Out of scope (v0.x)

- Full WYSIWYG with rich-text toolbars (bold/italic via markdown shortcut only).
- Image paste → upload (deferred to v0.1; needs MCP write tools).
- Multi-cursor or collaborative editing.
- Cmd+K command palette (deferred per `studio-lite.md`).
- Inline markdown syntax highlighting in the textarea (Monaco / CodeMirror) — plain `<textarea>` is intentional.
- Cross-device drawer-width persistence; `localStorage` only for v0.
- Code block edits inline on the preview; v0 routes through the markdown drawer.

## Open questions

| # | Question | Recommendation |
|---|---|---|
| 1 | Generate with Claude — modal vs side panel vs inline-prompt? | Modal. Schema + intent in, streamed markdown out, three insert options (above / below / replace). |
| 2 | New page picker — flat cartridge-type list vs grouped vs search? | Flat for v0 (5 cartridge types). Search when there are >10 types. |
| 3 | Publish sheet — required confirmation, or one-click? | Confirmation when ANY surface is incomplete (lists what's missing); one-click when all ready. |
| 4 | Drawer width persistence scope — per user, per cartridge, or per page? | Per user (localStorage). Cartridge or page-level felt over-engineered in design discussion. |
| 5 | DESIGN.md unify-on-Geist or scope-by-surface? | Unify. See "DESIGN.md amendments" above. |

## References

- Mockup: [`docs/designs/studio-lite-editor-mockup.html`](studio-lite-editor-mockup.html) — open in any browser. Includes the draggable divider and click-to-edit preview. Source-of-truth for visual decisions. Loads `chilopod-mono.png` from this same directory.
- Brand assets: `docs/designs/chilopod-mono.png` (icon, used in topbar), `docs/designs/chilopod.png` (wordmark, reserved for marketing surfaces).
- Companion docs: `docs/designs/studio-lite.md` (product plan), `DESIGN.md` (root system, see amendments above).

## History

- 2026-05-08 — Authored after `/design-review` exploration of three directions (Stage, Triptych, Tutor). Stage selected. Iterated on brand mark, typography (Geist replaces Fraunces), draggable divider, simplification from block editor to markdown body + click-to-edit preview. Final pivot was "or both": markdown is source of truth, preview is a click-to-edit layer that syncs back.
