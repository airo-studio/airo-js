# Design System — airo-js

The visual language for studio-lite, airo.you, and every future host app built on airo-js. Authored 2026-05-08 during `/plan-design-review` on the studio-lite plan; expected to evolve.

## Amendments

- **2026-05-08 — studio-lite editor adopts Geist + jade.** Per [docs/designs/studio-lite-editor.md](docs/designs/studio-lite-editor.md), the studio-lite editor surface uses a distinct local palette (Geist + Geist Mono typography, jade `#1F6F4E` accent on warm off-white `#FAF7F2` ground) optimised for long-form authoring. The chilopod mark is a geometric sans; Geist is its visually congruent typographic peer. The recommendation in that doc is option 1 (unify across all surfaces); we're staging the migration:
  - **Authoritative for the studio-lite editor today:** the tokens listed in `studio-lite-editor.md` §Visual language. The compose drawer, page list rail, and stage all use them.
  - **Still on the original system below:** the `@airo-js/devtools` Lit elements (`<studio-aio-score>`, `<studio-adapter-coverage>`, `<studio-preview-triple>`) and `@airo-js/doc-cartridges`'s published-page stylesheet. They keep Inter + signal-blue until migrated.
  - **Future:** unify on Geist + jade across the rest. Tracked as a follow-up alongside the other Lane B/C/E migrations.

## Direction

Clean, simple, monochromatic. Color is intentional restraint, not decoration. A single accent color flairs the moments that genuinely require attention. The product looks like authoring software, not a marketing site. Linear / Notion / Figma's clean professionalism, not Webflow's stock-photo SaaS energy.

## Color

### Neutrals (the entire palette except for one accent)

| Token | Value | Usage |
|---|---|---|
| `--color-bg` | `#FFFFFF` | Page background |
| `--color-surface` | `#FAFAFA` | Sidebars, panels, raised regions |
| `--color-surface-2` | `#F2F2F2` | Hover states on neutral surfaces, subtle inset |
| `--color-border` | `#E8E8E8` | Hairlines, dividers, subtle outlines |
| `--color-border-strong` | `#D0D0D0` | Form field borders, defined boundaries |
| `--color-text-muted` | `#888888` | Secondary text, helper text, placeholders |
| `--color-text` | `#2A2A2A` | Body copy |
| `--color-text-strong` | `#111111` | Headings, emphasized labels, the AIO Score number when neutral |

### The flair accent (use sparingly)

| Token | Value | Usage |
|---|---|---|
| `--color-accent` | `#2D70FF` | The AIO Score number when it goes up; primary save button background; required-action callouts; focused form input outline; blocked-adapter status dot when action is required |
| `--color-accent-hover` | `#2461E0` | Hover state on accent buttons |
| `--color-accent-soft` | `rgba(45, 112, 255, 0.08)` | Subtle accent backgrounds (selected row, focus rings) |

**The accent rule:** if a screen has more than ~4 elements using the accent color, one of them is wrong. The accent should be the eye magnet, not the wallpaper.

### Status colors (separate from the accent on purpose)

| Token | Value | Usage |
|---|---|---|
| `--color-success` | `#1F9D55` | "Adapter ready" indicators, save-success flashes |
| `--color-warning` | `#C97A0E` | Coverage warnings (partial adapter readiness) |
| `--color-error` | `#D63838` | Validation errors, save failures, parse errors |

Status colors are functional, not decorative. Use them only when they communicate state. The accent is for "look here", status colors are for "this is what state this is in".

## Typography

Two typefaces. No more. No system-ui fallback as the primary face — pick a real face.

| Role | Family | Weight | Size | Usage |
|---|---|---|---|---|
| Display | Inter Display (Geist Sans as fallback) | 600 | 48-64px | The AIO Score number. Possibly the studio header title. Used very sparingly. |
| Heading | Inter Display | 600 | 16-20px | Section headings (Sidebar:Score, Adapter Coverage, etc.) |
| Body | Inter | 400-450 | 14px | Form labels, paragraph copy, list items |
| Body strong | Inter | 600 | 14px | Emphasized labels, button labels, currently-selected nav items |
| Label | Inter | 500 | 11px | Tracking 0.04em, uppercase, used for sidebar section headers ("AIO SCORE", "ADAPTER COVERAGE") |
| Mono | JetBrains Mono (or Geist Mono) | 400 | 13px | Code blocks, JSON-LD output, MCP tool names, schema field paths |

**Line height:** 1.5 for body, 1.2 for display, 1.3 for headings.

**Letter spacing:** -0.01em for display, 0 for headings/body, +0.04em for uppercase labels.

## Spacing

4px base scale: **4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 / 96**.

Use 16px as the default gap between unrelated elements. 8px for related elements (label + input). 4px for very tight relationships (icon + label). 32px between sections. 48px+ for major regions.

Sidebars get 16px internal padding. The editor canvas gets 24px. Preview panes get 16px.

## Border radius

| Token | Value | Usage |
|---|---|---|
| `--radius-sm` | `4px` | Buttons, form fields, status dots |
| `--radius` | `8px` | Cards (when used) |
| `--radius-lg` | `12px` | Modals, popovers |
| `--radius-pill` | `9999px` | Status pills (use sparingly) |

The studio shell layout uses 0 — sidebars and panes meet at hairline borders, not rounded corners.

## Elevation

Minimal. Most surfaces are flat. Use shadow only to signal "floating above the page".

| Token | Value | Usage |
|---|---|---|
| `--shadow-popover` | `0 4px 12px rgba(17, 17, 17, 0.08), 0 1px 3px rgba(17, 17, 17, 0.04)` | Modals, popovers, hover-revealed menus |
| `--shadow-focus` | `0 0 0 3px rgba(45, 112, 255, 0.15)` | Focus ring on form inputs |

No card drop shadows. No decorative shadows. If a card needs to feel separated, use a hairline border, not a shadow.

## Motion

Restrained. Motion clarifies hierarchy and confirms state changes. Motion is not decoration.

| Token | Value | Usage |
|---|---|---|
| `--ease` | `cubic-bezier(0.4, 0, 0.2, 1)` | Default ease-out for most transitions |
| `--duration-fast` | `120ms` | Hover state changes, micro-feedback |
| `--duration` | `200ms` | Button press, panel toggle, sidebar reveal |
| `--duration-slow` | `350ms` | The AIO Score count-up animation |

**The AIO Score animation:** when the score changes, the number tweens from old to new over 350ms with `--ease`. The number briefly flashes `--color-accent` for 200ms at the moment it stabilizes, then returns to `--color-text-strong`. This is the single piece of choreographed motion in the product. Everything else is invisible (the highest compliment for motion).

**Forbidden motion:** parallax, 3D transforms, decorative loops, anything that calls attention to itself. Studio-lite is a tool, not a showcase.

## Iconography

Use Lucide (clean line icons, 1.5px stroke). 16px or 20px for inline icons; 24px for navigation.

Status dots are filled circles, 8px diameter. No ornamental icons — every icon must have a function (save state, adapter status, expand/collapse, copy-to-clipboard, etc).

## Information hierarchy

In every screen:

1. **The score** (when on screen) is the largest visual weight. 48-64px display number.
2. **The active editor canvas** is the next-largest region (real estate, not necessarily type size). It's where the user's focus lives.
3. **The previews** are clearly secondary — same canvas region, but visually subordinate (lower visual weight, smaller or recessed).
4. **The sidebars** are consistent secondary chrome — visible but quiet.
5. **The header** is utility — present but never competing.

If everything competes, nothing wins. Subtraction default.

## Accessibility

- Body text contrast ratio against background ≥ 4.5:1 (`#2A2A2A` on `#FFFFFF` = 13.5:1 ✓; `#888888` on `#FFFFFF` = 4.6:1 ✓ for muted, fails for body — never use muted gray for body content).
- Focus ring on all interactive elements (use `--shadow-focus`).
- Touch targets ≥ 44px minimum (mobile); 32px minimum (desktop with mouse).
- All status indicators carry both color AND a non-color signal (a label, a shape, an icon). Status dot color alone is not enough for colorblind users.
- Keyboard navigation: tab order follows visual order; sidebar panels skippable via landmark navigation.
- Honor `prefers-reduced-motion` — disable the AIO Score count-up animation; cross-fade instead.

## Brand applications

| Surface | Approach |
|---|---|
| studio-lite | This design system applied directly. |
| airo.you (docs site) | Same palette, same type. Docs pages can use slightly more generous whitespace and a wider type scale for reading. Code blocks use Mono. The AI Overview preview in the docs (when showing AIO Score / cartridge demos) uses the accent. |
| Cartridge author tools (future @airo-js/devtools) | Same system applied to cartridge dev surfaces. |
| Marketing material (if any) | Same system. The framework's "look" is consistent across surfaces. No marketing-site-with-different-design moments. |

## What's NOT in this design system

- No purple gradients
- No 3-column feature card grids
- No icons-in-colored-circles section decorations
- No splash screens or interstitials
- No emoji used as design elements (emoji in user content is fine)
- No carousels
- No system-ui as the primary typeface
- No multiple accent colors
- No drop shadows on cards
- No decorative imagery (illustrations, blobs, wave dividers, gradient meshes)
- No "stock photo" hero sections

## Status

DRAFT. Authored 2026-05-08 from `/plan-design-review` on studio-lite. Expected to evolve as the implementation surfaces gaps. Updates should be reviewed via `/design-consultation` or by amendment in this repo.
