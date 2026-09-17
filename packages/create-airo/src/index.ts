/**
 * create-airo — scaffold an airo-js project.
 *
 *   npm create airo@beta my-app
 *
 * This package is a command, not a library. Its module entry exposes only its
 * identity; the command lives in `cli.ts` → `run.ts`.
 *
 * `VERSION` is declared here, and not in a module `run.ts` could import
 * without a cycle, because `scripts/publish.sh` asserts it matches
 * package.json by reading this exact file. `run.ts` imports it from here;
 * nothing here imports `run.ts`, so there is no cycle.
 */

export const PACKAGE_NAME = 'create-airo';
/** Package version — publish preflight asserts this matches package.json. */
export const VERSION = '1.0.0-beta.1';
