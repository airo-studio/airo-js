/**
 * <studio-editor> — Lit custom element that hosts the schema-driven
 * cartridge editor inside the EditorShell cartridge's View slot.
 *
 * Slice 2 (this commit): schema-driven form rendering, internal edit state,
 * validate-and-save flow.
 *   - cartridge: the Cartridge envelope (schema + metadata)
 *   - data: the current value being edited (TData of the cartridge)
 *
 * Modes:
 *   - No cartridge → empty placeholder
 *   - Cartridge but no data → metadata-only viewer (slice 1 behaviour)
 *   - Cartridge + data → editable form rendered from cartridge.schema.toJsonSchema()
 *
 * Events emitted (composed, bubbling):
 *   - 'studio-editor-data-change' (detail: { data }) on every form mutation
 *   - 'studio-editor-save'        (detail: { data }) when the user clicks save
 *                                                   AND the data validates
 *   - 'studio-editor-validation-error' (detail: { error }) when save fails validation
 *
 * Stack: Lit 3, native customElements.define. Form state held as a Lit
 * reactive property (no @lit-labs/signals at slice 2 — the form is small
 * enough that re-rendering on each keystroke is cheap; signals return when
 * sibling cartridges share state).
 */

import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import type { Cartridge } from '@airo-js/cartridge-kit';

import { renderSchemaForm, setIn, type JsonPath, type JsonValue, type SchemaFragment } from '../schema-form.js';

export class StudioEditorElement extends LitElement {
  static override properties = {
    cartridge: { attribute: false },
    data: { attribute: false },
    _draft: { state: true },
    _dirty: { state: true },
    _validationError: { state: true },
    _saveStatus: { state: true },
  };

  /** The cartridge being authored. */
  declare cartridge?: Cartridge;

  /** The current value (TData) being edited. Setting this resets the draft. */
  declare data?: unknown;

  // Reactive internal state. `declare` keeps Lit's prototype accessor live —
  // class-field initializers would shadow it under useDefineForClassFields.
  declare _draft: JsonValue | undefined;
  declare _dirty: boolean;
  declare _validationError: string | null;
  declare _saveStatus: 'idle' | 'saving' | 'saved';

  constructor() {
    super();
    this._draft = undefined;
    this._dirty = false;
    this._validationError = null;
    this._saveStatus = 'idle';
  }

  static override styles = css`
    :host {
      --airo-editor-bg: #ffffff;
      --airo-editor-fg: #0a0a0a;
      --airo-editor-muted: #6b7280;
      --airo-editor-border: #e5e7eb;
      --airo-editor-accent: #2d70ff;
      --airo-editor-accent-fg: #ffffff;
      --airo-editor-danger: #b00020;
      --airo-editor-success: #1a7f37;
      --airo-editor-code-bg: #f6f8fa;
      --airo-editor-radius: 8px;
      --airo-editor-spacing: 16px;
      --airo-editor-font-sans:
        'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      --airo-editor-font-mono:
        'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;

      display: block;
      box-sizing: border-box;
      width: 100%;
      height: 100%;
      padding: var(--airo-editor-spacing);
      background: var(--airo-editor-bg);
      color: var(--airo-editor-fg);
      font-family: var(--airo-editor-font-sans);
      font-size: 14px;
      line-height: 1.5;
    }

    *, *::before, *::after { box-sizing: border-box; }

    .empty {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--airo-editor-muted);
      font-style: italic;
    }

    header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: var(--airo-editor-spacing);
      padding-bottom: var(--airo-editor-spacing);
      border-bottom: 1px solid var(--airo-editor-border);
      margin-bottom: var(--airo-editor-spacing);
    }

    .header__identity {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    h1 {
      margin: 0;
      font-size: 20px;
      font-weight: 600;
      letter-spacing: -0.01em;
    }

    .meta {
      color: var(--airo-editor-muted);
      font-family: var(--airo-editor-font-mono);
      font-size: 12px;
    }

    .description {
      margin: 0 0 var(--airo-editor-spacing) 0;
      color: var(--airo-editor-fg);
    }

    .save-button {
      align-self: flex-start;
      padding: 8px 14px;
      border: 0;
      border-radius: 6px;
      background: var(--airo-editor-accent);
      color: var(--airo-editor-accent-fg);
      font-family: inherit;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: background-color 120ms ease;
    }
    .save-button:hover { filter: brightness(1.05); }
    .save-button:active { filter: brightness(0.95); }
    .save-button:disabled {
      background: var(--airo-editor-border);
      color: var(--airo-editor-muted);
      cursor: not-allowed;
    }

    .save-status {
      margin-top: 6px;
      font-size: 12px;
      color: var(--airo-editor-muted);
    }
    .save-status--saved { color: var(--airo-editor-success); }

    .banner {
      margin-bottom: var(--airo-editor-spacing);
      padding: 10px 12px;
      border-radius: var(--airo-editor-radius);
      font-size: 13px;
      border-left: 3px solid;
    }
    .banner--error {
      background: color-mix(in oklab, var(--airo-editor-danger) 8%, white);
      color: var(--airo-editor-danger);
      border-color: var(--airo-editor-danger);
    }

    section { margin-bottom: var(--airo-editor-spacing); }
    h2 {
      margin: 0 0 8px 0;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--airo-editor-muted);
    }

    .inventory {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
      gap: 8px;
    }
    .inventory-item {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 10px 12px;
      border: 1px solid var(--airo-editor-border);
      border-radius: var(--airo-editor-radius);
      background: var(--airo-editor-code-bg);
    }
    .inventory-count {
      font-size: 22px;
      font-weight: 600;
      line-height: 1;
      font-variant-numeric: tabular-nums;
    }
    .inventory-label {
      font-size: 11px;
      color: var(--airo-editor-muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    pre {
      margin: 0;
      padding: 12px;
      background: var(--airo-editor-code-bg);
      border: 1px solid var(--airo-editor-border);
      border-radius: var(--airo-editor-radius);
      font-family: var(--airo-editor-font-mono);
      font-size: 12px;
      line-height: 1.5;
      overflow-x: auto;
      max-height: 320px;
      overflow-y: auto;
    }
    .placeholder {
      color: var(--airo-editor-muted);
      font-style: italic;
    }

    /* ─── schema-form fields (rendered by schema-form.ts) ─── */
    .schema-field {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-bottom: 12px;
    }
    .schema-field--object {
      margin: 0 0 12px 0;
      padding: 12px;
      border: 1px solid var(--airo-editor-border);
      border-radius: var(--airo-editor-radius);
      background: color-mix(in oklab, var(--airo-editor-code-bg) 60%, white);
    }
    .schema-field__legend {
      padding: 0 6px;
      font-size: 13px;
      font-weight: 600;
    }
    .schema-field__label {
      font-size: 12px;
      font-weight: 500;
      color: var(--airo-editor-fg);
    }
    .schema-field__label--inline {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 400;
    }
    .schema-field__required {
      margin-left: 2px;
      color: var(--airo-editor-danger);
    }
    .schema-field__description,
    .schema-field__hint {
      margin: 0;
      font-size: 11px;
      color: var(--airo-editor-muted);
    }
    .schema-field__hint {
      font-style: italic;
    }
    .schema-field__input,
    .schema-field__textarea {
      padding: 8px 10px;
      border: 1px solid var(--airo-editor-border);
      border-radius: 6px;
      background: var(--airo-editor-bg);
      color: var(--airo-editor-fg);
      font-family: inherit;
      font-size: 13px;
      transition: border-color 80ms ease, box-shadow 80ms ease;
    }
    .schema-field__input:focus,
    .schema-field__textarea:focus {
      outline: none;
      border-color: var(--airo-editor-accent);
      box-shadow: 0 0 0 3px color-mix(in oklab, var(--airo-editor-accent) 18%, transparent);
    }
    .schema-field__textarea {
      font-family: var(--airo-editor-font-mono);
      font-size: 12px;
      resize: vertical;
      min-height: 96px;
    }
    .schema-field__list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .schema-field__list-item {
      display: flex;
      align-items: flex-start;
      gap: 8px;
    }
    .schema-field__list-item .schema-field {
      flex: 1;
      margin-bottom: 0;
    }
    .schema-field__remove,
    .schema-field__add {
      padding: 6px 10px;
      border: 1px solid var(--airo-editor-border);
      border-radius: 6px;
      background: var(--airo-editor-bg);
      color: var(--airo-editor-fg);
      font-family: inherit;
      font-size: 12px;
      cursor: pointer;
      transition: background-color 80ms ease;
    }
    .schema-field__remove { color: var(--airo-editor-muted); }
    .schema-field__remove:hover { color: var(--airo-editor-danger); border-color: var(--airo-editor-danger); }
    .schema-field__add { align-self: flex-start; }
    .schema-field__add:hover { background: var(--airo-editor-code-bg); }

    .footer-actions {
      display: flex;
      align-items: center;
      gap: 12px;
      padding-top: var(--airo-editor-spacing);
      border-top: 1px solid var(--airo-editor-border);
      margin-top: var(--airo-editor-spacing);
    }
  `;

  // Sync external `data` → internal `_draft` whenever it changes from outside.
  override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has('data')) {
      this._draft = (this.data ?? undefined) as JsonValue | undefined;
      this._dirty = false;
      this._validationError = null;
      this._saveStatus = 'idle';
    }
  }

  override render(): TemplateResult {
    const cartridge = this.cartridge;
    if (!cartridge) {
      return html`<div class="empty">No cartridge loaded.</div>`;
    }

    const hasData = this._draft !== undefined;
    const schema = cartridge.schema.toJsonSchema?.();

    return html`
      <header>
        <div class="header__identity">
          <h1>${cartridge.displayName}</h1>
          <span class="meta">${cartridge.id} · v${cartridge.version} · ${cartridge.industry}</span>
        </div>
        ${hasData
          ? html`
              <div>
                <button
                  type="button"
                  class="save-button"
                  ?disabled=${!this._dirty}
                  @click=${this.#handleSave}
                >
                  ${this._saveStatus === 'saving' ? 'Saving…' : this._dirty ? 'Save' : 'Saved'}
                </button>
                ${this.#renderSaveStatus()}
              </div>
            `
          : nothing}
      </header>

      <p class="description">${cartridge.description}</p>

      ${this._validationError
        ? html`<div class="banner banner--error" role="alert">${this._validationError}</div>`
        : nothing}

      ${hasData && schema
        ? this.#renderEditMode(schema as SchemaFragment)
        : this.#renderViewerMode(cartridge)}
    `;
  }

  // ──────────────────────────── render modes ──────────────────────────

  #renderEditMode(schema: SchemaFragment): TemplateResult {
    return html`
      <section class="schema-form">
        <h2>Edit</h2>
        ${renderSchemaForm(schema, this._draft, this.#handleFieldChange, [], schema.title)}
      </section>
    `;
  }

  #renderViewerMode(cartridge: Cartridge): TemplateResult {
    return html`
      <section>
        <h2>Inventory</h2>
        <div class="inventory">
          ${this.#renderInventoryItem('Views', cartridge.views.length)}
          ${this.#renderInventoryItem('Templates', cartridge.templates.length)}
          ${this.#renderInventoryItem('Data sources', cartridge.dataSources.length)}
          ${this.#renderInventoryItem('Transformers', cartridge.transformers?.length ?? 0)}
          ${this.#renderInventoryItem('MCP tools', cartridge.mcpTools?.length ?? 0)}
          ${this.#renderInventoryItem('Adapters', cartridge.publicationAdapters?.length ?? 0)}
        </div>
      </section>
      <section>
        <h2>Schema</h2>
        ${this.#renderSchemaPreview(cartridge)}
      </section>
    `;
  }

  #renderInventoryItem(label: string, count: number): TemplateResult {
    return html`
      <div class="inventory-item">
        <span class="inventory-count">${count}</span>
        <span class="inventory-label">${label}</span>
      </div>
    `;
  }

  #renderSchemaPreview(cartridge: Cartridge): TemplateResult {
    const exporter = cartridge.schema.toJsonSchema;
    if (!exporter) {
      return html`
        <p class="placeholder">
          This cartridge's schema does not export a JSON Schema. The fallback raw-JSON editor will be used when data is loaded.
        </p>
      `;
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(exporter.call(cartridge.schema), null, 2);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return html`<p class="placeholder">Could not serialize schema: ${message}</p>`;
    }
    return html`<pre>${serialized}</pre>`;
  }

  #renderSaveStatus(): TemplateResult | typeof nothing {
    if (this._saveStatus === 'saved') {
      return html`<p class="save-status save-status--saved">Saved.</p>`;
    }
    if (this._dirty) {
      return html`<p class="save-status">Unsaved changes.</p>`;
    }
    return nothing;
  }

  // ──────────────────────────── handlers ──────────────────────────────

  #handleFieldChange = (path: JsonPath, value: JsonValue | undefined): void => {
    this._draft = setIn(this._draft, path, value);
    this._dirty = true;
    this._saveStatus = 'idle';
    this.dispatchEvent(
      new CustomEvent('studio-editor-data-change', {
        detail: { data: this._draft },
        bubbles: true,
        composed: true,
      }),
    );
  };

  #handleSave = (): void => {
    if (!this.cartridge || this._draft === undefined) return;
    this._saveStatus = 'saving';
    const result = this.cartridge.schema.safeParse(this._draft);
    if (!result.success) {
      this._validationError = result.error.message;
      this._saveStatus = 'idle';
      this.dispatchEvent(
        new CustomEvent('studio-editor-validation-error', {
          detail: { error: result.error },
          bubbles: true,
          composed: true,
        }),
      );
      return;
    }
    this._validationError = null;
    this._dirty = false;
    this._saveStatus = 'saved';
    this.dispatchEvent(
      new CustomEvent('studio-editor-save', {
        detail: { data: result.data },
        bubbles: true,
        composed: true,
      }),
    );
  };
}

if (typeof customElements !== 'undefined' && !customElements.get('studio-editor')) {
  customElements.define('studio-editor', StudioEditorElement);
}

declare global {
  interface HTMLElementTagNameMap {
    'studio-editor': StudioEditorElement;
  }
}
