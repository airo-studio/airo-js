import { defineConfig } from 'vitest/config';

// Parity run against jsdom — same files as vitest.config.ts under jsdom's DOM
// implementation. Carried over when these tests moved here from
// `@airo-js/runtime`, where they had it: `initLogControls` reads
// `window.location` and writes `localStorage`, and it is called directly by
// consumers whose own suites run under jsdom (React + RTL). A control surface
// that works in happy-dom and breaks in jsdom is a shipped break, and only a
// second environment catches it.
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.ts'],
    name: 'jsdom-parity',
  },
});
