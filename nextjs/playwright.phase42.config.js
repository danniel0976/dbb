// @ts-check
const { defineConfig, devices } = require('@playwright/test')

const APP_ORIGIN = 'http://localhost:34242'

module.exports = defineConfig({
  testDir: './tests',
  testMatch: 'phase42-library-price-rendered-uat.spec.js',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  globalSetup: require.resolve('./scripts/phase42-uat-harness.mjs'),
  use: {
    baseURL: APP_ORIGIN,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [{
    name: 'phase42-isolated-chromium',
    use: { ...devices['Desktop Chrome'] },
  }],
  webServer: {
    command: 'node scripts/phase42-uat-harness.mjs serve',
    url: `${APP_ORIGIN}/login`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
