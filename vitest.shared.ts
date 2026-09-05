import { fileURLToPath } from 'node:url';

/**
 * Workspace aliases for every package's vitest run.
 *
 * Without these, a cross-package import in a test resolves through
 * `node_modules` to the target package's **built `dist/`**, because that is
 * what its `main`/`exports` point at. Two consequences, both bad:
 *
 *   1. `pnpm test` passes against a STALE build. Edit
 *      `cartridge-kit/src/coverage.ts`, run the suite, and the 142 mcp + ssr
 *      tests that exercise `missingRequiredPaths` keep testing yesterday's
 *      copy — green while the source is broken. That is precisely inverted
 *      for a predicate extracted so two packages "cannot disagree".
 *   2. A fresh clone has no `dist/` at all, so the same suites fail outright
 *      until someone runs `pnpm build` first.
 *
 * Pointing the aliases at `src/index.ts` makes every run compile the current
 * source. Prefer this over adding `pnpm build` to the test script: it is
 * faster, and it removes the fresh-clone failure rather than papering over it.
 *
 * Subpath exports get their own entry — `@airo-js/runtime/test-harness` is a
 * declared export and would otherwise fall through to `dist`.
 */
const pkg = (name: string, entry = 'src/index.ts'): string =>
  fileURLToPath(new URL(`./packages/${name}/${entry}`, import.meta.url));

export const airoAliases: Record<string, string> = {
  '@airo-js/core': pkg('core'),
  '@airo-js/cartridge-kit': pkg('cartridge-kit'),
  '@airo-js/runtime/test-harness': pkg('runtime', 'src/test-harness.ts'),
  '@airo-js/runtime': pkg('runtime'),
  '@airo-js/ssr': pkg('ssr'),
  '@airo-js/embed': pkg('embed'),
  '@airo-js/mcp': pkg('mcp'),
  '@airo-js/log': pkg('log'),
};
