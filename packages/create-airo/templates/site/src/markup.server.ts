/**
 * What each page looks like, as HTML. Server-only.
 *
 * These are the `template` half of the views built in `cartridge.server.ts`.
 * The browser never imports this file: it hydrates the markup the server
 * wrote and never renders a page, so shipping these templates, and the copy
 * and markup helpers they pull in, would only add bytes to `client.js`. The
 * smoke check fails if one of them turns up there.
 *
 * Each template must be PURE: the same data gives the same string, with no
 * `Date.now()`, no `Math.random()` and no DOM reads. Listeners go in
 * `hydrate.ts`, never here. A listener there finds its markup by class
 * (`a.site-card__link`), so rename a class here and change it there too.
 */

import type { CartridgeAppContext } from '@airo-js/cartridge-kit';
import { escapeAttr, escapeHtml, type RenderContext } from '@airo-js/core';

import { isPublished, type PageType, type SiteConfig, type SiteData } from './cartridge.js';
import { COPY } from './content.js';

type MarkupCtx = RenderContext<PageType, CartridgeAppContext<SiteData, SiteConfig>>;

const page = (inner: string) => `<div class="site-page">${inner}</div>`;

export function homeMarkup(ctx: MarkupCtx): string {
  const { site, posts } = ctx.app.data;
  const items = posts
    .filter(isPublished)
    .map(
      (p) => `
        <li class="site-card">
          <a class="site-card__link" href="/post/${escapeAttr(p.slug)}">${escapeHtml(p.title)}</a>
          <p class="site-card__desc">${escapeHtml(p.description)}</p>
        </li>`,
    )
    .join('');
  return page(`
      <header>
        <h1 class="site-title">${escapeHtml(site.name)}</h1>
        <p class="site-tagline">${escapeHtml(site.tagline)}</p>
      </header>
      <ul class="site-list">${items}</ul>
    `);
}

export function postMarkup(ctx: MarkupCtx): string {
  const { post } = ctx.app.data;
  if (!post) return page(`<p class="site-empty">${escapeHtml(COPY.notFound)}</p>`);
  const toc = post.sections.map((s) => `<li><a href="#${escapeAttr(s.id)}">${escapeHtml(s.title)}</a></li>`).join('');
  const body = post.sections
    .map(
      (s) => `
        <section class="site-section" id="${escapeAttr(s.id)}">
          <h${s.depth}>${escapeHtml(s.title)}</h${s.depth}>
          ${s.html}
        </section>`,
    )
    .join('');
  return page(`
      <article>
        <a class="site-back" href="/">${escapeHtml(COPY.backToIndex)}</a>
        <h1 class="site-title">${escapeHtml(post.title)}</h1>
        <p class="site-tagline">${escapeHtml(post.description)}</p>
        <nav class="site-toc"><ol>${toc}</ol></nav>
        ${body}
      </article>
    `);
}
