/**
 * The client entry — and the artifact that proves the router claim.
 *
 * `basePath: '/'` root-mounts the whole site: the app owns `/`, `/doc/<slug>`,
 * `/members`, `/note/<slug>` and every url in between. `entryPageId: 'home'`
 * collapses the bare entry state onto `/` so the index has ONE url instead
 * of answering on both `/` and `/home` — and stops the url silently
 * rewriting itself on load.
 *
 * Everything this entry needs to know about the page it landed on is on
 * the `#app` root the server emitted, so one entry serves every page:
 *
 *   data-airo-mode             'hydrate' adopts the server's markup; 'csr'
 *                              paints fresh into an empty root (the 401 shell).
 *   data-airo-source           'members' → mount with the members DataSource,
 *                              which asks /api/members/me with the cookie.
 *   data-airo-gates-satisfied  gate ids the server's private render already
 *                              met → passed as `satisfiedGates`, so the login
 *                              gate is not re-asked by the render that
 *                              required it. Initial mount only.
 *
 * On a 401 shell the gate runs BEFORE any fetch: it asks /auth/session,
 * gets a 401, paints the sign-in panel and blocks; /api/members/me is never
 * called. On a server-rendered members page the gate is satisfied, the
 * members DataSource refetches the private slice with the cookie, and
 * hydrate attaches listeners — the first page is SSR, everything after is
 * CSR.
 *
 * Bundled by esbuild into `dist/public/client.js` and served by
 * `server.ts`. Until 0.11.0 it was referenced and never served, so nothing
 * here had ever run in a browser; `e2e/` now proves it does.
 */

import { mountCartridge } from '@airo-js/runtime';

import { docSiteCartridge, docSiteTemplate, signInPanel, type DocSiteConfig, type DocSiteData } from './cartridge.js';
import { SITE } from './content.js';

const host = document.getElementById('app');
if (!host) throw new Error('[full-site] no #app host element');

const mode = host.dataset.airoMode === 'csr' ? 'csr' : 'hydrate';
const source = host.dataset.airoSource === 'members' ? 'members' : 'content';
const satisfiedGates = (host.dataset.airoGatesSatisfied ?? '').split(',').filter(Boolean);
const slug = window.location.pathname.split('/')[2];
const config: DocSiteConfig = { locale: 'en-GB', siteUrl: SITE.url, siteName: SITE.name };

const result = await mountCartridge<DocSiteData, DocSiteConfig>({
  cartridge: docSiteCartridge,
  config,
  template: docSiteTemplate,
  host,
  mode,
  styleIsolation: 'light',
  enableRouter: { mode: 'path', basePath: '/', entryPageId: 'home', pathContextKey: 'slug' },
  dataSourceId: source,
  dataSourceInput: { kind: 'custom', payload: { slug } },
  satisfiedGates,
  onError(phase) {
    // The one failure a visitor can act on: the session expired between the
    // server's render and this fetch. The API said 401; show the panel.
    if (phase === 'fetch' && source === 'members') {
      host.innerHTML = signInPanel(`${window.location.pathname}${window.location.search}`, {
        error: 'Your session has ended. Sign in again to continue.',
      });
    }
  },
});

// Host-side markers for the browser checks: which mode this page mounted
// in, and whether a gate blocked it. Not framework signals.
document.documentElement.setAttribute('data-airo-mounted', mode);
document.documentElement.setAttribute('data-airo-blocked', result.blocked ? result.blockedBy : '');
