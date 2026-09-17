/**
 * Transformers see the page the url names, on the server as in the browser.
 *
 * The runtime hands every transformer `{ ...entry.navState, page:
 * entry.page.id }` for the page the mount starts on (`resolveMountEntry`).
 * Until 0.11.1 this server passed `{ page: '' }` to every transformer on
 * every route. Nothing broke only because `anchorIds` ignores `navState`;
 * the first transformer that shapes data per page would have produced
 * server markup the client's data disagreed with.
 *
 * A recording transformer is appended to the browser cartridge (which the
 * server half spreads), and each route is asked what it passed.
 *
 * @vitest-environment node
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

const { seen } = vi.hoisted(() => ({ seen: [] as Array<Record<string, unknown>> }));

vi.mock('../src/cartridge.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/cartridge.js')>();
  return {
    ...mod,
    docSiteCartridge: {
      ...mod.docSiteCartridge,
      transformers: [
        ...(mod.docSiteCartridge.transformers ?? []),
        {
          name: 'record-nav-state',
          isEnabled: () => true,
          transform: (data: unknown, ctx: { navState: Record<string, unknown> }) => {
            seen.push({ ...ctx.navState });
            return data;
          },
        },
      ],
    },
  };
});

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

beforeEach(() => {
  seen.length = 0;
});

describe('the navigation state server-side transformers receive', () => {
  test('the index: the entry page', async () => {
    expect((await fetch(`${BASE}/`)).status).toBe(200);
    expect(seen).toEqual([expect.objectContaining({ page: 'home' })]);
  });

  test('a document: its page and its slug', async () => {
    expect((await fetch(`${BASE}/doc/why-snapshots`)).status).toBe(200);
    expect(seen).toEqual([expect.objectContaining({ page: 'doc', slug: 'why-snapshots' })]);
  });

  test('an unknown url: the page the runtime would fall back to, never an empty id', async () => {
    expect((await fetch(`${BASE}/does-not-exist`)).status).toBe(404);
    expect(seen.map((s) => s.page)).toEqual(['home']);
  });

  test('machine routes name the page each snapshot is for', async () => {
    await fetch(`${BASE}/sitemap.xml`);
    const pages = seen.map((s) => `${s.page}:${s.slug ?? ''}`);
    expect(pages).toContain('home:');
    expect(pages).toContain('doc:why-snapshots');
    expect(seen.every((s) => s.page === 'home' || s.page === 'doc')).toBe(true);
  });

  test('an agent call about a document names that document', async () => {
    await fetch(`${BASE}/mcp/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'list_pages', slug: 'why-snapshots' }),
    });
    expect(seen).toEqual([expect.objectContaining({ page: 'doc', slug: 'why-snapshots' })]);
  });

  test('no route ever passes an empty page id', async () => {
    for (const path of ['/', '/doc/why-snapshots', '/doc/unfinished-draft', '/members', '/llms.txt']) {
      await fetch(BASE + path);
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((s) => !s.page)).toEqual([]);
  });
});
