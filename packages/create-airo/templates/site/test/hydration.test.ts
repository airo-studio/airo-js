/**
 * The browser must adopt the server's markup untouched.
 *
 * This site renders every page on the server and only hydrates it in the
 * browser (`cartridge.ts` builds hydrate-only views: listeners, no template).
 * Hydration keeps the HTML the server sent and attaches listeners to it, so
 * what can go wrong is the adoption: markup that is replaced instead of
 * kept, or a listener that never attaches. The classic cause upstream is a
 * `template` that reads the clock, a random number or the DOM, which makes
 * the server's output differ from a browser render of the same data.
 *
 * Two proofs, both against the markup `server.ts` would send:
 *
 *   1. the browser cartridge hydrates it in place, and its listener fires;
 *   2. the server cartridge, rendered from scratch in the browser (the path a
 *      `csr-only` view would take), produces byte-identical markup. That is
 *      the purity of `template`, and it still matters wherever a render is
 *      demanded.
 *
 * Both sides use the same DOM implementation, so any difference is in your
 * code rather than in how two libraries print HTML.
 *
 * @vitest-environment happy-dom
 */

import { templateToAppConfig } from '@airo-js/cartridge-kit';
import type { NavigationState } from '@airo-js/core';
import { mountCartridge } from '@airo-js/runtime';
import { renderAppWithPublication } from '@airo-js/ssr';
import { describe, expect, test } from 'vitest';

import { siteCartridge, siteTemplate, type SiteConfig, type SiteData } from '../src/cartridge.js';
import { siteServerCartridge } from '../src/cartridge.server.js';
import { snapshotFor } from '../src/server.js';

const config = siteCartridge.defaultConfig;
const appConfig = templateToAppConfig(siteTemplate, siteCartridge.id);

async function serverMarkup(state?: Partial<NavigationState>): Promise<string> {
  const result = await renderAppWithPublication<SiteData, SiteConfig>({
    // The server half renders: it holds the templates. Its adapters are left
    // out so `html` is the page markup alone, without the inline JSON-LD
    // script `server.ts` adds beside it.
    cartridge: { ...siteServerCartridge, publicationAdapters: [] },
    appConfig,
    snapshot: await snapshotFor(state),
    publicationCtx: { config, locale: config.locale, country: 'GB' },
    document: document.implementation.createHTMLDocument(''),
    initialNavState: state,
  });
  return result.html;
}

/** Mount a cartridge on `host` and report what it left there. */
async function mountOn(
  host: HTMLElement,
  cartridge: typeof siteCartridge,
  mode: 'csr' | 'hydrate',
  state?: Partial<NavigationState>,
): Promise<string> {
  const mounted = await mountCartridge<SiteData, SiteConfig>({
    cartridge,
    config,
    template: siteTemplate,
    host,
    mode,
    styleIsolation: 'light',
    initialNavState: state,
    dataSourceInput: { kind: 'custom', payload: { slug: state?.slug } },
  });
  const html = host.innerHTML;
  if (!mounted.blocked) mounted.destroy();
  return html;
}

async function withHost<T>(run: (host: HTMLElement) => Promise<T>): Promise<T> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  try {
    return await run(host);
  } finally {
    host.remove();
  }
}

const PAGES = [
  ['the index', undefined],
  ['a post', { page: 'post', slug: 'hello' }],
] as const;

describe('the browser adopts the server markup', () => {
  test.each(PAGES)('%s is kept, not redrawn', async (_name, state) => {
    const server = await serverMarkup(state);
    expect(server).toContain('site-page');
    await withHost(async (host) => {
      host.innerHTML = server;
      const adopted = host.firstElementChild;
      expect(await mountOn(host, siteCartridge, 'hydrate', state)).toBe(server);
      // The same node, so nothing was thrown away and rebuilt.
      expect(host.firstElementChild).toBe(adopted);
    });
  });

  test('the index listener attaches', async () => {
    const server = await serverMarkup();
    await withHost(async (host) => {
      host.innerHTML = server;
      const mounted = await mountCartridge<SiteData, SiteConfig>({
        cartridge: siteCartridge,
        config,
        template: siteTemplate,
        host,
        mode: 'hydrate',
        styleIsolation: 'light',
        dataSourceInput: { kind: 'custom', payload: {} },
      });
      host.querySelector<HTMLElement>('a.site-card__link')?.click();
      // `hydrate` marks the root it was given, which may be `host` itself.
      const marked = [host, ...host.querySelectorAll('[data-last-click]')].find((el) => el.hasAttribute('data-last-click'));
      const clicked = marked?.getAttribute('data-last-click');
      if (!mounted.blocked) mounted.destroy();
      expect(clicked).toBe('Hello');
    });
  });

  test('the browser cartridge refuses to render a page it holds no template for', async () => {
    await withHost(async (host) => {
      await expect(mountOn(host, siteCartridge, 'csr')).rejects.toThrow(/hydrate-only/);
    });
  });
});

describe('the server cartridge renders the same markup in the browser as on the server', () => {
  test.each(PAGES)('%s', async (_name, state) => {
    const server = await serverMarkup(state);
    await withHost(async (host) => {
      expect(await mountOn(host, siteServerCartridge, 'csr', state)).toBe(server);
    });
  });
});

describe('content', () => {
  test('the index does not link to an unpublished post', async () => {
    const html = await serverMarkup();
    expect(html).toContain('/post/hello');
    expect(html).not.toContain('/post/unfinished');
  });

  test('a post gets anchor ids from the transformer', async () => {
    const snapshot = await snapshotFor({ page: 'post', slug: 'hello' });
    expect(snapshot.post?.sections.map((s) => s.id)).toEqual(['one-snapshot-every-audience', 'where-to-start']);
  });
});
