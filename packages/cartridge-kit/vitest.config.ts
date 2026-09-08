import { defineConfig } from 'vitest/config';

import { airoAliases } from '../../vitest.shared.js';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // `*.test-d.ts` files are compile-time contracts (`@ts-expect-error`
    // lines that must stay errors). `pnpm typecheck` never sees test/ —
    // the package tsconfig includes only src/ — so without this they would
    // be checked by nobody. Runs tsc over just those files as part of
    // `vitest run`.
    typecheck: {
      enabled: true,
      include: ['test/**/*.test-d.ts'],
      // NOT the package tsconfig: that one is `composite` with
      // `rootDir: ./src`, which rejects a test file at the config level,
      // and vitest reports a run that produced only config errors as "no
      // errors" — a wrong path sailed through until this was split out.
      tsconfig: './tsconfig.typecheck.json',
    },
  },
  // Resolve @airo-js/* to source, not a stale dist. See vitest.shared.ts.
  resolve: { alias: airoAliases },
});
