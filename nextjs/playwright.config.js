// @ts-check
const { defineConfig, devices } = require('@playwright/test');

/**
 * Default, read-only Playwright configuration.
 * @see https://playwright.dev/docs/test-configuration
 */

// The Phase 45C Claim Sale suite mutates real rows (cart add, checkout, order
// transition). Those writes do not happen in the browser: /api/cart and
// /api/checkout build their Supabase clients server-side from
// NEXT_PUBLIC_SUPABASE_URL read at request time, so the only thing that decides
// where they write is the environment of the Next.js *process*.
// tests/helpers/local-backend-guard.js pins that by asserting this harness's own
// environment — which is sound only while the server under test is one this run
// started and therefore handed its environment to.
//
// This config does not start such a server: it defaults to the shared port 3000
// and reuses whatever is already listening there, which is Dan's long-lived
// server — a process this run never launched, built and started from unknown
// environment. So the mutating suite is removed from this config's universe
// outright.
//
// `testIgnore` is the right instrument because Playwright applies it itself,
// against the resolved absolute path of every candidate file, *after* positional
// filters have been applied. There is therefore no selection form — bare
// filename, `tests/`-prefixed, `./`-prefixed, absolute path, `--grep`, or a
// regex fragment such as `claim-sale` — that can bring the suite back into a run
// of this config. Deciding scope by parsing `process.argv` was the previous
// approach and is deliberately gone: a hand-written parser has to model every
// present and future Playwright flag correctly, and any gap in it silently
// re-admits the mutating suite onto the shared server.
//
// The one supported route for that suite is playwright.claim-sale.config.js,
// which owns the server it tests:
//
//   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 npm run build
//   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 PW_PORT=3100 \
//     npx playwright test --config playwright.claim-sale.config.js
const MUTATING_SUITE_IGNORE = '**/phase45c-claim-sale-uat.spec.js';

// Read-only suites may run against the shared server; nothing here writes.
const PORT = process.env.PW_PORT || '3000';

module.exports = defineConfig({
  testDir: './tests',
  testIgnore: MUTATING_SUITE_IGNORE,
  fullyParallel: false, // One test at a time to avoid VPS capacity issues
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: `npm run start -- -p ${PORT} -H 0.0.0.0`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
