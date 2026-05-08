/**
 * <studio-editor> — the Lit custom element that hosts the schema-driven
 * cartridge editor inside the EditorShell cartridge's View slot.
 *
 * Slice 1 (this commit): display-only. Shows the loaded cartridge's identity,
 * description, schema preview (toJsonSchema output), and inventory counts
 * (views / mcp tools / publication adapters / templates). Proves the
 * Lit + cartridge-kit wiring without yet committing to a form-control set.
 *
 * Slice 2 will add the actual schema-form rendering (text/number/array/
 * object/fallback-JSON field elements) plus a save action that goes to
 * Lane D's /api/save endpoint.
 *
 * Stack: Lit 3, native custom elements. Zero editor runtime beyond Lit's
 * ~5KB. State management arrives in Slice 2 with `@lit-labs/signals`.
 *
 * Reactivity is wired with the non-decorator `static properties` pattern
 * + manual `customElements.define()` — portable across TS decorator modes.
 */

import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import type { Cartridge } from '@airo-js/cartridge-kit';

export class StudioEditorElement extends LitElement {
  static override properties = {
    cartridge: { attribute: false },
  };

  /**
   * The cartridge being authored. Object property only — Web Components
   * attributes can't carry rich objects, so the host JS sets this directly.
   */
  cartridge?: Cartridge;

  static override styles = css`
    :host {
      --airo-editor-bg: #ffffff;
      --airo-editor-fg: #0a0a0a;
      --airo-editor-muted: #6b7280;
      --airo-editor-border: #e5e7eb;
      --airo-editor-accent: #2d70ff;
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

    *, *::before, *::after {
      box-sizing: border-box;
    }

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
      flex-direction: column;
      gap: 4px;
      padding-bottom: var(--airo-editor-spacing);
      border-bottom: 1px solid var(--airo-editor-border);
      margin-bottom: var(--airo-editor-spacing);
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

    section {
      margin-bottom: var(--airo-editor-spacing);
    }

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
      grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
      gap: 8px;
    }

    .inventory-item {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 12px;
      border: 1px solid var(--airo-editor-border);
      border-radius: var(--airo-editor-radius);
      background: var(--airo-editor-code-bg);
    }

    .inventory-count {
      font-size: 24px;
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

    .slice-note {
      margin-top: var(--airo-editor-spacing);
      padding: 8px 12px;
      border-left: 2px solid var(--airo-editor-accent);
      background: color-mix(in oklab, var(--airo-editor-accent) 6%, white);
      font-size: 12px;
      color: var(--airo-editor-muted);
    }
  `;

  override render(): TemplateResult {
    const cartridge = this.cartridge;
    if (!cartridge) {
      return html`<div class="empty">No cartridge loaded.</div>`;
    }

    return html`
      <header>
        <h1>${cartridge.displayName}</h1>
        <span class="meta">
          ${cartridge.id} · v${cartridge.version} · ${cartridge.industry}
        </span>
      </header>

      <p class="description">${cartridge.description}</p>

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

      <div class="slice-note">
        Slice 1 — display only. Schema-driven form fields land in the next commit.
      </div>
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

  #renderSchemaPreview(cartridge: Cartridge): TemplateResult | typeof nothing {
    const exporter = cartridge.schema.toJsonSchema;
    if (!exporter) {
      return html`
        <p class="placeholder">
          This cartridge's schema does not export a JSON Schema. The fallback raw-JSON editor
          will be used in Slice 2.
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
}

if (typeof customElements !== 'undefined' && !customElements.get('studio-editor')) {
  customElements.define('studio-editor', StudioEditorElement);
}

declare global {
  interface HTMLElementTagNameMap {
    'studio-editor': StudioEditorElement;
  }
}
