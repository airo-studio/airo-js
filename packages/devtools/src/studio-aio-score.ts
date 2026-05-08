/**
 * <studio-aio-score> — sidebar element that displays the AIO Score.
 *
 * Per the design doc, the AIO Score number is the largest visual weight on
 * the studio screen. This element renders that headline number plus a
 * 5-row breakdown of inputs with hints on what would raise each.
 *
 * Inputs:
 *   - cartridge: the Cartridge being authored
 *   - data: the current TData snapshot (post-edits, pre-save)
 *
 * Recompute is debounced 300ms (per the design doc) so fast-typing doesn't
 * thrash the formula. Score arrives via async computeAioScore — the element
 * shows a "Calculating…" placeholder during the first compute.
 */

import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import type { Cartridge } from '@airo-js/cartridge-kit';

import { computeAioScore, type AioScore } from './score-formula.js';

const RECOMPUTE_DEBOUNCE_MS = 300;

export class StudioAioScoreElement extends LitElement {
  static override properties = {
    cartridge: { attribute: false },
    data: { attribute: false },
    _score: { state: true },
    _computing: { state: true },
  };

  declare cartridge?: Cartridge;
  declare data?: unknown;

  // Reactive state — `declare` so Lit's prototype accessor isn't shadowed by
  // class-field initializers (useDefineForClassFields).
  declare _score: AioScore | null;
  declare _computing: boolean;

  // Non-reactive instance state (not in static properties — class fields are fine).
  private _debounce: ReturnType<typeof setTimeout> | null = null;
  private _computeId = 0;

  constructor() {
    super();
    this._score = null;
    this._computing = false;
  }

  static override styles = css`
    :host {
      --airo-score-bg: #ffffff;
      --airo-score-fg: #0a0a0a;
      --airo-score-muted: #6b7280;
      --airo-score-border: #e5e7eb;
      --airo-score-accent: #2d70ff;
      --airo-score-good: #1a7f37;
      --airo-score-warn: #b54708;
      --airo-score-bad: #b00020;
      --airo-score-radius: 10px;
      --airo-score-spacing: 12px;
      --airo-score-font-sans:
        'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;

      display: block;
      box-sizing: border-box;
      width: 100%;
      padding: var(--airo-score-spacing);
      background: var(--airo-score-bg);
      color: var(--airo-score-fg);
      font-family: var(--airo-score-font-sans);
      font-size: 13px;
      line-height: 1.45;
    }

    *, *::before, *::after { box-sizing: border-box; }

    h2 {
      margin: 0 0 6px 0;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--airo-score-muted);
    }

    .score-headline {
      display: flex;
      align-items: baseline;
      gap: 8px;
      margin-bottom: var(--airo-score-spacing);
    }

    .score-number {
      font-size: 56px;
      font-weight: 600;
      line-height: 1;
      letter-spacing: -0.02em;
      font-variant-numeric: tabular-nums;
    }
    .score-number--good { color: var(--airo-score-good); }
    .score-number--warn { color: var(--airo-score-warn); }
    .score-number--bad  { color: var(--airo-score-bad); }
    .score-number--idle { color: var(--airo-score-muted); }

    .score-suffix {
      font-size: 14px;
      color: var(--airo-score-muted);
    }

    .breakdown {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .row {
      display: grid;
      grid-template-columns: 24px 1fr;
      gap: 10px;
      align-items: start;
      padding: 8px 10px;
      border: 1px solid var(--airo-score-border);
      border-radius: 6px;
      background: color-mix(in oklab, var(--airo-score-border) 18%, white);
    }

    .row__pip {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      margin-top: 4px;
    }
    .row__pip--good { background: var(--airo-score-good); }
    .row__pip--warn { background: var(--airo-score-warn); }
    .row__pip--bad  { background: var(--airo-score-bad); }

    .row__body {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .row__label {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 6px;
      font-weight: 500;
    }
    .row__score {
      color: var(--airo-score-muted);
      font-size: 12px;
      font-variant-numeric: tabular-nums;
    }
    .row__hint {
      margin: 0;
      color: var(--airo-score-muted);
      font-size: 12px;
    }

    .empty, .loading {
      color: var(--airo-score-muted);
      font-style: italic;
    }
  `;

  override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has('cartridge') || changed.has('data')) {
      this.#scheduleRecompute();
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._debounce !== null) {
      clearTimeout(this._debounce);
      this._debounce = null;
    }
  }

  override render(): TemplateResult {
    if (!this.cartridge) {
      return html`<h2>AIO Score</h2><p class="empty">No cartridge loaded.</p>`;
    }
    if (this.data === undefined) {
      return html`<h2>AIO Score</h2><p class="empty">No data — load a cartridge instance to score.</p>`;
    }
    if (!this._score && this._computing) {
      return html`<h2>AIO Score</h2><p class="loading">Calculating…</p>`;
    }
    if (!this._score) {
      // Shouldn't happen often; defensive.
      return html`<h2>AIO Score</h2><p class="empty">No score yet.</p>`;
    }

    const total = this._score.total;
    const tone =
      total >= 80 ? 'good' : total >= 50 ? 'warn' : total > 0 ? 'bad' : 'idle';

    return html`
      <h2>AIO Score</h2>
      <div class="score-headline">
        <span class="score-number score-number--${tone}">${total}</span>
        <span class="score-suffix">/ 100</span>
      </div>
      <div class="breakdown">
        ${this._score.breakdown.map((row) => this.#renderRow(row))}
      </div>
    `;
  }

  #renderRow(row: AioScore['breakdown'][number]): TemplateResult {
    const tone = row.score >= 80 ? 'good' : row.score >= 50 ? 'warn' : 'bad';
    return html`
      <div class="row">
        <span class="row__pip row__pip--${tone}" aria-hidden="true"></span>
        <div class="row__body">
          <div class="row__label">
            <span>${row.label}</span>
            <span class="row__score">${row.score} / 100${nothing}</span>
          </div>
          <p class="row__hint">${row.hint}</p>
        </div>
      </div>
    `;
  }

  #scheduleRecompute(): void {
    if (this._debounce !== null) clearTimeout(this._debounce);
    if (!this.cartridge || this.data === undefined) {
      this._score = null;
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
      const score = await computeAioScore(cart, this.data);
      // Only commit if we're still the latest in-flight compute.
      if (id !== this._computeId) return;
      this._score = score;
    } finally {
      if (id === this._computeId) this._computing = false;
    }
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('studio-aio-score')) {
  customElements.define('studio-aio-score', StudioAioScoreElement);
}

declare global {
  interface HTMLElementTagNameMap {
    'studio-aio-score': StudioAioScoreElement;
  }
}
