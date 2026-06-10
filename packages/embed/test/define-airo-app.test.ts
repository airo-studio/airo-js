import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { EventBus, pushToMailbox } from '@airo-js/core';

import { defineAiroApp } from '../src/define-airo-app.js';
import {
  fakeCartridge,
  recordingRenderer,
  uniqueElementName,
  waitFor,
} from './fixtures.js';

let host: HTMLElement;
let consoleError: ReturnType<typeof vi.spyOn>;
let consoleWarn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  host.remove();
  consoleError.mockRestore();
  consoleWarn.mockRestore();
});

/** Mount a fresh `<elementName airo-id="...">` under `host`. */
function mountElement(elementName: string, attrs: Record<string, string>): HTMLElement {
  const el = document.createElement(elementName);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v);
  }
  host.appendChild(el);
  return el;
}

describe('defineAiroApp', () => {
  test('happy path: element mounts, onMounted fires', async () => {
    const elementName = uniqueElementName();
    const onMounted = vi.fn();
    const cartridge = fakeCartridge();

    defineAiroApp({
      elementName,
      loadConfig: async (id) => ({
        config: {},
        cartridgeId: 'fake',
        templateId: 'main',
        preloadedData: { items: [] },
      }),
      resolveCartridge: async () => cartridge,
      onMounted,
    });

    mountElement(elementName, { 'airo-id': 'wgt_123' });

    await waitFor(() => onMounted.mock.calls.length > 0);
    expect(onMounted).toHaveBeenCalledTimes(1);
    expect(onMounted.mock.calls[0][0]).toBe('wgt_123');
  });

  test('missing id attribute → console.error; no mount attempted', async () => {
    const elementName = uniqueElementName();
    const loadConfig = vi.fn();

    defineAiroApp({
      elementName,
      loadConfig,
      resolveCartridge: async () => fakeCartridge(),
    });

    mountElement(elementName, {});
    // Give the connectedCallback a chance to bail.
    await new Promise((r) => setTimeout(r, 10));

    expect(loadConfig).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
  });

  test("loadConfig throws → onError('load-config', err, host) fires; no resolveCartridge call", async () => {
    const elementName = uniqueElementName();
    const onError = vi.fn();
    const resolveCartridge = vi.fn(async () => fakeCartridge());

    defineAiroApp({
      elementName,
      loadConfig: async () => {
        throw new Error('backend down');
      },
      resolveCartridge,
      onError,
    });

    mountElement(elementName, { 'airo-id': 'wgt_x' });
    await waitFor(() => onError.mock.calls.length > 0);

    const [phase, err] = onError.mock.calls[0];
    expect(phase).toBe('load-config');
    expect((err as Error).message).toBe('backend down');
    expect(resolveCartridge).not.toHaveBeenCalled();
  });

  test("resolveCartridge throws → onError('resolve-cartridge', ...) fires", async () => {
    const elementName = uniqueElementName();
    const onError = vi.fn();

    defineAiroApp({
      elementName,
      loadConfig: async () => ({
        config: {},
        cartridgeId: 'unknown',
        templateId: 'main',
        preloadedData: { items: [] },
      }),
      resolveCartridge: async () => {
        throw new Error('no such cartridge');
      },
      onError,
    });

    mountElement(elementName, { 'airo-id': 'wgt_x' });
    await waitFor(() => onError.mock.calls.length > 0);

    expect(onError.mock.calls[0][0]).toBe('resolve-cartridge');
  });

  test('fetchSsrHtml throws → falls through to CSR; mount still succeeds', async () => {
    const elementName = uniqueElementName();
    const onError = vi.fn();
    const onMounted = vi.fn();

    defineAiroApp({
      elementName,
      loadConfig: async () => ({
        config: {},
        cartridgeId: 'fake',
        templateId: 'main',
        preloadedData: { items: [] },
      }),
      resolveCartridge: async () => fakeCartridge(),
      fetchSsrHtml: async () => {
        throw new Error('ssr endpoint down');
      },
      onError,
      onMounted,
    });

    mountElement(elementName, { 'airo-id': 'wgt_y' });
    await waitFor(() => onMounted.mock.calls.length > 0);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBe('fetch-ssr');
    expect(onMounted).toHaveBeenCalledTimes(1);
  });

  test('ssrHtml from loadConfig → painted pre-mount, hydrate mode used', async () => {
    const elementName = uniqueElementName();
    const lifecycle: string[] = [];
    const onMounted = vi.fn();

    defineAiroApp({
      elementName,
      loadConfig: async () => ({
        config: {},
        cartridgeId: 'fake',
        templateId: 'main',
        preloadedData: { items: [] },
        styleIsolation: 'shadow',
        ssrHtml: '<div data-ssr="yes">server-rendered</div>',
      }),
      resolveCartridge: async () => fakeCartridge(lifecycle),
      onMounted,
    });

    const el = mountElement(elementName, { 'airo-id': 'wgt_ssr' });
    await waitFor(() => onMounted.mock.calls.length > 0);

    expect(lifecycle).toContain('hydrate');
    expect(lifecycle).not.toContain('render');
    // SSR HTML should be inside the shadow wrapper (preserved by mountCartridge).
    expect(el.shadowRoot?.innerHTML).toContain('server-rendered');
  });

  test('unknown templateId → onError("mount", ...) fires', async () => {
    const elementName = uniqueElementName();
    const onError = vi.fn();

    defineAiroApp({
      elementName,
      loadConfig: async () => ({
        config: {},
        cartridgeId: 'fake',
        templateId: 'does-not-exist',
        preloadedData: { items: [] },
      }),
      resolveCartridge: async () => fakeCartridge(),
      onError,
    });

    mountElement(elementName, { 'airo-id': 'wgt_x' });
    await waitFor(() => onError.mock.calls.length > 0);

    expect(onError.mock.calls[0][0]).toBe('mount');
    expect((onError.mock.calls[0][1] as Error).message).toContain("template 'does-not-exist'");
  });

  test('disconnect after mount → destroy is called', async () => {
    const elementName = uniqueElementName();
    const lifecycle: string[] = [];
    const onMounted = vi.fn();

    defineAiroApp({
      elementName,
      loadConfig: async () => ({
        config: {},
        cartridgeId: 'fake',
        templateId: 'main',
        preloadedData: { items: [] },
      }),
      resolveCartridge: async () => fakeCartridge(lifecycle),
      onMounted,
    });

    const el = mountElement(elementName, { 'airo-id': 'wgt_z' });
    await waitFor(() => onMounted.mock.calls.length > 0);

    el.remove();
    await waitFor(() => lifecycle.includes('destroy'));
    expect(lifecycle).toContain('destroy');
  });

  test('onShellReady fires before onMounted with a real ShellHandle', async () => {
    const elementName = uniqueElementName();
    const lifecycleOrder: string[] = [];
    const shellSeen: Array<{ hasRenderRoot: boolean; hasStyleRoot: boolean; hasEvents: boolean; hasRootId: boolean }> = [];
    const onMounted = vi.fn(() => lifecycleOrder.push('mounted'));

    defineAiroApp({
      elementName,
      loadConfig: async () => ({
        config: {},
        cartridgeId: 'fake',
        templateId: 'main',
        preloadedData: { items: [] },
      }),
      resolveCartridge: async () => fakeCartridge(),
      onShellReady: (shell) => {
        lifecycleOrder.push('shell-ready');
        shellSeen.push({
          hasRenderRoot: shell.renderRoot instanceof HTMLElement,
          hasStyleRoot: shell.styleRoot !== undefined,
          hasEvents: shell.events !== undefined && typeof shell.events.emit === 'function',
          hasRootId: typeof shell.rootId === 'string' && shell.rootId.length > 0,
        });
      },
      onMounted,
    });

    mountElement(elementName, { 'airo-id': 'wgt_shell' });
    await waitFor(() => onMounted.mock.calls.length > 0);

    expect(lifecycleOrder).toEqual(['shell-ready', 'mounted']);
    expect(shellSeen).toHaveLength(1);
    expect(shellSeen[0]).toEqual({
      hasRenderRoot: true,
      hasStyleRoot: true,
      hasEvents: true,
      hasRootId: true,
    });
  });

  test('declarative shadow root present → fetchSsrHtml skipped, DSD content preserved, hydrate mode forced', async () => {
    const elementName = uniqueElementName();
    const lifecycle: string[] = [];
    const onMounted = vi.fn();
    const fetchSsrHtml = vi.fn(async () => '<div data-from="endpoint">should-not-fetch</div>');

    defineAiroApp({
      elementName,
      loadConfig: async () => ({
        config: {},
        cartridgeId: 'fake',
        templateId: 'main',
        preloadedData: { items: [] },
        styleIsolation: 'shadow',
      }),
      resolveCartridge: async () => fakeCartridge(lifecycle),
      fetchSsrHtml,
      onMounted,
    });

    // Simulate Declarative Shadow DOM: attach a shadow root with SSR
    // content BEFORE appendChild triggers connectedCallback. Mirrors
    // what the browser does when parsing `<template shadowrootmode>`
    // — zero-FOUC path because shadow styles applied during initial
    // parse, not after a JS lift.
    const el = document.createElement(elementName);
    el.setAttribute('airo-id', 'wgt_dsd');
    const shadow = el.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<article data-dsd="yes">declarative-shadow-content</article>';
    // No airo-ssr attribute — DSD presence alone is the signal.
    host.appendChild(el);

    await waitFor(() => onMounted.mock.calls.length > 0);

    expect(fetchSsrHtml).not.toHaveBeenCalled();
    expect(lifecycle).toContain('hydrate');
    expect(lifecycle).not.toContain('render');
    // DSD content survives — embed didn't wipe innerHTML, runtime
    // adopted the existing shadow root.
    expect(el.shadowRoot?.innerHTML).toContain('declarative-shadow-content');
  });

  test('airo-ssr="hydrate" + pre-injected innerHTML → fetchSsrHtml skipped, markup preserved', async () => {
    const elementName = uniqueElementName();
    const lifecycle: string[] = [];
    const onMounted = vi.fn();
    const fetchSsrHtml = vi.fn(async () => '<div data-from="endpoint">should-not-fetch</div>');

    defineAiroApp({
      elementName,
      loadConfig: async () => ({
        config: {},
        cartridgeId: 'fake',
        templateId: 'main',
        preloadedData: { items: [] },
        styleIsolation: 'shadow',
      }),
      resolveCartridge: async () => fakeCartridge(lifecycle),
      fetchSsrHtml,
      onMounted,
    });

    // Pre-inject the SSR HTML AND set airo-ssr="hydrate" before
    // appendChild triggers connectedCallback. Mirrors the Campaign Page
    // flow where the host server already rendered the widget into the
    // element before the page shipped.
    const el = document.createElement(elementName);
    el.setAttribute('airo-id', 'wgt_host_ssr');
    el.setAttribute('airo-ssr', 'hydrate');
    el.innerHTML = '<div data-from="host">host-server-rendered</div>';
    host.appendChild(el);

    await waitFor(() => onMounted.mock.calls.length > 0);

    expect(fetchSsrHtml).not.toHaveBeenCalled();
    expect(lifecycle).toContain('hydrate');
    expect(lifecycle).not.toContain('render');
    // The original host markup survives inside the shadow wrapper.
    expect(el.shadowRoot?.innerHTML).toContain('host-server-rendered');
    expect(el.shadowRoot?.innerHTML).toContain('data-from="host"');
  });

  test('airo-ssr="hydrate" with empty innerHTML → falls back to fetchSsrHtml', async () => {
    const elementName = uniqueElementName();
    const onMounted = vi.fn();
    const fetchSsrHtml = vi.fn(async () => '<div data-from="endpoint">fetched</div>');

    defineAiroApp({
      elementName,
      loadConfig: async () => ({
        config: {},
        cartridgeId: 'fake',
        templateId: 'main',
        preloadedData: { items: [] },
      }),
      resolveCartridge: async () => fakeCartridge(),
      fetchSsrHtml,
      onMounted,
    });

    const el = document.createElement(elementName);
    el.setAttribute('airo-id', 'wgt_empty_hydrate');
    el.setAttribute('airo-ssr', 'hydrate');
    // Note: no innerHTML — the attribute alone shouldn't trigger the
    // host-injected branch; fetchSsrHtml should still run.
    host.appendChild(el);

    await waitFor(() => onMounted.mock.calls.length > 0);

    expect(fetchSsrHtml).toHaveBeenCalledTimes(1);
  });

  test('enableRouter hash mode → embed reads window.location.hash, forwards as navHint', async () => {
    const elementName = uniqueElementName();
    const fetchSsrHtml = vi.fn(async () => null);
    const onMounted = vi.fn();

    // Set the hash BEFORE the element mounts. embed.connectedCallback
    // reads window.location.hash and forwards as navHint.
    window.history.replaceState(null, '', '/some-page#products/abc');

    defineAiroApp({
      elementName,
      loadConfig: async () => ({
        config: {},
        cartridgeId: 'fake',
        templateId: 'main',
        preloadedData: { items: [] },
        enableRouter: { mode: 'hash' },
      }),
      resolveCartridge: async () => fakeCartridge(),
      fetchSsrHtml,
      onMounted,
    });

    mountElement(elementName, { 'airo-id': 'wgt_hash_nav' });
    await waitFor(() => onMounted.mock.calls.length > 0);

    expect(fetchSsrHtml).toHaveBeenCalledTimes(1);
    const [id, token, navHint] = fetchSsrHtml.mock.calls[0]!;
    expect(id).toBe('wgt_hash_nav');
    expect(token).toBeNull();
    expect(navHint).toBe('products/abc');

    // Cleanup — leave URL state in a clean spot for downstream tests.
    window.history.replaceState(null, '', '/');
  });

  test('enableRouter path mode → embed extracts path tail, forwards as navHint', async () => {
    const elementName = uniqueElementName();
    const fetchSsrHtml = vi.fn(async () => null);
    const onMounted = vi.fn();

    // Pre-fix the URL to the path-mode deeplink shape.
    window.history.replaceState(null, '', '/campaign/xyz/products/abc');

    defineAiroApp({
      elementName,
      loadConfig: async () => ({
        config: {},
        cartridgeId: 'fake',
        templateId: 'main',
        preloadedData: { items: [] },
        enableRouter: { mode: 'path', basePath: '/campaign/xyz' },
      }),
      resolveCartridge: async () => fakeCartridge(),
      fetchSsrHtml,
      onMounted,
    });

    mountElement(elementName, { 'airo-id': 'wgt_path_nav' });
    await waitFor(() => onMounted.mock.calls.length > 0);

    expect(fetchSsrHtml).toHaveBeenCalledTimes(1);
    expect(fetchSsrHtml.mock.calls[0]![2]).toBe('products/abc');

    window.history.replaceState(null, '', '/');
  });

  test('path mode + hash present → path wins; hash NOT forwarded (verification 3)', async () => {
    const elementName = uniqueElementName();
    const fetchSsrHtml = vi.fn(async () => null);
    const onMounted = vi.fn();

    // URL has BOTH a path route AND a trailing hash. Path is the
    // source of truth in path mode; hash is treated as a normal page
    // anchor — must NOT be forwarded as the navHint.
    window.history.replaceState(null, '', '/campaign/xyz/products/abc#some-anchor');

    defineAiroApp({
      elementName,
      loadConfig: async () => ({
        config: {},
        cartridgeId: 'fake',
        templateId: 'main',
        preloadedData: { items: [] },
        enableRouter: { mode: 'path', basePath: '/campaign/xyz' },
      }),
      resolveCartridge: async () => fakeCartridge(),
      fetchSsrHtml,
      onMounted,
    });

    mountElement(elementName, { 'airo-id': 'wgt_path_hash' });
    await waitFor(() => onMounted.mock.calls.length > 0);

    const navHint = fetchSsrHtml.mock.calls[0]![2];
    expect(navHint).toBe('products/abc');
    expect(navHint).not.toContain('some-anchor');

    window.history.replaceState(null, '', '/');
  });

  test('path mode + basePath mismatch → navHint is null (no thrown error)', async () => {
    const elementName = uniqueElementName();
    const fetchSsrHtml = vi.fn(async () => null);
    const onMounted = vi.fn();

    // URL doesn't match basePath at all. extractPathTail returns null;
    // navHint forwarded as null; embed continues without throwing.
    window.history.replaceState(null, '', '/totally/different/path');

    defineAiroApp({
      elementName,
      loadConfig: async () => ({
        config: {},
        cartridgeId: 'fake',
        templateId: 'main',
        preloadedData: { items: [] },
        enableRouter: { mode: 'path', basePath: '/campaign/xyz' },
      }),
      resolveCartridge: async () => fakeCartridge(),
      fetchSsrHtml,
      onMounted,
    });

    mountElement(elementName, { 'airo-id': 'wgt_path_miss' });
    await waitFor(() => onMounted.mock.calls.length > 0);

    expect(fetchSsrHtml.mock.calls[0]![2]).toBeNull();

    window.history.replaceState(null, '', '/');
  });

  test('no enableRouter → navHint is null (no router, no deeplinks)', async () => {
    const elementName = uniqueElementName();
    const fetchSsrHtml = vi.fn(async () => null);
    const onMounted = vi.fn();

    window.history.replaceState(null, '', '/some-page#products/abc');

    defineAiroApp({
      elementName,
      loadConfig: async () => ({
        config: {},
        cartridgeId: 'fake',
        templateId: 'main',
        preloadedData: { items: [] },
        // enableRouter omitted — no router configured
      }),
      resolveCartridge: async () => fakeCartridge(),
      fetchSsrHtml,
      onMounted,
    });

    mountElement(elementName, { 'airo-id': 'wgt_no_router' });
    await waitFor(() => onMounted.mock.calls.length > 0);

    // Hash is present in URL but no router → no navHint forwarded.
    expect(fetchSsrHtml.mock.calls[0]![2]).toBeNull();

    window.history.replaceState(null, '', '/');
  });

  test('pre-built `events` bus is threaded into the shell (host-app pre-wire)', async () => {
    const elementName = uniqueElementName();
    const onMounted = vi.fn();
    const sharedBus = new EventBus();
    let shellBus: unknown = null;

    defineAiroApp({
      elementName,
      events: sharedBus,
      loadConfig: async () => ({
        config: {},
        cartridgeId: 'fake',
        templateId: 'main',
        preloadedData: { items: [] },
      }),
      resolveCartridge: async () => fakeCartridge(),
      onShellReady: (shell) => {
        shellBus = shell.events;
      },
      onMounted,
    });

    mountElement(elementName, { 'airo-id': 'wgt_bus' });
    await waitFor(() => onMounted.mock.calls.length > 0);

    expect(shellBus).toBe(sharedBus);
  });

  test('element-name collision → second defineAiroApp call warns + no-ops', () => {
    const elementName = uniqueElementName();

    defineAiroApp({
      elementName,
      loadConfig: async () => {
        throw new Error('never called');
      },
      resolveCartridge: async () => fakeCartridge(),
    });
    defineAiroApp({
      elementName,
      loadConfig: async () => {
        throw new Error('never called');
      },
      resolveCartridge: async () => fakeCartridge(),
    });

    expect(consoleWarn).toHaveBeenCalledTimes(1);
    // Args from @airo-js/log's consoleSink: [tag, msg, data?]. Match across all args.
    const warnArgs = consoleWarn.mock.calls[0].map(String).join(' ');
    expect(warnArgs).toContain(elementName);
    expect(warnArgs).toContain('@airo-js/embed');
  });

  test('resolveView: missing renderer → host loads chunk → recovers via navigate', async () => {
    const elementName = uniqueElementName();
    const sink: string[] = [];
    // Cartridge whose template declares `home` but ships NO static renderer
    // for it — forces the chunked-client `renderer:missing` case. Unique id +
    // mailbox so the module-level chunk registry (keyed by cartridge.id)
    // doesn't share registrations with other tests.
    const base = fakeCartridge(sink);
    const cartridge = {
      ...base,
      id: 'fake-rv',
      mailboxName: '__AIRO_FAKE_RV_PAGES__',
      views: [],
    };

    const resolveView = vi.fn(async (_cartridgeId: string, pageType: string) => {
      // Host loads the chunk; it self-registers to the mailbox. Resolve
      // void — embed re-resolves through the registry (no factory returned).
      pushToMailbox(cartridge.mailboxName, {
        key: pageType,
        factory: () => recordingRenderer(sink),
      });
    });

    defineAiroApp({
      elementName,
      loadConfig: async () => ({
        config: {},
        cartridgeId: 'fake',
        templateId: 'main',
        preloadedData: { items: [] },
      }),
      resolveCartridge: async () => cartridge,
      resolveView,
    });

    mountElement(elementName, { 'airo-id': 'wgt_rv' });

    await waitFor(() => sink.includes('render'));
    // Called with the resolved cartridge.id (not the loadConfig lookup key)
    // and the bare pageType.
    expect(resolveView).toHaveBeenCalledWith('fake-rv', 'home');
    // Singleflight: one load even though the miss can re-emit.
    expect(resolveView).toHaveBeenCalledTimes(1);
  });

  test('resolveView: load rejection → onError(resolve-view) fires', async () => {
    const elementName = uniqueElementName();
    const onError = vi.fn();
    const base = fakeCartridge();
    const cartridge = {
      ...base,
      id: 'fake-rv-err',
      mailboxName: '__AIRO_FAKE_RV_ERR_PAGES__',
      views: [],
    };

    defineAiroApp({
      elementName,
      loadConfig: async () => ({
        config: {},
        cartridgeId: 'fake',
        templateId: 'main',
        preloadedData: { items: [] },
      }),
      resolveCartridge: async () => cartridge,
      resolveView: async () => {
        throw new Error('chunk 404');
      },
      onError,
    });

    mountElement(elementName, { 'airo-id': 'wgt_rv_err' });

    await waitFor(() => onError.mock.calls.length > 0);
    expect(onError.mock.calls[0][0]).toBe('resolve-view');
  });
});
