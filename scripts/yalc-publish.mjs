#!/usr/bin/env node
// Publish/push every @airo-js/* package to the local yalc store with
// `workspace:` protocol ranges rewritten to concrete semver.
//
// Why: `pnpm publish` rewrites `workspace:^` → `^<version>` in the published
// package.json automatically; `yalc` does NOT — it copies package.json
// verbatim. So a yalc artifact ships `"@airo-js/core": "workspace:^"`, which
// an npm-based consumer (yalc add + npm install) rejects with
// `EUNSUPPORTEDPROTOCOL Unsupported URL Type "workspace:"`. This script does
// the rewrite that yalc lacks. The real `pnpm publish` path is unaffected —
// this is yalc-flow-only.
//
// Mechanism: for each package, rewrite workspace ranges in place, run
// `yalc <mode>` (which copies the rewritten package.json into the store),
// then restore the original package.json from its exact on-disk text. A
// `finally` restores every touched file even if yalc throws, so the working
// tree is never left rewritten.
//
// Usage:
//   node scripts/yalc-publish.mjs push           # build assumed done by caller
//   node scripts/yalc-publish.mjs publish
//   node scripts/yalc-publish.mjs push --dry      # rewrite preview, no yalc

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const mode = process.argv[2] === 'publish' ? 'publish' : 'push';
const dry = process.argv.includes('--dry');
const root = process.cwd();
const pkgsDir = join(root, 'packages');

const pkgDirs = readdirSync(pkgsDir)
  .map((d) => join(pkgsDir, d))
  .filter((d) => existsSync(join(d, 'package.json')));

// name → version for every workspace package, to resolve `workspace:` ranges.
const versions = {};
for (const dir of pkgDirs) {
  const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  versions[pj.name] = pj.version;
}

const DEP_BLOCKS = [
  'dependencies',
  'peerDependencies',
  'optionalDependencies',
  'devDependencies',
];

// Mirror pnpm's rewrite: workspace:* → exact, ^/~ → ranged, explicit range
// → that range verbatim (minus the protocol prefix).
function rewriteWorkspace(spec, depName) {
  const rest = spec.slice('workspace:'.length);
  const v = versions[depName];
  if (!v) return spec; // not a workspace package — leave as-is
  if (rest === '*') return v;
  if (rest === '^') return `^${v}`;
  if (rest === '~') return `~${v}`;
  return rest; // workspace:^1.2.3 → ^1.2.3
}

const restores = [];
let failure = null;
try {
  for (const dir of pkgDirs) {
    const pjPath = join(dir, 'package.json');
    const original = readFileSync(pjPath, 'utf8');
    const pj = JSON.parse(original);

    const rewrites = [];
    for (const block of DEP_BLOCKS) {
      const deps = pj[block];
      if (!deps) continue;
      for (const [name, spec] of Object.entries(deps)) {
        if (typeof spec === 'string' && spec.startsWith('workspace:')) {
          const next = rewriteWorkspace(spec, name);
          deps[name] = next;
          rewrites.push(`${block}.${name}: ${spec} → ${next}`);
        }
      }
    }

    if (rewrites.length > 0) {
      console.log(`[${pj.name}] ${rewrites.join(', ')}`);
      if (!dry) {
        writeFileSync(pjPath, `${JSON.stringify(pj, null, 2)}\n`);
        restores.push([pjPath, original]);
      }
    }

    if (!dry) {
      execFileSync('pnpm', ['exec', 'yalc', mode, '--private'], {
        cwd: dir,
        stdio: 'inherit',
      });
    }
  }
} catch (err) {
  failure = err;
} finally {
  for (const [p, orig] of restores) writeFileSync(p, orig);
}

if (failure) {
  console.error(failure.message ?? failure);
  process.exit(1);
}
console.log(
  dry
    ? 'yalc rewrite preview complete (no publish).'
    : `yalc ${mode}: done — workspace: ranges rewritten to concrete semver in the store.`,
);
