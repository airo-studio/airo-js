import { pluginAiroLynx } from '@airo-js/lynx/build';
import { pluginLynx } from '@lynx-js/rsbuild-plugin';
import { pluginVanillaLynx } from '@lynx-js/vanilla-rsbuild-plugin';
import { defineConfig } from '@rsbuild/core';

/**
 * Engine 3.9, set on the vanilla plugin: the encoder in
 * @lynx-js/rsbuild-plugin 0.1.3 refuses anything newer. `pluginAiroLynx()`
 * goes after the vanilla plugin, whose template plugins it patches for CSS
 * inheritance.
 *
 * AIRO_LYNX_COLLECTOR is where device reports go during a device check;
 * empty in every other build. The pages' images are served from the same
 * place as the bundle: the device check's server, or the dev server.
 * AIRO_LYNX_START is the first page's url, e.g. `/controls?open=1` for a
 * check that has to see an open dialog without a tap.
 */
const collector = process.env.AIRO_LYNX_COLLECTOR ?? '';
const port = Number(process.env.PORT ?? 3210);
const assets = collector ? `${new URL(collector).origin}/` : `http://localhost:${port}/`;

export default defineConfig({
  source: {
    entry: { main: './src/main-thread.ts' },
    define: {
      AIRO_LYNX_COLLECTOR: JSON.stringify(collector),
      AIRO_LYNX_START: JSON.stringify(process.env.AIRO_LYNX_START ?? '/'),
      AIRO_LYNX_ASSETS: JSON.stringify(assets),
    },
  },
  plugins: [pluginLynx(), pluginVanillaLynx({ engineVersion: '3.9' }), pluginAiroLynx()],
  environments: { lynx: {} },
  server: { port, host: '0.0.0.0' },
});
