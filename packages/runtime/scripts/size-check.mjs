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
 * ~27.7 kB / ~9.0 kB (28,332 B / 9,252 B at the cut). Raising the budget
 * is allowed and is a changelog line — the gate exists so growth is a
 * decision, not a discovery.
 *
 * Raised for core 0.11.1 to 32 KB / 10 KB: the line measures 31,057 B /
 * 10,110 B, from 28,585 B / 9,398 B on 0.11.0 (+2,472 B / +712 B). That is
 * in-place navigation (`PageRenderer.applyNavState`), the ordered queue for
 * navigations requested during another, the exact Back/Forward restore and
 * the router echo check, all of it on the navigation path every mount runs.
 *
 * Needs sibling packages built (`pnpm build` at the root) because the
 * peers resolve to their `dist` through the workspace links.
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const MAX_MIN = 32 * 1024;       // 32 KB (29 KB until core 0.11.1)
const MAX_GZIP = 10 * 1024;      // 10 KB (9.5 KB until core 0.11.1)

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
