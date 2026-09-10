/**
 * The client entry — and the artifact that proves the router claim.
 *
 * `basePath: '/'` root-mounts the whole site: the app owns `/`, `/doc/<slug>`,
 * and every url in between. `entryPageId: 'home'` collapses the bare entry
 * state onto `/` so the index has ONE url instead of answering on both `/`
 * and `/home` — and stops the url silently rewriting itself on load.
 *
 * The server names the mount mode on the root (`data-airo-mode`): `hydrate`
 * adopts the server's markup instead of repainting it; `csr` paints fresh
 * into an empty root. Reading it off the DOM rather than hardcoding it is
 * what lets one entry serve every page the server emits.
 *
 * Bundled by esbuild into `dist/public/client.js` and served by
 * `server.ts`. Until 0.11.0 it was referenced and never served, so nothing
 * here had ever run in a browser; `e2e/public.spec.ts` now proves it does.
 */

import { mountCartridge } from '@airo-js/runtime';

import { docSiteCartridge, docSiteTemplate, type DocSiteConfig, type DocSiteData } from './cartridge.js';
import { SITE } from './content.js';

const host = document.getElementById('app');
if (!host) throw new Error('[full-site] no #app host element');

const mode = host.dataset.airoMode === 'csr' ? 'csr' : 'hydrate';
const config: DocSiteConfig = { locale: 'en-GB', siteUrl: SITE.url, siteName: SITE.name };

await mountCartridge<DocSiteData, DocSiteConfig>({
  cartridge: docSiteCartridge,
  config,
  template: docSiteTemplate,
  host,
  mode,
  styleIsolation: 'light',
  enableRouter: { mode: 'path', basePath: '/', entryPageId: 'home', pathContextKey: 'slug' },
  dataSourceInput: { kind: 'custom', payload: { slug: window.location.pathname.split('/')[2] } },
});

// A host-side marker for the browser checks: which mode this page mounted
// in, stamped only once the mount resolved. Not a framework signal.
document.documentElement.setAttribute('data-airo-mounted', mode);
