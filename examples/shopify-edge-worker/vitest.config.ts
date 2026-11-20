import { defineConfig } from 'vitest/config';

import { airoAliases } from '../../vitest.shared.js';

// The worker's route tests drive `fetch` directly — no Wrangler runtime — with
// the upstream Shopify / WordPress calls stubbed. They run in CI's examples
// job, not under the root `pnpm test` (which filters to ./packages/*).
export default defineConfig({
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
  // Resolve @airo-js/* to source, not a stale dist. See vitest.shared.ts.
  resolve: { alias: airoAliases },
});
