/**
 * studio-lite Hono server.
 *
 * Editor reset (slice 1 of studio-lite-editor.md): markdown body is the
 * source of truth. The studio persists `StudioPageData` rows; the
 * cartridge consumes the derived `DocPageData` (with parsed
 * headings/sections/codeBlocks). Bridge in page-shape.ts.
 *
 * Endpoints (single-page at v0; multi-page lands in slice 2):
 *   GET  /api/state    latest persisted page + rendered body html + coverage
 *   POST /api/save     persist edits, parse markdown, return same shape
 *   POST /api/publish  derive DocPageData and run the publish pipeline
 *   GET  /api/fixture  read-only seed (diagnostic / "reset" affordance)
 *   GET  /healthz      ok + revision count
 *
 * Bind: 127.0.0.1 only — design doc's hard v0 constraint.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { serve } from '@hono/node-server';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Cartridge } from '@airo-js/cartridge-kit';
import { docPageCartridge } from '@airo-js-cartridges/doc-page';
import { analyzeAdapterCoverage, type AdapterCoverageRow } from '../editor/adapter-coverage.js';

import { CartridgeStateStore } from './db.js';
import { publishCartridge } from './publish.js';
import { renderMarkdownBodyHtml } from './markdown.js';
import { isStudioPageData, studioToDocPage, type StudioPageData } from './page-shape.js';
import { seedPage } from './seed-page.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, '..', '..');
const PUBLIC_DIR = resolve(APP_ROOT, 'public');
const REPO_ROOT = resolve(APP_ROOT, '..', '..');
const DB_PATH = resolve(APP_ROOT, '.studio-data', 'db.sqlite');
const PUBLISH_DIR = resolve(APP_ROOT, 'dist-publish');

const store = new CartridgeStateStore(DB_PATH);

const ACTIVE_CARTRIDGE: Cartridge = docPageCartridge as unknown as Cartridge;
const ACTIVE_CARTRIDGE_ID = 'doc-page';

const app = new Hono();

// ─────────────────────────── chrome ──────────────────────────────────

app.get('/', async (c) => {
  const html = await readFile(resolve(PUBLIC_DIR, 'index.html'), 'utf8');
  return c.html(html);
});

app.get('/bundle.js', async (c) => {
  try {
    const js = await readFile(resolve(PUBLIC_DIR, 'bundle.js'), 'utf8');
    return c.body(js, 200, {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'no-store',
    });
  } catch (e) {
    return c.text(
      `// bundle.js not built. Run: pnpm --filter @airo-js-apps/studio-lite build:bundle\n// ${
        e instanceof Error ? e.message : String(e)
      }`,
      404,
      { 'content-type': 'application/javascript; charset=utf-8' },
    );
  }
});

app.get('/bundle.js.map', async (c) => {
  try {
    const map = await readFile(resolve(PUBLIC_DIR, 'bundle.js.map'), 'utf8');
    return c.body(map, 200, { 'content-type': 'application/json; charset=utf-8' });
  } catch {
    return c.notFound();
  }
});

// Brand asset (chilopod-mono) — served from docs/designs to avoid duplication.
app.get('/chilopod-mono.png', async (c) => {
  try {
    const buf = await readFile(resolve(REPO_ROOT, 'docs', 'designs', 'chilopod-mono.png'));
    return c.body(buf, 200, {
      'content-type': 'image/png',
      'cache-control': 'public, max-age=86400',
    });
  } catch {
    return c.notFound();
  }
});

// ──────────────────────────── API ────────────────────────────────────

app.get('/api/state', async (c) => c.json(await buildStateResponse()));

app.post('/api/save', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be JSON.' }, 400);
  }
  if (!isStudioPageData(body)) {
    return c.json(
      { error: 'Expected StudioPageData: { slug, title, description, publishedAt, updatedAt, body, ... }.' },
      400,
    );
  }
  const persisted: StudioPageData = {
    ...body,
    updatedAt: new Date().toISOString(),
  };
  const saved = store.save(ACTIVE_CARTRIDGE_ID, persisted);
  return c.json({
    cartridgeId: saved.cartridgeId,
    revisionId: saved.revisionId,
    createdAt: saved.createdAt,
    page: persisted,
    renderedBodyHtml: renderMarkdownBodyHtml(persisted.body),
    coverage: await coverageFor(persisted),
  });
});

app.get('/api/fixture', (c) => c.json({ data: studioToDocPage(seedPage), page: seedPage }));

app.post('/api/publish', async (c) => {
  const stored = store.latest(ACTIVE_CARTRIDGE_ID);
  const page: StudioPageData =
    stored && isStudioPageData(stored.data) ? stored.data : seedPage;
  const docPageData = studioToDocPage(page);
  try {
    const result = await publishCartridge({
      cartridge: ACTIVE_CARTRIDGE,
      instances: [{ data: docPageData }],
      outputDir: PUBLISH_DIR,
    });
    return c.json({
      ok: true,
      outputDir: result.outputDir,
      pages: result.pages,
      files: result.files,
      warnings: result.warnings,
      revisionId: stored?.revisionId ?? 0,
      elapsedMs: result.completedAt - result.startedAt,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // eslint-disable-next-line no-console
    console.error('[studio-lite] publish failed', e);
    return c.json({ ok: false, error: message }, 500);
  }
});

// Static serving of published artifacts for in-browser preview.
app.get('/publish/llms.txt', (c) =>
  servePublishFile(c, 'llms.txt', 'text/plain; charset=utf-8'),
);
app.get('/publish/sitemap.xml', (c) =>
  servePublishFile(c, 'sitemap.xml', 'application/xml; charset=utf-8'),
);
app.get('/publish/robots.txt', (c) =>
  servePublishFile(c, 'robots.txt', 'text/plain; charset=utf-8'),
);
app.get('/publish/:slug', (c) => c.redirect(`/publish/${c.req.param('slug')}/`));
app.get('/publish/:slug/', (c) =>
  servePublishFile(c, `${c.req.param('slug')}/index.html`, 'text/html; charset=utf-8'),
);

app.get('/healthz', (c) =>
  c.json({
    ok: true,
    cartridgeId: ACTIVE_CARTRIDGE_ID,
    revisions: store.countByCartridge(ACTIVE_CARTRIDGE_ID),
  }),
);

// ───────────────────────── helpers ──────────────────────────────────

interface StateResponse {
  cartridgeId: string;
  revisionId: number;
  page: StudioPageData;
  renderedBodyHtml: string;
  coverage: AdapterCoverageRow[];
  createdAt: number;
  seeded: boolean;
}

async function buildStateResponse(): Promise<StateResponse> {
  const stored = store.latest(ACTIVE_CARTRIDGE_ID);
  if (stored && isStudioPageData(stored.data)) {
    const page = stored.data;
    return {
      cartridgeId: stored.cartridgeId,
      revisionId: stored.revisionId,
      page,
      renderedBodyHtml: renderMarkdownBodyHtml(page.body),
      coverage: await coverageFor(page),
      createdAt: stored.createdAt,
      seeded: false,
    };
  }
  return {
    cartridgeId: ACTIVE_CARTRIDGE_ID,
    revisionId: 0,
    page: seedPage,
    renderedBodyHtml: renderMarkdownBodyHtml(seedPage.body),
    coverage: await coverageFor(seedPage),
    createdAt: 0,
    seeded: true,
  };
}

async function coverageFor(page: StudioPageData): Promise<AdapterCoverageRow[]> {
  return analyzeAdapterCoverage(ACTIVE_CARTRIDGE, studioToDocPage(page));
}

async function servePublishFile(
  c: Context,
  relPath: string,
  contentType: string,
): Promise<Response> {
  try {
    const body = await readFile(resolve(PUBLISH_DIR, relPath), 'utf8');
    return c.body(body, 200, {
      'content-type': contentType,
      'cache-control': 'no-store',
    });
  } catch {
    return c.text(
      `Not published yet. Click "Publish" in the studio (or POST /api/publish) to generate this file.`,
      404,
      { 'content-type': 'text/plain; charset=utf-8' },
    );
  }
}

// ─────────────────────────── boot ────────────────────────────────────

const port = Number(process.env.PORT ?? 3000);
const hostname = '127.0.0.1';

serve({ fetch: app.fetch, port, hostname }, ({ address, port: actualPort }) => {
  const revisions = store.countByCartridge(ACTIVE_CARTRIDGE_ID);
  // eslint-disable-next-line no-console
  console.info(
    `studio-lite serving on http://${address}:${actualPort} (db: ${DB_PATH}, revisions: ${revisions})`,
  );
});
