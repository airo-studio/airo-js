/**
 * The whole server. ~150 lines of Express, and none of it is framework-specific.
 *
 * ## Read this if you take one thing from this example
 *
 * `@airo-js/ssr` is pure functions over a `Document`. There is no HTTP server
 * in the framework, no file-based routing, no bundler and no dev server, and
 * that is deliberate rather than missing. **Swap this file for Hono, Fastify,
 * a Cloudflare Worker or bare `node:http` and nothing else changes** — the
 * cartridge, the client entry and every surface below are identical. The
 * sibling `shopify-edge-worker` example is the same framework calls behind a
 * Worker `fetch` handler.
 *
 * ## Four things here are easy to get wrong
 *
 * 1. **Static assets are routed BEFORE the wildcard.** `basePath: '/'`
 *    normalises to `''`, and `''.startsWith('')` is true for every path, so
 *    the app claims the entire origin. The `validPages` allowlist is the only
 *    thing keeping `/favicon.ico` from decoding as a page. Order matters.
 *
 * 2. **The nav hint is decoded with `fragmentToState`, NOT `decodeNavHint`.**
 *    `decodeNavHint`'s allowlist fails closed, and a `null` hint is
 *    indistinguishable from "nothing requested" — so the runner never learns
 *    a page was asked for, `fellBack` never fires, and `/does-not-exist`
 *    answers 200. Two gates in series, the outer silencing the inner. Here
 *    the runner is the gate: it validates the entry page and re-derives
 *    `navState.page` from the page it actually resolved, so a rejected id
 *    cannot reach a renderer. See best-practices §5.10a.
 *
 * 3. **404 branches on `fellBack.reason`, never on its presence.** Only
 *    `'unknown-page'` means the url does not exist. `'disabled'` is a config
 *    state and `'gate-page'` is a real page — both legitimate 200s.
 *
 * 4. **The snapshot is per request.** The DataSource takes the requested slug,
 *    so canonicals are per-page and `validate()` gates one url rather than the
 *    whole site.
 */

import express from 'express';
import { parseHTML } from 'linkedom';

import { extractPathTail, fragmentToState, type NavigationState } from '@airo-js/core';
import { renderAppWithPublication, renderDocument, runPublicationAdapters, headFromPublication } from '@airo-js/ssr';
import { templateToAppConfig } from '@airo-js/cartridge-kit';
import { buildToolManifest, dispatchTool } from '@airo-js/mcp';

import { DOCS, SITE } from './content.js';
import { SITE_CSS, docSiteCartridge, docSiteTemplate, type DocSiteConfig, type DocSiteData } from './cartridge.js';

const PORT = Number(process.env.PORT ?? 3000);
const BASE_PATH = '/';
const PATH_CONTEXT_KEY = 'slug';

const config: DocSiteConfig = { locale: 'en-GB', siteUrl: SITE.url, siteName: SITE.name };
const appConfig = templateToAppConfig(docSiteTemplate, docSiteCartridge.id);
const publicationCtx = { config, locale: config.locale, country: 'GB' as const };

const app = express();

/** A fresh Document per request. `@airo-js/ssr` never touches a global one. */
function freshDocument(): Document {
  return parseHTML('<!doctype html><html><head></head><body></body></html>').document as unknown as Document;
}

/** Decode a url into nav state. See note 2 above for why this is not `decodeNavHint`. */
function navStateFor(pathname: string): Partial<NavigationState> | undefined {
  const tail = extractPathTail(pathname, BASE_PATH);
  if (!tail) return undefined; // bare basePath — the legitimate entry, not a miss
  return fragmentToState(tail, { pathContextKey: PATH_CONTEXT_KEY }) ?? undefined;
}

async function snapshotFor(slug?: string): Promise<DocSiteData> {
  const raw = await docSiteCartridge.dataSources[0]!.fetch(
    { kind: 'custom', payload: { slug } },
    { config },
  );
  // Run the transformer chain exactly as the client will, so the anchor ids
  // a crawler indexes are the ones a reader clicks.
  let data = raw;
  for (const t of docSiteCartridge.transformers ?? []) {
    if (t.isEnabled(config)) data = await t.transform(data, { config, navState: { page: '' }, locale: config.locale });
  }
  return data;
}

type HeadPatch = Partial<Parameters<typeof renderDocument>[0]['head']>;

function documentFor(head: HeadPatch, body: string): string {
  return renderDocument({
    head: {
      // Viewport has NO framework default; it is responsive-design policy,
      // so this example states its own.
      viewport: 'width=device-width, initial-scale=1',
      inlineStyles: [SITE_CSS],
      ...head,
      // `lang` is REQUIRED and the framework will not guess a locale, so it
      // is pinned last rather than spread over.
      lang: config.locale,
    },
    body,
    bodyScripts: [{ src: '/client.js', type: 'module' }],
  });
}

// 1 ── static assets FIRST. See note 1.
app.use('/assets', express.static('public'));
// For POST /mcp/call. Nothing else on this server takes a body.
app.use(express.json());
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// 2 ── machine surfaces, all off the same snapshot the humans get.
app.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send(`User-agent: *\nAllow: /\nSitemap: ${SITE.url}/sitemap.xml\n`);
});

/**
 * The framework emits ONE sitemap entry per page and will never assemble
 * `sitemap.xml`. That is not a gap: having the full entry list requires a
 * site-wide inventory, and an inventory means enumeration plus persistence —
 * state the framework is not allowed to own. The host has the route list, so
 * the host assembles it. This is that assembly, and it is 15 lines.
 */
app.get('/sitemap.xml', async (_req, res) => {
  const entries: string[] = [];
  for (const slug of [undefined, ...DOCS.map((d) => d.slug)]) {
    const snapshot = await snapshotFor(slug);
    const [result] = await runPublicationAdapters(docSiteCartridge, snapshot, publicationCtx, {
      adapterIds: ['crawler-surface'],
    });
    // `included: false` means validate() blocked it — the unfinished draft.
    // It is absent from the sitemap for the same reason it 404s.
    if (!result?.included) continue;
    const { sitemap } = result.output as { sitemap: { loc: string; lastmod?: string; changefreq?: string; priority?: number } };
    entries.push(
      `  <url><loc>${sitemap.loc}</loc>${sitemap.lastmod ? `<lastmod>${sitemap.lastmod}</lastmod>` : ''}` +
        `<changefreq>${sitemap.changefreq}</changefreq><priority>${sitemap.priority}</priority></url>`,
    );
  }
  res
    .type('application/xml')
    .send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</urlset>\n`);
});

/**
 * `llms.txt`, and a trap worth seeing.
 *
 * Each adapter validates its OWN output, independently. The llms-txt adapter
 * only needs an index line and a body, so the unfinished draft passes it —
 * even though the crawler adapter blocked that page and the url 404s.
 *
 * Advertising a url to an AI assistant that a crawler is forbidden to index,
 * and that answers 404, is exactly the drift this framework exists to
 * prevent. So the PUBLICATION DECISION is made once, by the surface that owns
 * it, and every other surface honours it. That coordination is host work: the
 * framework gives you per-adapter verdicts, not a site-wide policy.
 */
app.get('/llms.txt', async (_req, res) => {
  const lines: string[] = [];
  for (const slug of [undefined, ...DOCS.map((d) => d.slug)]) {
    const snapshot = await snapshotFor(slug);
    const results = await runPublicationAdapters(docSiteCartridge, snapshot, publicationCtx, {
      adapterIds: ['crawler-surface', 'llms-txt'],
    });
    const publishable = results.find((r) => r.adapterId === 'crawler-surface')?.included;
    const llms = results.find((r) => r.adapterId === 'llms-txt');
    if (publishable && llms?.included) lines.push((llms.output as { indexLine: string }).indexLine);
  }
  res.type('text/plain').send(lines.join('\n') + '\n');
});

/**
 * The microdata fragment, served on its own route. Same snapshot as the HTML
 * and the JSON-LD — a different ENCODING for indexers that read attributes off
 * markup rather than a script block, not a different set of facts.
 */
app.get('/microdata/:slug', async (req, res) => {
  const snapshot = await snapshotFor(req.params.slug);
  if (!snapshot.doc) { res.status(404).type('text/plain').send('not found\n'); return; }
  // Same coordination as /llms.txt, and for the same reason. The microdata
  // adapter validates only its OWN output — a non-empty fragment — so it
  // happily publishes a page the crawler adapter blocked. One publication
  // decision, honoured by every surface, is host work.
  const results = await runPublicationAdapters(docSiteCartridge, snapshot, publicationCtx, {
    adapterIds: ['crawler-surface', 'schema-org-microdata'],
  });
  const publishable = results.find((r) => r.adapterId === 'crawler-surface')?.included;
  const micro = results.find((r) => r.adapterId === 'schema-org-microdata');
  if (!publishable || !micro?.included) { res.status(404).type('text/plain').send('not published\n'); return; }
  res.type('text/html').send((micro.output as { fragment: string }).fragment);
});

/**
 * The agent surface. Same cartridge, same snapshot, third audience.
 *
 * This used to map `mcpTools` by hand, with a cast per field because no
 * typed helper existed. `buildToolManifest` emits MCP's `tools/list` shape
 * from the cartridge directly, and `dispatchTool` answers a call against the
 * same `snapshotFor(slug)` the HTML route renders — which is the whole
 * snapshot-fidelity claim, made checkable on one page.
 */
app.get('/mcp/tools', (_req, res) => {
  res.json(buildToolManifest(docSiteCartridge));
});

app.post('/mcp/call', async (req, res) => {
  const { name, arguments: args, slug } = req.body ?? {};
  if (typeof name !== 'string') { res.status(400).json({ error: 'missing tool name' }); return; }

  const snapshot = await snapshotFor(typeof slug === 'string' ? slug : undefined);
  const out = await dispatchTool(docSiteCartridge, name, args ?? {}, snapshot, {
    config: docSiteCartridge.defaultConfig,
  });

  // A tool the agent got wrong is a 400, not a 500 — the dispatcher returns
  // a verdict rather than throwing, so the distinction survives to the wire.
  res.status(out.ok ? 200 : 400).json(out);
});

// 3 ── every human-facing url lands here.
//
// Registered TWICE on purpose: Express 5's `/*splat` matches one-or-more
// segments and does NOT match the bare root, so a wildcard-only route leaves
// `/` falling through to Express's own 404 — on the one url a root-mounted
// site most needs to serve. Caught by curling `/` rather than by any test.
const renderPage: express.RequestHandler = async (req, res) => {
  const initialNavState = navStateFor(req.path);
  const snapshot = await snapshotFor(initialNavState?.[PATH_CONTEXT_KEY] as string | undefined);

  const result = await renderAppWithPublication<DocSiteData, DocSiteConfig>({
    cartridge: docSiteCartridge,
    appConfig,
    snapshot,
    publicationCtx,
    document: freshDocument(),
    initialNavState,
  });

  // Note 3: branch on the REASON. Only 'unknown-page' is a missing url.
  const unknownUrl =
    result.fellBack?.reason === 'unknown-page' ||
    // A doc page whose slug matched no document, or one the publish gate
    // blocked (no canonical), is equally a 404 on this surface.
    (initialNavState?.page === 'doc' && !snapshot.doc) ||
    (snapshot.doc && !snapshot.doc.updatedAt);

  if (unknownUrl) {
    // Assembled directly — no cartridge and no snapshot needed, which is
    // exactly why renderDocument composes rather than wraps.
    res.status(404).send(
      documentFor(
        { title: `Not found — ${SITE.name}` },
        `<div class="fs-page"><h1 class="fs-title">Not found</h1>
         <p class="fs-tagline">No page lives at <code>${req.path}</code>.</p>
         <a class="fs-back" href="/">← index</a></div>`,
      ),
    );
    return;
  }

  res.status(200).send(
    documentFor(
      {
        title: snapshot.doc ? `${snapshot.doc.title} — ${SITE.name}` : SITE.name,
        // Canonical, OpenGraph and Twitter Card, folded from the adapter
        // output by shape. `included: false` output never reaches here.
        ...headFromPublication(result.adapterResults),
      },
      result.html,
    ),
  );
};

app.get('/', renderPage);
app.get('/*splat', renderPage);

app.listen(PORT, () => {
  console.log(`full-site listening on http://localhost:${PORT}`);
  console.log(`  /                      index`);
  console.log(`  /doc/why-snapshots     a document`);
  console.log(`  /doc/unfinished-draft  404 — blocked by the publish gate`);
  console.log(`  /does-not-exist        404 — fellBack.reason === 'unknown-page'`);
  console.log(`  /sitemap.xml /llms.txt /robots.txt /mcp/tools`);
});
