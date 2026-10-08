/**
 * `pluginAiroLynx()` — the rsbuild plugin a native build adds after
 * `pluginLynx()` and `pluginVanillaLynx()`.
 *
 * ```ts
 * plugins: [
 *   pluginLynx({ engineVersion: '3.9' }),
 *   pluginVanillaLynx({ engineVersion: '3.9' }),
 *   pluginAiroLynx(),
 * ]
 * ```
 *
 * It does three things, in build order:
 *
 *   1. Every stylesheet goes through `normaliseCss` before any other loader
 *      sees it.
 *   2. The vanilla template plugins get `enableCSSInheritance: true`, and
 *      the build fails if there was none to patch.
 *   3. After each environment compiles, it checks the emitted bundles carry
 *      the flag and writes the per-cartridge report next to them.
 *
 * It also turns off CSS minification for the build. In the measuring
 * spike's minified build the encoder received `.a, :is(.a ~ .b, …)` — two
 * neighbouring source rules with equal declarations merged into one list,
 * the kind of merge a minifier does — and rejected the whole list, because
 * the encoder rejects any list holding `:is()`. Unminified, the normaliser's
 * output is what the encoder sees. The encoder compresses the CSS into the
 * bundle anyway.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { RsbuildPlugin } from '@rsbuild/core';

import { assertInheritanceInBundles, type InheritanceOptions, tapCssInheritance } from './inheritance-tap.js';
import { type NormaliseReport, normaliseCss } from './normalise.js';
import { buildReport, formatReport, summaryLine, type CartridgeReport, type WarningLike } from './report.js';

export interface AiroLynxPluginOptions extends InheritanceOptions {
  /**
   * Where the report goes, relative to each environment's output directory.
   * The JSON and the Markdown share the stem. Default `airo-lynx-report`.
   */
  reportName?: string;
  /** Called with each environment's report, for a build script that wants to act on it. */
  onReport?: (report: CartridgeReport) => void;
}

export const PLUGIN_NAME = 'airo-js:lynx';

export function pluginAiroLynx(options: AiroLynxPluginOptions = {}): RsbuildPlugin {
  const reportName = options.reportName ?? 'airo-lynx-report';
  /** Normaliser reports by environment, then by stylesheet path (a rebuild replaces its entry). */
  const sheets = new Map<string, Map<string, NormaliseReport>>();

  return {
    name: PLUGIN_NAME,
    setup(api) {
      api.modifyRsbuildConfig((config) => {
        const minify = config.output?.minify;
        config.output = {
          ...config.output,
          minify: minify === false ? false : { ...(typeof minify === 'object' ? minify : {}), css: false },
        };
      });

      api.transform({ test: /\.css$/ }, ({ code, resourcePath, environment }) => {
        const { css, report } = normaliseCss(code, { filename: resourcePath });
        const forEnv = sheets.get(environment.name) ?? new Map<string, NormaliseReport>();
        forEnv.set(resourcePath, report);
        sheets.set(environment.name, forEnv);
        return css;
      });

      api.modifyBundlerChain({
        order: 'post',
        handler: (chain, { environment }) => {
          tapCssInheritance(chain as unknown as Parameters<typeof tapCssInheritance>[0], environment.name, options);
        },
      });

      api.onAfterEnvironmentCompile(({ stats, environment }) => {
        if (!stats) return;
        const compilation = stats.compilation;
        assertInheritanceInBundles(
          compilation.getAssets().map((a) => ({ name: a.name, source: a.source.buffer() })),
        );
        const warnings: WarningLike[] = compilation.warnings.map((w) => ({
          message: w.message,
          file: (w as { file?: string }).file,
          loc: (w as { loc?: WarningLike['loc'] }).loc,
        }));
        const report = buildReport(environment.name, [...(sheets.get(environment.name)?.values() ?? [])], warnings);
        const dir = environment.distPath;
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${reportName}.json`), `${JSON.stringify(report, null, 2)}\n`);
        writeFileSync(join(dir, `${reportName}.md`), formatReport(report));
        api.logger.info(summaryLine(report));
        options.onReport?.(report);
      });
    },
  };
}
