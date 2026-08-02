// Rendered evidence for the Phase 45C Claim Sales UAT repairs.
//
// Runs against the local disposable click-through fixture. It drives the real
// product paths only (login form, inspector, cart, checkout) — no direct DB
// writes — so the reserved state it observes is produced by an actual unpaid
// order, exactly as in Dan's UAT.
//
// Admission is fail-closed and loopback-only. `baseURL` being localhost proves
// nothing about the backend: `.env.local` points NEXT_PUBLIC_SUPABASE_URL at
// the phone-facing Tailscale address, so a default build serves a client wired
// to a non-loopback Supabase. Before any mutation, beforeEach
//   * pins the environment the Next.js server inherits — the cart and checkout
//     writes happen in `/api/cart` and `/api/checkout`, server-side, from
//     NEXT_PUBLIC_SUPABASE_URL read at request time, where neither the bundle
//     scan nor the browser guard can see them;
//   * resolves the Supabase URL the candidate server actually serves and
//     refuses to continue unless it is loopback;
//   * installs a request guard that aborts any Supabase-shaped request that
//     leaves it, and any request that addresses an application other than the
//     isolated one.
// That last clause is not decoration. src/middleware.js builds every auth
// redirect from NEXT_PUBLIC_SITE_URL, which `.env.local` points at the
// phone-facing shared server, so a build that pins only the Supabase URL
// answers the first protected navigation by sending this browser — fixture
// session cookies and all — to a different app instance. The backend guard
// cannot see that: a LAN or staging app origin is not Supabase-shaped.
//
// The environment pin only describes a server *this run started*. So this suite
// is excluded from the default playwright.config.js altogether (`testIgnore`,
// which no positional filter can undo) and has one supported route:
// playwright.claim-sale.config.js, which requires an explicit numeric non-3000
// PW_PORT, never reuses an existing listener, and hands its own child both
// isolated NEXT_PUBLIC_ values.
//
// Run with — both NEXT_PUBLIC_* values in the guarded build command, because Next.js
// inlines NEXT_PUBLIC_* at build time: the site origin the middleware redirects
// to is decided by the build, not by the environment the config hands the
// server. The port in NEXT_PUBLIC_SITE_URL must be the PW_PORT the run uses.
// Create/copy a candidate outside the source worktree, `cd` into it, then:
//   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 \
//     NEXT_PUBLIC_SITE_URL=http://localhost:3100 \
//     node scripts/phase45c-build-isolated-candidate.mjs \
//       --source /absolute/path/to/source/nextjs --candidate "$PWD" --port 3100
//   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 PW_PORT=3100 \
//     PHASE45C_ISOLATED_BUILD_RECEIPT="$PWD/.phase45c-isolated-build-receipt.json" \
//     npx playwright test --config playwright.claim-sale.config.js
//
// Teardown is not optional. Every test — including the one that deliberately
// creates an unpaid order — ends by proving the fixture cart is empty, no
// fixture order is open, no order-sourced reservation holds a fixture card,
// and both listings are active and offered again.
const { test, expect } = require('@playwright/test')
const {
  assertCandidateBackendIsLocal,
  assertHarnessBackendEnv,
  assertLocalBackendReachable,
  installBackendOriginGuard,
} = require('./helpers/local-backend-guard')
const { restoreFixture } = require('./helpers/phase45c-fixture-cleanup')

const DAN_EMAIL = 'dan@dbb.test'
const DAN_PASSWORD = 'password1234'
const CLAIM_SALE_ID = 'f6a68eae-de02-4b38-80de-dc2b2e4f0481'
const CARD = 'UAT Counterspell'

// The shared long-lived server. Never a legal target for this suite.
const SHARED_SERVER_PORT = '3000'
// The complete set of app origins this suite may drive, once the isolated port
// is known. A matching port is not an identity: `http://100.94.130.7:3100`
// carries PW_PORT exactly while being served over the phone-facing Tailscale
// interface, and `https://staging.example:3100` matches too. Only an http
// loopback origin on the isolated port describes a server this run started, so
// the whole origin — scheme, host and port — is what gets compared.
// The dedicated server command binds IPv4 only (`-H 127.0.0.1`). `[::1]` is
// loopback, but it is not an origin this run owns and must remain off this list.
const ISOLATED_APP_HOSTNAMES = ['localhost', '127.0.0.1']

// Second, independent layer of the isolation rule the dedicated
// playwright.claim-sale.config.js enforces at load time. That config is the only
// supported route and the default config cannot select this suite at all; if
// either arrangement is ever undone, or the suite is driven from a third
// config, the mutations must still refuse to run against a server this run did
// not start — the harness environment pin says nothing about a process it never
// launched. Cheap and re-run per test, like the environment pin itself.
function assertIsolatedServer(baseURL) {
  const port = String(process.env.PW_PORT == null ? '' : process.env.PW_PORT).trim()
  const remedy = 'Re-run through playwright.claim-sale.config.js with an unused loopback port of '
    + 'its own, e.g. PW_PORT=3100.'
  if (!port || !/^\d+$/.test(port) || Number(port) === Number(SHARED_SERVER_PORT)) {
    throw new Error(
      `server admission: this suite mutates cart/checkout/order rows and may only run against a `
      + `server this run started, but PW_PORT is ${port ? port : 'unset'}, which targets the `
      + `shared ${SHARED_SERVER_PORT} server whose server-side backend environment is unknown. `
      + remedy)
  }
  let servedOrigin = null
  try {
    servedOrigin = new URL(String(baseURL)).origin
  } catch {
    throw new Error(`server admission: baseURL ${baseURL} is not a parseable URL. ${remedy}`)
  }
  const approvedOrigins = ISOLATED_APP_HOSTNAMES.map(host => `http://${host}:${port}`)
  if (!approvedOrigins.includes(servedOrigin)) {
    throw new Error(
      `server admission: baseURL ${baseURL} resolves to origin ${servedOrigin}, which is not one `
      + `of the approved isolated origins ${approvedOrigins.join(', ')}. A matching port alone is `
      + 'not proof: a non-loopback host on the isolated port is a server this run did not start, '
      + 'so where its cart/checkout writes land is unknown. ' + remedy)
  }
  return port
}

// Resolved once per worker; the result is reused so every test still fails
// closed without re-downloading the bundle each time.
let admittedBackend = null
let activeGuard = null

test.beforeEach(async ({ page, request, baseURL }) => {
  activeGuard = null
  // Which server, before which backend: an admitted backend on a server this
  // run never started proves nothing about where its mutations land.
  assertIsolatedServer(baseURL)
  // Cheap, synchronous and re-run for every test: this is the only check that
  // covers the server-side cart/checkout writes, so it is never cached.
  assertHarnessBackendEnv()
  if (!admittedBackend) {
    await assertLocalBackendReachable({ request })
    admittedBackend = await assertCandidateBackendIsLocal({ request, baseURL })
  }
  activeGuard = await installBackendOriginGuard(page, { baseURL })
})

// Both halves always run and both failures are reported: a teardown that threw
// must never hide a backend violation, and a backend violation must never skip
// the restore that the next test depends on.
test.afterEach(async () => {
  const guard = activeGuard
  activeGuard = null
  const problems = []
  try {
    if (guard) guard.assertNoViolations()
  } catch (error) {
    problems.push(error.message)
  }
  try {
    await restoreFixture(CLAIM_SALE_ID)
  } catch (error) {
    problems.push(error.message)
  }
  if (problems.length > 0) throw new Error(problems.join('\n'))
})

async function login(page) {
  await page.goto('/login')
  await page.locator('input[type="email"]').fill(DAN_EMAIL)
  await page.locator('input[type="password"]').fill(DAN_PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(url => !url.pathname.startsWith('/login'), { timeout: 20000 })
}

function inspector(page) {
  return page.locator('[data-testid="claim-sale-inspector-panel"]')
}

async function openCard(page, name) {
  await page.goto(`/claim-sales/${CLAIM_SALE_ID}`)
  await page.getByRole('button', { name: new RegExp(`Inspect ${name}`) }).first().click()
  await expect(inspector(page)).toBeVisible()
}

test('dedicated /claim-sales page shows a loaded card thumbnail', async ({ page }) => {
  await page.goto('/claim-sales')
  const thumb = page.locator('[data-testid="claim-sale-thumbnail"]').first()
  await expect(thumb).toBeVisible()
  const img = thumb.locator('img')
  await expect(img).toHaveAttribute('alt', '')
  await expect.poll(
    () => img.evaluate(el => el.complete && el.naturalWidth),
    { timeout: 20000 },
  ).toBeGreaterThan(0)
  await page.screenshot({ path: 'test-results/phase45c-claim-sales-thumbnail.png', fullPage: true })
})

async function removeFromCart(page) {
  await page.goto('/cart')
  await expect(page.getByText(CARD)).toBeVisible()
  const remove = page.locator('button[title="Remove from cart"]').first()
  const removeResponse = page.waitForResponse(res =>
    /\/api\/cart\//.test(res.url()) && res.request().method() === 'DELETE')
  await remove.click()
  const res = await removeResponse
  expect(res.ok(), `cart delete rejected (${res.status()}): ${await res.text()}`).toBe(true)
  await expect(page.getByText(CARD)).toHaveCount(0)
}

test('available card can be added, removed from cart, and added again', async ({ page }) => {
  await login(page)

  await openCard(page, CARD)
  await expect(inspector(page).locator('[data-testid="claim-sale-offered-qty"]')).toHaveText('1')
  await expect(inspector(page).locator('[data-testid="claim-sale-unavailable"]')).toHaveCount(0)
  await inspector(page).getByRole('button', { name: 'Add to cart' }).click()
  await expect(inspector(page).getByText(/Added to cart|In cart/)).toBeVisible()
  await page.screenshot({ path: 'test-results/phase45c-inspector-available.png' })

  await removeFromCart(page)

  // Deleting a cart row must leave the listing offered and genuinely re-addable:
  // the cart holds intent only, the listing reservation is untouched. Proving
  // the button is merely *offered* is not enough — the second add has to be
  // clicked and land in the cart.
  await openCard(page, CARD)
  await expect(inspector(page).locator('[data-testid="claim-sale-offered-qty"]')).toHaveText('1')
  await expect(inspector(page).locator('[data-testid="claim-sale-unavailable"]')).toHaveCount(0)
  const addAgain = page.waitForResponse(res =>
    res.url().includes('/api/cart') && res.request().method() === 'POST')
  await inspector(page).getByRole('button', { name: 'Add to cart' }).click()
  const readdRes = await addAgain
  expect(readdRes.ok(), `re-add rejected (${readdRes.status()}): ${await readdRes.text()}`).toBe(true)
  await expect(inspector(page).getByRole('button', { name: 'Added to cart' })).toBeVisible()
  await page.screenshot({ path: 'test-results/phase45c-inspector-readdable.png' })

  // The re-added row must really be in the cart, not just acknowledged by the
  // inspector, and the offered quantity must still be the listing's 1.
  await page.goto('/cart')
  await expect(page.getByText(CARD)).toBeVisible()
  await expect(page.getByText('Available now: 1').first()).toBeVisible()
  await page.screenshot({ path: 'test-results/phase45c-cart-readded.png' })

  // Leave the fixture exactly as this test found it.
  await removeFromCart(page)
  await openCard(page, CARD)
  await expect(inspector(page).locator('[data-testid="claim-sale-offered-qty"]')).toHaveText('1')
  await expect(inspector(page).getByRole('button', { name: 'Add to cart' })).toBeVisible()
})

// This is the one test that deliberately leaves an unpaid order behind. It is
// allowed to, because the afterEach above cancels it through the production
// transition_order RPC in the same test's teardown and then proves the offered
// copy was handed back — cart empty, no open fixture order, no order-sourced
// reservation, both listings active and offering 1 again.
test('an unpaid order makes the card unavailable with a named reason', async ({ page }) => {
  await login(page)

  await openCard(page, CARD)
  await inspector(page).getByRole('button', { name: 'Add to cart' }).click()
  await expect(inspector(page).getByText(/Added to cart|In cart/)).toBeVisible()

  await page.goto('/cart')
  // The pickup select preselects the first available store; just confirm it
  // resolved before checking out.
  await expect(page.locator('select').first()).not.toHaveValue('')
  // Surface the API reason if checkout is rejected; the UI only toasts it.
  const checkoutResponse = page.waitForResponse(res =>
    res.url().includes('/api/checkout') && res.request().method() === 'POST')
  await page.getByRole('button', { name: /Checkout/ }).click()
  const res = await checkoutResponse
  expect(res.ok(), `checkout rejected (${res.status()}): ${await res.text()}`).toBe(true)
  await expect(page.getByRole('heading', { name: 'Orders created' })).toBeVisible({ timeout: 20000 })

  // The order is now awaiting_payment and holds the seller's copy.
  await openCard(page, CARD)
  const notice = inspector(page).locator('[data-testid="claim-sale-unavailable"]')
  await expect(notice).toBeVisible()
  await expect(notice).toHaveAttribute('data-availability', 'reserved')
  await expect(notice).toContainText('Reserved by a pending order')
  await expect(inspector(page).locator('[data-testid="claim-sale-offered-qty"]')).toContainText('0')
  await expect(inspector(page).getByRole('button', { name: 'Add to cart' })).toHaveCount(0)
  await page.screenshot({ path: 'test-results/phase45c-inspector-reserved.png' })
})
