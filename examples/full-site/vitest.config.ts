import { defineConfig } from 'vitest/config';

import { airoAliases } from '../../vitest.shared.js';

// The example's unit tests mount the cartridge under happy-dom with `fetch`
// mocked — the gate's precheck, the sign-in panel, session expiry between
// the render and the hydrate fetch. They run in CI's examples job, not
// under the root `pnpm test` (which filters to ./packages/*).
export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['test/**/*.test.ts'],
  },
  // Resolve @airo-js/* to source, not a stale dist. See vitest.shared.ts.
  resolve: { alias: airoAliases },
});
