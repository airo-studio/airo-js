#!/usr/bin/env node
/**
 * Bundle-size gate for the runtime's reachable closure.
 *
 * Bundles `src/index.ts` as ESM, minified, with every `@airo-js/*` peer
 * INCLUDED — so the number is what a consumer entry that imports
 * `mountCartridge` pays for the framework at most: runtime + core +
 * cartridge-kit + log, tree-shaken the way esbuild would. Cartridge code is
 * excluded by definition (it is the consumer's).
 *
 * Why a gate, and why now: the embed has had one since 0.4; runtime
 * consumers had nothing equivalent, and 0.11.0 was the first line where the
 * runtime's share of a consumer entry moved by more than a kilobyte
 * (+1.0 kB minified / +0.27 kB gzip — the gate phase, the shared entry
 * ladder, the hydrate restore). Both consumers measured it independently and
 * asked for a number to watch before 1.0. This is that number.
 *
 * Budget is measured-plus-headroom, not aspirational: 0.11.0 measures
 * ~27.6 kB / ~9.0 kB. Raising the budget is allowed and is a changelog
 * line — the gate exists so growth is a decision, not a discovery.
 *
 * Needs sibling packages built (`pnpm build` at the root) because the
 * peers resolve to their `dist` through the workspace links.
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const MAX_MIN = 29 * 1024;       // 29 KB
const MAX_GZIP = 9.5 * 1024;     // 9.5 KB

// Resolved from this file, not the cwd, so the gate measures the same entry
// however it is invoked.
const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const minified = execFileSync(
  'esbuild',
  ['--bundle', '--minify', '--format=esm', '--target=es2022', entry],
  { encoding: 'buffer' },
);
const gzipped = gzipSync(minified, { level: 9 });

const minSize = minified.length;
const gzSize = gzipped.length;

const fmt = (n) => `${n.toLocaleString()} B (${(n / 1024).toFixed(2)} KB)`;

console.log('@airo-js/runtime reachable closure (runtime + core + cartridge-kit + log):');
console.log(`  minified: ${fmt(minSize)}  /  budget: ${fmt(MAX_MIN)}`);
console.log(`  gzip:     ${fmt(gzSize)}  /  budget: ${fmt(MAX_GZIP)}`);

let failed = false;
if (minSize > MAX_MIN) {
  console.error(`\nFAIL: minified closure exceeds ${fmt(MAX_MIN)}.`);
  failed = true;
}
if (gzSize > MAX_GZIP) {
  console.error(`\nFAIL: gzipped closure exceeds ${fmt(MAX_GZIP)}.`);
  failed = true;
}

if (failed) {
  console.error(
    '\nEvery consumer page that mounts a cartridge pays this closure. Trim, or raise the budget deliberately with a CHANGELOG line saying what the bytes buy.',
  );
  process.exit(1);
}

console.log('\nOK — both budgets honoured.');
