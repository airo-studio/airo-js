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
 * the `#app` root the server emitted (`ROOT_ATTRS` in `cartridge.ts` names
 * the attributes on both sides), so one entry serves every page:
 *
 *   data-airo-mode             'hydrate' adopts the server's markup; 'csr'
 *                              paints fresh into the root (the 401 shell).
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

import {
  MEMBERS_SOURCE_ID,
  ROOT_ATTRS,
  docSiteCartridge,
  docSiteTemplate,
  sessionEndedHandler,
  type DocSiteConfig,
  type DocSiteData,
} from './cartridge.js';
import { SITE } from './content.js';

const host = document.getElementById('app');
if (!host) throw new Error('[full-site] no #app host element');

const mode = host.getAttribute(ROOT_ATTRS.mode) === 'csr' ? 'csr' : 'hydrate';
const source = host.getAttribute(ROOT_ATTRS.source) === MEMBERS_SOURCE_ID ? MEMBERS_SOURCE_ID : 'content';
const satisfiedGates = (host.getAttribute(ROOT_ATTRS.gatesSatisfied) ?? '').split(',').filter(Boolean);
const slug = window.location.pathname.split('/')[2];
const config: DocSiteConfig = { locale: 'en-GB', siteUrl: SITE.url, siteName: SITE.name };

// Host-side markers for the browser checks: which mode this page mounted
// in, and whether a gate blocked it or the mount failed. Not framework
// signals. The runtime rethrows after `onError`, so the expired-session
// path (panel painted by `sessionEndedHandler`) lands in the catch — a
// top-level `await` outside it would end the module on an unhandled
// rejection with no marker set.
try {
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
    onError: source === MEMBERS_SOURCE_ID ? sessionEndedHandler(host) : undefined,
  });
  document.documentElement.setAttribute('data-airo-mounted', mode);
  document.documentElement.setAttribute('data-airo-blocked', result.blocked ? result.blockedBy : '');
} catch (err) {
  document.documentElement.setAttribute('data-airo-mounted', mode);
  document.documentElement.setAttribute('data-airo-blocked', 'error');
  console.error('[full-site] mount failed', err);
}
