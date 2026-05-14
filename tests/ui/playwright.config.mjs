import { defineConfig, devices } from '@playwright/test'

/* Run UI tests against live URLs by default — the whole point is to verify
   what the user actually sees, not a local sandbox. Override with
   PLAYWRIGHT_BASE_URL_*= for staging or a local server. */
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.mjs',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 4,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    actionTimeout: 8_000,
    navigationTimeout: 20_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'mobile-chromium',  use: { ...devices['Pixel 7'] } },
  ],
})
