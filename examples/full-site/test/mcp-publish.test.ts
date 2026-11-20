/**
 * `/mcp/call` honours the publish decision.
 *
 * The page route, `sitemap.xml`, `llms.txt` and `/microdata/:slug` all treat
 * an unpublished document (the crawler-surface adapter blocks it: no
 * `updatedAt`, so no canonical) as a 404. `/mcp/call` used to build a
 * snapshot for any slug and dispatch against it, so an agent could read the
 * body of a page the site itself says does not exist.
 *
 * @vitest-environment node
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

let server: Server;
let BASE = '';

beforeAll(async () => {
  const port = await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, () => {
      const { port: p } = probe.address() as AddressInfo;
      probe.close(() => resolve(p));
    });
  });
  process.env.PORT = String(port);
  const { app } = await import('../src/server.js');
  server = app.listen(port);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  BASE = `http://localhost:${port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const call = (body: unknown) =>
  fetch(`${BASE}/mcp/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('/mcp/call and the publish decision', () => {
  test('the page route itself 404s the draft (the premise)', async () => {
    expect((await fetch(`${BASE}/doc/unfinished-draft`)).status).toBe(404);
  });

  test('get_section on the unpublished draft is a 404, not its body', async () => {
    const res = await call({ name: 'get_section', arguments: { id: 'todo' }, slug: 'unfinished-draft' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: { code: 'not-found', message: 'no such page' } });
  });

  test('an unknown slug is the same 404', async () => {
    const res = await call({ name: 'get_section', arguments: { id: 'x' }, slug: 'nope' });
    expect(res.status).toBe(404);
  });

  test('list_pages omits the unpublished draft', async () => {
    const res = await call({ name: 'list_pages', arguments: {} });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; result: { pages: Array<{ url: string }> } };
    const urls = body.result.pages.map((p) => p.url);
    expect(urls.some((u) => u.endsWith('/doc/why-snapshots'))).toBe(true);
    expect(urls.some((u) => u.includes('unfinished-draft'))).toBe(false);
  });

  test('the home page links every published doc and not the draft, a url that 404s', async () => {
    const html = await (await fetch(`${BASE}/`)).text();
    expect(html).toContain('/doc/why-snapshots');
    expect(html).not.toContain('unfinished-draft');
  });

  test('a published slug still answers', async () => {
    const res = await call({ name: 'get_section', arguments: { id: 'the-drift-problem' }, slug: 'why-snapshots' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; result: { title?: string } };
    expect(body.ok).toBe(true);
    expect(body.result.title).toBe('The drift problem');
  });
});
