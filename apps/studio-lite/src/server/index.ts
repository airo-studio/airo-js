/**
 * studio-lite Hono server (Lane D, slice 0).
 *
 * Minimal static server + the /api/fixture endpoint the bootstrap fetches
 * to seed the doc-page cartridge. /api/save / /api/preview / /api/score /
 * /api/app-config + SQLite + the in-process MCP server land in subsequent
 * slices of Lane D.
 *
 * Bind: 127.0.0.1 only — per the design doc's hard v0 constraint. Random
 * port + Origin check come with Lane D slice 1.
 */

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sampleDocPageData } from '@airo-js/doc-cartridges';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, '..', '..');
const PUBLIC_DIR = resolve(APP_ROOT, 'public');

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

app.get('/api/fixture', (c) => c.json({ data: sampleDocPageData }));

app.get('/healthz', (c) => c.json({ ok: true }));

const port = Number(process.env.PORT ?? 3000);
const hostname = '127.0.0.1';

serve({ fetch: app.fetch, port, hostname }, ({ address, port: actualPort }) => {
  // eslint-disable-next-line no-console
  console.info(`studio-lite serving on http://${address}:${actualPort}`);
});
