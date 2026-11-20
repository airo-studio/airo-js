import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Node, not a DOM: this package never runs in a browser.
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Some cases scaffold real directories and shell out to `npm pack`.
    testTimeout: 30_000,
  },
});
