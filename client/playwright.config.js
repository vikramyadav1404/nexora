import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests for what the unit and mount suites cannot see: the session
 * (login, the refresh-token cycle, logout) and flows that only break after an
 * interaction.
 *
 * They run the production build (`vite preview`) in a real browser, with the
 * API answered by a stateful mock in e2e/mockApi.js. The server has its own
 * suites; these are about the client behaving correctly against the API's
 * contract, including its failure answers.
 *
 * Browser: Playwright's Chromium in CI (`npx playwright install chromium`).
 * Locally, PLAYWRIGHT_CHANNEL=chrome uses an installed Chrome instead.
 */
const PORT = 4173;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    // public/sw.js would fetch on the page's behalf, and service-worker
    // requests bypass page.route -- they would reach the real network.
    serviceWorkers: 'block',
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {})
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npm run build && npx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // Built as production builds are, so it renders what users see: no
    // environment banner (the mock /api/version also says production).
    env: { VITE_ENVIRONMENT: 'production' }
  }
});
