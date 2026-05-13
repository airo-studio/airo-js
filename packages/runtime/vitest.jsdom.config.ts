import { defineConfig } from 'vitest/config';

// Parity run against jsdom — runs the same test files as vitest.config.ts but
// under jsdom's DOM implementation. Catches consumer-env regressions that the
// happy-dom-only run misses (jsdom omits several DOM globals happy-dom exposes:
// `ShadowRoot`, etc.). Studio-side consumers use jsdom for React+RTL testing;
// shipping a framework primitive that breaks jsdom = shipping a known break.
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.ts'],
    name: 'jsdom-parity',
  },
});
