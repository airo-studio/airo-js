/**
 * The Node versions a scaffolded project runs on, and the check that says so
 * before anything is written.
 *
 * ## Why the CLI checks it
 *
 * The CLI itself has no dependencies and runs on far older Node than the
 * project it writes, so `npm create airo` succeeds on Node 20. The scaffold's
 * devDependencies do not: Vitest 5 needs Node `^22.12 || ^24 || >=26`, and
 * the template's own `engines` says `^22.12.0 || >=24.0.0`. (The range is
 * deliberately the template's, not Vitest's: it stays open on Node 25, which
 * Vitest 5 does not declare, rather than second-guess an odd-numbered release.) Without this the first sign of the problem is an
 * `npm install` full of engine warnings, then a `npm run verify` that dies
 * somewhere inside Vitest. Saying it here costs one comparison.
 *
 * `NODE_ENGINES` is the string the template's package.json carries, and
 * `test/node-support.test.ts` fails if the two disagree, so there is one
 * answer rather than two that drift. `isSupportedNode` implements exactly
 * that range; it is hand-written because the CLI takes no semver dependency.
 */

export const NODE_ENGINES = '^22.12.0 || >=24.0.0';

/** Whether `version` (`process.versions.node`, e.g. `22.12.1`) satisfies `NODE_ENGINES`. */
export function isSupportedNode(version: string): boolean {
  const [major, minor] = version.split('.').map((part) => Number.parseInt(part, 10));
  if (major === undefined || minor === undefined || Number.isNaN(major) || Number.isNaN(minor)) return false;
  return major >= 24 || (major === 22 && minor >= 12);
}
