/**
 * The client entry — and the artifact that proves the router claim.
 *
 * `basePath: '/'` root-mounts the whole site: the app owns `/`, `/doc/<slug>`,
 * and every url in between. `entryPageId: 'home'` collapses the bare entry
 * state onto `/` so the index has ONE url instead of answering on both `/`
 * and `/home` — and stops the url silently rewriting itself on load.
 *
 * `mode: 'hydrate'` adopts the server's markup instead of repainting it.
 */

import { mountCartridge } from '@airo-js/runtime';

import { docSiteCartridge, docSiteTemplate, type DocSiteConfig, type DocSiteData } from './cartridge.js';
import { SITE } from './content.js';

const host = document.getElementById('app');
if (!host) throw new Error('[full-site] no #app host element');

const config: DocSiteConfig = { locale: 'en-GB', siteUrl: SITE.url, siteName: SITE.name };

await mountCartridge<DocSiteData, DocSiteConfig>({
  cartridge: docSiteCartridge,
  config,
  template: docSiteTemplate,
  host,
  mode: 'hydrate',
  styleIsolation: 'light',
  enableRouter: { mode: 'path', basePath: '/', entryPageId: 'home', pathContextKey: 'slug' },
  dataSourceInput: { kind: 'custom', payload: { slug: window.location.pathname.split('/')[2] } },
});
