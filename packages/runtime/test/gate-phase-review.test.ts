/**
 * The gate phase after the 0.11.0 pre-landing review — one test per fix.
 *
 * A blocking gate's `destroy()` runs at teardown and before a remount
 * re-runs the phase; a gate-blocked remount forces the NEXT update to
 * remount rather than hot-swap into a destroyed App; the gate sees the
 * mount's `navState`; transformers see the resolved entry page, not the
 * template's first page; a broken graph resolves `data-airo-gate` instead
 * of leaving it pending; in-app navigation into a private page does not
 * re-run an entry-scoped gate; `private` is a structural page key; and the
 * hydrate snapshot is not taken when no gate can paint.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Gate, GateContext } from '@airo-js/cartridge-kit';
import { resetLogLevels, setLogLevel } from '@airo-js/log';

import { mountCartridge } from '../src/mount-cartridge.js';
import {
  type TestConfig,
  type TestData,
  fakeCartridge,
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
  vi.restoreAllMocks();
});

describe("a blocking gate's destroy()", () => {
  test('runs when the host tears the blocked mount down, once', async () => {
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
    result.destroy();
    expect(record).toEqual(['login:precheck', 'login:mount', 'login:destroy']);
    result.destroy();
    expect(record.filter((r) => r === 'login:destroy')).toHaveLength(1);
  });

  test('a gate-blocked remount: the next update() remounts (never hot-swaps into the destroyed App) and destroys the blocker first', async () => {
    const record: string[] = [];
    let prechecks = 0;
    // allow → block → allow: the middle remount is the one the gate stops.
    const age: Gate<TestConfig> = {
      id: 'age',
      displayName: 'Age',
      isEnabled: () => true,
      async precheck() {
        prechecks += 1;
        record.push('precheck');
        return prechecks === 2 ? 'gate-required' : 'allow';
      },
      async mount(h) {
        record.push('mount');
        h.innerHTML = '<div class="gate-age">verify</div>';
        return 'block';
      },
      destroy() {
        record.push('destroy');
      },
    };
    const result = await mountCartridge({
      cartridge: fakeCartridge({ gates: [age], hotSwapKeys: ['theme'] }),
      config: {},
      template: fakeTemplate(),
      host,
      preloadedData: { items: [] },
    });
    if (result.blocked) throw new Error('expected an unblocked initial mount');

    // `locale` is not a hot-swap key → remount → the gate blocks. The gate
    // paints into the render root (shadow by default), so query that.
    await expect(result.update({ locale: 'fr' })).rejects.toThrow(/blocked by gate "age"/);
    expect(record).toEqual(['precheck', 'precheck', 'mount']);
    expect(result.shell.renderRoot.querySelector('.gate-age')).not.toBeNull();

    // `theme` IS a hot-swap key. Before the fix this hot-swapped into the
    // destroyed App and resolved `{ mode: 'hot-swap' }` with the gate panel
    // still on screen. It must remount, re-running the gate — and the
    // blocker's destroy() runs before the phase does.
    const outcome = await result.update({ theme: { primary: 'red' } });
    expect(outcome.mode).toBe('remount');
    expect(record).toEqual(['precheck', 'precheck', 'mount', 'destroy', 'precheck']);
    expect(result.shell.renderRoot.querySelector('.gate-age')).toBeNull();
  });
});

describe('what the gate and the transformers are told', () => {
  test("the gate's ctx carries the mount's navState — the page it is scoped against", async () => {
    let seen: GateContext<TestConfig> | undefined;
    const probe: Gate<TestConfig> = {
      ...loginGate([], { decision: 'allow' }),
      async precheck(ctx) {
        seen = ctx;
        return 'allow';
      },
    };
    await mountCartridge({
      cartridge: mixedCartridge({ gates: [probe] }),
      config: {},
      template: privateTemplate(),
      host,
      preloadedData: { items: [] },
      initialNavState: { page: 'members' },
    });
    expect(seen?.navState?.page).toBe('members');
  });

  test("transformers see the resolved entry page as navState.page, not the template's first page", async () => {
    const seen: string[] = [];
    const cartridge = mixedCartridge({
      transformers: [
        {
          name: 'records-page',
          isEnabled: () => true,
          transform: (d: TestData, ctx) => {
            seen.push(ctx.navState.page);
            return d;
          },
        },
      ],
    });
    await mountCartridge({
      cartridge,
      config: {},
      template: privateTemplate(),
      host,
      preloadedData: { items: [] },
      initialNavState: { page: 'members' },
    });
    expect(seen).toEqual(['members']);
  });
});

describe('graph and navigation edges', () => {
  test('a graph with no enabled entry page resolves data-airo-gate="pending" to "error" instead of leaving it stuck', async () => {
    host.setAttribute('data-airo-gate', 'pending');
    const template = { ...fakeTemplate(), pages: [{ id: 'home', type: 'home', enabled: false }] };
    await expect(
      mountCartridge({ cartridge: fakeCartridge(), config: {}, template, host, preloadedData: { items: [] } }),
    ).rejects.toThrow(/no enabled entry page/);
    expect(host.getAttribute('data-airo-gate')).toBe('error');
  });

  test('in-app navigation into a private page does not re-run an entry-scoped gate', async () => {
    const record: string[] = [];
    const result = await mountCartridge({
      cartridge: mixedCartridge({ gates: [loginGate(record)] }),
      config: {},
      template: privateTemplate(),
      host,
      preloadedData: { items: [] },
    });
    if (result.blocked) throw new Error('expected an unblocked mount on the public entry');
    expect(record).toEqual([]);

    result.app.navigate({ page: 'members' });

    expect(result.app.getNavigationState().page).toBe('members');
    expect(record).toEqual([]);
  });

  test("'private' is a structural page key: flipping it forces a remount even when listed in pageHotSwapKeys", async () => {
    const record: string[] = [];
    const cartridge = mixedCartridge({ gates: [loginGate(record)], pageHotSwapKeys: ['private'] });
    const result = await mountCartridge({
      cartridge,
      config: {},
      template: privateTemplate(),
      host,
      preloadedData: { items: [] },
    });
    if (result.blocked) throw new Error('expected an unblocked mount on the public entry');
    expect(record).toEqual([]);

    // The entry page becomes private → the private-scoped gate now applies
    // → a remount runs it → it blocks. A hot-swap would have run nothing.
    const flipped = privateTemplate().pages.map((p) => (p.id === 'home' ? { ...p, private: true } : p));
    await expect(result.updatePages(flipped)).rejects.toThrow(/blocked by gate "login"/);
    expect(record).toEqual(['login:precheck', 'login:mount']);
  });
});

describe('the URL changing during the gate phase', () => {
  test('is narrated: the gates ran for one page, the URL now names another', async () => {
    setLogLevel('debug');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      window.location.hash = '#/home';
      // A gate that flips the URL to the private page while it is open,
      // then allows — the gates were scoped against `home`.
      const flipper: Gate<TestConfig> = {
        id: 'flipper',
        displayName: 'Flipper',
        isEnabled: () => true,
        async precheck() {
          return 'gate-required';
        },
        async mount() {
          window.location.hash = '#/members';
          return 'allow';
        },
        destroy() {},
      };
      await mountCartridge({
        cartridge: mixedCartridge({ gates: [flipper] }),
        config: {},
        template: privateTemplate(),
        host,
        preloadedData: { items: [] },
        enableRouter: { mode: 'hash' },
      });
      const narrated = warn.mock.calls.some((c) =>
        c.some((arg) => typeof arg === 'string' && arg.includes('the URL changed during the gate phase')),
      );
      expect(narrated).toBe(true);
    } finally {
      warn.mockRestore();
      resetLogLevels();
      window.location.hash = '';
    }
  });
});

describe('the hydrate snapshot is taken only when a gate could paint', () => {
  /** Count reads of `innerHTML` on the render root during a mount. */
  async function readsDuring(mount: () => Promise<unknown>): Promise<number> {
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
    if (!desc?.get) throw new Error('innerHTML is not an accessor on Element.prototype in this DOM');
    const original = desc.get;
    let reads = 0;
    const spy = vi.spyOn(Element.prototype, 'innerHTML', 'get').mockImplementation(function (this: Element) {
      if (this === host) reads += 1;
      return original.call(this);
    });
    try {
      await mount();
    } finally {
      spy.mockRestore();
    }
    return reads;
  }

  test('no gate → the render root is never serialised; a painting gate → it is snapshotted and compared', async () => {
    const withoutGates = await readsDuring(() => {
      host.innerHTML = '<div data-ssr="products">products</div>';
      return mountCartridge({
        cartridge: fakeCartridge({
          views: [{ id: 'home-view', displayName: 'Home', pageType: 'home', factory: () => recordingRenderer([]) }],
        }),
        config: {},
        template: fakeTemplate(),
        host,
        mode: 'hydrate',
        styleIsolation: 'light',
        preloadedData: { items: [] },
      });
    });

    host.remove();
    host = document.createElement('div');
    document.body.appendChild(host);

    const withGate = await readsDuring(() => {
      host.innerHTML = '<div data-ssr="products">products</div>';
      return mountCartridge({
        cartridge: fakeCartridge({
          gates: [paintingGate('age')],
          views: [{ id: 'home-view', displayName: 'Home', pageType: 'home', factory: () => recordingRenderer([]) }],
        }),
        config: {},
        template: fakeTemplate(),
        host,
        mode: 'hydrate',
        styleIsolation: 'light',
        preloadedData: { items: [] },
      });
    });

    expect(withoutGates).toBe(0);
    expect(withGate).toBeGreaterThanOrEqual(2);
    // And the restore still happened: the server's markup is back.
    expect(host.querySelector('[data-ssr="products"]')).not.toBeNull();
  });
});
