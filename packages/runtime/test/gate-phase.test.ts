/**
 * The runtime's gate phase (0.11.0): gates run BEFORE the data fetch, are
 * scoped to the resolved entry page, honour the host's server-verified
 * hand-off, restore SSR markup after a painting gate allows, resolve the
 * no-paint attribute on every exit, and are re-run — never remembered —
 * on remounts.
 *
 * Covers: no fetch / pipeline / onPipelineComplete on a blocked mount;
 * onError('gate') for a throwing precheck; `appliesTo: 'private'` against
 * a public entry, a private entry named by initialNavState, and a private
 * entry named only by the URL under path and hash routers (the ladder the
 * gate phase must share with PageManager); `satisfiedGates` on the initial
 * mount and NOT on the same handle's remount; the CRITICAL regression that
 * a remount blocked by a gate throws; `data-airo-gate` on all five exits
 * and untouched when absent; hydrate restore after a painting gate.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { EventBus } from '@airo-js/core';
import type { Gate, GateContext } from '@airo-js/cartridge-kit';

import { mountCartridge } from '../src/mount-cartridge.js';
import {
  type TestConfig,
  fakeCartridge,
  fakeDataSource,
  fakeTemplate,
  loginGate,
  mixedCartridge,
  paintingGate,
  privateTemplate,
  recordingRenderer,
} from './fixtures.js';

let host: HTMLElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  host.remove();
  window.history.replaceState(null, '', '/');
  window.location.hash = '';
});

const feed = { kind: 'url' as const, url: 'https://example.com/feed' };

describe('gates run before the data fetch', () => {
  test('a blocked mount never fetches, never runs transformers, never fires onPipelineComplete', async () => {
    const record: string[] = [];
    const fetchSpy = vi.fn(async () => ({ items: ['fetched'] }));
    const transform = vi.fn((d: { items: string[] }) => d);
    const onPipelineComplete = vi.fn();
    const cartridge = mixedCartridge({
      gates: [loginGate(record)],
      dataSources: [fakeDataSource({ fetch: fetchSpy })],
      transformers: [{ name: 't', isEnabled: () => true, transform }],
    });

    const result = await mountCartridge({
      cartridge,
      config: {},
      template: privateTemplate(),
      host,
      dataSourceInput: feed,
      initialNavState: { page: 'members' },
      onPipelineComplete,
    });

    expect(result.blocked).toBe(true);
    if (!result.blocked) throw new Error('expected blocked');
    expect(result.blockedBy).toBe('login');
    expect(record).toEqual(['login:precheck', 'login:mount']);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(transform).not.toHaveBeenCalled();
    expect(onPipelineComplete).not.toHaveBeenCalled();
    // Default isolation is shadow: the gate painted into the render root.
    expect(result.shell.renderRoot.querySelector('.gate-login')).not.toBeNull();
  });

  test("a throwing precheck reports onError('gate') and rethrows", async () => {
    const onError = vi.fn();
    const boom = new Error('token verify failed');
    const cartridge = fakeCartridge({
      gates: [
        {
          id: 'login',
          displayName: 'Login',
          isEnabled: () => true,
          async precheck() {
            throw boom;
          },
          async mount() {
            return 'allow';
          },
          destroy() {},
        },
      ],
    });

    await expect(
      mountCartridge({ cartridge, config: {}, template: fakeTemplate(), host, preloadedData: { items: [] }, onError }),
    ).rejects.toThrow('token verify failed');
    expect(onError).toHaveBeenCalledTimes(1);
    const [phase, err, shell] = onError.mock.calls[0];
    expect(phase).toBe('gate');
    expect(err).toBe(boom);
    expect(shell).not.toBeNull();
  });
});

describe("appliesTo: 'private' is scoped to the resolved entry page", () => {
  test('public entry → the private gate is skipped without precheck, mount or narration', async () => {
    const record: string[] = [];
    const events = new EventBus();
    const narrated: string[] = [];
    events.on('gate:precheck', () => narrated.push('precheck'));
    events.on('gate:allowed', () => narrated.push('allowed'));

    const result = await mountCartridge({
      cartridge: mixedCartridge({ gates: [loginGate(record)] }),
      config: {},
      template: privateTemplate(),
      host,
      preloadedData: { items: [] },
      events,
    });

    expect(result.blocked).toBe(false);
    expect(record).toEqual([]);
    expect(narrated).toEqual([]);
  });

  test('private entry named by initialNavState → the private gate runs', async () => {
    const record: string[] = [];
    const result = await mountCartridge({
      cartridge: mixedCartridge({ gates: [loginGate(record)] }),
      config: {},
      template: privateTemplate(),
      host,
      preloadedData: { items: [] },
      initialNavState: { page: 'members' },
    });
    expect(result.blocked).toBe(true);
    expect(record).toEqual(['login:precheck', 'login:mount']);
  });

  test('private entry named only by the URL under a path router → the private gate runs (no initialNavState)', async () => {
    window.history.replaceState(null, '', '/members');
    const record: string[] = [];
    const result = await mountCartridge({
      cartridge: mixedCartridge({ gates: [loginGate(record)] }),
      config: {},
      template: privateTemplate(),
      host,
      preloadedData: { items: [] },
      enableRouter: { mode: 'path', basePath: '/' },
    });
    expect(result.blocked).toBe(true);
    if (!result.blocked) throw new Error('expected blocked');
    expect(result.blockedBy).toBe('login');
  });

  test('the URL outranks initialNavState for gate scoping, as it does for PageManager', async () => {
    window.history.replaceState(null, '', '/home');
    const record: string[] = [];
    const result = await mountCartridge({
      cartridge: mixedCartridge({ gates: [loginGate(record)] }),
      config: {},
      template: privateTemplate(),
      host,
      preloadedData: { items: [] },
      enableRouter: { mode: 'path', basePath: '/' },
      initialNavState: { page: 'members' },
    });
    expect(result.blocked).toBe(false);
    expect(record).toEqual([]);
  });

  test('private entry named only by the hash → the private gate runs', async () => {
    window.location.hash = '#/members';
    const record: string[] = [];
    const result = await mountCartridge({
      cartridge: mixedCartridge({ gates: [loginGate(record)] }),
      config: {},
      template: privateTemplate(),
      host,
      preloadedData: { items: [] },
      enableRouter: { mode: 'hash' },
    });
    expect(result.blocked).toBe(true);
  });

  test("an 'all' gate still runs on a public entry", async () => {
    const record: string[] = [];
    const gate = { ...loginGate(record, { id: 'age', verdict: 'allow' }), appliesTo: 'all' as const };
    const result = await mountCartridge({
      cartridge: mixedCartridge({ gates: [gate] }),
      config: {},
      template: privateTemplate(),
      host,
      preloadedData: { items: [] },
    });
    expect(result.blocked).toBe(false);
    expect(record).toEqual(['age:precheck', 'age:mount', 'age:destroy']);
  });
});

describe('satisfiedGates — the server-verified hand-off', () => {
  test('skips the named gate on the initial mount and narrates via: server', async () => {
    const record: string[] = [];
    const events = new EventBus();
    const allowed: unknown[] = [];
    events.on('gate:allowed', (payload: unknown) => allowed.push(payload));

    const result = await mountCartridge({
      cartridge: mixedCartridge({ gates: [loginGate(record)] }),
      config: {},
      template: privateTemplate(),
      host,
      preloadedData: { items: [] },
      initialNavState: { page: 'members' },
      satisfiedGates: ['login'],
      events,
    });

    expect(result.blocked).toBe(false);
    expect(record).toEqual([]);
    expect(allowed).toEqual([{ gateId: 'login', via: 'server' }]);
  });

  test("the same handle's update() remount re-runs the gate — freshness wins", async () => {
    const record: string[] = [];
    const result = await mountCartridge({
      cartridge: mixedCartridge({ gates: [loginGate(record, { decision: 'allow' })] }),
      config: {},
      template: privateTemplate(),
      host,
      preloadedData: { items: [] },
      initialNavState: { page: 'members' },
      satisfiedGates: ['login'],
    });
    expect(result.blocked).toBe(false);
    if (result.blocked) throw new Error('expected unblocked');
    expect(record).toEqual([]);

    // No hotSwapKeys declared → any delta remounts.
    await result.update({ locale: 'fr' });
    expect(record).toEqual(['login:precheck']);
  });

  test('an id naming no applicable gate is ignored', async () => {
    const record: string[] = [];
    const result = await mountCartridge({
      cartridge: mixedCartridge({ gates: [loginGate(record)] }),
      config: {},
      template: privateTemplate(),
      host,
      preloadedData: { items: [] },
      initialNavState: { page: 'members' },
      satisfiedGates: ['nope'],
    });
    expect(result.blocked).toBe(true);
    expect(record).toEqual(['login:precheck', 'login:mount']);
  });
});

describe('CRITICAL regression — a remount blocked by a gate throws the documented error', () => {
  function flipFlopGate(record: string[]) {
    let mounts = 0;
    return {
      id: 'login',
      displayName: 'Login',
      isEnabled: () => true,
      async precheck() {
        record.push('precheck');
        mounts += 1;
        return mounts === 1 ? ('allow' as const) : ('gate-required' as const);
      },
      async mount(h: HTMLElement) {
        h.innerHTML = '<div class="gate-login">sign in</div>';
        return 'block' as const;
      },
      destroy() {},
    };
  }

  test('update()', async () => {
    const record: string[] = [];
    const result = await mountCartridge({
      cartridge: fakeCartridge({ gates: [flipFlopGate(record)] }),
      config: {},
      template: fakeTemplate(),
      host,
      preloadedData: { items: [] },
    });
    if (result.blocked) throw new Error('expected unblocked');
    await expect(result.update({ locale: 'fr' })).rejects.toThrow(/blocked by gate "login"/);
    expect(record).toEqual(['precheck', 'precheck']);
    expect(result.app.state).toBe('destroyed');
  });

  test('updatePages()', async () => {
    const record: string[] = [];
    const result = await mountCartridge({
      cartridge: fakeCartridge({ gates: [flipFlopGate(record)] }),
      config: {},
      template: fakeTemplate(),
      host,
      preloadedData: { items: [] },
    });
    if (result.blocked) throw new Error('expected unblocked');
    // A structural change (a new page) always remounts.
    await expect(
      result.updatePages([
        { id: 'home', type: 'home', enabled: true },
        { id: 'extra', type: 'home', enabled: true },
      ]),
    ).rejects.toThrow(/blocked by gate "login"/);
  });
});

describe('data-airo-gate — the no-paint attribute', () => {
  const mountWith = (gates: ReturnType<typeof loginGate>[], extra: Record<string, unknown> = {}) =>
    mountCartridge({
      cartridge: mixedCartridge({ gates }),
      config: {},
      template: privateTemplate(),
      host,
      preloadedData: { items: [] },
      ...extra,
    });

  test('absent → never written', async () => {
    await mountWith([loginGate([], { verdict: 'allow' })], { initialNavState: { page: 'members' } });
    expect(host.hasAttribute('data-airo-gate')).toBe(false);
  });

  test('zero applicable gates → passed before the data phase', async () => {
    host.setAttribute('data-airo-gate', 'pending');
    await mountWith([loginGate([])]); // public entry: the private gate does not apply
    expect(host.getAttribute('data-airo-gate')).toBe('passed');
  });

  test('all allow → passed', async () => {
    host.setAttribute('data-airo-gate', 'pending');
    await mountWith([loginGate([], { decision: 'allow' })], { initialNavState: { page: 'members' } });
    expect(host.getAttribute('data-airo-gate')).toBe('passed');
  });

  test('block → blocked', async () => {
    host.setAttribute('data-airo-gate', 'pending');
    await mountWith([loginGate([])], { initialNavState: { page: 'members' } });
    expect(host.getAttribute('data-airo-gate')).toBe('blocked');
  });

  test('throw → error', async () => {
    host.setAttribute('data-airo-gate', 'pending');
    const throwing = {
      ...loginGate([]),
      async precheck() {
        throw new Error('boom');
      },
    };
    await expect(mountWith([throwing], { initialNavState: { page: 'members' } })).rejects.toThrow('boom');
    expect(host.getAttribute('data-airo-gate')).toBe('error');
  });
});

describe('the gate context and the entry sanity check', () => {
  test('gateScope, the mount config and the shared bus reach the gate as its ctx', async () => {
    const events = new EventBus();
    let seen: { scope?: unknown; config?: unknown; events?: unknown } = {};
    const probe: Gate<TestConfig> = {
      ...loginGate([], { decision: 'allow' }),
      async precheck(ctx: GateContext<TestConfig>) {
        seen = { scope: ctx.scope, config: ctx.config, events: ctx.events };
        return 'allow';
      },
    };

    const result = await mountCartridge({
      cartridge: mixedCartridge({ gates: [probe] }),
      config: { locale: 'fr' },
      template: privateTemplate(),
      host,
      preloadedData: { items: [] },
      initialNavState: { page: 'members' },
      gateScope: { user_id: 'u1', country: 'GB' },
      events,
    });

    expect(result.blocked).toBe(false);
    expect(seen.scope).toEqual({ user_id: 'u1', country: 'GB' });
    expect(seen.config).toEqual({ locale: 'fr' });
    expect(seen.events).toBe(events);
  });

  test("a template with no enabled entry page reports onError('mount') and throws BEFORE any gate runs", async () => {
    // The sanity check moved ahead of the gate phase in 0.11.0 so a broken
    // graph fails before a gate paints. `appliesTo: 'private'` fails closed
    // on an unresolved entry, so this gate WOULD run if the check came later.
    const record: string[] = [];
    const onError = vi.fn();
    const template = { ...fakeTemplate(), pages: [{ id: 'home', type: 'home', enabled: false }] };

    await expect(
      mountCartridge({
        cartridge: fakeCartridge({ gates: [loginGate(record)] }),
        config: {},
        template,
        host,
        preloadedData: { items: [] },
        onError,
      }),
    ).rejects.toThrow(/no enabled entry page/);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBe('mount');
    expect(record).toEqual([]);
    expect(host.hasAttribute('data-airo-gate')).toBe(false);
  });
});

describe('hydrate + a painting gate', () => {
  test('a gate that paints then allows → the SSR markup is restored and hydrate() sees it', async () => {
    host.innerHTML = '<div data-ssr="products">products</div>';
    const record: string[] = [];
    let seen = '';
    const cartridge = fakeCartridge({
      gates: [paintingGate('age', 'allow')],
      views: [
        {
          id: 'home-view',
          displayName: 'Home',
          pageType: 'home',
          factory: () => ({
            ...recordingRenderer(record),
            hydrate(root: HTMLElement) {
              record.push('hydrate');
              seen = root.innerHTML;
            },
          }),
        },
      ],
    });

    const result = await mountCartridge({
      cartridge,
      config: {},
      template: fakeTemplate(),
      host,
      preloadedData: { items: [] },
      mode: 'hydrate',
      styleIsolation: 'light',
    });

    expect(result.blocked).toBe(false);
    expect(record).toContain('hydrate');
    expect(seen).toContain('data-ssr="products"');
    expect(seen).not.toContain('gate-age');
  });

  test('a gate that paints then blocks → its paint stays', async () => {
    host.innerHTML = '<div data-ssr="products">products</div>';
    const result = await mountCartridge({
      cartridge: fakeCartridge({ gates: [paintingGate('age', 'block')] }),
      config: {},
      template: fakeTemplate(),
      host,
      preloadedData: { items: [] },
      mode: 'hydrate',
      styleIsolation: 'light',
    });
    expect(result.blocked).toBe(true);
    expect(host.querySelector('.gate-age')).not.toBeNull();
    expect(host.querySelector('[data-ssr]')).toBeNull();
  });
});
