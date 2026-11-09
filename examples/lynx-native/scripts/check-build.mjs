/**
 * After `pnpm build`: the native bundle carries what @airo-js/lynx/build is
 * for. A unit test proves each piece on its own; this proves them inside a
 * real rsbuild + Lynx build, where a renamed chain entry or a reordered
 * loader would otherwise pass every unit test and still ship black text.
 *
 *   - the bundle's page config has `"enableCSSInheritance":true`;
 *   - the stylesheet reached the encoder normalised: no `color-mix()`,
 *     `oklch()` (tokens included), `inline-flex` or `calc()` left, and the
 *     page / tag / mirror classes in;
 *   - the bundle is one chunk: a split chunk (`exports.ids=…`) is CommonJS
 *     the vanilla loader runs on neither thread, and the card never starts;
 *   - nothing after the normaliser undid it: no `inset` reached the encoder
 *     (lightningcss merges four sides back into one, which the encoder removes),
 *     and no `place-items` (the encoder removes the shorthand);
 *   - the report was written, and counts what this stylesheet exercises.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// `--dist <dir>` checks another build of this card (scripts/check-packed.mjs); the default is this one's.
const at = process.argv.indexOf('--dist');
const dist = at > -1 ? pathToFileURL(`${resolve(process.argv[at + 1])}/`) : new URL('../dist/', import.meta.url);
const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

const bundle = readFileSync(new URL('main.lynx.bundle', dist)).toString('latin1');
const report = JSON.parse(readFileSync(new URL('airo-lynx-report.json', dist), 'utf8'));

check(/"enableCSSInheritance":true/.test(bundle), 'bundle page config does not enable CSS inheritance');
check(!/exports\.ids=/.test(bundle), 'a split chunk reached the bundle (exports.ids=…): the card would not start on device');
check(!/"enableCSSInheritance":false/.test(bundle), 'bundle page config still says enableCSSInheritance false');
for (const gone of ['color-mix', 'oklch', 'inline-flex', 'calc(', 'focus-visible']) {
  check(!bundle.includes(gone), `"${gone}" reached the encoder`);
}
for (const present of [
  'airo-lynx-page',
  'airo-lynx-dark',
  'tag-h1',
  'a-hidden',
  'a-aria-expanded--true',
  'airo-lynx-empty',
  'airo-lynx-closed',
  'airo-lynx-modal',
  'airo-lynx-backdrop--sheet',
  'airo-lynx-checked',
]) {
  check(bundle.includes(present), `"${present}" is missing from the encoded stylesheet`);
}

const expected = {
  'page-selector': 1,
  'page-font-size': 1,
  'type-selector': 7,
  'attribute-selector': 5,
  'inline-flex': 2,
  'display-block': 2,
  'place-shorthand': 1,
  'font-shorthand': 1,
  calc: 1,
  'aspect-ratio-width': 2,
  'color-mix': 5,
  'colour-function': 13,
  'color-scheme-media': 1,
  'display-none-clip': 2,
  empty: 1,
  checked: 2,
  backdrop: 1,
};
for (const [kind, n] of Object.entries(expected)) {
  check(report.rewrites[kind] === n, `report: ${kind} is ${report.rewrites[kind]}, expected ${n}`);
}
check(
  report.rejectedSelectors.some((s) => s.selector === '.panel__toggle:focus-visible'),
  'report: the :focus-visible selector is not listed as rejected',
);
check(Array.isArray(report.removedProperties), 'report: no removedProperties section');
check(
  !report.removedProperties.some((p) => p.property === 'place-items'),
  'the encoder removed `place-items`: the normaliser no longer splits it into align-items and justify-items',
);
check(
  !report.removedProperties.some((p) => p.property === 'inset'),
  'the encoder removed `inset`: something after the normaliser merged top/right/bottom/left back into it',
);

if (failures.length) {
  console.error(`lynx-native build check failed:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log(`lynx-native build check: ok (${bundle.length} byte bundle, inheritance on, ${Object.values(report.rewrites).reduce((a, b) => a + b, 0)} rewrites)`);
