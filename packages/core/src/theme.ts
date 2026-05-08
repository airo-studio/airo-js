/**
 * Theme — CSS custom properties + custom-CSS injection for an App.
 *
 * Framework-agnostic by design: takes `tokens` as a flat
 * `Record<string, string>` and writes each entry as a `--{key}` CSS
 * variable on the target element. Domain code owns the mapping from its
 * config shape (light/dark colors, shadow levels, …) to this token bag.
 *
 * `customCSS` is appended verbatim into the style root. It's the escape
 * hatch host apps use to override the runtime stylesheet without forking
 * the build (e.g. host-app CSS overrides, AI-generated customisations).
 */

export interface ThemeOptions {
  /**
   * CSS custom properties to set on the target. Keys are written with a
   * `--` prefix if missing, so `'brand-primary'` becomes `--brand-primary`.
   */
  tokens?: Record<string, string>;
  /** Verbatim CSS appended into the style root. Empty/undefined removes any prior block. */
  customCSS?: string;
}

export class Theme {
  private readonly el: HTMLElement;
  private readonly styleRoot: HTMLElement | ShadowRoot;
  private customStyleEl: HTMLStyleElement | null = null;
  private readonly appliedKeys = new Set<string>();

  constructor(
    target: HTMLElement,
    styleRoot: HTMLElement | ShadowRoot = document.head,
  ) {
    this.el = target;
    this.styleRoot = styleRoot;
  }

  apply(opts: ThemeOptions): void {
    if (opts.tokens) this.applyTokens(opts.tokens);
    if (opts.customCSS !== undefined) this.applyCustomCSS(opts.customCSS);
  }

  /** Update only the tokens / customCSS provided. Other state stays. */
  update(opts: ThemeOptions): void {
    this.apply(opts);
  }

  destroy(): void {
    for (const key of this.appliedKeys) {
      this.el.style.removeProperty(key);
    }
    this.appliedKeys.clear();
    this.customStyleEl?.remove();
    this.customStyleEl = null;
  }

  private applyTokens(tokens: Record<string, string>): void {
    for (const [rawKey, value] of Object.entries(tokens)) {
      const key = rawKey.startsWith('--') ? rawKey : `--${rawKey}`;
      this.el.style.setProperty(key, value);
      this.appliedKeys.add(key);
    }
  }

  private applyCustomCSS(css: string): void {
    if (!css) {
      this.customStyleEl?.remove();
      this.customStyleEl = null;
      return;
    }
    if (!this.customStyleEl) {
      this.customStyleEl = document.createElement('style');
      this.customStyleEl.dataset['airoTheme'] = 'custom';
      this.styleRoot.appendChild(this.customStyleEl);
    }
    this.customStyleEl.textContent = css;
  }
}
