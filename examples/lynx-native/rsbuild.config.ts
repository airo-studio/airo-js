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
 * empty in every other build.
 */
const collector = process.env.AIRO_LYNX_COLLECTOR ?? '';

export default defineConfig({
  source: {
    entry: { main: './src/main-thread.ts' },
    define: { AIRO_LYNX_COLLECTOR: JSON.stringify(collector) },
  },
  plugins: [pluginLynx(), pluginVanillaLynx({ engineVersion: '3.9' }), pluginAiroLynx()],
  environments: { lynx: {} },
  server: { port: Number(process.env.PORT ?? 3210), host: '0.0.0.0' },
});
