/**
 * Inline stylesheet for the demo. Inlined into the HTML response so
 * the demo is a single-resource page (one HTTP request → fully styled
 * page + Schema.org JSON-LD + meta tags). Maximizes Lighthouse score;
 * no waterfall for the brag-screenshot.
 *
 * Design intent: minimal product card, system font stack, no JS for
 * v0. Designed for the demo recording — clear visual hierarchy that
 * reads on a Twitter share preview.
 */
export const DEMO_CSS = `
  :root {
    color-scheme: light dark;
    --airo-card-max: 32rem;
    --airo-text: #111;
    --airo-muted: #666;
    --airo-accent: #1a1a1a;
    --airo-accent-on: #fff;
    --airo-divider: #e5e5e5;
    --airo-bg: #fafafa;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --airo-text: #f4f4f5;
      --airo-muted: #a1a1aa;
      --airo-accent: #f4f4f5;
      --airo-accent-on: #18181b;
      --airo-divider: #27272a;
      --airo-bg: #0a0a0a;
    }
  }
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 2rem 1rem;
    font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: var(--airo-text);
    background: var(--airo-bg);
    display: grid;
    place-items: start center;
    min-height: 100vh;
  }
  .airo-product-card {
    width: 100%;
    max-width: var(--airo-card-max);
    background: color-mix(in srgb, var(--airo-bg) 60%, transparent);
    border: 1px solid var(--airo-divider);
    border-radius: 14px;
    overflow: hidden;
  }
  .airo-product-card__image {
    width: 100%;
    aspect-ratio: 4 / 3;
    object-fit: cover;
    display: block;
    background: var(--airo-divider);
  }
  .airo-product-card__body { padding: 1.25rem 1.25rem 1.5rem; }
  .airo-product-card__vendor {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--airo-muted);
    margin: 0 0 0.25rem;
  }
  .airo-product-card__title {
    margin: 0 0 0.75rem;
    font-size: 1.5rem;
    line-height: 1.2;
    letter-spacing: -0.01em;
  }
  .airo-product-card__price-row {
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
    margin: 0 0 1rem;
  }
  .airo-product-card__price { font-size: 1.25rem; font-weight: 600; }
  .airo-product-card__compare { color: var(--airo-muted); }
  .airo-product-card__description {
    margin: 0 0 1.25rem;
    color: var(--airo-muted);
    font-size: 0.9375rem;
  }
  .airo-product-card__buy {
    display: inline-block;
    padding: 0.75rem 1.25rem;
    background: var(--airo-accent);
    color: var(--airo-accent-on);
    border-radius: 999px;
    text-decoration: none;
    font-weight: 600;
    font-size: 0.9375rem;
  }
  .airo-product-card__buy[aria-disabled="true"] {
    background: var(--airo-muted);
    pointer-events: none;
  }
  .airo-product-card__snapshot {
    margin: 1.25rem 0 0;
    font-size: 0.6875rem;
    color: var(--airo-muted);
    border-top: 1px solid var(--airo-divider);
    padding-top: 0.75rem;
  }
  .airo-product-card__snapshot code,
  .airo-blog-post__snapshot code {
    font: 0.75rem/1 ui-monospace, SFMono-Regular, Menlo, monospace;
    background: color-mix(in srgb, var(--airo-divider) 50%, transparent);
    padding: 0.125rem 0.375rem;
    border-radius: 4px;
  }

  /* ───── Blog post card (WP cartridge) ───── */
  .airo-blog-post {
    width: 100%;
    max-width: var(--airo-card-max);
    background: color-mix(in srgb, var(--airo-bg) 60%, transparent);
    border: 1px solid var(--airo-divider);
    border-radius: 14px;
    overflow: hidden;
  }
  .airo-blog-post__image {
    width: 100%;
    aspect-ratio: 16 / 9;
    object-fit: cover;
    display: block;
    background: var(--airo-divider);
  }
  .airo-blog-post__body { padding: 1.25rem 1.25rem 1.5rem; }
  .airo-blog-post__meta {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--airo-muted);
    margin: 0 0 0.5rem;
  }
  .airo-blog-post__title {
    margin: 0 0 0.5rem;
    font-size: 1.5rem;
    line-height: 1.2;
    letter-spacing: -0.01em;
  }
  .airo-blog-post__author {
    margin: 0 0 1rem;
    color: var(--airo-muted);
    font-size: 0.875rem;
    font-style: italic;
  }
  .airo-blog-post__excerpt {
    margin: 0 0 1.25rem;
    color: var(--airo-text);
    font-size: 0.9375rem;
    line-height: 1.5;
  }
  .airo-blog-post__read {
    display: inline-block;
    padding: 0.5rem 1rem;
    border: 1px solid var(--airo-accent);
    color: var(--airo-accent);
    border-radius: 999px;
    text-decoration: none;
    font-weight: 600;
    font-size: 0.875rem;
    transition: background 0.15s ease, color 0.15s ease;
  }
  .airo-blog-post__read:hover {
    background: var(--airo-accent);
    color: var(--airo-accent-on);
  }
  .airo-blog-post__snapshot {
    margin: 1.25rem 0 0;
    font-size: 0.6875rem;
    color: var(--airo-muted);
    border-top: 1px solid var(--airo-divider);
    padding-top: 0.75rem;
  }

  /* ───── Landing index ───── */
  .airo-landing {
    max-width: 36rem;
    display: grid;
    gap: 1rem;
  }
  .airo-landing h1 {
    margin: 0 0 0.5rem;
    font-size: 1.5rem;
    letter-spacing: -0.01em;
  }
  .airo-landing p {
    margin: 0 0 1rem;
    color: var(--airo-muted);
  }
  .airo-landing ul { padding-left: 1.25rem; margin: 0; }
  .airo-landing li { margin-bottom: 0.5rem; }
  .airo-landing code {
    font: 0.875rem/1 ui-monospace, SFMono-Regular, Menlo, monospace;
    background: color-mix(in srgb, var(--airo-divider) 50%, transparent);
    padding: 0.125rem 0.375rem;
    border-radius: 4px;
  }
`.trim();
