/**
 * studio-lite Hono server.
 *
 * Lane D slice 1 (this commit): SQLite-backed persistence.
 *   - GET  /api/state        latest persisted state OR seed if no save yet
 *   - POST /api/save         persist + return new monotonic revision_id
 *   - GET  /api/fixture      seed fixture (read-only — diagnostic / "reset")
 *   - GET  /healthz          ok + cartridge_state count
 *
 * Bind: 127.0.0.1 only — design doc's hard v0 constraint. Random port +
 * Origin check land in slice 2 with the in-process MCP server.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { serve } from '@hono/node-server';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Cartridge } from '@airo-js/cartridge-kit';
import { docPageCartridge, sampleDocPageData } from '@airo-js/doc-cartridges';

import { CartridgeStateStore } from './db.js';
import { publishCartridge } from './publish.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, '..', '..');
const PUBLIC_DIR = resolve(APP_ROOT, 'public');
const DB_PATH = resolve(APP_ROOT, '.studio-data', 'db.sqlite');
const PUBLISH_DIR = resolve(APP_ROOT, 'dist-publish');

const store = new CartridgeStateStore(DB_PATH);

// Active cartridge instance the studio is authoring against. Hardcoded to
// doc-page at v0; multi-cartridge selection arrives with the chrome bar's
// cartridge dropdown later.
const ACTIVE_CARTRIDGE: Cartridge = docPageCartridge as unknown as Cartridge;

// Cartridge identity is hardcoded at v0 — single-cartridge studio. Multi-
// cartridge selection arrives once the cartridge selector lands in the
// chrome bar (slice 4).
const ACTIVE_CARTRIDGE_ID = 'doc-page';

const app = new Hono();

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

// ───────────────────── API ──────────────────────────────────────────

app.get('/api/state', (c) => {
  const state = store.latest(ACTIVE_CARTRIDGE_ID);
  if (state) {
    return c.json({
      cartridgeId: state.cartridgeId,
      revisionId: state.revisionId,
      data: state.data,
      createdAt: state.createdAt,
      seeded: false,
    });
  }
  // No save yet — return seed at revision 0. First save bumps to revision 1.
  return c.json({
    cartridgeId: ACTIVE_CARTRIDGE_ID,
    revisionId: 0,
    data: sampleDocPageData,
    createdAt: 0,
    seeded: true,
  });
});

app.post('/api/save', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be JSON.' }, 400);
  }
  if (!isObject(body) || typeof body.cartridgeId !== 'string' || body.data === undefined) {
    return c.json({ error: 'Body shape: { cartridgeId: string, data: unknown }.' }, 400);
  }
  if (body.cartridgeId !== ACTIVE_CARTRIDGE_ID) {
    return c.json(
      { error: `cartridgeId must be '${ACTIVE_CARTRIDGE_ID}' at v0.` },
      400,
    );
  }
  const state = store.save(body.cartridgeId, body.data);
  return c.json({
    cartridgeId: state.cartridgeId,
    revisionId: state.revisionId,
    createdAt: state.createdAt,
  });
});

app.get('/api/fixture', (c) => c.json({ data: sampleDocPageData }));

app.post('/api/publish', async (c) => {
  const state = store.latest(ACTIVE_CARTRIDGE_ID);
  const data = state ? state.data : sampleDocPageData;
  try {
    const result = await publishCartridge({
      cartridge: ACTIVE_CARTRIDGE,
      instances: [{ data }],
      outputDir: PUBLISH_DIR,
    });
    return c.json({
      ok: true,
      outputDir: result.outputDir,
      pages: result.pages,
      files: result.files,
      warnings: result.warnings,
      revisionId: state?.revisionId ?? 0,
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
app.get('/publish/:slug', (c) => {
  const slug = c.req.param('slug');
  return c.redirect(`/publish/${slug}/`);
});
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

// ─────────────────────── boot ────────────────────────────────────────

const port = Number(process.env.PORT ?? 3000);
const hostname = '127.0.0.1';

serve({ fetch: app.fetch, port, hostname }, ({ address, port: actualPort }) => {
  const revisions = store.countByCartridge(ACTIVE_CARTRIDGE_ID);
  // eslint-disable-next-line no-console
  console.info(
    `studio-lite serving on http://${address}:${actualPort} (db: ${DB_PATH}, revisions: ${revisions})`,
  );
});

// ─────────────────────── helpers ─────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
