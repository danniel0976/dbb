// @ts-check
const { defineConfig, devices } = require('@playwright/test');
const { assertHarnessBackendEnv } = require('./tests/helpers/local-backend-guard');
const { assertIsolatedBuildReceipt } = require('./tests/helpers/isolated-build-receipt');

/**
 * Dedicated configuration for the Phase 45C Claim Sale rendered UAT — the only
 * supported route for running that suite.
 * @see https://playwright.dev/docs/test-configuration
 */

// Why this suite needs a config of its own.
//
// The suite mutates real rows: it adds to the cart, checks out, and leaves an
// unpaid order that its own teardown cancels. None of those writes happen in the
// browser. /api/cart and /api/checkout build their Supabase clients server-side
// from NEXT_PUBLIC_SUPABASE_URL read at request time, so the only thing that
// decides where a checkout writes is the environment the Next.js *process* was
// started with. tests/helpers/local-backend-guard.js pins that by asserting this
// harness's own environment, and Playwright's `webServer` child inherits it —
// but only for a server this run actually started.
//
// Attaching to a pre-existing listener breaks that chain completely: a server
// built against loopback but *started* from `.env.local` passes the client
// bundle scan and the browser request guard while every mutation lands on the
// phone-facing Tailscale backend. Port 3000 is where that hazard lives — Dan's
// long-lived server.
//
// So this config, unconditionally and with no dependence on how it was invoked:
//   * requires an explicit numeric PW_PORT that is not the shared 3000, and
//     throws at config load — before any server is started or test collected —
//     when one is not supplied;
//   * sets reuseExistingServer: false, so Playwright starts and owns the server
//     it tests and fails loudly rather than silently attaching if the port is
//     already taken;
//   * binds that server to loopback only, so the isolated instance is not
//     reachable from the phone-facing interface while it holds fixture state;
//   * restricts `testMatch` to the mutating suite, so this isolated server is
//     never quietly used to run something else;
//   * names the isolated app origin explicitly and hands the child both
//     NEXT_PUBLIC_SITE_URL and the approved loopback NEXT_PUBLIC_SUPABASE_URL,
//     rather than letting either come from the ambient environment.
//
// Why the site URL belongs here at all. The backend is not the only thing a
// build is wired to: src/middleware.js turns every unauthenticated hit on a
// protected path into a redirect built from NEXT_PUBLIC_SITE_URL, and
// `.env.local` points that at the phone-facing shared server. A candidate that
// pins only the Supabase URL therefore answers the first protected navigation
// by sending the browser — with the fixture session cookies — to a different
// application instance, which may be a LAN dev server, a staging deployment or
// Dan's long-lived 3000. The loopback backend guard cannot see it: the redirect
// target is not Supabase-shaped, and only the Tailscale case happens to look
// like a backend hazard. So the origin is pinned here, the request guard aborts
// any cross-origin app traffic at runtime, and the build must supply it too.
//
// Nothing here inspects process.argv. Scope is a property of which config is
// selected, not of a hand-written parse of the command line: the default
// playwright.config.js excludes this suite via `testIgnore`, and this config
// admits nothing else.
//
// Run with — both NEXT_PUBLIC_* values in the guarded build command. Next.js inlines
// NEXT_PUBLIC_* at build time, so the site origin the middleware redirects to
// is decided by the build, not by the environment this config hands the server;
// the runtime value below is the second line of defence, not the first. The
// port in NEXT_PUBLIC_SITE_URL must be the PW_PORT the run uses. Create the
// disposable candidate outside the source worktree, copy this package into it,
// then run the guard from the candidate itself; it refuses a source CWD before
// it can overwrite source `.next`.
//   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 \
//     NEXT_PUBLIC_SITE_URL=http://localhost:3100 \
//     node scripts/phase45c-build-isolated-candidate.mjs \
//       --source /absolute/path/to/source/nextjs --candidate "$PWD" --port 3100
//   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 PW_PORT=3100 \
//     PHASE45C_ISOLATED_BUILD_RECEIPT="$PWD/.phase45c-isolated-build-receipt.json" \
//     npx playwright test --config playwright.claim-sale.config.js
const MUTATING_SUITE = 'tests/phase45c-claim-sale-uat.spec.js';
const SHARED_PORT = '3000';

function resolveIsolatedPort(env) {
  const raw = String(env.PW_PORT == null ? '' : env.PW_PORT).trim();
  const remedy =
    'Re-run with an unused port of its own, e.g. PW_PORT=3100 npx playwright test '
    + '--config playwright.claim-sale.config.js';
  if (!raw) {
    throw new Error(
      `playwright.claim-sale.config.js: ${MUTATING_SUITE} mutates real cart/checkout/order rows `
      + 'and may only run against a server this run starts, so its backend environment is the one '
      + `pinned by the harness. PW_PORT is unset, and the shared ${SHARED_PORT} server is never a `
      + `legal target. ${remedy}`);
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`playwright.claim-sale.config.js: PW_PORT=${raw} is not a port number. ${remedy}`);
  }
  if (Number(raw) === Number(SHARED_PORT)) {
    throw new Error(
      `playwright.claim-sale.config.js: PW_PORT=${raw} is the shared long-lived server port. `
      + `${MUTATING_SUITE} must not run against it: that process was not started by this run, `
      + 'so its server-side NEXT_PUBLIC_SUPABASE_URL is unknown and its mutations can leave '
      + `loopback. ${remedy}`);
  }
  return raw;
}

// Throws here, at config load, before any server is started or test collected.
const PORT = resolveIsolatedPort(process.env);

// The one application origin this suite may drive, derived from the isolated
// port so it cannot drift from the server this config starts.
const ISOLATED_APP_ORIGIN = `http://localhost:${PORT}`;

// Also at config load, before a server exists: the backend the mutating API
// routes will resolve at request time. The helper that owns the loopback
// contract is the one asked, so an override can never widen it here either.
const ISOLATED_BACKEND_ORIGIN = assertHarnessBackendEnv();

// Handed to the webServer child explicitly. Playwright merges this over
// process.env, so `.env.local`'s phone-facing values lose to both of these
// rather than being inherited by the server that holds fixture state.
const ISOLATED_SERVER_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: ISOLATED_BACKEND_ORIGIN,
  NEXT_PUBLIC_SITE_URL: ISOLATED_APP_ORIGIN,
};

// A loopback config is not enough: an operator could still invoke `npm run
// build` in the protected source directory, then point this config at it. The
// build wrapper writes this receipt only after its source-hash check succeeds.
// Config load refuses before Playwright starts a server or collects a test when
// the receipt is absent, forged, source-bound, or wired to different origins.
assertIsolatedBuildReceipt({
  configRoot: __dirname,
  port: PORT,
  backendOrigin: ISOLATED_BACKEND_ORIGIN,
  appOrigin: ISOLATED_APP_ORIGIN,
});

module.exports = defineConfig({
  testDir: './tests',
  // This isolated, self-started server exists for the mutating suite alone.
  testMatch: '**/phase45c-claim-sale-uat.spec.js',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // A retry re-runs a test that mutates rows. Teardown restores the fixture
  // after every test, but a deterministic single attempt is what the evidence
  // for this suite is read from.
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: ISOLATED_APP_ORIGIN,
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
    // IPv4-loopback-bound: this instance holds fixture state and must not be
    // reachable from the phone-facing interface while it does. The runtime
    // guards therefore never treat the unbound IPv6 `[::1]` origin as owned.
    command: `npm run start -- -p ${PORT} -H 127.0.0.1`,
    url: ISOLATED_APP_ORIGIN,
    // Never reused: attaching to a pre-existing listener would test a process
    // whose environment this run never set.
    reuseExistingServer: false,
    // Neither the backend nor the site origin is left to the ambient
    // environment; both are the isolated values resolved above.
    env: ISOLATED_SERVER_ENV,
    timeout: 120000,
  },
});
