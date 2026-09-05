import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // happy-dom by default for the DOM-touching units (style, theme).
    // The pure ones (pipeline, breadcrumb) and parse-html override to
    // `node` per-file — parse-html deliberately runs with NO global
    // document so its env-agnostic seam is exercised rather than assumed.
    environment: 'happy-dom',
    include: ['test/**/*.test.ts'],
  },
});
