import { defineConfig } from 'vitest/config';

import { airoAliases } from '../../vitest.shared.js';

export default defineConfig({
  test: {
    // Node, not a DOM environment: the runtime entry runs on the Lynx main
    // thread, which has no `window` or `document`. A test that passes only
    // because happy-dom supplied a global would pass for the wrong reason.
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
  // Resolve @airo-js/* to source, not a stale dist. See vitest.shared.ts.
  resolve: { alias: airoAliases },
});
