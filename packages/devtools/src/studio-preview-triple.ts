/**
 * <studio-preview-triple> — three-pane preview surface that updates
 * synchronously on cartridge / data changes (300ms debounce).
 *
 * Three readers, one snapshot:
 *   - Human  cartridge view rendered into a sandboxed <iframe srcdoc>
 *   - SEO-AIO  JSON-LD adapter output rendered as a Google-AI-Overview-style card
 *   - Agent  MCP tool inventory + auto-invocation results for tools with no
 *            required input + "open in Claude Desktop" copy-paste link
 *            (placeholder URL until Lane D's MCP server lands)
 *
 * Implementation notes:
 *   - Tabs control which preview is foregrounded; switching tabs is instant
 *     (no recompute) — all three previews are pre-computed and cached.
 *   - The human-preview iframe is sandboxed (no scripts) by srcdoc default;
 *     the cartridge view's static HTML is rendered, not its JS lifecycle.
 *   - In-flight computes are tagged with a monotonic id so a fast keystroke
 *     stream doesn't ship stale results to the UI.
 */

import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import type { Cartridge } from '@airo-js/cartridge-kit';

import {
  buildIframeSrcdoc,
  renderAgentPreview,
  renderHumanPreview,
  renderSeoAioSnippet,
  type AgentToolPreview,
  type HumanPreviewOutput,
  type RenderResult,
  type SeoAioSnippet,
} from './preview-renderer.js';

const RECOMPUTE_DEBOUNCE_MS = 300;
type PreviewSurface = 'human' | 'seo-aio' | 'agent';

interface ComputedPreviews {
  human: RenderResult<HumanPreviewOutput>;
  seoAio: RenderResult<SeoAioSnippet>;
  agent: AgentToolPreview[];
}

export class StudioPreviewTripleElement extends LitElement {
  static override properties = {
    cartridge: { attribute: false },
    data: { attribute: false },
    /** Optional — placeholder MCP server URL surfaced in the agent panel. */
    mcpServerUrl: { type: String, attribute: 'mcp-server-url' },
    _previews: { state: true },
    _computing: { state: true },
    _activeTab: { state: true },
  };

  cartridge?: Cartridge;
  data?: unknown;
  mcpServerUrl: string = 'http://127.0.0.1:0/mcp/';

  private _previews: ComputedPreviews | null = null;
  private _computing = false;
  private _activeTab: PreviewSurface = 'human';
  private _debounce: ReturnType<typeof setTimeout> | null = null;
  private _computeId = 0;

  static override styles = css`
    :host {
      --airo-prv-bg: #ffffff;
      --airo-prv-fg: #0a0a0a;
      --airo-prv-muted: #6b7280;
      --airo-prv-border: #e5e7eb;
      --airo-prv-accent: #2d70ff;
      --airo-prv-good: #1a7f37;
      --airo-prv-bad: #b00020;
      --airo-prv-code-bg: #f6f8fa;
      --airo-prv-radius: 8px;
      --airo-prv-spacing: 12px;
      --airo-prv-font-sans:
        'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      --airo-prv-font-mono:
        'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;

      display: flex;
      flex-direction: column;
      box-sizing: border-box;
      width: 100%;
      height: 100%;
      background: var(--airo-prv-bg);
      color: var(--airo-prv-fg);
      font-family: var(--airo-prv-font-sans);
      font-size: 13px;
      line-height: 1.45;
    }

    *, *::before, *::after { box-sizing: border-box; }

    .tabs {
      display: flex;
      border-bottom: 1px solid var(--airo-prv-border);
      background: color-mix(in oklab, var(--airo-prv-border) 18%, white);
    }
    .tab {
      flex: 1;
      padding: 10px 14px;
      border: 0;
      border-right: 1px solid var(--airo-prv-border);
      border-bottom: 2px solid transparent;
      background: transparent;
      color: var(--airo-prv-muted);
      font: inherit;
      cursor: pointer;
      transition: color 80ms ease, border-color 80ms ease, background-color 80ms ease;
    }
    .tab:last-child { border-right: 0; }
    .tab:hover { background: var(--airo-prv-bg); color: var(--airo-prv-fg); }
    .tab--active {
      color: var(--airo-prv-fg);
      background: var(--airo-prv-bg);
      border-bottom-color: var(--airo-prv-accent);
      font-weight: 500;
    }

    .pane {
      flex: 1;
      min-height: 0;
      overflow: auto;
      padding: var(--airo-prv-spacing);
    }
    .pane--human { padding: 0; }
    .pane--human iframe {
      width: 100%;
      height: 100%;
      border: 0;
      background: var(--airo-prv-bg);
    }

    .empty, .loading {
      color: var(--airo-prv-muted);
      font-style: italic;
    }

    .error {
      padding: 10px 12px;
      border-radius: var(--airo-prv-radius);
      background: color-mix(in oklab, var(--airo-prv-bad) 8%, white);
      color: var(--airo-prv-bad);
      font-size: 12px;
      font-family: var(--airo-prv-font-mono);
    }

    /* SEO-AIO snippet card */
    .snippet {
      max-width: 600px;
      padding: 16px;
      border: 1px solid var(--airo-prv-border);
      border-radius: var(--airo-prv-radius);
      background: var(--airo-prv-bg);
    }
    .snippet__url {
      color: var(--airo-prv-good);
      font-size: 12px;
      font-family: var(--airo-prv-font-mono);
      margin: 0 0 4px;
      overflow-wrap: anywhere;
    }
    .snippet__title {
      margin: 0 0 6px;
      color: var(--airo-prv-accent);
      font-size: 18px;
      font-weight: 600;
      line-height: 1.25;
    }
    .snippet__desc {
      margin: 0 0 10px;
      color: var(--airo-prv-fg);
    }
    .snippet__meta {
      display: flex;
      gap: 12px;
      font-size: 11px;
      color: var(--airo-prv-muted);
    }
    .snippet__type {
      display: inline-block;
      margin-top: 12px;
      padding: 2px 8px;
      border: 1px solid var(--airo-prv-border);
      border-radius: 4px;
      font-size: 11px;
      font-family: var(--airo-prv-font-mono);
      color: var(--airo-prv-muted);
    }

    .raw-jsonld {
      margin-top: 16px;
    }
    .raw-jsonld details {
      border: 1px solid var(--airo-prv-border);
      border-radius: var(--airo-prv-radius);
    }
    .raw-jsonld summary {
      padding: 8px 12px;
      cursor: pointer;
      font-size: 11px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--airo-prv-muted);
    }
    .raw-jsonld pre {
      margin: 0;
      padding: 12px;
      border-top: 1px solid var(--airo-prv-border);
      background: var(--airo-prv-code-bg);
      font-family: var(--airo-prv-font-mono);
      font-size: 11px;
      line-height: 1.5;
      overflow-x: auto;
      max-height: 240px;
      overflow-y: auto;
    }

    /* Agent preview */
    .agent-header {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-bottom: var(--airo-prv-spacing);
      padding-bottom: var(--airo-prv-spacing);
      border-bottom: 1px solid var(--airo-prv-border);
    }
    .agent-header__url {
      display: flex;
      gap: 6px;
      align-items: center;
      font-family: var(--airo-prv-font-mono);
      font-size: 12px;
      color: var(--airo-prv-muted);
    }
    .agent-header__url code {
      padding: 2px 6px;
      background: var(--airo-prv-code-bg);
      border: 1px solid var(--airo-prv-border);
      border-radius: 4px;
      color: var(--airo-prv-fg);
    }

    .tool-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .tool {
      padding: 12px;
      border: 1px solid var(--airo-prv-border);
      border-radius: var(--airo-prv-radius);
    }
    .tool__name {
      margin: 0 0 4px;
      font-family: var(--airo-prv-font-mono);
      font-size: 13px;
      color: var(--airo-prv-accent);
    }
    .tool__desc {
      margin: 0 0 8px;
      color: var(--airo-prv-fg);
      font-size: 12px;
    }
    .tool__schema-label,
    .tool__output-label {
      display: block;
      margin: 6px 0 4px;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--airo-prv-muted);
    }
    .tool__schema, .tool__output {
      margin: 0;
      padding: 8px 10px;
      background: var(--airo-prv-code-bg);
      border: 1px solid var(--airo-prv-border);
      border-radius: 4px;
      font-family: var(--airo-prv-font-mono);
      font-size: 11px;
      line-height: 1.5;
      max-height: 200px;
      overflow: auto;
    }
    .tool__note {
      margin: 6px 0 0;
      color: var(--airo-prv-muted);
      font-size: 12px;
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
    if (this._debounce !== null) clearTimeout(this._debounce);
  }

  override render(): TemplateResult {
    return html`
      <div class="tabs" role="tablist">
        ${this.#renderTab('human', 'Human')}
        ${this.#renderTab('seo-aio', 'SEO/AIO')}
        ${this.#renderTab('agent', 'Agent')}
      </div>
      <div class="pane pane--${this._activeTab}">${this.#renderActivePane()}</div>
    `;
  }

  #renderTab(surface: PreviewSurface, label: string): TemplateResult {
    return html`
      <button
        type="button"
        class=${'tab' + (this._activeTab === surface ? ' tab--active' : '')}
        role="tab"
        aria-selected=${this._activeTab === surface ? 'true' : 'false'}
        @click=${() => this.#switchTab(surface)}
      >
        ${label}
      </button>
    `;
  }

  #switchTab(surface: PreviewSurface): void {
    this._activeTab = surface;
  }

  #renderActivePane(): TemplateResult {
    if (!this.cartridge) return html`<p class="empty">No cartridge loaded.</p>`;
    if (this.data === undefined) return html`<p class="empty">No data — load a cartridge instance to preview.</p>`;
    if (!this._previews && this._computing) return html`<p class="loading">Rendering preview…</p>`;
    if (!this._previews) return html`<p class="empty">No preview yet.</p>`;

    switch (this._activeTab) {
      case 'human':
        return this.#renderHumanPane(this._previews.human);
      case 'seo-aio':
        return this.#renderSeoAioPane(this._previews.seoAio);
      case 'agent':
        return this.#renderAgentPane(this._previews.agent);
    }
  }

  #renderHumanPane(result: RenderResult<HumanPreviewOutput>): TemplateResult {
    if (!result.ok) return html`<div class="error">Human preview failed: ${result.error}</div>`;
    return html`<iframe sandbox srcdoc=${buildIframeSrcdoc(result.value.html)} title="Human preview"></iframe>`;
  }

  #renderSeoAioPane(result: RenderResult<SeoAioSnippet>): TemplateResult {
    if (!result.ok) return html`<div class="error">SEO/AIO preview failed: ${result.error}</div>`;
    const s = result.value;
    return html`
      <article class="snippet">
        ${s.url ? html`<p class="snippet__url">${s.url}</p>` : nothing}
        <h3 class="snippet__title">${s.title}</h3>
        <p class="snippet__desc">${s.description}</p>
        <div class="snippet__meta">
          ${s.authorName ? html`<span>By ${s.authorName}</span>` : nothing}
          ${s.date ? html`<span>${formatDateShort(s.date)}</span>` : nothing}
        </div>
        ${s.schemaType ? html`<span class="snippet__type">@type: ${s.schemaType}</span>` : nothing}
      </article>
      <div class="raw-jsonld">
        <details>
          <summary>Raw JSON-LD</summary>
          <pre>${JSON.stringify(s.raw, null, 2)}</pre>
        </details>
      </div>
    `;
  }

  #renderAgentPane(tools: AgentToolPreview[]): TemplateResult {
    if (tools.length === 0) {
      return html`<p class="empty">Cartridge has no MCP tools declared.</p>`;
    }
    return html`
      <div class="agent-header">
        <p>${tools.length} MCP tool${tools.length === 1 ? '' : 's'} available to agents.</p>
        <div class="agent-header__url">
          <span>Server URL:</span>
          <code>${this.mcpServerUrl}</code>
        </div>
      </div>
      <div class="tool-list">
        ${tools.map((t) => this.#renderTool(t))}
      </div>
    `;
  }

  #renderTool(t: AgentToolPreview): TemplateResult {
    return html`
      <article class="tool">
        <h4 class="tool__name">${t.name}</h4>
        <p class="tool__desc">${t.description}</p>
        <span class="tool__schema-label">Input schema</span>
        <pre class="tool__schema">${JSON.stringify(t.inputSchema, null, 2)}</pre>
        ${t.sampleOutput !== undefined
          ? html`
              <span class="tool__output-label">Sample output (auto-invoked with empty input)</span>
              <pre class="tool__output">${JSON.stringify(t.sampleOutput, null, 2)}</pre>
            `
          : nothing}
        ${t.note ? html`<p class="tool__note">${t.note}</p>` : nothing}
      </article>
    `;
  }

  #scheduleRecompute(): void {
    if (this._debounce !== null) clearTimeout(this._debounce);
    if (!this.cartridge || this.data === undefined) {
      this._previews = null;
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
      const [human, seoAio, agent] = await Promise.all([
        Promise.resolve(renderHumanPreview(cart, this.data)),
        renderSeoAioSnippet(cart, this.data),
        renderAgentPreview(cart, this.data),
      ]);
      if (id !== this._computeId) return;
      this._previews = { human, seoAio, agent };
    } finally {
      if (id === this._computeId) this._computing = false;
    }
  }
}

function formatDateShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });
}

if (typeof customElements !== 'undefined' && !customElements.get('studio-preview-triple')) {
  customElements.define('studio-preview-triple', StudioPreviewTripleElement);
}

declare global {
  interface HTMLElementTagNameMap {
    'studio-preview-triple': StudioPreviewTripleElement;
  }
}
