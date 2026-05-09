/**
 * <studio-adapter-coverage> — sidebar element listing every
 * PublicationAdapter the cartridge declares with status (ready /
 * partially-blocked / fully-blocked) and the missing dotted field paths
 * for blocked adapters.
 *
 * Sits below <studio-aio-score> in the studio's left sidebar. Where the
 * AIO Score answers "how well does this cartridge serve the AIO surfaces?",
 * this panel answers "which surfaces specifically are blocked, and on what?".
 *
 * Inputs:
 *   - cartridge: the Cartridge being authored
 *   - data: the current TData snapshot (post-edits, pre-save)
 *
 * Recompute is debounced 300ms — same cadence as the AIO Score, since
 * the inputs are the same. Falls back to "no adapters" / "no data"
 * placeholders for empty states.
 */

import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import type { Cartridge } from '@airo-js/cartridge-kit';

import { analyzeAdapterCoverage, type AdapterCoverageRow } from '../adapter-coverage.js';

const RECOMPUTE_DEBOUNCE_MS = 300;

export class StudioAdapterCoverageElement extends LitElement {
  static override properties = {
    cartridge: { attribute: false },
    data: { attribute: false },
    _rows: { state: true },
    _computing: { state: true },
  };

  declare cartridge?: Cartridge;
  declare data?: unknown;

  // Reactive state — `declare` so Lit's prototype accessor isn't shadowed by
  // class-field initializers (useDefineForClassFields).
  declare _rows: AdapterCoverageRow[] | null;
  declare _computing: boolean;

  // Non-reactive instance state (not in static properties).
  private _debounce: ReturnType<typeof setTimeout> | null = null;
  private _computeId = 0;

  constructor() {
    super();
    this._rows = null;
    this._computing = false;
  }

  static override styles = css`
    :host {
      --airo-cov-bg: #ffffff;
      --airo-cov-fg: #0a0a0a;
      --airo-cov-muted: #6b7280;
      --airo-cov-border: #e5e7eb;
      --airo-cov-good: #1a7f37;
      --airo-cov-warn: #b54708;
      --airo-cov-bad: #b00020;
      --airo-cov-radius: 8px;
      --airo-cov-spacing: 12px;
      --airo-cov-font-sans:
        'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      --airo-cov-font-mono:
        'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;

      display: block;
      box-sizing: border-box;
      width: 100%;
      padding: var(--airo-cov-spacing);
      background: var(--airo-cov-bg);
      color: var(--airo-cov-fg);
      font-family: var(--airo-cov-font-sans);
      font-size: 13px;
      line-height: 1.45;
    }

    *, *::before, *::after { box-sizing: border-box; }

    h2 {
      margin: 0 0 8px 0;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--airo-cov-muted);
    }

    .empty, .loading {
      color: var(--airo-cov-muted);
      font-style: italic;
    }

    .list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .row {
      padding: 10px 12px;
      border: 1px solid var(--airo-cov-border);
      border-left-width: 3px;
      border-radius: var(--airo-cov-radius);
      background: color-mix(in oklab, var(--airo-cov-border) 12%, white);
    }
    .row--ready             { border-left-color: var(--airo-cov-good); }
    .row--partially-blocked { border-left-color: var(--airo-cov-warn); }
    .row--fully-blocked     { border-left-color: var(--airo-cov-bad); }

    .row__head {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 8px;
    }

    .row__title {
      font-weight: 500;
    }

    .row__meta {
      font-size: 11px;
      color: var(--airo-cov-muted);
      font-family: var(--airo-cov-font-mono);
    }

    .row__status {
      margin: 4px 0 0;
      font-size: 12px;
      color: var(--airo-cov-muted);
    }

    .missing {
      margin: 6px 0 0;
      padding: 0;
      list-style: none;
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }
    .missing li {
      padding: 2px 6px;
      border: 1px solid var(--airo-cov-border);
      border-radius: 4px;
      font-family: var(--airo-cov-font-mono);
      font-size: 11px;
      background: var(--airo-cov-bg);
      color: var(--airo-cov-fg);
    }
    .missing li.missing__preferred {
      color: var(--airo-cov-muted);
    }

    .error {
      margin: 6px 0 0;
      padding: 6px 8px;
      border-radius: 4px;
      background: color-mix(in oklab, var(--airo-cov-bad) 10%, white);
      color: var(--airo-cov-bad);
      font-family: var(--airo-cov-font-mono);
      font-size: 11px;
    }
  `;

  override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has('cartridge') || changed.has('data')) {
      this.#scheduleRecompute();
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._debounce !== null) clearTimeout(this._debounce);
  }

  override render(): TemplateResult {
    if (!this.cartridge) {
      return html`<h2>Adapter coverage</h2><p class="empty">No cartridge loaded.</p>`;
    }
    if (this.data === undefined) {
      return html`<h2>Adapter coverage</h2><p class="empty">No data — load a cartridge instance to inspect coverage.</p>`;
    }
    const adapterCount = this.cartridge.publicationAdapters?.length ?? 0;
    if (adapterCount === 0) {
      return html`
        <h2>Adapter coverage</h2>
        <p class="empty">
          No PublicationAdapters declared. Author at least one to surface this cartridge to AIO indexers.
        </p>
      `;
    }
    if (!this._rows && this._computing) {
      return html`<h2>Adapter coverage</h2><p class="loading">Analyzing…</p>`;
    }
    if (!this._rows) {
      return html`<h2>Adapter coverage</h2><p class="empty">No analysis yet.</p>`;
    }
    return html`
      <h2>Adapter coverage</h2>
      <div class="list">${this._rows.map((row) => this.#renderRow(row))}</div>
    `;
  }

  #renderRow(row: AdapterCoverageRow): TemplateResult {
    return html`
      <div class="row row--${row.status}">
        <div class="row__head">
          <span class="row__title">${row.displayName}</span>
          <span class="row__meta">${row.format} · ${row.populatedRequires}/${row.totalRequires}</span>
        </div>
        <p class="row__status">${this.#statusLine(row)}</p>
        ${row.missingAlways.length > 0 || row.missingPreferred.length > 0
          ? html`
              <ul class="missing">
                ${row.missingAlways.map((p) => html`<li>${p}</li>`)}
                ${row.missingPreferred.map((p) => html`<li class="missing__preferred">${p} (preferred)</li>`)}
              </ul>
            `
          : nothing}
        ${row.generateError ? html`<div class="error">generate() threw: ${row.generateError}</div>` : nothing}
      </div>
    `;
  }

  #statusLine(row: AdapterCoverageRow): string {
    if (row.status === 'ready') {
      return row.missingPreferred.length > 0
        ? `Ready — ${row.missingPreferred.length} preferred field(s) missing.`
        : 'Ready to publish.';
    }
    if (row.status === 'partially-blocked') {
      const parts: string[] = [];
      if (row.missingAlways.length > 0) {
        parts.push(`${row.missingAlways.length} always-required field(s) missing`);
      }
      if (row.validationErrors > 0) {
        parts.push(`${row.validationErrors} validation error(s)`);
      }
      return parts.length > 0 ? `Partially blocked — ${parts.join('; ')}.` : 'Partially blocked.';
    }
    return 'Fully blocked — no required data populated, or generate threw.';
  }

  #scheduleRecompute(): void {
    if (this._debounce !== null) clearTimeout(this._debounce);
    if (!this.cartridge || this.data === undefined) {
      this._rows = null;
      return;
    }
    this._computing = true;
    this._debounce = setTimeout(() => this.#recompute(), RECOMPUTE_DEBOUNCE_MS);
  }

  async #recompute(): Promise<void> {
    if (!this.cartridge || this.data === undefined) return;
    const id = ++this._computeId;
    const cart = this.cartridge as Cartridge<unknown, unknown>;
    try {
      const rows = await analyzeAdapterCoverage(cart, this.data);
      if (id !== this._computeId) return;
      this._rows = rows;
    } finally {
      if (id === this._computeId) this._computing = false;
    }
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('studio-adapter-coverage')) {
  customElements.define('studio-adapter-coverage', StudioAdapterCoverageElement);
}

declare global {
  interface HTMLElementTagNameMap {
    'studio-adapter-coverage': StudioAdapterCoverageElement;
  }
}
