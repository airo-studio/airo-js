import { defineConfig } from 'vitest/config';

import { airoAliases } from '../../vitest.shared.js';

export default defineConfig({
  test: {
    // happy-dom by default for the DOM-touching units (style, theme).
    // The pure ones (pipeline, breadcrumb) and parse-html override to
    // `node` per-file — parse-html deliberately runs with NO global
    // document so its env-agnostic seam is exercised rather than assumed.
    environment: 'happy-dom',
    include: ['test/**/*.test.ts'],
  },
  // Resolve @airo-js/* to source, not a stale dist. See vitest.shared.ts.
  resolve: { alias: airoAliases },
});
