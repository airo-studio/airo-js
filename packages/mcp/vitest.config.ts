import { defineConfig } from 'vitest/config';

import { airoAliases } from '../../vitest.shared.js';

export default defineConfig({
  test: {
    // Node, not happy-dom: MCP is server-only by intent (see src/index.ts,
    // "Envelope"). A DOM here would let a browser-only mistake pass.
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
  // Resolve @airo-js/* to source, not a stale dist. See vitest.shared.ts.
  resolve: { alias: airoAliases },
});
