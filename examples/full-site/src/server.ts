/**
 * The whole server. ~250 lines of Express, and none of it is framework-specific.
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
 * The same is true of the members area: sessions, cookies, the OAuth
 * provider and the relying party (`./auth/*`) are host code. The framework's
 * whole involvement is the `private: true` flag on two pages, the
 * `renderPrivate` flag this file sets after it verified a session, and a
 * gate that paints a sign-in panel.
 *
 * ## Six things here are easy to get wrong
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
 * 3. **404 branches on `fellBack.reason`, never on its presence** — and
 *    `skipped` is read BEFORE `fellBack`. Only `'unknown-page'` means the
 *    url does not exist. `'disabled'` is a config state and `'gate-page'`
 *    is a real page — both legitimate 200s. `skipped.reason === 'private'`
 *    is a 401, and a private refusal has no canonical, so a "no canonical
 *    → 404" rule written for public pages would misfire on it.
 *
 * 4. **The snapshot is per request.** The DataSource takes the requested
 *    slug, so canonicals are per-page and `validate()` gates one url rather
 *    than the whole site.
 *
 * 5. **Member data never enters a snapshot built for a machine route, and
 *    it is keyed on the PAGE, never on the session.** Adapters and MCP tools
 *    are page-blind; they publish whatever the snapshot holds. `/sitemap.xml`,
 *    `/llms.txt` and `/mcp/call` build their snapshots without a session, so
 *    the private slice is simply never there. And the wildcard builds it
 *    only inside the `skipped.reason === 'private'` branch — a signed-in
 *    visitor's public pages are byte-identical to an anonymous visitor's,
 *    which is what makes `Cache-Control: public` honest.
 *
 * 6. **Refuse first, then ask who is asking.** The wildcard calls the runner
 *    WITHOUT `renderPrivate`; only on a private refusal does it read the
 *    cookie, build the slice and call again. Two runner calls on a signed-in
 *    private request, and the host never re-derives which page the URL
 *    names — the runner did.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { parseHTML } from 'linkedom';

import { escapeHtml, extractPathTail, fragmentToState, type NavigationState } from '@airo-js/core';
import { renderAppWithPublication, renderDocument, runPublicationAdapters, headFromPublication } from '@airo-js/ssr';
import { templateToAppConfig } from '@airo-js/cartridge-kit';
import { buildToolManifest, dispatchTool } from '@airo-js/mcp';

import { DOCS, MEMBER_NOTES, SITE, findNote } from './content.js';
import {
  SITE_CSS,
  docSiteCartridge,
  docSiteTemplate,
  type DocSiteConfig,
  type DocSiteData,
  type MemberSlice,
} from './cartridge.js';
import { oauthProvider, type RegisteredClient } from './auth/oauth-provider.js';
import { privateHeaders, readSession, relyingParty } from './auth/session.js';

const PORT = Number(process.env.PORT ?? 3000);
const BASE_PATH = '/';
const PATH_CONTEXT_KEY = 'slug';
/** This server's own origin; the demo identity provider lives on it too unless `AUTH_ISSUER` says otherwise. */
const ORIGIN = process.env.SITE_ORIGIN ?? `http://localhost:${PORT}`;
const AUTH_ISSUER = process.env.AUTH_ISSUER ?? ORIGIN;

const config: DocSiteConfig = { locale: 'en-GB', siteUrl: SITE.url, siteName: SITE.name };
const appConfig = templateToAppConfig(docSiteTemplate, docSiteCartridge.id);
const publicationCtx = { config, locale: config.locale, country: 'GB' as const };

/** The one relying party the demo provider knows. `redirect_uri` is matched exactly. */
const client: RegisteredClient = {
  clientId: 'full-site',
  clientSecret: 'demo-client-secret',
  redirectUri: `${ORIGIN}/auth/callback`,
};

export const app: express.Express = express();
// Honour `X-Forwarded-Proto` from one hop, so `req.secure` (and the cookie's
// `Secure` flag) is right behind a TLS terminator.
app.set('trust proxy', 1);

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

/** The public snapshot for a request — never carries `member`. */
async function snapshotFor(slug?: string): Promise<DocSiteData> {
  const raw = await docSiteCartridge.dataSources[0]!.fetch(
    { kind: 'custom', payload: { slug } },
    { config },
  );
  return runTransformers(raw);
}

// Run the transformer chain exactly as the client will, so the anchor ids
// a crawler indexes are the ones a reader clicks.
async function runTransformers(raw: DocSiteData): Promise<DocSiteData> {
  let data = raw;
  for (const t of docSiteCartridge.transformers ?? []) {
    if (t.isEnabled(config)) data = await t.transform(data, { config, navState: { page: '' }, locale: config.locale });
  }
  return data;
}

/**
 * The private slice, built ONLY for a verified session rendering a private
 * page. One builder, used by the wildcard's private branch and by
 * `/api/members/me`, so SSR and the API cannot disagree about its shape.
 * Shaped to exactly what the two private views render.
 */
function memberSliceFor(userId: string, name: string, slug?: string): MemberSlice {
  return {
    user: { id: userId, name },
    notes: MEMBER_NOTES.map(({ slug: s, title, description, updatedAt }) => ({ slug: s, title, description, updatedAt })),
    ...(slug ? { note: findNote(slug) } : {}),
  };
}

type HeadPatch = Partial<Parameters<typeof renderDocument>[0]['head']>;

/**
 * Assemble a full document. `mount` names how the client should treat the
 * `#app` root — `'hydrate'` adopts the server's markup, `'csr'` paints
 * fresh into an empty root — or `false` for documents (the 404 page) that
 * carry no app and therefore no client bundle. `rootAttrs` are extra
 * `data-airo-*` attributes on the root: which DataSource the client mounts
 * with, and which gates the server's render already satisfied. The client
 * reads all of it off the DOM, so the two sides never disagree.
 */
function documentFor(
  head: HeadPatch,
  body: string,
  mount: 'hydrate' | 'csr' | false = 'hydrate',
  rootAttrs: Record<string, string> = {},
): string {
  const attrs = Object.entries(rootAttrs)
    .map(([k, v]) => ` ${k}="${escapeHtml(v)}"`)
    .join('');
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
    body: mount ? `<div id="app" data-airo-mode="${mount}"${attrs}>${body}</div>` : body,
    bodyScripts: mount ? [{ src: '/client.js', type: 'module' }] : [],
  });
}

const NOINDEX: HeadPatch = { meta: [{ name: 'robots', content: 'noindex, nofollow' }] };

// 1 ── static assets FIRST. See note 1.
//
// `dist/public/client.js` is the esbuild bundle of `src/client.ts`. Until
// 0.11.0 this file referenced `/client.js` and never served it: the route
// fell through to the wildcard and the browser was handed an HTML page as
// a module, so this example's hydrate path had never run in a browser.
// The Playwright checks in `e2e/` exist so that cannot happen silently
// again.
app.use(express.static(join(dirname(fileURLToPath(import.meta.url)), 'public'), { index: false }));
app.use('/assets', express.static('public'));
// JSON for POST /mcp/call; urlencoded for the sign-in form and the token endpoint.
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// 2 ── auth. All host code: the demo identity provider and the relying party.
app.use(oauthProvider(client));
app.use(relyingParty({ client, issuer: AUTH_ISSUER }));

/**
 * The members API — the authority. 401 without a session, the private
 * snapshot with one. The client's `membersSource` calls this on every
 * private mount; the gate that paints the sign-in panel is UX, this is the
 * boundary.
 */
app.get('/api/members/me', async (req, res) => {
  privateHeaders(res);
  const session = readSession(req);
  if (!session) { res.status(401).json({ error: 'unauthenticated' }); return; }
  const slug = typeof req.query.slug === 'string' ? req.query.slug : undefined;
  const snapshot = await runTransformers({
    ...(await snapshotFor()),
    member: memberSliceFor(session.userId, session.user.name, slug),
  });
  res.json(snapshot);
});

// 3 ── machine surfaces, all off the same PUBLIC snapshot the humans get.
// None of these read a cookie, so none can ever carry a `member` slice.
app.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send(
    `User-agent: *\nAllow: /\nDisallow: /members\nDisallow: /note/\nDisallow: /auth/\nDisallow: /api/\nDisallow: /oauth/\nSitemap: ${SITE.url}/sitemap.xml\n`,
  );
});

/**
 * The framework emits ONE sitemap entry per page and will never assemble
 * `sitemap.xml`. That is not a gap: having the full entry list requires a
 * site-wide inventory, and an inventory means enumeration plus persistence —
 * state the framework is not allowed to own. The host has the route list, so
 * the host assembles it. This is that assembly, and it is 15 lines. The
 * inventory is the PUBLIC docs; member notes are not in it by construction.
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
 * snapshot-fidelity claim, made checkable on one page. It never reads a
 * cookie, so an agent can never be handed a member's notes.
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
  //
  // Note what is NOT sent: `error.cause` carries whatever the cartridge's
  // handler threw, and handlers routinely close over server credentials.
  // Log it, never return it.
  if (!out.ok) {
    console.error('[mcp] dispatch failed', out.error.code, out.error.cause ?? '');
    res.status(400).json({ ok: false, toolName: out.toolName, error: { code: out.error.code, message: out.error.message } });
    return;
  }
  res.status(200).json(out);
});

// 4 ── every human-facing url lands here.
//
// Registered TWICE on purpose: Express 5's `/*splat` matches one-or-more
// segments and does NOT match the bare root, so a wildcard-only route leaves
// `/` falling through to Express's own 404 — on the one url a root-mounted
// site most needs to serve. Caught by curling `/` rather than by any test.
const renderPage: express.RequestHandler = async (req, res) => {
  const initialNavState = navStateFor(req.path);
  const slug = initialNavState?.[PATH_CONTEXT_KEY] as string | undefined;
  const publicSnapshot = await snapshotFor(slug);
  const render = (snapshot: DocSiteData, renderPrivate: boolean) =>
    renderAppWithPublication<DocSiteData, DocSiteConfig>({
      cartridge: docSiteCartridge,
      appConfig,
      snapshot,
      publicationCtx,
      document: freshDocument(),
      initialNavState,
      renderPrivate,
    });

  // Note 6: refuse first. Public pages come back rendered; a private entry
  // comes back refused with nothing run and nothing inlined.
  let result = await render(publicSnapshot, false);
  let snapshot = publicSnapshot;
  let isPrivate = false;

  if (result.skipped?.reason === 'private') {
    isPrivate = true;
    privateHeaders(res);
    // Only now — inside the private branch — is the cookie read. Public
    // pages never touch it, which is true by construction rather than by
    // discipline.
    const session = readSession(req);
    if (!session) {
      // The 401 shell: an empty root the client mounts in CSR mode with the
      // members DataSource. The gate runs before any fetch, asks
      // `/auth/session`, and paints the sign-in panel. Bots get this too —
      // no private byte, no bundle-free markup to index, `noindex` twice.
      res.status(401).send(
        documentFor({ title: `Members — ${SITE.name}`, ...NOINDEX }, '', 'csr', { 'data-airo-source': 'members' }),
      );
      return;
    }
    // Note 5: the slice is built here and nowhere else on this route.
    snapshot = await runTransformers({
      ...publicSnapshot,
      member: memberSliceFor(session.userId, session.user.name, slug),
    });
    result = await render(snapshot, true);
  }

  // Note 3: branch on the REASON. Only 'unknown-page' is a missing url.
  const unknownUrl =
    result.fellBack?.reason === 'unknown-page' ||
    // A doc page whose slug matched no document, or one the publish gate
    // blocked (no canonical), is equally a 404 on this surface.
    (initialNavState?.page === 'doc' && !snapshot.doc) ||
    (snapshot.doc && !snapshot.doc.updatedAt) ||
    // A member note that does not exist — only reachable signed in.
    (initialNavState?.page === 'note' && !snapshot.member?.note);

  if (unknownUrl) {
    // Assembled directly — no cartridge and no snapshot needed, which is
    // exactly why renderDocument composes rather than wraps. No app root
    // and no client bundle either: there is nothing to mount.
    res.status(404).send(
      documentFor(
        { title: `Not found — ${SITE.name}` },
        `<div class="fs-page"><h1 class="fs-title">Not found</h1>
         <p class="fs-tagline">No page lives at <code>${escapeHtml(req.path)}</code>.</p>
         <a class="fs-back" href="/">← index</a></div>`,
        false,
      ),
    );
    return;
  }

  if (isPrivate) {
    // A private render for a session: server-rendered HTML, no adapters ran
    // (so no canonical, no OpenGraph, no JSON-LD to fold in), `noindex`, and
    // the gates this render already met on the root so the client mounts
    // without asking `/auth/session` again.
    const title = snapshot.member?.note ? `${snapshot.member.note.title} — Members` : `Members — ${SITE.name}`;
    res.status(200).send(
      documentFor({ title, ...NOINDEX }, result.html, 'hydrate', {
        'data-airo-source': 'members',
        'data-airo-gates-satisfied': result.gates.satisfied.join(','),
      }),
    );
    return;
  }

  // Public pages are shared-cacheable: a signed-in visitor's public page is
  // byte-identical to an anonymous visitor's, which is what makes this
  // header honest.
  res.set('Cache-Control', 'public, max-age=60');
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

// `server.ts` is imported by the unit tests (which bind their own port) and
// run directly by `pnpm dev`; only the latter listens here.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  app.listen(PORT, () => {
    console.log(`full-site listening on http://localhost:${PORT}`);
    console.log(`  /                      index`);
    console.log(`  /doc/why-snapshots     a document`);
    console.log(`  /doc/unfinished-draft  404 — blocked by the publish gate`);
    console.log(`  /does-not-exist        404 — fellBack.reason === 'unknown-page'`);
    console.log(`  /members               401 shell + sign-in gate; 200 server-rendered for a session (demo / demo)`);
    console.log(`  /note/roadmap          a member note — private`);
    console.log(`  /sitemap.xml /llms.txt /robots.txt /mcp/tools`);
    console.log(`  identity provider at ${AUTH_ISSUER}/oauth/authorize`);
  });
}
