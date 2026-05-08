/**
 * Bundle src/editor/bootstrap.ts (and its workspace transitive deps) into
 * public/bundle.js for the browser.
 *
 * Resolves @airo-js/* packages from each package's `dist/` (their `main`
 * field). That means the workspace packages must have been built before
 * this script runs. From the repo root: `pnpm -r --filter './packages/*'
 * build` produces dist/ for each package.
 */

import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, '..');

const result = await build({
  entryPoints: [resolve(APP_ROOT, 'src/editor/bootstrap.ts')],
  outfile: resolve(APP_ROOT, 'public/bundle.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  sourcemap: true,
  minify: false,
  conditions: ['browser', 'import', 'module', 'default'],
  metafile: true,
  logLevel: 'info',
});

const meta = result.metafile;
if (meta) {
  const sizes = Object.entries(meta.outputs).map(([file, info]) => ({
    file: file.replace(`${APP_ROOT}/`, ''),
    bytes: info.bytes,
  }));
  // eslint-disable-next-line no-console
  console.info(
    sizes
      .map((s) => `  ${s.file.padEnd(22)} ${(s.bytes / 1024).toFixed(1)} KB`)
      .join('\n'),
  );
}
