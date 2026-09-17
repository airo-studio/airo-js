#!/usr/bin/env node
/**
 * The end-to-end check for `create-airo`: scaffold every template the way a
 * user would, install it as a user would, and prove it builds, tests,
 * serves and hydrates.
 *
 *   node scripts/e2e-create-airo.mjs                 # every shipped template
 *   node scripts/e2e-create-airo.mjs --template site
 *   node scripts/e2e-create-airo.mjs --keep          # leave the temp dir for a look
 *   node scripts/e2e-create-airo.mjs --skip-browser  # no Playwright
 *   node scripts/e2e-create-airo.mjs --reuse <dir>   # re-verify a kept, installed app
 *
 * `--reuse` skips building, packing, scaffolding and installing, and runs
 * only the template's checks — the loop for editing a template: change the
 * kept copy, re-verify, then carry the change back to `templates/`.
 *
 * ## The problem this solves
 *
 * A scaffolded project depends on `^<version>` of each @airo-js package.
 * On a branch that bumps the line, those versions are not on npm yet, so
 * installing from the registry fails on exactly the changes this check
 * exists for. So:
 *
 * 1. Every package is `pnpm pack`ed. Pack applies the same `workspace:` →
 *    semver rewrite as publish, so each tarball declares its peers exactly
 *    as the published package will.
 * 2. The project is scaffolded into a temp directory OUTSIDE the repo, by the
 *    built CLI.
 * 3. Each scaffolded `@airo-js/*` range is checked against its packed version,
 *    then swapped for the tarball path. Nothing else in the file changes.
 *
 *    Not `pnpm.overrides`: overrides also rewrite the peer ranges INSIDE each
 *    package to the `file:` spec, and pnpm then calls `0.11.0` an unmet peer
 *    of its own tarball (`peerDependencyRules` does not silence that under
 *    strict peers in pnpm 9). Every link between @airo-js packages is a peer,
 *    so swapping the project's direct dependencies is enough, and the peer
 *    ranges pnpm checks are the ones that ship.
 * 4. Install with strict peers ON and auto-install-peers OFF. The repo's own
 *    `.npmrc` turns auto-install on for convenience; a scaffolded project must
 *    not rely on that, and this is the setting that turns "the template forgot
 *    a peer" or "the template's versions disagree with each other" into a
 *    failure here instead of in a stranger's app.
 *
 * `--ignore-workspace` stops pnpm from walking up into this repo's workspace.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CLI_DIR = join(REPO, 'packages/create-airo');

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const skipBrowser = args.includes('--skip-browser');
const valuesOf = (flag) => args.flatMap((a, i) => (a === flag && args[i + 1] ? [args[i + 1]] : []));
const only = valuesOf('--template');
const [reuse] = valuesOf('--reuse');

function step(text) {
  console.log(`\n==> ${text}`);
}

function sh(cmd, cmdArgs, opts = {}) {
  execFileSync(cmd, cmdArgs, { stdio: 'inherit', ...opts });
}

async function freePort() {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', fail);
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => ok(port));
    });
  });
}

async function waitForServer(base, child) {
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error(`server exited early with code ${child.exitCode}`);
    try {
      const res = await fetch(base);
      if (res.status > 0) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server never answered at ${base}`);
}

/**
 * The browser half of the proof: the bundle runs, the mount adopts the DOM
 * the server sent (no node replaced), and a listener attached by `hydrate()`
 * fires. Same method as `examples/full-site/e2e/helpers.ts`.
 */
async function browserCheck(base) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const failures = [];
  try {
    for (const [path, expectClick] of [
      ['/', 'Hello'],
      ['/post/hello', null],
    ]) {
      const page = await browser.newPage();
      const problems = [];
      page.on('pageerror', (err) => problems.push(`pageerror: ${err}`));
      page.on('console', (msg) => {
        if (msg.type() === 'error' || msg.type() === 'warning') problems.push(`${msg.type()}: ${msg.text()}`);
      });
      await page.addInitScript(() => {
        window.__ssrRoot = undefined;
        window.__lateAppMutations = 0;
        new MutationObserver((records) => {
          for (const record of records) {
            for (const node of record.addedNodes) {
              if (!window.__ssrRoot && node instanceof Element && node.classList.contains('site-page')) {
                window.__ssrRoot = node;
              }
            }
            if (record.target.id === 'app' && document.readyState !== 'loading') {
              window.__lateAppMutations += record.addedNodes.length + record.removedNodes.length;
            }
          }
        }).observe(document, { childList: true, subtree: true });
      });

      const res = await page.goto(base + path);
      if (res?.status() !== 200) failures.push(`${path}: status ${res?.status()}`);
      await page.waitForFunction(() => document.documentElement.hasAttribute('data-airo-mounted'), null, {
        timeout: 15_000,
      });
      const mounted = await page.evaluate(() => document.documentElement.getAttribute('data-airo-mounted'));
      if (mounted !== 'hydrate') failures.push(`${path}: mounted as "${mounted}", expected "hydrate"`);

      const adopted = await page.evaluate(
        () =>
          !!window.__ssrRoot &&
          document.contains(window.__ssrRoot) &&
          window.__ssrRoot.closest('#app') !== null &&
          window.__lateAppMutations === 0,
      );
      if (!adopted) failures.push(`${path}: hydration replaced the server's DOM instead of adopting it`);

      if (expectClick) {
        const clicked = await page.evaluate(() => {
          const link = document.querySelector('a.site-card__link');
          link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          return document.querySelector('[data-last-click]')?.getAttribute('data-last-click') ?? null;
        });
        if (clicked !== expectClick) failures.push(`${path}: hydrate() listener did not fire (got ${clicked})`);
      }
      for (const p of problems) failures.push(`${path}: ${p}`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
  if (failures.length) throw new Error(`browser check failed:\n  ${failures.join('\n  ')}`);
  console.log('    browser: hydrates in place, listener fires, console clean');
}

/** A server-backed template: start it, run its own smoke, then the browser check. */
async function serveAndCheck(app) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn('node', ['dist/server.js'], {
    cwd: app,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  try {
    await waitForServer(base, child);
    sh('node', ['scripts/smoke.mjs'], { cwd: app, env: { ...process.env, BASE_URL: base } });
    if (!skipBrowser) await browserCheck(base);
  } finally {
    child.kill();
  }
}

/**
 * `^x.y.z` only, which is all `workspace:^` produces. Anything else fails
 * loudly rather than being half-checked.
 */
function caretAccepts(range, version) {
  const r = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
  const v = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!r || !v) throw new Error(`caretAccepts cannot read "${range}" against "${version}" — extend it`);
  const [want, have] = [r.slice(1).map(Number), v.slice(1).map(Number)];
  const pivot = want[0] > 0 ? 0 : want[1] > 0 ? 1 : 2;
  for (let i = 0; i <= pivot; i++) if (have[i] !== want[i]) return false;
  for (let i = pivot + 1; i < 3; i++) {
    if (have[i] > want[i]) return true;
    if (have[i] < want[i]) return false;
  }
  return true;
}

/** What each template must pass once installed. A template without an entry fails loudly. */
const VERIFY = {
  site: async (app) => {
    sh('pnpm', ['run', 'typecheck'], { cwd: app });
    sh('pnpm', ['run', 'build'], { cwd: app });
    sh('pnpm', ['test'], { cwd: app });
    await serveAndCheck(app);
  },
};

// ─────────────────────────────────────────────────────────────────────────

if (reuse) {
  const app = resolve(reuse);
  const name = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')).airo?.template;
  if (!VERIFY[name]) throw new Error(`${app} is not a scaffold this script can verify (template "${name}")`);
  step(`verify "${name}" in ${app}`);
  await VERIFY[name](app);
  console.log(`    ${name}: ok`);
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), 'create-airo-e2e-'));
let ok = false;

try {
  step('build every package');
  sh('pnpm', ['-r', '--filter', './packages/*', 'build'], { cwd: REPO });

  const { TEMPLATES } = await import(join(CLI_DIR, 'dist/templates.js'));
  const templates = only.length ? only : TEMPLATES.map((t) => t.name);
  for (const name of templates) {
    if (!VERIFY[name]) throw new Error(`no end-to-end verifier for template "${name}" — add one to VERIFY`);
  }

  step('pack the framework packages');
  const tarballs = join(work, 'tarballs');
  mkdirSync(tarballs);
  const tarballFor = {};
  const versions = {};
  for (const dir of readdirSync(join(REPO, 'packages'))) {
    const manifest = JSON.parse(readFileSync(join(REPO, 'packages', dir, 'package.json'), 'utf8'));
    if (!manifest.name.startsWith('@airo-js/') || manifest.private) continue;
    const before = new Set(readdirSync(tarballs));
    sh('pnpm', ['pack', '--pack-destination', tarballs], {
      cwd: join(REPO, 'packages', dir),
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    const made = readdirSync(tarballs).find((f) => !before.has(f));
    if (!made) throw new Error(`pnpm pack produced nothing for ${manifest.name}`);
    tarballFor[manifest.name] = `file:${join(tarballs, made)}`;
    versions[manifest.name] = manifest.version;
    console.log(`    ${manifest.name} → ${made}`);
  }

  for (const name of templates) {
    step(`scaffold "${name}"`);
    const app = join(work, `${name}-app`);
    sh('node', [join(CLI_DIR, 'dist/cli.js'), app, '--template', name, '--yes'], { cwd: work });

    const pkgPath = join(app, 'package.json');
    const scaffolded = readFileSync(pkgPath, 'utf8');
    if (scaffolded.includes('workspace:')) throw new Error(`${name}: package.json contains a workspace: range`);
    const pkg = JSON.parse(scaffolded);
    for (const field of ['dependencies', 'devDependencies']) {
      for (const [dep, range] of Object.entries(pkg[field] ?? {})) {
        if (!dep.startsWith('@airo-js/')) continue;
        if (!versions[dep]) throw new Error(`${name}: depends on ${dep}, which this repo does not publish`);
        if (!caretAccepts(range, versions[dep])) {
          throw new Error(`${name}: ${dep}@${range} does not accept the packed ${versions[dep]}`);
        }
        pkg[field][dep] = tarballFor[dep];
      }
    }
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

    step(`install "${name}" (strict peers, no auto-install)`);
    sh(
      'pnpm',
      [
        'install',
        '--ignore-workspace',
        '--config.strict-peer-dependencies=true',
        '--config.auto-install-peers=false',
      ],
      { cwd: app },
    );

    step(`verify "${name}"`);
    await VERIFY[name](app);
    console.log(`    ${name}: ok`);
  }

  ok = true;
  console.log(`\ncreate-airo e2e: ${templates.length} template(s) passed`);
} finally {
  if (ok && !keep) {
    rmSync(work, { recursive: true, force: true });
  } else if (existsSync(work)) {
    console.log(`\nleft for inspection: ${work}`);
  }
}
