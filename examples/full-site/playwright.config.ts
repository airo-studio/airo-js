import { defineConfig } from '@playwright/test';

// Chromium only: one real browser is enough to prove the two claims the
// smoke cannot — that the gate paints, and that hydration adopts the
// server's DOM without repainting. `reuseExistingServer` lets CI (which
// already runs the server on :4317 for the smoke) and a developer with
// `pnpm dev` up share the config; with nothing listening it starts one.
const PORT = process.env.PORT ?? '4317';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    browserName: 'chromium',
  },
  webServer: {
    command: `PORT=${PORT} node dist/server.js`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
