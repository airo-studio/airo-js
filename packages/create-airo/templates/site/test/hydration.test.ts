/**
 * The server and the browser must produce the same markup for the same page.
 *
 * Hydration keeps the HTML the server sent and attaches listeners to it. If
 * the browser would have rendered something different, the page quietly
 * shows the server's version while the app believes its own — the classic
 * cause is a `template` that reads the clock, a random number or the DOM.
 * This test renders each page both ways and compares them.
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
import { snapshotFor } from '../src/server.js';

const config = siteCartridge.defaultConfig;
const appConfig = templateToAppConfig(siteTemplate, siteCartridge.id);

async function serverMarkup(state?: Partial<NavigationState>): Promise<string> {
  const result = await renderAppWithPublication<SiteData, SiteConfig>({
    // The browser half: no adapters, so `html` is the page markup alone.
    cartridge: siteCartridge,
    appConfig,
    snapshot: await snapshotFor(state),
    publicationCtx: { config, locale: config.locale, country: 'GB' },
    document: document.implementation.createHTMLDocument(''),
    initialNavState: state,
  });
  return result.html;
}

async function browserMarkup(state?: Partial<NavigationState>): Promise<string> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const mounted = await mountCartridge<SiteData, SiteConfig>({
    cartridge: siteCartridge,
    config,
    template: siteTemplate,
    host,
    mode: 'csr',
    styleIsolation: 'light',
    initialNavState: state,
    dataSourceInput: { kind: 'custom', payload: { slug: state?.slug } },
  });
  const html = host.innerHTML;
  if (!mounted.blocked) mounted.destroy();
  host.remove();
  return html;
}

describe('server and browser render the same markup', () => {
  test.each([
    ['the index', undefined],
    ['a post', { page: 'post', slug: 'hello' }],
  ] as const)('%s', async (_name, state) => {
    const server = await serverMarkup(state);
    expect(server).toContain('site-page');
    expect(await browserMarkup(state)).toBe(server);
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
