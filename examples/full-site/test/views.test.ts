/**
 * The private views, the members DataSource and the transformer, under
 * happy-dom with `fetch` mocked.
 *
 * `gate.test.ts` covers the gate around a private mount. This file covers
 * what renders INSIDE one: the two private views' signed-out state (an
 * in-app navigation into a private page never re-runs the gate, so the view
 * paints the panel itself), the note view's not-found and article states,
 * the `?slug=` the members source asks the API for, the anchor ids the
 * transformer gives a member note, and two edges of the gate's own panel —
 * `next` carrying the query string, and retry copy that does not stick.
 *
 * @vitest-environment happy-dom
 * @vitest-environment-options { "url": "http://localhost:4317/members" }
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mountCartridge } from '@airo-js/runtime';

import { docSiteCartridge, docSiteTemplate, type DocSiteConfig, type DocSiteData } from '../src/cartridge.js';
import { SITE } from '../src/content.js';
import { DEMO_USER, findNote } from '../src/members-content.js';

const config: DocSiteConfig = { locale: 'en-GB', siteUrl: SITE.url, siteName: SITE.name };
const publicSnapshot = (): DocSiteData => ({ site: SITE, index: [] });

type Route = { status: number; body?: unknown } | Error;

/** Route `fetch` by pathname; record every url (path + query) asked for. */
function mockFetch(routes: Record<string, Route>): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = new URL(String(input), 'http://localhost:4317');
      calls.push(url.pathname + url.search);
      const route = routes[url.pathname];
      if (!route) throw new Error(`unrouted ${url.pathname}`);
      if (route instanceof Error) throw route;
      return new Response(route.body === undefined ? null : JSON.stringify(route.body), {
        status: route.status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return { calls };
}

let host: HTMLElement;

beforeEach(() => {
  host = document.createElement('div');
  host.id = 'app';
  document.body.appendChild(host);
});

afterEach(() => {
  host.remove();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/members');
});

/** A private mount the server already satisfied, with whatever snapshot the test hands it. */
function mountPrivate(page: 'members' | 'note', data: DocSiteData, slug?: string) {
  return mountCartridge<DocSiteData, DocSiteConfig>({
    cartridge: docSiteCartridge,
    config,
    template: docSiteTemplate,
    host,
    mode: 'csr',
    styleIsolation: 'light',
    initialNavState: { page, ...(slug ? { slug } : {}) },
    preloadedData: data,
    satisfiedGates: ['login'],
  });
}

describe('the private views without a member slice', () => {
  test('both paint the sign-in panel themselves, linking back to the page asked for, and ask nothing', async () => {
    const { calls } = mockFetch({});
    const result = await mountPrivate('members', publicSnapshot());
    expect(result.blocked).toBe(false);
    expect(calls).toEqual([]);
    expect(host.querySelector('.fs-signin')).not.toBeNull();
    expect(host.querySelector('a.fs-signin__button')?.getAttribute('href')).toBe('/auth/login?next=%2Fmembers');
    expect(host.querySelector('.fs-signout')).toBeNull();

    host.remove();
    host = document.createElement('div');
    document.body.appendChild(host);
    await mountPrivate('note', publicSnapshot(), 'roadmap');
    expect(host.querySelector('a.fs-signin__button')?.getAttribute('href')).toBe(
      '/auth/login?next=%2Fnote%2Froadmap',
    );
    expect(calls).toEqual([]);
  });
});

describe('the note view with a member slice', () => {
  test('an unknown note → "Not found.", never the panel', async () => {
    mockFetch({});
    await mountPrivate('note', { ...publicSnapshot(), member: { user: DEMO_USER, notes: [] } }, 'nope');
    expect(host.querySelector('.fs-empty')?.textContent).toBe('Not found.');
    expect(host.querySelector('.fs-signin')).toBeNull();
  });

  test('a known note → the article, back link to /members, anchors filled by the transformer', async () => {
    mockFetch({});
    const note = findNote('roadmap');
    await mountPrivate('note', { ...publicSnapshot(), member: { user: DEMO_USER, notes: [], note } }, 'roadmap');
    expect(host.querySelector('h1.fs-title')?.textContent).toBe('What ships next');
    expect(host.querySelector('a.fs-back')?.getAttribute('href')).toBe('/members');
    expect(host.querySelector('a.fs-back')?.textContent).toContain('members');
    // The anchor a reader clicks is the id the transformer minted from the title.
    expect(host.querySelector('.fs-toc a[href="#the-freeze"]')).not.toBeNull();
    expect(host.querySelector('section#after-the-freeze')).not.toBeNull();
  });
});

describe('the members DataSource', () => {
  test('asks /api/members/me with ?slug= for a custom input, and without one otherwise', async () => {
    const { calls } = mockFetch({ '/api/members/me': { status: 200, body: publicSnapshot() } });
    const members = docSiteCartridge.dataSources.find((s) => s.id === 'members');
    if (!members) throw new Error('members source missing');

    await members.fetch({ kind: 'custom', payload: { slug: 'release checklist' } }, { config });
    await members.fetch({ kind: 'custom', payload: {} }, { config });
    await members.fetch({ kind: 'url', url: 'ignored' }, { config });

    expect(calls).toEqual([
      '/api/members/me?slug=release%20checklist',
      '/api/members/me',
      '/api/members/me',
    ]);
  });
});

describe('the anchor-ids transformer', () => {
  const ctx = { config, navState: { page: '' }, locale: config.locale };

  test('fills a member note\'s section ids from their titles and leaves filled ids alone', async () => {
    const [anchorIds] = docSiteCartridge.transformers ?? [];
    if (!anchorIds) throw new Error('transformer missing');
    const note = findNote('roadmap');
    if (!note) throw new Error('fixture note missing');
    const withOneId = { ...note, sections: [{ ...note.sections[0]!, id: 'kept' }, note.sections[1]!] };

    const out = await anchorIds.transform(
      { ...publicSnapshot(), member: { user: DEMO_USER, notes: [], note: withOneId } },
      ctx,
    );

    expect(out.member?.note?.sections.map((s) => s.id)).toEqual(['kept', 'after-the-freeze']);
    // Pure: the input note was not mutated.
    expect(withOneId.sections[1]?.id).toBe('');
  });
});

describe('the sign-in gate\'s panel', () => {
  function mountMembersViaApi(extra: { satisfiedGates?: string[] } = {}) {
    return mountCartridge<DocSiteData, DocSiteConfig>({
      cartridge: docSiteCartridge,
      config,
      template: docSiteTemplate,
      host,
      mode: 'csr',
      styleIsolation: 'light',
      initialNavState: { page: 'members' },
      dataSourceId: 'members',
      dataSourceInput: { kind: 'custom', payload: {} },
      ...extra,
    });
  }

  test('next carries the query string, so the round trip lands on the same view state', async () => {
    mockFetch({ '/auth/session': { status: 401 } });
    window.history.replaceState(null, '', '/members?tab=notes');
    const result = await mountMembersViaApi();
    expect(result.blocked).toBe(true);
    expect(host.querySelector('a.fs-signin__button')?.getAttribute('href')).toBe(
      '/auth/login?next=%2Fmembers%3Ftab%3Dnotes',
    );
  });

  test('retry copy from a failed precheck does not stick to the next mount', async () => {
    mockFetch({ '/auth/session': new Error('offline') });
    await mountMembersViaApi();
    expect(host.querySelector('.fs-signin__error')).not.toBeNull();

    host.remove();
    host = document.createElement('div');
    document.body.appendChild(host);
    vi.unstubAllGlobals();
    mockFetch({ '/auth/session': { status: 401 } });
    await mountMembersViaApi();
    expect(host.querySelector('.fs-signin')).not.toBeNull();
    expect(host.querySelector('.fs-signin__error')).toBeNull();
  });
});
