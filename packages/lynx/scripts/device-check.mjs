#!/usr/bin/env node
/**
 * The manual device check for @airo-js/lynx: run a built card on the iOS
 * simulator and record what the engine did with it.
 *
 * gstack-shortcut(dec-f720d431): this runs by hand at the tracer and
 * propagation milestones instead of as a nightly macOS CI job. Ceiling:
 * a Lynx toolchain regression goes unnoticed between milestones. Upgrade to
 * a nightly job when a milestone run finds a regression a nightly job would
 * have caught, or whenever a @lynx-js/* dependency is bumped.
 *
 * What it does, in order:
 *
 *   1. serves the built card (`--dist`, the directory holding
 *      main.lynx.bundle) and a report collector on one port;
 *   2. picks the booted simulator (or boots `--udid`), installs `--app` if
 *      given, and launches Lynx Explorer straight into the bundle through
 *      the `lynx_initial_url` launch environment (no typing, no prompt);
 *   3. waits for the card's first device report (`@airo-js/lynx/device`,
 *      posted by the background thread), screenshots the simulator, and
 *      writes every report plus a summary to `--out`;
 *   4. with `--watch <seconds>`, keeps collecting while someone taps through
 *      the card: a card that calls `reportOnTouch` sends a report after
 *      every touch, and each one is printed with what changed since the last.
 *
 * The card must be built with the collector's url, for example:
 *
 *   AIRO_LYNX_COLLECTOR=http://localhost:3299/__collect pnpm --filter @airo-js-examples/lynx-native build
 *   node packages/lynx/scripts/device-check.mjs --dist examples/lynx-native/dist --out .tmp/device-run
 *
 * Taps cannot be scripted (simctl has no tap, and `__DispatchEvent` does not
 * reach `__AddEventListener` listeners on iOS); the tap checks in the test
 * plan are done by hand during `--watch`, and recorded by `reportOnTouch`.
 */

import { execFileSync, spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, arg, i, all) => {
    if (arg.startsWith('--')) acc.push([arg.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? 'true' : all[i + 1]]);
    return acc;
  }, []),
);

if (!args.dist || !args.out) {
  console.error('usage: device-check.mjs --dist <dir with main.lynx.bundle> --out <dir> [--port 3299] [--udid <id>] [--app <LynxExplorer.app>] [--bundle main.lynx.bundle] [--timeout 30] [--watch 0]');
  process.exit(2);
}

const dist = resolve(args.dist);
const out = resolve(args.out);
const port = Number(args.port ?? 3299);
const bundleName = args.bundle ?? 'main.lynx.bundle';
const timeoutMs = Number(args.timeout ?? 30) * 1000;
const watchMs = Number(args.watch ?? 0) * 1000;
const bundleUrl = `http://localhost:${port}/${bundleName}`;

if (!existsSync(join(dist, bundleName))) {
  console.error(`no ${bundleName} in ${dist}; build the card first`);
  process.exit(1);
}
// A card built without the collector's url sends its reports nowhere; say so
// now rather than after a silent wait.
const collectorUrl = `http://localhost:${port}/__collect`;
if (!readFileSync(join(dist, bundleName)).toString('latin1').includes(collectorUrl)) {
  console.error(
    `${bundleName} does not contain ${collectorUrl}, so its reports would go nowhere. Rebuild the card with the collector, e.g.\n  AIRO_LYNX_COLLECTOR=${collectorUrl} pnpm --filter @airo-js-examples/lynx-native build`,
  );
  process.exit(1);
}
mkdirSync(out, { recursive: true });

// ── 1. server: the bundle, and the collector ─────────────────────────────────

const reports = new Map();
let previous = null;
let firstReport;
const firstReportArrived = new Promise((r) => {
  firstReport = r;
});

/** What a report shows that the one before it did not: new text, and elements whose classes changed. */
function changes(prev, cur) {
  if (!prev) return [];
  const label = (e) => e.classes.split(' ')[0] || e.tag;
  const texts = (r) => (r.elements ?? []).filter((e) => e.text).map((e) => `${label(e)} "${e.text}"`);
  const before = new Set(texts(prev));
  const beforeClasses = new Set((prev.elements ?? []).map((e) => e.classes));
  return [
    ...texts(cur).filter((t) => !before.has(t)).map((t) => `text ${t}`),
    ...(cur.elements ?? []).filter((e) => !beforeClasses.has(e.classes)).map((e) => `classes ${e.classes}`),
  ].slice(0, 10);
}

const TYPES = { '.bundle': 'application/octet-stream', '.json': 'application/json', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  if (req.method === 'POST' && url.pathname === '/__collect') {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const name = (url.searchParams.get('name') ?? 'report').replace(/[^\w.-]/g, '_');
      if (!body) {
        console.log(`[device-check] ${name}: empty body (the macOS Explorer does this; use the iOS simulator)`);
      } else {
        writeFileSync(join(out, `${name}.json`), body);
        const report = JSON.parse(body);
        reports.set(name, report);
        console.log(`[device-check] report ${name}: ${report.elements?.length ?? '?'} elements, ${report.extra?.errors?.length ?? 0} errors, nav ${JSON.stringify(report.extra?.nav?.page ?? null)}`);
        for (const line of changes(previous, report)) console.log(`[device-check]   ${line}`);
        report.changes = changes(previous, report);
        previous = report;
        firstReport(report);
      }
      res.statusCode = 204;
      res.end();
    });
    return;
  }
  const file = join(dist, url.pathname);
  if (!file.startsWith(dist) || !existsSync(file) || !statSync(file).isFile()) {
    res.statusCode = 404;
    res.end();
    return;
  }
  res.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream');
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(port, '0.0.0.0', r));
console.log(`[device-check] serving ${dist} and the collector on http://localhost:${port}`);

// ── 2. simulator ─────────────────────────────────────────────────────────────

const simctl = (...a) => execFileSync('xcrun', ['simctl', ...a], { encoding: 'utf8', timeout: 60_000 });
const booted = () => {
  const list = JSON.parse(simctl('list', 'devices', 'booted', '-j')).devices;
  return Object.values(list).flat()[0];
};
let udid = args.udid;
if (udid) {
  try {
    simctl('boot', udid);
  } catch {
    // already booted
  }
} else {
  udid = booted()?.udid;
  if (!udid) {
    console.error('no booted simulator; boot one or pass --udid');
    server.close();
    process.exit(1);
  }
}
if (args.app) simctl('install', udid, resolve(args.app));

// `simctl terminate` can hang in a non-interactive shell; launching with
// --terminate-running-process restarts the Explorer in one call instead.
const launch = spawn('xcrun', ['simctl', 'launch', '--terminate-running-process', udid, 'com.lynx.LynxExplorer'], {
  env: { ...process.env, SIMCTL_CHILD_lynx_initial_url: bundleUrl },
  stdio: 'inherit',
});
await new Promise((r) => launch.on('exit', r));
console.log(`[device-check] launched Lynx Explorer on ${udid} with ${bundleUrl}`);

// ── 3. first report, screenshot, summary ────────────────────────────────────

const first = await Promise.race([firstReportArrived, new Promise((r) => setTimeout(() => r(null), timeoutMs))]);
if (!first) {
  console.error(`[device-check] no report within ${timeoutMs / 1000}s. Was the card built with AIRO_LYNX_COLLECTOR=http://localhost:${port}/__collect?`);
}
await new Promise((r) => setTimeout(r, 1000));
try {
  simctl('io', udid, 'screenshot', join(out, 'screen.png'));
  console.log(`[device-check] screenshot: ${join(out, 'screen.png')}`);
} catch (err) {
  console.error(`[device-check] screenshot failed: ${err.message}`);
}

if (watchMs > 0) {
  console.log(`[device-check] watching for ${watchMs / 1000}s: tap through the card now`);
  await new Promise((r) => setTimeout(r, watchMs));
  try {
    simctl('io', udid, 'screenshot', join(out, 'screen-after.png'));
  } catch {
    // keep the reports even when the second screenshot fails
  }
}

const summarise = (name, report) => {
  const byTag = {};
  for (const el of report.elements ?? []) byTag[el.tag] = (byTag[el.tag] ?? 0) + 1;
  const sized = (report.elements ?? []).filter((e) => e.rect && typeof e.rect === 'object');
  return [
    `## ${name}`,
    '',
    ...(report.platform && report.platform !== 'unknown' ? [`- platform: ${report.platform}, sdk: ${report.sdk}`] : []),
    `- elements: ${report.elements?.length ?? 0} (${Object.entries(byTag).map(([t, n]) => `${t} ${n}`).join(', ')})`,
    `- layout boxes answered: ${sized.length}`,
    `- navigation: ${JSON.stringify(report.extra?.nav ?? null)}`,
    `- errors: ${report.extra?.errors?.length ? `\n${report.extra.errors.map((e) => `  - ${e}`).join('\n')}` : 'none'}`,
    ...(report.changes?.length ? [`- changed since the previous report:\n${report.changes.map((c) => `  - ${c}`).join('\n')}`] : []),
    '',
  ].join('\n');
};
const summary = [
  `# Device check — ${new Date().toISOString()}`,
  '',
  `Bundle: ${bundleUrl} (${statSync(join(dist, bundleName)).size} bytes). Simulator: ${udid}.`,
  '',
  ...[...reports].map(([name, report]) => summarise(name, report)),
].join('\n');
writeFileSync(join(out, 'summary.md'), summary);
console.log(`[device-check] ${reports.size} report(s); summary: ${join(out, 'summary.md')}`);
if (existsSync(join(out, 'summary.md'))) console.log(readFileSync(join(out, 'summary.md'), 'utf8'));
server.close();
process.exit(first ? 0 : 1);
