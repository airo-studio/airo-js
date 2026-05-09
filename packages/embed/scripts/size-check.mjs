#!/usr/bin/env node
/**
 * Bundle-size gate. Builds the embed bundle as IIFE (no runtime, lazy-loaded),
 * minified, and asserts both raw + gzip sizes against the documented budget.
 *
 * Budget (load-bearing for v0.1):
 *   - Minified: ≤ 5 KB
 *   - Gzipped:  ≤ 2.5 KB
 *
 * The runtime is excluded from the bundle (peerDep, dynamic-imported at
 * runtime). Cartridge code is excluded by definition (resolved by the host
 * app via resolveCartridge).
 *
 * Why a gate: the embed ships to customer pages. Bigger bundles mean slower
 * paint + worse Core Web Vitals. The gate keeps the framework honest.
 */

import { execSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';

const MAX_MIN = 5 * 1024;        // 5 KB
const MAX_GZIP = 2.5 * 1024;     // 2.5 KB

const minified = execSync(
  'esbuild --bundle --minify --format=iife --external:@airo-js/runtime src/index.ts',
  { encoding: 'buffer' },
);
const gzipped = gzipSync(minified);

const minSize = minified.length;
const gzSize = gzipped.length;

const fmt = (n) => `${n.toLocaleString()} B (${(n / 1024).toFixed(2)} KB)`;

console.log(`@airo-js/embed bundle sizes:`);
console.log(`  minified: ${fmt(minSize)}  /  budget: ${fmt(MAX_MIN)}`);
console.log(`  gzip:     ${fmt(gzSize)}  /  budget: ${fmt(MAX_GZIP)}`);

let failed = false;
if (minSize > MAX_MIN) {
  console.error(`\nFAIL: minified bundle exceeds ${fmt(MAX_MIN)}.`);
  failed = true;
}
if (gzSize > MAX_GZIP) {
  console.error(`\nFAIL: gzipped bundle exceeds ${fmt(MAX_GZIP)}.`);
  failed = true;
}

if (failed) {
  console.error(
    '\nThe embed bundle is the customer-facing entry point — it ships to every host page that pastes the script tag. Trim before landing.',
  );
  process.exit(1);
}

console.log(`\nOK — both budgets honoured.`);
