import { defineConfig, devices } from '@playwright/test';

// Playwright is this repo's committed test runner as of the Cloud Chaburah
// Phase 1 baseline. Before this there was no runner at all -- verification was
// done with throwaway scripts that left no regression coverage behind.
//
// The browser binary is resolved from PLAYWRIGHT_BROWSERS_PATH when set (CI
// images and this project's dev container ship Chromium pre-installed at
// /opt/pw-browsers); otherwise Playwright falls back to its own download
// location, so `npx playwright install chromium` is all a fresh machine needs.

const PORT = Number(process.env.PORT || 8941);

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.mjs',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  timeout: 30000,
  expect: { timeout: 7000 },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    // The plan's mobile requirements (single column, 44px targets, bottom nav)
    // need a real mobile viewport, not just a narrow desktop window.
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'node tests/static-server.mjs',
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'pipe',
    timeout: 20000,
  },
});
