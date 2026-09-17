/**
 * The browser entry. Bundled into `dist/public/client.js` by `npm run build`,
 * and loaded by every page `server.ts` renders.
 *
 * It mounts the cartridge on the `#app` element the server wrote. In
 * `'hydrate'` mode the runtime keeps the server's markup and only attaches
 * listeners; nothing is drawn twice.
 *
 * The router owns the whole origin (`basePath: '/'`). `entryPageId: 'home'`
 * gives the index one url, `/`, instead of answering on `/home` as well.
 */

import { mountCartridge } from '@airo-js/runtime';

import { ROOT_ATTRS, siteCartridge, siteTemplate, type SiteConfig, type SiteData } from './cartridge.js';

const host = document.getElementById('app');

if (host) {
  const mode = host.getAttribute(ROOT_ATTRS.mode) === 'csr' ? 'csr' : 'hydrate';
  // `/post/<slug>` → the slug. The server decodes the same url the same way.
  const slug = window.location.pathname.split('/')[2];

  try {
    await mountCartridge<SiteData, SiteConfig>({
      cartridge: siteCartridge,
      config: siteCartridge.defaultConfig,
      template: siteTemplate,
      host,
      mode,
      // `'light'` renders into the page's own DOM so `SITE_CSS` applies.
      // `'shadow'` would isolate the app, and styles would have to come from
      // each view's `stylesheet` instead.
      styleIsolation: 'light',
      enableRouter: { mode: 'path', basePath: '/', entryPageId: 'home', pathContextKey: 'slug' },
      // Without this, the runtime looks for `config.feed.url` and throws.
      dataSourceInput: { kind: 'custom', payload: { slug } },
    });
    // A marker for tests and for you in devtools: which mode actually ran.
    document.documentElement.setAttribute('data-airo-mounted', mode);
  } catch (err) {
    document.documentElement.setAttribute('data-airo-mounted', 'error');
    console.error('[__CARTRIDGE_ID__] mount failed', err);
  }
}
