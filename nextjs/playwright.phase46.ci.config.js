// @ts-check
//
// GitHub Actions variant of playwright.phase46.config.js. Same spec, same
// origins, same fixture identities — only the harness differs, because the
// Mac harness is host-locked by design. See scripts/phase46-uat-harness-ci.mjs.
const { defineConfig, devices } = require('@playwright/test')

const APP_ORIGIN = 'http://localhost:34242'

module.exports = defineConfig({
  testDir: './tests',
  testMatch: 'phase46-backlog-fastfollow-rendered-uat.spec.js',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: 'list',
  globalSetup: require.resolve('./scripts/phase46-uat-harness-ci.mjs'),
  use: {
    baseURL: APP_ORIGIN,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [{
    name: 'phase46-ci-chromium',
    use: { ...devices['Desktop Chrome'] },
  }],
  webServer: {
    command: 'node scripts/phase46-uat-harness-ci.mjs serve',
    url: `${APP_ORIGIN}/login`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
