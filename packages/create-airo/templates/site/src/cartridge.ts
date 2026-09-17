/**
 * Your cartridge — the browser half.
 *
 * A cartridge is everything the framework needs to render your site: the
 * shape of your data, where it comes from, how it is prepared, and one view
 * per page type. This file is what the browser bundle includes.
 *
 * The server half, `cartridge.server.ts`, adds the search-engine and agent
 * surfaces on top. They live in a separate file so none of that code is
 * shipped to browsers — importing it here would put it in `client.js`.
 *
 * ## The idea everything else rests on
 *
 * Each request gets its own snapshot: the data source takes the page being
 * asked for and returns data for THAT page. The view, the search metadata and
 * the agent tools all read that one snapshot, which is why they can never
 * disagree, and why an unfinished post blocks only its own url rather than
 * the whole site.
 */

import {
  defineSSRSafeRenderer,
  type Cartridge,
  type CartridgeAppContext,
  type DataSource,
  type Template,
  type Transformer,
  type ViewDefinition,
} from '@airo-js/cartridge-kit';
import { escapeAttr, escapeHtml } from '@airo-js/core';

import { COPY, POSTS, SITE, findPost, type Post, type Section, type Site } from './content.js';

// ─────────────────────────── types ───────────────────────────

/** What an editor could change about the site. Page structure is not here; it lives on the template. */
export interface SiteConfig {
  locale: string;
}

export interface PostSummary {
  slug: string;
  title: string;
  description: string;
  updatedAt: string;
}

/**
 * The snapshot every surface reads. `post` is present only when the request
 * named a post; the index leaves it out, and everything downstream branches
 * on exactly that.
 */
export interface SiteData {
  site: Site;
  posts: PostSummary[];
  post?: Post;
}

/**
 * One union for both sides of the view ↔ page mapping. A view whose
 * `pageType` does not match a template page's `type` does not throw — it
 * renders a blank page. Typing both against this union makes that a compile
 * error instead.
 */
export type PageType = 'home' | 'post';

/** What the host passes to the data source: which post, if any. */
export interface SiteInput {
  slug?: string;
}

/**
 * The server → browser contract, named once. `server.ts` writes these on the
 * `#app` element and `client.ts` reads them, so a rename cannot silently
 * break one side.
 */
export const ROOT_ATTRS = {
  /** `'hydrate'` adopts the server's markup; `'csr'` renders into an empty root. */
  mode: 'data-airo-mode',
} as const;

export function toSummary({ slug, title, description, updatedAt }: Post): PostSummary {
  return { slug, title, description, updatedAt };
}

/**
 * The one definition of "published". The index view, the crawler adapter and
 * the agent tool all ask this, so a post can never be linked from the index
 * while search engines are told it does not exist.
 */
export function isPublished(post: Pick<Post, 'updatedAt'>): boolean {
  return post.updatedAt !== '';
}

// ─────────────────────────── schema ───────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * The framework never calls this for you. A schema only protects you if your
 * own code calls `parse` — which is why the data source below does, on every
 * fetch.
 *
 * Hand-written rather than Zod on purpose: this file is in the browser
 * bundle, and Zod is about 12 KB gzipped. If you want a real schema library,
 * use it in `cartridge.server.ts` instead.
 */
export const siteSchema = {
  parse(input: unknown): SiteData {
    if (!isObject(input) || !isObject(input.site) || !Array.isArray(input.posts)) {
      throw new Error('[__CARTRIDGE_ID__] snapshot must be { site, posts[], post? }');
    }
    return input as unknown as SiteData;
  },
  safeParse(input: unknown) {
    try {
      return { success: true as const, data: siteSchema.parse(input) };
    } catch (err) {
      return { success: false as const, error: err as Error };
    }
  },
};

// ───────────────────────── data source ─────────────────────────

/**
 * Where the data comes from. This one reads `content.ts`; yours might call a
 * CMS. Reshape the upstream response here, into `SiteData` — a transformer
 * cannot change the data's shape.
 */
const contentSource: DataSource<SiteData, SiteConfig> = {
  id: 'content',
  displayName: 'Content',
  onboardingShape: { kind: 'url-input' },
  async fetch(input): Promise<SiteData> {
    // `'custom'` is the input kind for host-shaped input; the slug rides its payload.
    const { slug } = input.kind === 'custom' ? ((input.payload ?? {}) as SiteInput) : ({} as SiteInput);
    const post = slug ? findPost(slug) : undefined;
    // When you fetch from a network, pass `ctx.signal` through to `fetch`.
    return siteSchema.parse({ site: SITE, posts: POSTS.map(toSummary), ...(post ? { post } : {}) });
  },
};

// ───────────────────────── transformer ─────────────────────────

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function withAnchorIds(sections: Section[]): Section[] {
  return sections.map((s) => ({ ...s, id: s.id || slugify(s.title) }));
}

/**
 * Transformers run before every surface, on the server and in the browser,
 * so the anchor a reader clicks and the one a search engine indexes are the
 * same string.
 *
 * Rules: same shape in and out, no side effects. Leave `errorPolicy` unset —
 * it defaults to failing the render, which is almost always right. Never set
 * it to `'skip'` on anything that filters what a visitor may see: a skipped
 * filter shows them everything.
 */
const anchorIds: Transformer<SiteData, SiteConfig> = {
  name: 'anchor-ids',
  isEnabled: () => true,
  transform: (data) => (data.post ? { ...data, post: { ...data.post, sections: withAnchorIds(data.post.sections) } } : data),
};

// ─────────────────────────── views ───────────────────────────
//
// `defineSSRSafeRenderer` builds all three render paths — browser render,
// server render, hydrate — from one `template` and one `hydrate`, so they
// cannot drift apart. Two rules keep that true:
//
//   1. `template` is pure. No `Date.now()`, no `Math.random()`, no DOM reads.
//      The same data must produce the same string on the server and in the
//      browser, or hydration adopts markup that does not match.
//   2. Listeners go in `hydrate`, never in `template`.
//
// Its type arguments cannot be inferred, so pass them explicitly.

type Ctx = CartridgeAppContext<SiteData, SiteConfig>;

const page = (inner: string) => `<div class="site-page">${inner}</div>`;

const homeView: ViewDefinition<SiteData, SiteConfig> = {
  id: 'home-view',
  displayName: 'Index',
  pageType: 'home' satisfies PageType,
  capabilities: ['ssr-safe', 'hydratable'],
  factory: defineSSRSafeRenderer<PageType, Ctx>({
    template(ctx) {
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
    },
    hydrate(root) {
      // An example listener, attached identically after a server render and a
      // browser render. It records which card was clicked; replace it with
      // your own behaviour.
      root.addEventListener('click', (e) => {
        const link = (e.target as Element).closest('a.site-card__link');
        if (link) root.setAttribute('data-last-click', link.textContent ?? '');
      });
    },
  }),
};

const postView: ViewDefinition<SiteData, SiteConfig> = {
  id: 'post-view',
  displayName: 'Post',
  pageType: 'post' satisfies PageType,
  capabilities: ['ssr-safe', 'hydratable'],
  factory: defineSSRSafeRenderer<PageType, Ctx>({
    template(ctx) {
      const { post } = ctx.app.data;
      if (!post) return page(`<p class="site-empty">${escapeHtml(COPY.notFound)}</p>`);
      const toc = post.sections
        .map((s) => `<li><a href="#${escapeAttr(s.id)}">${escapeHtml(s.title)}</a></li>`)
        .join('');
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
    },
    hydrate() {
      // Plain links, nothing to attach. Keeping the handler keeps both render paths symmetric.
    },
  }),
};

// ─────────────────────────── template ───────────────────────────

const TEMPLATE_ID = 'site';

/**
 * The page graph. `/post/<slug>` decodes to `{ page: 'post', slug }` because
 * the client and server both route with `pathContextKey: 'slug'`.
 *
 * The first enabled page is the default entry, so keep a public page first.
 * There is no "not found" page: the server answers 404 itself, without the
 * cartridge — see `server.ts`.
 *
 * To make a page members-only, add `private: true`. The server then refuses
 * it until you verify a session; `server.ts` shows where that goes.
 */
export const siteTemplate: Template<SiteConfig> = {
  id: TEMPLATE_ID,
  displayName: '__DISPLAY_NAME__',
  description: 'An index and one page per post.',
  pages: [
    { id: 'home', type: 'home' satisfies PageType, enabled: true },
    { id: 'post', type: 'post' satisfies PageType, enabled: true },
  ],
  defaultConfig: { locale: 'en-GB' },
};

/**
 * The browser half of the cartridge. Every one of these fields is required.
 *
 * `mailboxName` follows `__AIRO_<ID>_PAGES__`. It only matters once you split
 * views into separately loaded chunks, and it must be unique per cartridge on
 * a page.
 */
export const siteCartridge: Cartridge<SiteData, SiteConfig> = {
  id: '__CARTRIDGE_ID__',
  industry: 'content',
  displayName: '__DISPLAY_NAME__',
  description: 'A server-rendered site with search-engine and agent surfaces.',
  version: '0.1.0',
  mailboxName: '__MAILBOX_NAME__',
  schema: siteSchema,
  dataSources: [contentSource],
  transformers: [anchorIds],
  views: [homeView, postView],
  templates: [siteTemplate],
  // The framework reads neither `defaultConfig`. Pointing one at the other
  // stops them drifting apart.
  defaultConfig: siteTemplate.defaultConfig,
  // Must name a template above; a mismatch fails at mount time.
  defaultTemplateId: TEMPLATE_ID,
};

/**
 * Your CSS. The framework ships none. On this site it goes into the page
 * `<head>` from `server.ts`; the framework never injects a view's
 * `stylesheet` for you.
 */
export const SITE_CSS = `
  :root { --ink:#16161a; --muted:#6b7280; --line:#e5e7eb; --accent:#0b5cad; }
  * { box-sizing: border-box; }
  body { margin:0; font:16px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif; color:var(--ink); }
  .site-page { max-width:44rem; margin:0 auto; padding:3rem 1.25rem 6rem; }
  .site-title { font-size:2rem; line-height:1.15; margin:0 0 .35rem; letter-spacing:-.02em; }
  .site-tagline { color:var(--muted); margin:0 0 2rem; }
  .site-list { list-style:none; margin:0; padding:0; display:grid; gap:1.25rem; }
  .site-card { border-top:1px solid var(--line); padding-top:1.25rem; }
  .site-card__link { color:var(--accent); font-weight:650; text-decoration:none; font-size:1.1rem; }
  .site-card__link:hover { text-decoration:underline; }
  .site-card__desc { color:var(--muted); margin:.35rem 0 0; }
  .site-back { color:var(--muted); text-decoration:none; font-size:.9rem; display:inline-block; margin-bottom:1.5rem; }
  .site-toc { border-left:2px solid var(--line); padding-left:1rem; margin:0 0 2rem; }
  .site-toc ol { margin:0; padding-left:1rem; color:var(--muted); }
  .site-toc a { color:var(--muted); }
  .site-section h2 { margin-top:2.25rem; font-size:1.25rem; letter-spacing:-.01em; }
  code { background:#f3f4f6; padding:.1em .35em; border-radius:3px; font-size:.9em; }
`;
