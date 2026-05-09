import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { EventBus } from '@airo-js/core';

import { mountCartridge } from '../src/mount-cartridge.js';
import {
  blockingGate,
  fakeCartridge,
  fakeDataSource,
  fakeTemplate,
  failingTransformer,
  recordingRenderer,
} from './fixtures.js';

let host: HTMLElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  host.remove();
});

describe('mountCartridge', () => {
  test('happy path: no gates + preloadedData → blocked: false, app handle returned', async () => {
    const result = await mountCartridge({
      cartridge: fakeCartridge(),
      config: {},
      template: fakeTemplate(),
      host,
      preloadedData: { items: ['preloaded'] },
    });

    expect(result.blocked).toBe(false);
    if (result.blocked) throw new Error('expected unblocked branch');
    expect(result.app).toBeDefined();
    expect(result.app.state).toBe('mounted');
    expect(result.shell.rootId).toMatch(/^airo-/);
  });

  test('gate that returns block → blocked: true, blockedBy: <gate.id>', async () => {
    const gate = blockingGate('age-gate');
    const result = await mountCartridge({
      cartridge: fakeCartridge({ gates: [gate] }),
      config: {},
      template: fakeTemplate(),
      host,
      preloadedData: { items: [] },
    });

    expect(result.blocked).toBe(true);
    if (!result.blocked) throw new Error('expected blocked branch');
    expect(result.blockedBy).toBe('age-gate');
    expect(result.app).toBeNull();
  });

  test("dataSource.fetch throws → onError('fetch', ...) fires + mount throws", async () => {
    const onError = vi.fn();
    const fetchErr = new Error('boom');
    const cartridge = fakeCartridge({
      dataSources: [
        fakeDataSource({
          fetch: async () => {
            throw fetchErr;
          },
        }),
      ],
    });

    await expect(
      mountCartridge({
        cartridge,
        config: { feed: { url: 'https://example.com/feed' } },
        template: fakeTemplate(),
        host,
        onError,
      }),
    ).rejects.toThrow('boom');

    expect(onError).toHaveBeenCalledTimes(1);
    const [phase, err, shell] = onError.mock.calls[0];
    expect(phase).toBe('fetch');
    expect(err).toBe(fetchErr);
    expect(shell).not.toBeNull();
  });

  test("transformer with errorPolicy='fail-render' throws → onError('pipeline', ...) fires + mount throws", async () => {
    const onError = vi.fn();
    const cartridge = fakeCartridge({
      transformers: [failingTransformer('fail-render')],
    });

    await expect(
      mountCartridge({
        cartridge,
        config: {},
        template: fakeTemplate(),
        host,
        preloadedData: { items: [] },
        onError,
      }),
    ).rejects.toThrow('transformer-blew-up');

    expect(onError).toHaveBeenCalledTimes(1);
    const [phase, , shell] = onError.mock.calls[0];
    expect(phase).toBe('pipeline');
    expect(shell).not.toBeNull();
  });

  test('preloadedData skips dataSource.fetch entirely', async () => {
    const fetchSpy = vi.fn(async () => ({ items: ['from-fetch'] }));
    const cartridge = fakeCartridge({
      dataSources: [fakeDataSource({ fetch: fetchSpy })],
    });

    const result = await mountCartridge({
      cartridge,
      config: {},
      template: fakeTemplate(),
      host,
      preloadedData: { items: ['preloaded'] },
    });

    expect(result.blocked).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('onShellReady fires once, before gates run', async () => {
    const order: string[] = [];
    const gate = {
      id: 'order-probe',
      displayName: 'Order Probe',
      isEnabled: () => true,
      async precheck() {
        order.push('gate-precheck');
        return 'allow' as const;
      },
      async mount() {
        order.push('gate-mount');
        return 'allow' as const;
      },
      destroy() {
        // no-op
      },
    };

    await mountCartridge({
      cartridge: fakeCartridge({ gates: [gate] }),
      config: {},
      template: fakeTemplate(),
      host,
      preloadedData: { items: [] },
      onShellReady: () => {
        order.push('shell-ready');
      },
    });

    expect(order[0]).toBe('shell-ready');
    expect(order.filter((s) => s === 'shell-ready')).toHaveLength(1);
    expect(order.indexOf('shell-ready')).toBeLessThan(order.indexOf('gate-precheck'));
  });

  test('destroy() tears down the App and clears renderRoot when isolated', async () => {
    const result = await mountCartridge({
      cartridge: fakeCartridge(),
      config: {},
      template: fakeTemplate(),
      host,
      preloadedData: { items: [] },
      styleIsolation: 'partial',
    });

    if (result.blocked) throw new Error('expected unblocked branch');
    expect(result.app.state).toBe('mounted');

    const renderRootBefore = result.shell.renderRoot;
    result.destroy();

    expect(result.app.state).toBe('destroyed');
    expect(renderRootBefore.innerHTML).toBe('');
  });

  test("mode: 'hydrate' preserves SSR HTML inside the shadow wrapper and drives renderer.hydrate()", async () => {
    const lifecycle: string[] = [];
    const cartridge = fakeCartridge({
      views: [
        {
          id: 'home-view',
          displayName: 'Home',
          pageType: 'home',
          factory: () => recordingRenderer(lifecycle),
        },
      ],
    });

    // Customer page state — SSR HTML in the host before mountCartridge runs.
    host.innerHTML = '<div data-ssr="true">server-rendered content</div>';

    const result = await mountCartridge({
      cartridge,
      config: {},
      template: fakeTemplate(),
      host,
      preloadedData: { items: [] },
      styleIsolation: 'partial',
      mode: 'hydrate',
    });

    if (result.blocked) throw new Error('expected unblocked branch');
    expect(lifecycle).toContain('hydrate');
    expect(lifecycle).not.toContain('render');
    expect(result.shell.renderRoot.innerHTML).toContain('server-rendered content');
  });

  test("default mode 'csr' drives renderer.render() (no hydrate call)", async () => {
    const lifecycle: string[] = [];
    const cartridge = fakeCartridge({
      views: [
        {
          id: 'home-view',
          displayName: 'Home',
          pageType: 'home',
          factory: () => recordingRenderer(lifecycle),
        },
      ],
    });

    const result = await mountCartridge({
      cartridge,
      config: {},
      template: fakeTemplate(),
      host,
      preloadedData: { items: [] },
    });

    if (result.blocked) throw new Error('expected unblocked branch');
    expect(lifecycle).toContain('render');
    expect(lifecycle).not.toContain('hydrate');
  });

  test('host-supplied events bus is threaded through (not replaced)', async () => {
    const events = new EventBus();
    const result = await mountCartridge({
      cartridge: fakeCartridge(),
      config: {},
      template: fakeTemplate(),
      host,
      preloadedData: { items: [] },
      events,
    });

    if (result.blocked) throw new Error('expected unblocked branch');
    expect(result.shell.events).toBe(events);
    expect(result.app.events).toBe(events);
  });
});
