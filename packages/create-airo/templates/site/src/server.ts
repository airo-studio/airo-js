/**
 * The server. Plain Express, and none of it is specific to the framework.
 *
 * `@airo-js/ssr` is a set of functions that turn a cartridge and a snapshot
 * into HTML. There is no framework server, router or dev server. Swap this
 * file for Hono, Fastify, a Cloudflare Worker or `node:http` and nothing else
 * in the project changes.
 *
 * ## Five things here are easy to get wrong
 *
 * 1. **Static files are served BEFORE the page route.** The site is mounted at
 *    `/`, so the page route matches every url; anything registered after it is
 *    unreachable.
 *
 * 2. **Urls are decoded with `fragmentToState`, not `decodeNavHint`.**
 *    `decodeNavHint` drops a page it does not recognise, so the renderer never
 *    learns one was asked for and `/does-not-exist` answers 200 with the home
 *    page. Here the renderer decides, and reports what it decided.
 *
 * 3. **Status codes come from the renderer's reasons, in this order.** Read
 *    `fellBack.reason === 'unknown-page'` (404) before `skipped.reason`
 *    (`'private'` is 401). Check the reason, never just whether the field is
 *    there: `fellBack` is also set for a disabled page, which is a real page.
 *    Because this server answers that 404 itself, it passes
 *    `unknownPage: 'refuse'`, and nothing is rendered for an unknown url.
 *
 * 4. **Every request gets its own snapshot**, built for the page it names.
 *    That is what gives each page its own canonical url, and lets one
 *    unfinished post 404 without affecting the rest.
 *
 * 5. **Transformers see the same navigation state here as in the browser.**
 *    `resolveMountEntry` is the function the runtime uses to pick the entry
 *    page; calling it here means a transformer that reads `navState` produces
 *    the same data on both sides, so hydration never adopts mismatched markup.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { templateToAppConfig } from '@airo-js/cartridge-kit';
import {
  createPipeline,
  escapeHtml,
  extractPathTail,
  fragmentToState,
  resolveMountEntry,
  type NavigationState,
} from '@airo-js/core';
import { buildToolManifest, dispatchTool } from '@airo-js/mcp';
import { headFromPublication, renderAppWithPublication, renderDocument, runPublicationAdapters } from '@airo-js/ssr';
import express from 'express';
import { parseHTML } from 'linkedom';

import { ROOT_ATTRS, SITE_CSS, isPublished, siteTemplate, type SiteConfig, type SiteData, type SiteInput } from './cartridge.js';
import { siteServerCartridge as cartridge, type LlmsTxtOutput } from './cartridge.server.js';
import { COPY, POSTS, SITE, findPost } from './content.js';

const PORT = Number(process.env.PORT ?? 3000);
const BASE_PATH = '/';
const PATH_CONTEXT_KEY = 'slug';

const config: SiteConfig = cartridge.defaultConfig;
const appConfig = templateToAppConfig(siteTemplate, cartridge.id);
const publicationCtx = { config, locale: config.locale, country: 'GB' };
const pipeline = createPipeline<SiteData, SiteConfig>(cartridge.transformers ?? []);

export const app: express.Express = express();

/** A fresh Document per render. The renderer never touches a global one. */
function freshDocument(): Document {
  return parseHTML('<!doctype html><html><head></head><body></body></html>').document as unknown as Document;
}

/** Decode a url into navigation state. See note 2 for why this is not `decodeNavHint`. */
function navStateFor(pathname: string): Partial<NavigationState> | undefined {
  const tail = extractPathTail(pathname, BASE_PATH);
  if (!tail) return undefined; // `/` itself: the default entry, not a miss
  return fragmentToState(tail, { pathContextKey: PATH_CONTEXT_KEY }) ?? undefined;
}

/**
 * The snapshot for one request, transformed exactly as the browser will
 * transform it. This is the only place snapshots are built, so every surface
 * below reads the same data.
 */
export async function snapshotFor(initialNavState?: Partial<NavigationState>): Promise<SiteData> {
  const source = cartridge.dataSources[0];
  if (!source) throw new Error('the cartridge declares no data source');
  const input: SiteInput = { slug: initialNavState?.[PATH_CONTEXT_KEY] };
  const raw = await source.fetch({ kind: 'custom', payload: input }, { config });
  // Note 5: the same entry the runtime computes in the browser.
  const entry = resolveMountEntry({ pages: appConfig.pages, initialNavState });
  return pipeline.runTransformers(raw, {
    config,
    locale: config.locale,
    navState: { ...entry.navState, page: entry.page?.id ?? entry.navState.page },
  });
}

type HeadPatch = Partial<Parameters<typeof renderDocument>[0]['head']>;

/**
 * A complete HTML document. `mount` tells the browser bundle how to start:
 * `'hydrate'` adopts the markup already in `#app`, `'csr'` renders into it
 * from scratch, and `false` means no app and no bundle at all.
 */
function documentFor(head: HeadPatch, body: string, mount: 'hydrate' | 'csr' | false = 'hydrate'): string {
  return renderDocument({
    head: {
      // The framework sets no viewport; that is your layout decision.
      viewport: 'width=device-width, initial-scale=1',
      inlineStyles: [SITE_CSS],
      ...head,
      // `lang` is required and never guessed, so it is set last.
      lang: config.locale,
    },
    body: mount ? `<div id="app" ${ROOT_ATTRS.mode}="${mount}">${body}</div>` : body,
    bodyScripts: mount ? [{ src: '/client.js', type: 'module' }] : [],
  });
}

function notFound(res: express.Response, path: string): void {
  res.status(404).send(
    documentFor(
      { title: `${COPY.notFound} — ${SITE.name}` },
      `<div class="site-page"><h1 class="site-title">${escapeHtml(COPY.notFound)}</h1>
       <p class="site-tagline">${escapeHtml(COPY.nothingAt)} <code>${escapeHtml(path)}</code>.</p>
       <a class="site-back" href="/">${escapeHtml(COPY.backToIndex)}</a></div>`,
      false,
    ),
  );
}

// ── 1. Static files, before anything else. See note 1. ────────────────────
//
// `dist/public/client.js` is the bundle `npm run build` makes from
// `src/client.ts`.
app.use(express.static(join(dirname(fileURLToPath(import.meta.url)), 'public'), { index: false }));
app.use(express.json());
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// ── 2. Search-engine and agent surfaces, from the same snapshots. ─────────

/** `/` plus one url per post — every url the sitemap and llms.txt consider. */
const PAGE_STATES: Array<Partial<NavigationState> | undefined> = [
  undefined,
  ...POSTS.map((p) => ({ page: 'post', [PATH_CONTEXT_KEY]: p.slug })),
];

// A real site would build these from a cache or an index on a schedule
// rather than per request; the `max-age` stands in for that.
const MACHINE_CACHE = 'public, max-age=300';

app.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send(`User-agent: *\nAllow: /\nSitemap: ${SITE.url}/sitemap.xml\n`);
});

/**
 * The framework gives you one sitemap entry per page; listing every page is
 * yours to do, because only you know what pages exist.
 */
app.get('/sitemap.xml', async (_req, res) => {
  const entries: string[] = [];
  for (const state of PAGE_STATES) {
    const [result] = await runPublicationAdapters(cartridge, await snapshotFor(state), publicationCtx, {
      adapterIds: ['crawler-surface'],
    });
    // `included: false` means `validate()` blocked the page — it 404s too.
    if (!result?.included) continue;
    const { sitemap } = result.output as {
      sitemap: { loc: string; lastmod?: string; changefreq?: string; priority?: number };
    };
    entries.push(
      `  <url><loc>${sitemap.loc}</loc>${sitemap.lastmod ? `<lastmod>${sitemap.lastmod}</lastmod>` : ''}` +
        `<changefreq>${sitemap.changefreq}</changefreq><priority>${sitemap.priority}</priority></url>`,
    );
  }
  res
    .set('Cache-Control', MACHINE_CACHE)
    .type('application/xml')
    .send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</urlset>\n`,
    );
});

/**
 * Each adapter checks only its own output, so the llms.txt adapter would
 * happily list the unfinished post that the crawler adapter blocked. The
 * decision to publish a page is made once — by the crawler adapter — and this
 * route honours it.
 */
app.get('/llms.txt', async (_req, res) => {
  const lines: string[] = [];
  for (const state of PAGE_STATES) {
    const results = await runPublicationAdapters(cartridge, await snapshotFor(state), publicationCtx, {
      adapterIds: ['crawler-surface', 'llms-txt'],
    });
    const published = results.find((r) => r.adapterId === 'crawler-surface')?.included;
    const llms = results.find((r) => r.adapterId === 'llms-txt');
    if (published && llms?.included) lines.push((llms.output as LlmsTxtOutput).line);
  }
  res.set('Cache-Control', MACHINE_CACHE).type('text/plain').send(`${lines.join('\n')}\n`);
});

/** The tools an AI agent can call. */
app.get('/mcp/tools', (_req, res) => {
  res.json(buildToolManifest(cartridge));
});

/**
 * Call a tool: `{ "name": "get_section", "arguments": { "id": "…" }, "slug": "hello" }`.
 * The tool reads the same snapshot `/post/hello` renders.
 */
app.post('/mcp/call', async (req, res) => {
  const { name, arguments: args, slug } = (req.body ?? {}) as { name?: unknown; arguments?: unknown; slug?: unknown };
  if (typeof name !== 'string') {
    res.status(400).json({ error: 'missing tool name' });
    return;
  }
  const state = typeof slug === 'string' ? { page: 'post', [PATH_CONTEXT_KEY]: slug } : undefined;
  const out = await dispatchTool(cartridge, name, args ?? {}, await snapshotFor(state), { config });

  if (!out.ok) {
    // A bad call from an agent is a 400, not a 500 — `dispatchTool` returns
    // a verdict instead of throwing. `error.cause` is whatever the tool threw,
    // and tools can close over secrets: log it here, never send it back.
    console.error(`[mcp] ${name} failed: ${out.error.code}`, ...(out.error.cause === undefined ? [] : [out.error.cause]));
    res.status(400).json({ ok: false, toolName: out.toolName, error: { code: out.error.code, message: out.error.message } });
    return;
  }
  res.json(out);
});

// ── 3. Every page. ───────────────────────────────────────────────────────
//
// Registered twice: Express 5's `/*splat` does not match `/` itself.
const renderPage: express.RequestHandler = async (req, res) => {
  const initialNavState = navStateFor(req.path);
  const snapshot = await snapshotFor(initialNavState);
  const result = await renderAppWithPublication<SiteData, SiteConfig>({
    cartridge,
    appConfig,
    snapshot,
    publicationCtx,
    document: freshDocument(),
    initialNavState,
    // This site answers 404 for unknown urls itself (just below), so the
    // renderer is told not to render the page it would fall back to. Without
    // this it renders the home page, runs its adapters and logs a warning,
    // all for a response that is thrown away. Leave it out only for an app
    // embedded in someone else's page, where the url is not yours.
    unknownPage: 'refuse',
  });

  // Note 3, first: a url that names no page is a 404, whatever else is set.
  if (result.fellBack?.reason === 'unknown-page') {
    notFound(res, req.path);
    return;
  }

  // Note 3, second: a page marked `private: true` in the template is refused
  // until you verify a session. To serve one, check the session here and call
  // `renderAppWithPublication` again with `renderPrivate: true`. The
  // `examples/full-site` project in the airo-js repo shows the whole flow.
  if (result.skipped?.reason === 'private') {
    res
      .status(401)
      .set('Cache-Control', 'private, no-store')
      .send(
        documentFor(
          { title: `${COPY.signInRequired} — ${SITE.name}`, meta: [{ name: 'robots', content: 'noindex, nofollow' }] },
          `<div class="site-page"><h1 class="site-title">${escapeHtml(COPY.signInRequired)}</h1></div>`,
          false,
        ),
      );
    return;
  }

  // A post that does not exist, or that its crawler adapter refused to
  // publish, is also missing as far as this site is concerned.
  const unpublished = result.adapterResults.some((r) => r.adapterId === 'crawler-surface' && !r.included);
  if ((initialNavState?.page === 'post' && !snapshot.post) || unpublished) {
    notFound(res, req.path);
    return;
  }

  // A view declared `capabilities: ['csr-only']` has no server markup; the
  // browser renders it from scratch.
  const mount = result.skipped?.reason === 'csr-only' ? 'csr' : 'hydrate';

  res.set('Cache-Control', 'public, max-age=60');
  res.status(200).send(
    documentFor(
      {
        title: snapshot.post ? `${snapshot.post.title} — ${SITE.name}` : SITE.name,
        // Canonical, OpenGraph and Twitter Card, taken from the adapters'
        // output. Output a `validate()` rejected never reaches here.
        ...headFromPublication(result.adapterResults),
      },
      result.html,
      mount,
    ),
  );
};

app.get('/', renderPage);
app.get('/*splat', renderPage);

/** `/` and `/post/<slug>`: the url a `PAGE_STATES` entry names. */
function urlFor(state: Partial<NavigationState> | undefined): string {
  return state ? `/${state.page}/${String(state[PATH_CONTEXT_KEY])}` : '/';
}

// Listen only when run directly, so `scripts/smoke.mjs` and tests can import
// `app` and bind their own port.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  app.listen(PORT, () => {
    console.log(`${SITE.name} on http://localhost:${PORT}`);
    // The same list the sitemap walks, so it changes when your content does.
    for (const state of PAGE_STATES) {
      const post = state ? findPost(String(state[PATH_CONTEXT_KEY])) : undefined;
      const note = !state ? 'the index' : post && isPublished(post) ? post.title : '404 until it has an updatedAt';
      console.log(`  ${urlFor(state).padEnd(22)} ${note}`);
    }
    console.log('  /sitemap.xml /llms.txt /robots.txt /mcp/tools');
  });
}
