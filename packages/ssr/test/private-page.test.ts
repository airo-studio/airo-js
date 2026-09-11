/**
 * Private pages on the SSR path (0.11.0).
 *
 * A page carrying `Page.private: true` is never published: no adapter runs
 * and nothing is inlined. It renders as HTML only when the host asserts
 * `renderPrivate: true`; otherwise it is refused with
 * `skipped: { reason: 'private' }`. Page-private is checked BEFORE the
 * view's `csr-only` capability and refusal wins.
 *
 * Covers the five-row decision table in `render-with-publication.ts`, the
 * "adapters never invoked" guarantee (a throwing `generate`), `fellBack`
 * threading, the default-entry-private case, and the `gates` report
 * (`pending` / `satisfied`) on public and private entries.
 */

import { describe, expect, test } from 'vitest';

import type { AppConfig, PageRenderer } from '@airo-js/core';
import type {
  Cartridge,
  Gate,
  PublicationAdapter,
  PublicationContext,
} from '@airo-js/cartridge-kit';

import { renderAppWithPublication } from '../src/render-with-publication.js';

interface D {
  marker: string;
  member?: { name: string };
}
interface C {
  locale?: string;
}

function ssrRenderer(label: string): PageRenderer {
  return {
    render() {},
    renderSSR(container, ctx) {
      container.innerHTML = `<div data-marker="${label}" data-page="${ctx.page.id}">${label}</div>`;
    },
    destroy() {},
  };
}

/** An adapter that must never run for a private entry — it throws if it does. */
function bombAdapter(): PublicationAdapter<D, unknown, C> & { runs: number } {
  const adapter = {
    id: 'json-ld',
    displayName: 'JSON-LD',
    description: 'Would publish whatever the snapshot holds.',
    format: 'json-ld' as const,
    delivery: 'inline-in-host' as const,
    requires: [],
    refreshCadence: { min: { ms: 0 }, max: { ms: 1000 } },
    runs: 0,
    async generate(data: D) {
      adapter.runs += 1;
      return { '@type': 'Thing', name: data.marker, member: data.member ?? null };
    },
    validate() {
      return { valid: true, errors: [], warnings: [] };
    },
  };
  return adapter;
}

function gate(id: string, appliesTo?: 'all' | 'private', enabled = true): Gate<C> {
  return {
    id,
    displayName: id,
    ...(appliesTo ? { appliesTo } : {}),
    isEnabled: () => enabled,
    async mount() {
      return 'block';
    },
    destroy() {},
  };
}

// The default renderer resolver keys a global chunk mailbox on this name;
// unique per fixture so tests stay hermetic regardless of order.
let mailboxCounter = 0;

function buildCartridge(opts: {
  membersCsrOnly?: boolean;
  adapter?: PublicationAdapter<D, unknown, C>;
  gates?: Gate<C>[];
} = {}): Cartridge<D, C> {
  return {
    id: 'private-test',
    mailboxName: `__AIRO_PRIVATE_PAGE_TEST_${mailboxCounter++}__`,
    industry: 'test',
    displayName: 'Private page test',
    description: 'fixture',
    version: '0.0.0',
    schema: {
      parse: (input) => input as D,
      safeParse: (input) => ({ success: true as const, data: input as D }),
    },
    dataSources: [],
    views: [
      { id: 'home-view', displayName: 'Home', pageType: 'home', factory: () => ssrRenderer('home') },
      {
        id: 'members-view',
        displayName: 'Members',
        pageType: 'members',
        factory: () => ssrRenderer('members'),
        ...(opts.membersCsrOnly ? { capabilities: ['csr-only' as const] } : {}),
      },
    ],
    templates: [],
    defaultConfig: {},
    defaultTemplateId: 'main',
    ...(opts.adapter ? { publicationAdapters: [opts.adapter] } : {}),
    ...(opts.gates ? { gates: opts.gates } : {}),
  };
}

const layout = { regionOrder: [], regions: {} };
const mixedGraph: AppConfig = {
  appId: 'app',
  pages: [
    { id: 'home', type: 'home', enabled: true, layout },
    { id: 'members', type: 'members', enabled: true, layout, private: true },
  ],
};
const publicationCtx: PublicationContext<C> = { config: {}, locale: 'en', country: 'GB' };
const snapshot: D = { marker: 'x', member: { name: 'Demo' } };

async function render(
  cartridge: Cartridge<D, C>,
  extra: {
    page?: string;
    renderPrivate?: boolean | { satisfiedGates: string[] };
    appConfig?: AppConfig;
  } = {},
) {
  return renderAppWithPublication<D, C>({
    cartridge,
    appConfig: extra.appConfig ?? mixedGraph,
    snapshot,
    publicationCtx,
    document: globalThis.document,
    ...(extra.page ? { initialNavState: { page: extra.page } } : {}),
    ...(extra.renderPrivate !== undefined ? { renderPrivate: extra.renderPrivate } : {}),
  });
}

describe('the gates report when no entry page resolves', () => {
  test('every enabled gate is pending — the client fails closed and runs them all, so the host is told so', async () => {
    const noEntry: AppConfig = {
      appId: 'app',
      pages: [{ id: 'home', type: 'home', enabled: false, layout }],
    };
    const result = await render(
      buildCartridge({ gates: [gate('age'), gate('login', 'private'), gate('off', 'all', false)] }),
      { appConfig: noEntry },
    );
    expect(result.html).toBe('');
    expect(result.gates).toEqual({ pending: ['age', 'login'], satisfied: [] });
  });
});

describe('renderPrivate names what the host verified', () => {
  const gates = () => [gate('age'), gate('login', 'private'), gate('paywall', 'private')];

  test('`true` is shorthand for every private-scoped gate', async () => {
    const result = await render(buildCartridge({ gates: gates() }), { page: 'members', renderPrivate: true });
    expect(result.html).toContain('data-marker="members"');
    expect(result.gates).toEqual({ pending: ['age'], satisfied: ['login', 'paywall'] });
  });

  test('the object form satisfies exactly the named gates; the rest stay pending', async () => {
    const result = await render(buildCartridge({ gates: gates() }), {
      page: 'members',
      renderPrivate: { satisfiedGates: ['login'] },
    });
    expect(result.html).toContain('data-marker="members"');
    expect(result.gates).toEqual({ pending: ['age', 'paywall'], satisfied: ['login'] });
  });

  test('a list naming only a public-scoped gate, or unknown ids, is not an unlock', async () => {
    for (const satisfiedGates of [['age'], ['nope'], ['age', 'nope']]) {
      const result = await render(buildCartridge({ gates: gates() }), {
        page: 'members',
        renderPrivate: { satisfiedGates },
      });
      expect(result.html).toBe('');
      expect(result.skipped?.reason).toBe('private');
      // The private-scoped gates stay pending for the client; only an
      // applicable public-scoped gate the host named is echoed.
      expect(result.gates.pending).toEqual(expect.arrayContaining(['login', 'paywall']));
      expect(result.gates.satisfied).not.toContain('login');
      expect(result.gates.satisfied).not.toContain('paywall');
    }
  });

  test('an empty list is not an unlock: `{ satisfiedGates: [] }` refuses like `false`', async () => {
    const result = await render(buildCartridge({ gates: gates() }), {
      page: 'members',
      renderPrivate: { satisfiedGates: [] },
    });
    expect(result.html).toBe('');
    expect(result.skipped?.reason).toBe('private');
    expect(result.gates).toEqual({ pending: ['age', 'login', 'paywall'], satisfied: [] });
  });

  test('the object form unlocks the private render like `true` does, and is echoed only for gates that apply', async () => {
    // On a public entry the private-scoped gates are not selected, so a
    // named 'login' is ignored; a named 'age' (applies to all) is honoured.
    const result = await render(buildCartridge({ gates: gates() }), {
      page: 'home',
      renderPrivate: { satisfiedGates: ['login', 'age'] },
    });
    expect(result.html).toContain('data-marker="home"');
    expect(result.gates).toEqual({ pending: [], satisfied: ['age'] });
  });
});

describe('renderAppWithPublication — private pages: the decision table', () => {
  test('public entry, public view → adapters run, widget html', async () => {
    const adapter = bombAdapter();
    const result = await render(buildCartridge({ adapter }), { page: 'home' });
    expect(adapter.runs).toBe(1);
    expect(result.html).toContain('data-marker="home"');
    expect(result.html).toContain('application/ld+json');
    expect(result.skipped).toBeUndefined();
  });

  test('private entry, no renderPrivate → refused: no adapter run, empty html, reason private', async () => {
    const adapter = bombAdapter();
    const result = await render(buildCartridge({ adapter }), { page: 'members' });
    expect(adapter.runs).toBe(0);
    expect(result).toMatchObject({
      html: '',
      adapterResults: [],
      skipped: { pageType: 'members', reason: 'private' },
    });
    // Nothing was substituted, so this is a 401 for the host — never a fallback.
    expect(result.fellBack).toBeUndefined();
  });

  test('private entry, renderPrivate → widget html only; adapters still never run', async () => {
    const adapter = bombAdapter();
    const result = await render(buildCartridge({ adapter }), { page: 'members', renderPrivate: true });
    expect(adapter.runs).toBe(0);
    expect(result.adapterResults).toEqual([]);
    expect(result.html).toContain('data-marker="members"');
    expect(result.html).not.toContain('application/ld+json');
    expect(result.skipped).toBeUndefined();
  });

  test('private entry, renderPrivate, csr-only view → skipped csr-only with nothing inlined', async () => {
    const adapter = bombAdapter();
    const result = await render(buildCartridge({ adapter, membersCsrOnly: true }), {
      page: 'members',
      renderPrivate: true,
    });
    expect(adapter.runs).toBe(0);
    expect(result).toMatchObject({
      html: '',
      adapterResults: [],
      skipped: { pageType: 'members', reason: 'csr-only' },
    });
  });

  test('private entry, no renderPrivate, csr-only view → private wins over csr-only', async () => {
    // The csr-only branch inlines JSON-LD for public pages. A private page
    // must never take that branch anonymously.
    const adapter = bombAdapter();
    const result = await render(buildCartridge({ adapter, membersCsrOnly: true }), { page: 'members' });
    expect(adapter.runs).toBe(0);
    expect(result.skipped).toEqual({ pageType: 'members', reason: 'private' });
    expect(result.html).toBe('');
  });

  test('renderPrivate on a public entry changes nothing', async () => {
    const adapter = bombAdapter();
    const result = await render(buildCartridge({ adapter }), { page: 'home', renderPrivate: true });
    expect(adapter.runs).toBe(1);
    expect(result.html).toContain('data-marker="home"');
    expect(result.skipped).toBeUndefined();
  });
});

describe('renderAppWithPublication — private pages: entry resolution', () => {
  test('a private page absent from the graph → fellBack unknown-page and the public entry renders', async () => {
    const publicOnly: AppConfig = { appId: 'app', pages: [mixedGraph.pages[0]!] };
    const result = await render(buildCartridge(), { page: 'members', appConfig: publicOnly });
    expect(result.fellBack).toEqual({ requested: 'members', reason: 'unknown-page' });
    expect(result.html).toContain('data-marker="home"');
    expect(result.skipped).toBeUndefined();
  });

  test('a site whose default entry is private → refused anonymously, rendered with renderPrivate', async () => {
    const privateFirst: AppConfig = {
      appId: 'app',
      pages: [mixedGraph.pages[1]!, mixedGraph.pages[0]!],
    };
    const anon = await render(buildCartridge(), { appConfig: privateFirst });
    expect(anon.skipped).toEqual({ pageType: 'members', reason: 'private' });
    expect(anon.fellBack).toBeUndefined();

    const signedIn = await render(buildCartridge(), { appConfig: privateFirst, renderPrivate: true });
    expect(signedIn.html).toContain('data-marker="members"');
  });

  test('the refusal still threads fellBack when the requested id was rejected onto a private default', async () => {
    const privateFirst: AppConfig = {
      appId: 'app',
      pages: [mixedGraph.pages[1]!, mixedGraph.pages[0]!],
    };
    const result = await render(buildCartridge(), { appConfig: privateFirst, page: 'nope' });
    expect(result.skipped).toEqual({ pageType: 'members', reason: 'private' });
    expect(result.fellBack).toEqual({ requested: 'nope', reason: 'unknown-page' });
  });
});

describe('renderAppWithPublication — the gates report', () => {
  const gates = [gate('age'), gate('login', 'private'), gate('off', 'all', false)];

  test('no gates → both lists empty', async () => {
    const result = await render(buildCartridge(), { page: 'home' });
    expect(result.gates).toEqual({ pending: [], satisfied: [] });
  });

  test('public entry → pending lists enabled all-gates; private-scoped gates are not pending', async () => {
    const result = await render(buildCartridge({ gates }), { page: 'home' });
    expect(result.gates).toEqual({ pending: ['age'], satisfied: [] });
  });

  test('private entry, refused → pending lists every enabled gate the client will run', async () => {
    const result = await render(buildCartridge({ gates }), { page: 'members' });
    expect(result.gates).toEqual({ pending: ['age', 'login'], satisfied: [] });
  });

  test('private entry, renderPrivate → the private-scoped gate is satisfied, the age gate still pending', async () => {
    const result = await render(buildCartridge({ gates }), { page: 'members', renderPrivate: true });
    expect(result.gates).toEqual({ pending: ['age'], satisfied: ['login'] });
  });

  test('csr-only skip on a public entry still carries the report', async () => {
    const result = await render(buildCartridge({ gates, membersCsrOnly: true }), { page: 'home' });
    expect(result.gates).toEqual({ pending: ['age'], satisfied: [] });
  });
});
