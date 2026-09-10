/**
 * The docs-site cartridge — one cartridge owning a whole multi-page site,
 * public pages and a members area alike.
 *
 * Rescued and extended from an earlier single-page `doc-page` cartridge that
 * existed only as untracked build output. Its shape is preserved: schema,
 * data source, transformer, MCP tools, a renderer, and publication adapters
 * covering every audience. What changed is that it now spans SEVERAL pages,
 * is tracked, runs, uses the 0.9.0 primitives instead of hand-rolling the
 * crawler bundle — and, since 0.11.0, carries two PRIVATE pages behind a
 * sign-in gate.
 *
 * ## The per-request snapshot is the load-bearing idea
 *
 * A multi-page site does NOT hand the framework its whole corpus and let
 * views pick a slice. The DataSource takes the requested slug as input and
 * returns a snapshot scoped to THAT page. Everything downstream — the view,
 * the JSON-LD, the crawler bundle, the MCP tools — reads that one snapshot,
 * which is what makes per-page canonicals correct and what makes
 * `validate()` a per-page gate rather than a per-feed one.
 *
 * Get this wrong and one unfinished entry blocks the entire site. Get it
 * right and it blocks only its own url.
 *
 * ## The members area
 *
 * Two sentences the framework signs, and this file is built on them:
 * a Gate decides whether to paint; whether to serve is the host's, per
 * request — and bots are never gated. So: the `members` and `note` pages
 * are `private: true` on the template (a page-graph flag, not a view
 * capability); the `loginGate` is `appliesTo: 'private'` and only ever
 * paints a sign-in panel; the `member` slice of the snapshot is built by
 * the SERVER for a verified session and never enters a snapshot a machine
 * route sees; and a private view renders `signInPanel` itself when the
 * snapshot carries no `member`, because an in-app navigation into it never
 * re-runs the gate. The API (`/api/members/me`, `server.ts`) is the
 * authority; the gate is UX.
 */

import {
  defineCrawlerSurfaceAdapter,
  defineSSRSafeRenderer,
  type Cartridge,
  type DataSource,
  type Gate,
  type McpToolDefinition,
  type PublicationAdapter,
  type Template,
  type Transformer,
  type ValidationResult,
  type ViewDefinition,
} from '@airo-js/cartridge-kit';
import type { CartridgeAppContext } from '@airo-js/cartridge-kit';
import { escapeAttr, escapeHtml } from '@airo-js/core';

import { DOCS, SITE, findDoc, type Doc, type DocSection, type MemberUser, type Site } from './content.js';

// ─────────────────────────── types ───────────────────────────

export interface DocSiteConfig {
  locale: string;
  /** Absolute origin. Canonicals compose from this. */
  siteUrl: string;
  siteName: string;
}

export interface DocSummary {
  slug: string;
  title: string;
  description: string;
  updatedAt: string;
}

/**
 * The private slice. Present ONLY on a snapshot the server built for a
 * verified session rendering a `private: true` page, or one the client
 * fetched from `/api/members/me` with the session cookie. Shaped to
 * exactly what the two private views render — nothing extra rides along.
 */
export interface MemberSlice {
  user: MemberUser;
  notes: DocSummary[];
  /** The requested note, when the entry page is `note`. */
  note?: Doc;
}

/**
 * The post-transformer snapshot. `doc` is present only when the request
 * resolved to a doc page — the index render leaves it undefined, and the
 * adapters below branch on exactly that. `member` is present only on a
 * private render for a session.
 */
export interface DocSiteData {
  site: Site;
  index: DocSummary[];
  doc?: Doc;
  member?: MemberSlice;
}

export type DocSitePageType = 'home' | 'doc' | 'members' | 'note';

export interface DocSiteInput {
  /** Slug of the requested doc or note, or undefined for the index / dashboard. */
  slug?: string;
}

// ─────────────────────────── schema ───────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Type-only validation in the browser envelope — no Zod, per the
 * two-envelope rule. A server envelope may swap a real schema in.
 */
const docSiteSchema = {
  parse(input: unknown): DocSiteData {
    if (!isObject(input) || !isObject(input.site) || !Array.isArray(input.index)) {
      throw new Error('[full-site] snapshot must be { site, index[], doc?, member? }');
    }
    return input as unknown as DocSiteData;
  },
  safeParse(input: unknown) {
    try {
      return { success: true as const, data: docSiteSchema.parse(input) };
    } catch (err) {
      return { success: false as const, error: err as Error };
    }
  },
};

// ───────────────────────── data sources ─────────────────────────

const contentSource: DataSource<DocSiteData, DocSiteConfig> = {
  id: 'content',
  displayName: 'Content store',
  onboardingShape: { kind: 'url-input' },
  async fetch(input): Promise<DocSiteData> {
    // `DataSourceInput` is a discriminated union; `'custom'` is the escape
    // hatch for host-shaped input. The slug rides its payload.
    const { slug } =
      input.kind === 'custom' ? ((input.payload ?? {}) as DocSiteInput) : ({} as DocSiteInput);
    const index: DocSummary[] = DOCS.map(({ slug: s, title, description, updatedAt }) => ({
      slug: s,
      title,
      description,
      updatedAt,
    }));
    // Scoped per request — see the docblock at the top of this file.
    return { site: SITE, index, ...(slug ? { doc: findDoc(slug) } : {}) };
  },
};

/**
 * The members source — the CLIENT's way to a private snapshot. It asks the
 * host's API with the session cookie; the API is the authority and answers
 * 401 without one. Used on every private mount (a hydrate refetches through
 * it; a 401 shell whose gate allowed fetches through it), so the first page
 * is SSR and everything after it is CSR. It is never used on the server,
 * which builds the slice in-process for the session it verified.
 */
const membersSource: DataSource<DocSiteData, DocSiteConfig> = {
  id: 'members',
  displayName: 'Members API',
  onboardingShape: { kind: 'url-input' },
  async fetch(input, ctx): Promise<DocSiteData> {
    const { slug } =
      input.kind === 'custom' ? ((input.payload ?? {}) as DocSiteInput) : ({} as DocSiteInput);
    const url = `/api/members/me${slug ? `?slug=${encodeURIComponent(slug)}` : ''}`;
    const res = await fetch(url, { credentials: 'same-origin', signal: ctx.signal });
    if (!res.ok) throw new Error(`[full-site] members api answered ${res.status}`);
    return docSiteSchema.parse(await res.json());
  },
};

// ───────────────────────── transformer ─────────────────────────

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function withAnchorIds(doc: Doc): Doc {
  const sections: DocSection[] = doc.sections.map((s) => ({
    ...s,
    id: s.id || slugify(s.title),
  }));
  return { ...doc, sections };
}

/**
 * Fills in section anchor ids. Shape-preserving (`TData → TData`) and pure,
 * which is the whole contract — a pivot belongs in `DataSource.fetch`.
 *
 * It runs BEFORE every surface, so the anchor a reader clicks, the one a
 * crawler indexes and the one an agent cites through `get_section` are the
 * same string by construction. Member notes get the same treatment.
 */
const anchorIds: Transformer<DocSiteData, DocSiteConfig> = {
  name: 'anchor-ids',
  isEnabled: () => true,
  transform(data) {
    let next = data;
    if (next.doc) next = { ...next, doc: withAnchorIds(next.doc) };
    if (next.member?.note) next = { ...next, member: { ...next.member, note: withAnchorIds(next.member.note) } };
    return next;
  },
};

// ─────────────────────────── shared UI ───────────────────────────

const shell = (inner: string) => `<div class="fs-page">${inner}</div>`;

/**
 * The one sign-in panel. Painted by the gate's `mount()` on a 401 shell,
 * and rendered by both private views when their snapshot has no `member`
 * (an in-app navigation into a private page never re-runs the gate). One
 * template so the copy and the `next` link cannot drift.
 */
export function signInPanel(next: string, opts: { error?: string } = {}): string {
  const href = `/auth/login?next=${encodeURIComponent(next)}`;
  return shell(`
      <section class="fs-signin">
        <a class="fs-back" href="/">← index</a>
        <h1 class="fs-title">Members</h1>
        <p class="fs-tagline">Notes for members. Sign in to continue — the demo account is <code>demo</code> / <code>demo</code>.</p>
        ${opts.error ? `<p class="fs-signin__error">${escapeHtml(opts.error)}</p>` : ''}
        <a class="fs-signin__button" href="${escapeAttr(href)}">Sign in with DemoAuth</a>
      </section>
    `);
}

function noteLink(n: DocSummary): string {
  return `
        <li class="fs-card">
          <a class="fs-card__link" href="/note/${escapeAttr(n.slug)}">${escapeHtml(n.title)}</a>
          <p class="fs-card__desc">${escapeHtml(n.description)}</p>
        </li>`;
}

// ─────────────────────────── views ───────────────────────────

const homeView: ViewDefinition<DocSiteData, DocSiteConfig> = {
  id: 'home-view',
  displayName: 'Index',
  pageType: 'home',
  capabilities: ['ssr-safe', 'hydratable'],
  factory: defineSSRSafeRenderer<DocSitePageType, CartridgeAppContext<DocSiteData, DocSiteConfig>>({
    template(ctx) {
      const { site, index } = ctx.app.data;
      const items = index
        .map(
          (d) => `
        <li class="fs-card">
          <a class="fs-card__link" href="/doc/${escapeAttr(d.slug)}">${escapeHtml(d.title)}</a>
          <p class="fs-card__desc">${escapeHtml(d.description)}</p>
        </li>`,
        )
        .join('');
      return shell(`
      <header class="fs-head">
        <h1 class="fs-title">${escapeHtml(site.name)}</h1>
        <p class="fs-tagline">${escapeHtml(site.tagline)}</p>
        <a class="fs-members-link" href="/members">Members →</a>
      </header>
      <ul class="fs-list">${items}</ul>
    `);
    },
    hydrate(root) {
      // One delegated listener, shared by the fresh-mount and SSR-hydrate
      // paths because `defineSSRSafeRenderer` derives both from this handler.
      // Drift between them is structurally impossible.
      root.addEventListener('click', (e) => {
        const link = (e.target as HTMLElement).closest('a.fs-card__link');
        if (link) root.setAttribute('data-last-click', link.textContent ?? '');
      });
    },
  }),
};

const docView: ViewDefinition<DocSiteData, DocSiteConfig> = {
  id: 'doc-view',
  displayName: 'Document',
  pageType: 'doc',
  capabilities: ['ssr-safe', 'hydratable'],
  factory: defineSSRSafeRenderer<DocSitePageType, CartridgeAppContext<DocSiteData, DocSiteConfig>>({
    template(ctx) {
      const { doc } = ctx.app.data;
      if (!doc) return shell('<p class="fs-empty">Not found.</p>');
      return shell(article(doc, '/'));
    },
    hydrate() {
      // Anchors are plain links; nothing to wire. The handler exists so the
      // SSR and CSR paths stay symmetric.
    },
  }),
};

function article(doc: Doc, backHref: string): string {
  const toc = doc.sections
    .map((s) => `<li><a href="#${escapeAttr(s.id)}">${escapeHtml(s.title)}</a></li>`)
    .join('');
  const body = doc.sections
    .map(
      (s) => `
        <section class="fs-section" id="${escapeAttr(s.id)}">
          <h${s.depth}>${escapeHtml(s.title)}</h${s.depth}>
          ${s.html}
        </section>`,
    )
    .join('');
  return `
      <article class="fs-doc">
        <a class="fs-back" href="${escapeAttr(backHref)}">← ${backHref === '/' ? 'index' : 'members'}</a>
        <h1 class="fs-title">${escapeHtml(doc.title)}</h1>
        <p class="fs-tagline">${escapeHtml(doc.description)}</p>
        <nav class="fs-toc"><ol>${toc}</ol></nav>
        ${body}
      </article>`;
}

/**
 * The members dashboard — a PRIVATE page. `template` is still pure and
 * still byte-identical between `renderSSR` and `render`; the only thing
 * that makes it private is where it sits in the page graph. Its sign-out
 * is a plain form POST to a host route, so nothing here needs a listener.
 */
const membersView: ViewDefinition<DocSiteData, DocSiteConfig> = {
  id: 'members-view',
  displayName: 'Members',
  pageType: 'members',
  capabilities: ['ssr-safe', 'hydratable'],
  factory: defineSSRSafeRenderer<DocSitePageType, CartridgeAppContext<DocSiteData, DocSiteConfig>>({
    template(ctx) {
      const { member } = ctx.app.data;
      if (!member) return signInPanel('/members');
      return shell(`
      <header class="fs-head">
        <a class="fs-back" href="/">← index</a>
        <h1 class="fs-title">Hello, ${escapeHtml(member.user.name)}</h1>
        <p class="fs-tagline">Notes for members. Nothing on this page reaches a crawler, an agent or a cache.</p>
        <form class="fs-signout" method="post" action="/auth/logout"><button type="submit">Sign out</button></form>
      </header>
      <ul class="fs-list">${member.notes.map(noteLink).join('')}</ul>
    `);
    },
    hydrate() {
      // Forms are plain; nothing to wire.
    },
  }),
};

const noteView: ViewDefinition<DocSiteData, DocSiteConfig> = {
  id: 'note-view',
  displayName: 'Member note',
  pageType: 'note',
  capabilities: ['ssr-safe', 'hydratable'],
  factory: defineSSRSafeRenderer<DocSitePageType, CartridgeAppContext<DocSiteData, DocSiteConfig>>({
    template(ctx) {
      const { member } = ctx.app.data;
      if (!member) return signInPanel(`/note/${escapeAttr(String(ctx.navState.slug ?? ''))}`);
      if (!member.note) return shell('<p class="fs-empty">Not found.</p>');
      return shell(article(member.note, '/members'));
    },
    hydrate() {
      // Anchors are plain links; nothing to wire.
    },
  }),
};

// ───────────────────────────── gate ─────────────────────────────

/**
 * The sign-in gate. `appliesTo: 'private'`: it runs only on mounts whose
 * entry page is `private: true`, so the public site never asks
 * `/auth/session`. `precheck` is one fetch — session validity stays a
 * server opinion, not a marker cookie that can drift. `mount` paints the
 * panel and returns `'block'`; its link leaves the page, so `mount` never
 * settles, and re-entry is `precheck` on the next mount, where the session
 * now exists. A server-rendered private page skips even that: the host
 * passes `satisfiedGates` from the render that verified the session.
 *
 * It decides whether to PAINT. Whether the private page is SERVED is
 * decided per request in `server.ts`, and `/api/members/me` refuses data to
 * anyone without a session — so this gate is UX, not a security boundary.
 */
let lastPrecheckError: string | undefined;

export const loginGate: Gate<DocSiteConfig> = {
  id: 'login',
  displayName: 'Sign in',
  appliesTo: 'private',
  isEnabled: () => true,
  async precheck() {
    lastPrecheckError = undefined;
    try {
      const res = await fetch('/auth/session', { credentials: 'same-origin' });
      return res.ok ? 'allow' : 'gate-required';
    } catch {
      // Conservative pattern from the Gate docblock: surface the error in
      // the gate UI so the visitor can retry, rather than throwing.
      lastPrecheckError = 'Could not reach the sign-in service. Check your connection and try again.';
      return 'gate-required';
    }
  },
  async mount(host) {
    const next = `${globalThis.location?.pathname ?? '/members'}${globalThis.location?.search ?? ''}`;
    host.innerHTML = signInPanel(next, lastPrecheckError ? { error: lastPrecheckError } : {});
    return 'block';
  },
  destroy() {
    // The panel is static markup; nothing to tear down.
  },
};

// ───────────────────────── MCP tools ─────────────────────────

const listPages: McpToolDefinition<DocSiteData, DocSiteConfig> = {
  name: 'list_pages',
  description: 'List every published page on the site with its url and summary.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_input, ctx) {
    return {
      pages: ctx.data.index.map((d) => ({
        url: `${ctx.data.site.url}/doc/${d.slug}`,
        title: d.title,
        summary: d.description,
      })),
    };
  },
};

const getSection: McpToolDefinition<DocSiteData, DocSiteConfig> = {
  name: 'get_section',
  description: 'Return one section of the current document by its anchor id.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const { id } = input as { id: string };
    const section = ctx.data.doc?.sections.find((s) => s.id === id);
    return section
      ? { id: section.id, title: section.title, html: section.html }
      : { error: `no section "${id}"` };
  },
};

// ──────────────────── publication adapters ────────────────────

function pageUrl(data: DocSiteData): string {
  const base = data.site.url.replace(/\/$/, '');
  return data.doc ? `${base}/doc/${data.doc.slug}` : base;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Canonical, OpenGraph, Twitter Card and a sitemap entry — from the 0.9.0
 * factory rather than by hand. It defaults to `format: 'head-meta'`, which
 * is what puts it inside `renderAppWithPublication`'s default filter; the
 * hand-rolled predecessor declared `format: 'custom'` and would silently
 * never have run.
 *
 * `canonical` returns `''` for a doc missing `updatedAt`, and `validate()`
 * blocks publish on a missing canonical. That is not a trick — a page that
 * cannot say when it was last meaningfully changed is not finished, and a
 * page that cannot say where it canonically lives should not reach a
 * crawler. One rule, enforced by the framework, no custom validator.
 *
 * None of these adapters ever see a `member` slice: the runner runs no
 * adapter for a private entry, and the machine routes build their
 * snapshots without a session.
 */
const crawlerSurface = defineCrawlerSurfaceAdapter<DocSiteData, DocSiteConfig>({
  id: 'crawler-surface',
  requires: [
    { path: 'site', required: 'always' },
    { path: 'doc.title', required: 'preferred' },
    { path: 'doc.updatedAt', required: 'preferred' },
  ],
  select: {
    canonical: (d) => (d.doc && !d.doc.updatedAt ? '' : pageUrl(d)),
    title: (d) => (d.doc ? d.doc.title : d.site.name),
    description: (d) => (d.doc ? d.doc.description : d.site.tagline),
    siteName: (d) => d.site.name,
    lastModified: (d) => d.doc?.updatedAt || undefined,
    ogType: (d) => (d.doc ? 'article' : 'website'),
    sitemap: (d) => ({ changefreq: 'weekly', priority: d.doc ? 0.7 : 1.0 }),
  },
});

const jsonLd: PublicationAdapter<DocSiteData, unknown, DocSiteConfig> = {
  id: 'schema-org-jsonld',
  displayName: 'Schema.org JSON-LD',
  description: 'TechArticle for a doc page, WebSite for the index. Inlined into the served HTML.',
  format: 'json-ld',
  delivery: 'inline-in-host',
  requires: [{ path: 'site', required: 'always' }],
  refreshCadence: { min: { ms: 0 }, max: { ms: 86_400_000 } },
  async generate(data) {
    const url = pageUrl(data);
    if (!data.doc) {
      return {
        '@context': 'https://schema.org',
        '@type': 'WebSite',
        name: data.site.name,
        url,
        description: data.site.tagline,
      };
    }
    return {
      '@context': 'https://schema.org',
      '@type': 'TechArticle',
      headline: data.doc.title,
      description: data.doc.description,
      url,
      datePublished: data.doc.publishedAt,
      dateModified: data.doc.updatedAt,
      keywords: data.doc.tags.join(', '),
    };
  },
  validate(output): ValidationResult {
    const o = output as { headline?: string; name?: string; url?: string };
    const errors = !o.url
      ? [{ code: 'missing-url', path: 'url', message: 'JSON-LD requires a url.' }]
      : [];
    return { valid: errors.length === 0, errors, warnings: [] };
  },
};

/**
 * `llms.txt` as a generated adapter rather than a hand-maintained file —
 * an index line for the site manifest plus a full-text dump for assistants
 * that fetch `llms-full.txt`. `format: 'custom'`, so it deliberately does
 * NOT run on the render hot path; the server calls it on its own routes.
 */
const llmsTxt: PublicationAdapter<DocSiteData, unknown, DocSiteConfig> = {
  id: 'llms-txt',
  displayName: 'llms.txt fragment',
  description: 'Index line for /llms.txt plus a full-text dump for /llms-full.txt.',
  format: 'custom',
  delivery: 'host-decides',
  // `site` is the only field BOTH branches of generate() read. `doc` is
  // 'preferred', not 'always': the index snapshot has no doc and still
  // yields a line — the `!data.doc` branch below is the /llms.txt heading.
  // An 'always' here made that branch unreachable, so on 0.10.0 the file
  // silently lost its `# heading`. The smoke now checks for it.
  requires: [
    { path: 'site', required: 'always' },
    { path: 'doc.sections', required: 'preferred' },
  ],
  refreshCadence: { min: { ms: 0 }, max: { ms: 86_400_000 } },
  async generate(data) {
    if (!data.doc) {
      return {
        indexLine: `# ${data.site.name}\n\n> ${data.site.tagline}`,
        fullText: `# ${data.site.name}\n\n${data.site.tagline}\n`,
      };
    }
    const url = pageUrl(data);
    const dump = data.doc.sections
      .map((s) => `## ${s.title}\n\n${stripHtml(s.html)}`)
      .join('\n\n');
    return {
      indexLine: `- [${data.doc.title}](${url}): ${data.doc.description}`,
      fullText: `# ${data.doc.title}\n\n${data.doc.description}\n\n${dump}\n`,
    };
  },
  validate(output): ValidationResult {
    const o = output as { indexLine?: string; fullText?: string };
    const errors = [];
    if (!o.indexLine) {
      errors.push({ code: 'missing-index-line', path: 'indexLine', message: 'Needs an index line.' });
    }
    if (!o.fullText) {
      errors.push({ code: 'missing-full-text', path: 'fullText', message: 'Needs a full-text dump.' });
    }
    return { valid: errors.length === 0, errors, warnings: [] };
  },
};

/**
 * Schema.org **microdata** — the inline-with-content alternative to JSON-LD,
 * for indexers that read attributes off the markup rather than a script block.
 *
 * Carried over from the predecessor cartridge because it is a genuinely
 * distinct audience surface, not a duplicate of the JSON-LD adapter: same
 * snapshot, same facts, different encoding. Emitting both is normal and they
 * cannot disagree, which is the entire argument for one snapshot.
 *
 * `format: 'custom'` — the host decides where this fragment goes.
 */
const microdata: PublicationAdapter<DocSiteData, unknown, DocSiteConfig> = {
  id: 'schema-org-microdata',
  displayName: 'Schema.org microdata (HTML)',
  description: 'HTML fragment with itemtype/itemprop attributes, for indexers that read microdata.',
  format: 'custom',
  delivery: 'host-decides',
  requires: [{ path: 'doc.title', required: 'always' }],
  refreshCadence: { min: { ms: 0 }, max: { ms: 86_400_000 } },
  async generate(data, ctx) {
    if (!data.doc) return { fragment: '' };
    const url = pageUrl(data);
    const keywords = data.doc.tags
      .map((t) => `  <meta itemprop="keywords" content="${escapeAttr(t)}">`)
      .join('\n');
    return {
      fragment: [
        '<article itemscope itemtype="https://schema.org/TechArticle">',
        `  <meta itemprop="url" content="${escapeAttr(url)}">`,
        `  <meta itemprop="inLanguage" content="${escapeAttr(ctx.locale)}">`,
        `  <meta itemprop="datePublished" content="${escapeAttr(data.doc.publishedAt)}">`,
        `  <meta itemprop="dateModified" content="${escapeAttr(data.doc.updatedAt)}">`,
        `  <h1 itemprop="headline">${escapeHtml(data.doc.title)}</h1>`,
        `  <p itemprop="description">${escapeHtml(data.doc.description)}</p>`,
        keywords,
        '</article>',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  },
  validate(output): ValidationResult {
    const o = output as { fragment?: string };
    const errors = !o.fragment
      ? [{ code: 'empty-fragment', path: 'fragment', message: 'Microdata fragment is empty.' }]
      : [];
    return { valid: errors.length === 0, errors, warnings: [] };
  },
};

// ─────────────────────────── template ───────────────────────────

/**
 * Four routable pages, one template. `doc` and `note` carry the slug in the
 * second path segment via `pathContextKey: 'slug'`, so `/doc/why-snapshots`
 * decodes to `{ page: 'doc', slug: 'why-snapshots' }` and `/note/roadmap` to
 * `{ page: 'note', slug: 'roadmap' }`.
 *
 * `members` and `note` are `private: true` — the whole of "this page is for
 * one signed-in visitor" is this one field. The public page comes first on
 * purpose: the default entry does not skip private pages, so a template
 * whose first page is private has a private `/`.
 *
 * There is no `notFound` page here: the runner will never dispatch to one,
 * and the server assembles its 404 with `renderDocument` directly — which
 * needs no cartridge and no snapshot. See `server.ts`.
 */
export const docSiteTemplate: Template<DocSiteConfig> = {
  id: 'site',
  displayName: 'Docs site',
  description: 'Index plus per-document pages, root-mounted, with a members area.',
  pages: [
    { id: 'home', type: 'home', enabled: true },
    { id: 'doc', type: 'doc', enabled: true },
    { id: 'members', type: 'members', enabled: true, private: true },
    { id: 'note', type: 'note', enabled: true, private: true },
  ],
  defaultConfig: { locale: 'en-GB', siteUrl: SITE.url, siteName: SITE.name },
};

export const docSiteCartridge: Cartridge<DocSiteData, DocSiteConfig> = {
  id: 'docs-site',
  industry: 'content',
  displayName: 'Docs site',
  description: 'One cartridge owning a whole multi-page site, with every audience surface off one snapshot and a members area behind a sign-in gate.',
  version: '0.11.0',
  mailboxName: '__AIRO_DOCS_SITE_PAGES__',
  schema: docSiteSchema,
  dataSources: [contentSource, membersSource],
  transformers: [anchorIds],
  gates: [loginGate],
  views: [homeView, docView, membersView, noteView],
  templates: [docSiteTemplate],
  mcpTools: [listPages, getSection],
  defaultConfig: { locale: 'en-GB', siteUrl: SITE.url, siteName: SITE.name },
  defaultTemplateId: 'site',
  publicationAdapters: [jsonLd, crawlerSurface, llmsTxt, microdata],
};

/** Caller-owned CSS. The framework authors none — this reaches the document via `head.inlineStyles`. */
export const SITE_CSS = `
  :root { --ink:#16161a; --muted:#6b7280; --line:#e5e7eb; --accent:#0b5cad; }
  * { box-sizing: border-box; }
  body { margin:0; font:16px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif; color:var(--ink); }
  .fs-page { max-width:44rem; margin:0 auto; padding:3rem 1.25rem 6rem; }
  .fs-title { font-size:2rem; line-height:1.15; margin:0 0 .35rem; letter-spacing:-.02em; }
  .fs-tagline { color:var(--muted); margin:0 0 2rem; }
  .fs-list { list-style:none; margin:0; padding:0; display:grid; gap:1.25rem; }
  .fs-card { border-top:1px solid var(--line); padding-top:1.25rem; }
  .fs-card__link { color:var(--accent); font-weight:650; text-decoration:none; font-size:1.1rem; }
  .fs-card__link:hover { text-decoration:underline; }
  .fs-card__desc { color:var(--muted); margin:.35rem 0 0; }
  .fs-back { color:var(--muted); text-decoration:none; font-size:.9rem; display:inline-block; margin-bottom:1.5rem; }
  .fs-toc { border-left:2px solid var(--line); padding-left:1rem; margin:0 0 2rem; }
  .fs-toc ol { margin:0; padding-left:1rem; color:var(--muted); }
  .fs-toc a { color:var(--muted); }
  .fs-section h2 { margin-top:2.25rem; font-size:1.25rem; letter-spacing:-.01em; }
  code { background:#f3f4f6; padding:.1em .35em; border-radius:3px; font-size:.9em; }
  .fs-members-link { display:inline-block; margin-top:-1rem; margin-bottom:2rem; color:var(--accent); font-weight:600; text-decoration:none; }
  .fs-members-link:hover { text-decoration:underline; }
  .fs-signin { border:1px solid var(--line); border-radius:8px; padding:2rem; }
  .fs-signin__button { display:inline-block; background:var(--accent); color:#fff; padding:.6rem 1.1rem; border-radius:4px; text-decoration:none; font-weight:600; }
  .fs-signin__error { color:#b91c1c; margin:0 0 1rem; }
  .fs-signout { margin:-1rem 0 2rem; }
  .fs-signout button { background:none; border:1px solid var(--line); border-radius:4px; padding:.35rem .8rem; color:var(--muted); cursor:pointer; }
`;
