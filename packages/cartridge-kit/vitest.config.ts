import { defineConfig } from 'vitest/config';

import { airoAliases } from '../../vitest.shared.js';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
  // Resolve @airo-js/* to source, not a stale dist. See vitest.shared.ts.
  resolve: { alias: airoAliases },
});
