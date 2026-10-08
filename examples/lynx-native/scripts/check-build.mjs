/**
 * After `pnpm build`: the native bundle carries what @airo-js/lynx/build is
 * for. A unit test proves each piece on its own; this proves them inside a
 * real rsbuild + Lynx build, where a renamed chain entry or a reordered
 * loader would otherwise pass every unit test and still ship black text.
 *
 *   - the bundle's page config has `"enableCSSInheritance":true`;
 *   - the stylesheet reached the encoder normalised: no `color-mix()`,
 *     `inline-flex` or `calc()` left, and the page / tag / mirror classes in;
 *   - the report was written, and counts what this stylesheet exercises.
 */

import { readFileSync } from 'node:fs';

const dist = new URL('../dist/', import.meta.url);
const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

const bundle = readFileSync(new URL('main.lynx.bundle', dist)).toString('latin1');
const report = JSON.parse(readFileSync(new URL('airo-lynx-report.json', dist), 'utf8'));

check(/"enableCSSInheritance":true/.test(bundle), 'bundle page config does not enable CSS inheritance');
check(!/"enableCSSInheritance":false/.test(bundle), 'bundle page config still says enableCSSInheritance false');
for (const gone of ['color-mix', 'inline-flex', 'calc(', 'focus-visible']) {
  check(!bundle.includes(gone), `"${gone}" reached the encoder`);
}
for (const present of ['airo-lynx-page', 'airo-lynx-dark', 'tag-h1', 'a-hidden', 'a-aria-expanded--true']) {
  check(bundle.includes(present), `"${present}" is missing from the encoded stylesheet`);
}

const expected = {
  'page-selector': 1,
  'type-selector': 3,
  'attribute-selector': 3,
  'inline-flex': 2,
  'font-shorthand': 1,
  calc: 1,
  'aspect-ratio-width': 1,
  'color-mix': 4,
  'color-scheme-media': 1,
};
for (const [kind, n] of Object.entries(expected)) {
  check(report.rewrites[kind] === n, `report: ${kind} is ${report.rewrites[kind]}, expected ${n}`);
}
check(
  report.rejectedSelectors.some((s) => s.selector === '.panel__toggle:focus-visible'),
  'report: the :focus-visible selector is not listed as rejected',
);
check(Array.isArray(report.removedProperties), 'report: no removedProperties section');

if (failures.length) {
  console.error(`lynx-native build check failed:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log(`lynx-native build check: ok (${bundle.length} byte bundle, inheritance on, ${Object.values(report.rewrites).reduce((a, b) => a + b, 0)} rewrites)`);
