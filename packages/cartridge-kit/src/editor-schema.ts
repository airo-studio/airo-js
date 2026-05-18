/**
 * Editor-time metadata. Cartridges declare these so host studios can
 * render configuration UIs without hardcoding per-cartridge catalogs.
 *
 * The framework consumes ZERO of these at render time — they exist so a
 * studio (any studio) can present an editor over the cartridge's
 * configurable surface. Cartridges that ship without these schemas remain
 * valid; host studios fall through to their own defaults.
 *
 * Three top-level shapes:
 *   - `ComponentSchema<TStyles>` — per-component editable surface (props
 *     + allowed style keys). Generic over the cartridge's style surface
 *     so `styles.allowed` typechecks against the cartridge's own keys.
 *   - `PageSchema` — per-page editable surface (props + allowed style keys
 *     for the page wrapper).
 *   - `ThemeSchema` — token catalog grouped by `app` / `page` / `component`
 *     scope. Studios render Style panels from this; the `component` scope
 *     is typically derived from `componentSchema` + the style surface via
 *     `deriveComponentTokens`, exported alongside.
 */

/**
 * Built-in field kinds the framework documents. Cartridges MAY declare
 * cartridge-specific kinds as first-class extensions — host studios
 * fall through to a textarea control and SHOULD `console.warn` so
 * authors notice during development.
 *
 * Common extension kinds seen in cartridge-side declarations:
 *
 *   - `'attribute'` — pick a key from the cartridge's typed feed
 *     (e.g., a product attribute name). Cartridges expose the
 *     available keys via cartridge-local helpers; studios render a
 *     `<Select>` populated from those.
 *   - `'reference'` — pointer to another entity in the cartridge's
 *     data graph (related product, recommended category).
 *   - `'image'` — image URL with preview + upload affordance.
 *
 * These stay extensions (not promoted to the core union) so the
 * framework doesn't pretend every host studio supports them out of
 * the box. Promoting `'attribute'` to core would commit every
 * downstream studio to rendering a feed-attribute picker; that's a
 * data-source semantics decision, not a UI-input-type decision.
 *
 * The intersection with `(string & {})` on consumers preserves IDE
 * autocomplete on the core set while leaving the type open for extensions.
 */
export type FieldType =
  | 'boolean'
  | 'string'
  | 'number'
  | 'enum'
  | 'color'
  | 'cssLength'
  /**
   * Free-form CSS — studio renders a code-textarea control. The cartridge
   * is responsible for any sanitisation at the boundary where the value
   * lands in the DOM; the framework reserves the kind so studios know to
   * pick a code-shaped editor instead of a single-line input.
   */
  | 'css'
  | 'textarea';

/**
 * Scope of state a prop change invalidates. Semantic, not paint-mechanism —
 * host studios pick the repaint strategy.
 *
 *   `'instance'` — local to one component instance; host can hot-patch.
 *   `'page'`     — requires page re-render; data fetches may re-trigger.
 *   `'app'`      — requires app re-init (config bound at boot); host
 *                  typically reloads the embed/iframe or remounts the SPA.
 *
 * Reserved: `'app'` is the slot for top-level cartridge-config props when
 * a `cartridgeConfigSchema` field lands as a future additive ask. Not used
 * on `ComponentSchema` or `PageSchema` props in v1 — those changes scope
 * to instance or page.
 */
export type ChangeScope = 'instance' | 'page' | 'app';

/**
 * Per-prop metadata. Drives studio-side input rendering.
 *
 * `changeScope` is non-optional by design: omitting it would let studios
 * either reload the iframe on every edit (slow, kills the live-edit feel)
 * or miss re-renders for changes that genuinely need an app-scope reload
 * (broken — user edits, sees no change, thinks studio is buggy). Authors
 * declare it per-prop.
 */
export interface PropSchema {
  /**
   * Field kind. The documented core set (`FieldType`) covers the common
   * inputs; cartridge-specific kinds (e.g., `'attribute'` for cartridges
   * that bind to a typed data path) are first-class extensions, not
   * violations.
   */
  type: FieldType | (string & {});
  label: string;
  description?: string;
  default: unknown;
  /** Enum options when `type === 'enum'`. */
  options?: ReadonlyArray<{ value: string; label: string }>;
  /** Numeric bounds when `type === 'number'`. */
  min?: number;
  max?: number;
  step?: number;
  /** Non-optional: declare which scope a change invalidates. */
  changeScope: ChangeScope;
  /**
   * Inspector section grouping. Open string — studios decide rendering.
   *
   * Common values:
   *   - `'behaviour'` — runtime behavior toggles (showPrices, autoplay)
   *   - `'layout'` — positional / sizing controls
   *   - `'style'` — visual treatment (colors, typography)
   *   - `'advanced'` — power-user surface
   *   - `'data-binding'` — feed-attribute picker / data-source mapping
   *
   * Open by design — studios are free to add their own buckets, and
   * the framework does not bless any one studio's tab vocabulary as
   * canonical. Listed values are examples to help authors converge on
   * common conventions, not a closed enum.
   */
  category?: string;
}

/**
 * Per-component editable surface. Generic over the cartridge's style
 * surface (`TStyles`) so `styles.allowed` can be typechecked against the
 * cartridge's own keys — declared via `defineStyleSurface` and threaded
 * through `Cartridge<TData, TConfig, TStyles>`.
 */
export interface ComponentSchema<TStyles = unknown> {
  id: string;
  label: string;
  /**
   * Studio-resolvable icon key. The framework doesn't mandate a library;
   * convention is whatever the host studio's icon resolver understands
   * (a Lucide name, a Heroicons name, an SVG identifier — cartridge picks).
   */
  icon: string;
  /**
   * Open-ended grouping. Studios decide how to bucket components in
   * navigation; common values are `'layout'`, `'content'`, `'media'`,
   * `'navigation'`, `'commerce'`, `'editorial'`.
   */
  category: string;
  /** Required components can't be hidden by studios (visibility locked). */
  required?: boolean;
  /**
   * Inline sub-component — surfaced under the parent's "Sub-components"
   * section in inspector UIs, excluded from the top-level region/drag
   * vocabulary.
   */
  inline?: { parent: string };
  /** Editable behaviour props. */
  props: Record<string, PropSchema>;
  /**
   * Which style keys this component honours. Type-checked against the
   * cartridge's `TStyles` surface — invalid keys fail at compile time when
   * the cartridge wires `Cartridge<TData, TConfig, TStyles>`.
   */
  styles: { allowed: ReadonlyArray<keyof TStyles & string> };
  /**
   * Restrict the component to specific page ids. Omit to allow on all
   * pages. Page ids are cartridge-author-controlled strings.
   */
  availableOnPages?: ReadonlyArray<string>;
}

/**
 * Per-page editable surface — the wrapper element's props + style keys.
 * Page styles are intentionally a thinner surface than component styles;
 * most theming happens at the global scope.
 */
export interface PageSchema {
  id: string;
  label: string;
  props: Record<string, PropSchema>;
  styles: { allowed: ReadonlyArray<string> };
}

// ---------------------------------------------------------------------------
// Theme schema — global / page / component token catalogs
// ---------------------------------------------------------------------------

/**
 * One CSS variable's editor metadata: name, kind, default, optional
 * options/bounds. The `cssVar` field is cartridge-author-controlled —
 * the framework doesn't mandate a prefix, so cartridges can use any
 * naming convention (`--airo-*`, `--mycartridge-*`, etc.).
 */
export interface TokenDef {
  /**
   * CSS custom property name (including the leading `--`). The cartridge
   * runtime reads this off the host element and applies it; the studio
   * writes to it via the value editor. Convention is cartridge-defined.
   */
  cssVar: string;
  kind: FieldType | (string & {});
  /**
   * Default value.
   *
   *   - `string` for flat tokens (the common case).
   *   - `Record<string, string>` keyed by mode name when this token lives
   *     in a section with `perMode: true`. Convention for mode keys is
   *     `'light'` / `'dark'` but cartridges pick the vocabulary.
   */
  default: string | Record<string, string>;
  description?: string;
  options?: ReadonlyArray<{ value: string; label: string }>;
  /** Inline numeric bounds (mirror PropSchema; no nested constraints object). */
  min?: number;
  max?: number;
  step?: number;
}

/**
 * A grouping of tokens — studios render one inspector section per
 * `TokenSection`, with `displayName` as the heading.
 */
export interface TokenSection {
  id: string;
  displayName: string;
  /**
   * When `true`, every `tokens[*].default` in this section is a record
   * keyed by mode name. Studios render a mode toggle at the section level.
   * Default `false` — flat tokens with `string` defaults.
   */
  perMode?: boolean;
  tokens: ReadonlyArray<TokenDef>;
}

/**
 * Token catalog grouped by scope.
 *
 *   - `app`       — global theme tokens (brand colours, typography, etc.).
 *   - `page`      — per-page wrapper overrides (background, padding, etc.).
 *   - `component` — per-component tokens. Typically derived from
 *                   `componentSchema` + the style surface via
 *                   `deriveComponentTokens` (exported alongside), so the
 *                   cartridge author writes the surface declaration once.
 */
export interface ThemeSchema {
  app: ReadonlyArray<TokenSection>;
  page: ReadonlyArray<TokenSection>;
  component: ReadonlyArray<TokenSection>;
}
