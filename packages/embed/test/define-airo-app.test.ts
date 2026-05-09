import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { defineAiroApp } from '../src/define-airo-app.js';
import { fakeCartridge, uniqueElementName, waitFor } from './fixtures.js';

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
        styleIsolation: 'partial',
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
});
