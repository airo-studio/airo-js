import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Node, not happy-dom: MCP is server-only by intent (see src/index.ts,
    // "Envelope"). A DOM here would let a browser-only mistake pass.
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
