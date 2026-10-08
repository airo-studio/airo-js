/**
 * This card built the way a consumer builds one: the four @airo-js packages
 * packed and installed from their tarballs into a plain `node_modules`,
 * outside this workspace, then held to the same checks as check-build.mjs.
 *
 * Inside the workspace the packages resolve to `packages/*`, which rsbuild
 * transpiles like the card's own source and never moves into a vendor chunk.
 * Installed, they were left untranspiled (the encoder's main-thread compiler
 * rejected them) and split into a CommonJS chunk neither thread could load,
 * so a consumer's card never started while this one always did (found by the
 * first consumer, 8 Oct 2026). Needs `pnpm build` first, and the network for
 * the install.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('..', import.meta.url));
const root = fileURLToPath(new URL('../../../', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'lynx-native-packed-'));
const packs = join(work, 'packs');
const card = join(work, 'card');
mkdirSync(packs);
mkdirSync(card);

const PACKAGES = ['core', 'cartridge-kit', 'log', 'lynx'];
try {
  for (const name of PACKAGES) {
    execFileSync('pnpm', ['pack', '--pack-destination', packs], { cwd: join(root, 'packages', name), stdio: 'ignore' });
  }
  const tarball = (name) => {
    const file = readdirSync(packs).find((f) => f.startsWith(`airo-js-${name}-`));
    if (!file) throw new Error(`no tarball for @airo-js/${name}`);
    return `file:${join(packs, file)}`;
  };
  const own = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));
  const toolchain = Object.fromEntries(Object.entries(own.devDependencies).filter(([n]) => n.startsWith('@lynx-js/') || n === '@rsbuild/core'));
  writeFileSync(
    join(card, 'package.json'),
    JSON.stringify(
      {
        name: 'lynx-native-packed',
        private: true,
        type: 'module',
        dependencies: Object.fromEntries(PACKAGES.map((n) => [`@airo-js/${n}`, tarball(n)])),
        devDependencies: toolchain,
      },
      null,
      2,
    ),
  );
  cpSync(join(here, 'src'), join(card, 'src'), { recursive: true });
  cpSync(join(here, 'rsbuild.config.ts'), join(card, 'rsbuild.config.ts'));
  // What lets rsbuild read `./cartridge.js` as the `.ts` beside it.
  writeFileSync(join(card, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true }, include: ['src'] }));

  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: card, stdio: 'inherit' });
  execFileSync('npx', ['rsbuild', 'build'], { cwd: card, stdio: 'inherit' });
  execFileSync('node', [join(here, 'scripts', 'check-build.mjs'), '--dist', join(card, 'dist')], { stdio: 'inherit' });
} finally {
  rmSync(work, { recursive: true, force: true });
}
