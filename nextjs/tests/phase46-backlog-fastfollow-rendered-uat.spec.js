// @ts-check
//
// Rendered UAT for the PR #9 backlog fast-follow diff.
//
// The existing phase42 spec proves the pricing surface stays authoritative.
// This one covers what *this* PR changed and what a source-level gate cannot
// reach:
//
//   F1  the real (unmocked) GET /api/listings single-card contract — a failed
//       lookup must not be shaped like a confirmed absence;
//   F4  ListingSection.handleList fails closed with no contradictory success
//       toast beside the amber "could not check listing status" panel;
//   a11y the shipped accent, price and tab-bar fixes measured from *computed*
//       styles in a real browser, not from token text in globals.css.
//
// Every assertion below is a DOM/behavioural observation. Nothing here reads
// source.

const { test, expect } = require('@playwright/test')

const APP_ORIGIN = 'http://localhost:34242'
const SUPABASE_ORIGIN = 'http://127.0.0.1:54321'
const FIXTURE_EMAIL = 'phase42-rendered-uat-20260803@dbb.local'
const FIXTURE_PASSWORD = 'Phase42_Rendered_UAT_2026!'
const FIXTURE_CARD_NAME = 'Phase 42 Rendered UAT Card'
const FIXTURE_SCRYFALL_ID = '42000000-0000-4000-8000-000000000042'
const FIXTURE_LIBRARY_CARD_ID = '42000000-0000-4000-8000-000000000043'

const AA_NORMAL_TEXT = 4.5
const FIXTURE_CKD_USD = 4.2

function pricePayload() {
  const round = multiplier => Math.round(FIXTURE_CKD_USD * multiplier * 2) / 2
  return {
    prices: {
      [`${FIXTURE_SCRYFALL_ID}:normal`]: {
        ckd_usd: FIXTURE_CKD_USD,
        myr_2_5: round(2.5),
        myr_2_8: round(2.8),
        myr_3_0: round(3.0),
      },
    },
    cache_age_min: 0,
  }
}

// Same origin discipline as the phase42 spec: only the app and the approved
// local Supabase may be reached, and the browser may not leave the app origin.
async function installNetworkGuards(page, violations, controls) {
  await page.route('**/*', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin === APP_ORIGIN && url.pathname === '/api/pricing/batch') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(pricePayload()) })
    }
    if (url.origin === APP_ORIGIN && url.pathname === '/api/listings' &&
        request.method() === 'POST' && controls.listingCreate === 'unconfirmed') {
      // A 201 whose body carries no matching active listing: the exact
      // ambiguity F4 used to paper over with an id-less fallback object.
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ listings: [] }),
      })
    }
    if (url.origin === 'https://api.scryfall.com') {
      violations.push(`stored-image fallback ${request.method()} ${url.origin}${url.pathname}`)
      return route.abort('blockedbyclient')
    }
    if (url.origin === APP_ORIGIN || url.origin === SUPABASE_ORIGIN) return route.continue()
    violations.push(`${request.resourceType()} ${request.method()} ${url.origin}${url.pathname}`)
    return route.abort('blockedbyclient')
  })
  page.on('framenavigated', frame => {
    if (frame !== page.mainFrame()) return
    const value = frame.url()
    if (!value || value === 'about:blank') return
    const url = new URL(value)
    if (url.origin !== APP_ORIGIN) violations.push(`navigation ${url.origin}${url.pathname}`)
  })
}

async function login(page) {
  await page.goto(`${APP_ORIGIN}/library`)
  await expect(page).toHaveURL(`${APP_ORIGIN}/login`)
  await page.getByPlaceholder('you@example.com').fill(FIXTURE_EMAIL)
  await page.getByPlaceholder('••••••••').fill(FIXTURE_PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(`${APP_ORIGIN}/library`)
}

async function openDetail(page, surface = '[data-testid="library-detail-panel"]') {
  await page.getByRole('button', { name: `View details for ${FIXTURE_CARD_NAME}` }).click()
  const dialog = page.locator(surface)
  await expect(dialog).toBeVisible()
  return dialog
}

// ── WCAG 2.x contrast, measured in the page ────────────────────────────────
// Reads getComputedStyle, walks up for the first opaque background, and
// composites any translucent layer it passes. This measures what a user's
// browser actually paints, which is the thing the AA floor is about.
function measureContrast(element) {
  const parseColor = value => {
    const match = String(value).match(/rgba?\(([^)]+)\)/)
    if (!match) return null
    const parts = match[1].split(/[\s,/]+/).filter(Boolean).map(Number)
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 }
  }
  const over = (top, bottom) => ({
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1,
  })
  const channel = v => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  const luminance = c => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b)

  const style = getComputedStyle(element)
  const color = parseColor(style.color)

  // Composite every background layer from the page root down to the element.
  const chain = []
  for (let node = element; node; node = node.parentElement) chain.push(node)
  let background = { r: 255, g: 255, b: 255, a: 1 }
  for (const node of chain.reverse()) {
    const layer = parseColor(getComputedStyle(node).backgroundColor)
    if (layer && layer.a > 0) background = over(layer, background)
  }
  const painted = color.a < 1 ? over(color, background) : color
  const [hi, lo] = [luminance(painted), luminance(background)].sort((x, y) => y - x)

  return {
    color: style.color,
    backgroundColor: 'rgb(' + [background.r, background.g, background.b].map(Math.round).join(', ') + ')',
    fontSizePx: parseFloat(style.fontSize),
    fontWeight: Number(style.fontWeight) || style.fontWeight,
    ratio: (hi + 0.05) / (lo + 0.05),
    text: (element.textContent || '').trim().slice(0, 40),
  }
}

// WCAG's 3:1 large-text allowance starts at 24px normal / 18.66px bold. If a
// surface crosses that line the 4.5:1 assertion stops describing the real
// requirement, so prove it has not.
function assertNormalSizeAA(label, measured) {
  const bold = Number(measured.fontWeight) >= 700
  expect(
    bold ? measured.fontSizePx < 18.66 : measured.fontSizePx < 24,
    `${label} renders at ${measured.fontSizePx}px/${measured.fontWeight}, which qualifies for ` +
    "WCAG's large-text exemption — the 4.5:1 assertion no longer describes its real requirement"
  ).toBe(true)
  expect(
    measured.ratio,
    `${label}: ${measured.color} on ${measured.backgroundColor} measures ` +
    `${measured.ratio.toFixed(3)}:1, below the ${AA_NORMAL_TEXT}:1 AA floor for normal-size text`
  ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)
  console.log(
    `[phase46-uat] ${label}: ${measured.color} on ${measured.backgroundColor} = ` +
    `${measured.ratio.toFixed(3)}:1 at ${measured.fontSizePx}px/${measured.fontWeight}` +
    (measured.text ? ` ("${measured.text}")` : '')
  )
}

test('F1: the real single-card listing lookup never fakes a confirmed absence', async ({ page }) => {
  const violations = []
  await installNetworkGuards(page, violations, { listingCreate: 'normal' })

  // Unauthenticated — the real route, not a mock. Before this PR this returned
  // HTTP 200 {listing: null}, which the modal reads as "confirmed not listed"
  // and prices as a preview.
  await page.goto(`${APP_ORIGIN}/login`)
  const anonymous = await page.request.get(`/api/listings?library_card_id=${FIXTURE_LIBRARY_CARD_ID}`)
  expect(anonymous.status()).toBe(401)
  const anonymousBody = await anonymous.json()
  expect(anonymousBody.code).toBe('UNAUTHORIZED')
  expect(Object.keys(anonymousBody)).not.toContain('listing')
  // A stable public code only — no raw database or driver text in the body.
  expect(JSON.stringify(anonymousBody)).not.toMatch(/column|relation|postgres|PGRST|stack/i)

  await login(page)

  // Authenticated resolution still returns the confirmed-absence shape at 200,
  // so the fail-closed change did not break the signal it protects.
  const authenticated = await page.request.get(`/api/listings?library_card_id=${FIXTURE_LIBRARY_CARD_ID}`)
  expect(authenticated.status()).toBe(200)
  const authenticatedBody = await authenticated.json()
  expect(Object.keys(authenticatedBody)).toContain('listing')
  expect(Number(authenticatedBody.listing.multiplier)).toBe(2.5)
  expect(authenticatedBody.listing.status).toBe('active')

  // An unknown card the fixture user does not own resolves to a real absence.
  const absent = await page.request.get('/api/listings?library_card_id=42000000-0000-4000-8000-0000000000ff')
  expect(absent.status()).toBe(200)
  expect(await absent.json()).toEqual({ listing: null })

  expect(violations).toEqual([])
})

// Runs before the F4 test on purpose: the bazaar assertion below needs the
// fixture's initial active listing, and F4 drives that listing through unlist
// and relist. Playwright runs a file's tests in declaration order.
test('a11y: the shipped price, accent and tab-bar fixes measure AA in the browser', async ({ page }) => {
  const violations = []
  await installNetworkGuards(page, violations, { listingCreate: 'normal' })
  await page.setViewportSize({ width: 1440, height: 900 })

  // `.btn-primary` — white on the accent fill. This is the pairing the source
  // gate recomputes from tokens; here it is measured from what Chromium paints.
  await page.goto(`${APP_ORIGIN}/login`)
  const signIn = page.getByRole('button', { name: 'Sign in' })
  await expect(signIn).toBeVisible()
  await expect(signIn).toHaveClass(/btn-primary/)
  assertNormalSizeAA('.btn-primary label', await signIn.evaluate(measureContrast))

  await login(page)

  // The library card face price — the `--dbb-price` token, on the real card
  // surface, at its real rendered size. This is the defect this PR fixed.
  const price = page.locator('span.text-dbb-price').first()
  await expect(price).toBeVisible()
  await expect(price).toHaveText(/^RM /)
  const measuredPrice = await price.evaluate(measureContrast)
  assertNormalSizeAA('library card price', measuredPrice)
  // The standing constraint is that pricing is always visibly shown; a token
  // that had been "fixed" by hiding the price would satisfy contrast alone.
  expect(await price.evaluate(el => getComputedStyle(el).visibility)).toBe('visible')
  expect(await price.evaluate(el => Number(getComputedStyle(el).opacity))).toBeGreaterThan(0.99)
  expect(await price.boundingBox()).not.toBeNull()

  // The bazaar card face carries the same token at its own larger size. The
  // fixture card is listed, so this row must actually be there — a skipped
  // measurement would be a vacuous pass.
  await page.goto(`${APP_ORIGIN}/bazaar`)
  const bazaarPrice = page.locator('.text-dbb-price').filter({ hasText: /^RM / })
  await expect(bazaarPrice.first()).toBeVisible()
  const bazaarCount = await bazaarPrice.count()
  for (let index = 0; index < bazaarCount; index += 1) {
    assertNormalSizeAA(`bazaar card price #${index + 1}`, await bazaarPrice.nth(index).evaluate(measureContrast))
  }

  // The mobile tab bar at a real phone width.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${APP_ORIGIN}/library`)
  const tabBar = page.locator('nav.sm\\:hidden').first()
  await expect(tabBar).toBeVisible()
  const labels = tabBar.locator('span.text-\\[11px\\]')
  const labelCount = await labels.count()
  expect(labelCount).toBeGreaterThan(0)
  for (let index = 0; index < labelCount; index += 1) {
    const measured = await labels.nth(index).evaluate(measureContrast)
    expect(
      measured.fontSizePx,
      `tab bar label "${measured.text}" renders ${measured.fontSizePx}px; the functional-text floor is 11px`
    ).toBeGreaterThanOrEqual(11)
    console.log(`[phase46-uat] tab label "${measured.text}": ${measured.fontSizePx}px`)
  }

  // And it really is the navigation at this width — a bar that had been hidden
  // would pass a font-size check vacuously.
  await expect(tabBar.getByText('Library', { exact: true })).toBeVisible()
  await expect(page.locator('nav.sm\\:hidden').first()).toBeInViewport()

  expect(violations).toEqual([])
})

test('F4: an unconfirmed listing create fails closed with no success toast', async ({ page }) => {
  const violations = []
  const controls = { listingCreate: 'normal' }
  await installNetworkGuards(page, violations, controls)
  await page.setViewportSize({ width: 1440, height: 900 })
  await login(page)

  // Start from a real unlisted state, driven through the UI.
  let dialog = await openDetail(page)
  const deletePromise = page.waitForResponse(response =>
    response.url().startsWith(`${APP_ORIGIN}/api/listings/`) && response.request().method() === 'DELETE')
  await dialog.getByRole('button', { name: /Unlist/i }).click()
  expect((await deletePromise).status()).toBe(200)
  await expect(dialog.getByRole('button', { name: 'List on Bazaar' })).toBeVisible()

  controls.listingCreate = 'unconfirmed'
  await dialog.getByRole('button', { name: 'List on Bazaar' }).click()
  await dialog.getByRole('button', { name: 'Singles' }).click()
  const createPromise = page.waitForResponse(response =>
    response.url() === `${APP_ORIGIN}/api/listings` && response.request().method() === 'POST')
  await dialog.getByRole('button', { name: 'Confirm Listing' }).click()
  expect((await createPromise).status()).toBe(201)

  // The user is told one thing, not two contradictory things.
  const failedToast = page.locator('div.toast', { hasText: 'Card was listed, but its Bazaar listing could not be confirmed' })
  await expect(failedToast).toBeVisible()
  await expect(failedToast).toHaveClass(/bg-red-700/)
  await expect(page.locator('div.toast', { hasText: 'Card listed on Bazaar' })).toHaveCount(0)

  await expect(dialog.locator('[data-testid="library-detail-listing-error"]')).toHaveText(
    'Could not check Bazaar listing status. Close and reopen to try again.'
  )
  const summary = dialog.locator('[data-testid="library-detail-price-summary"]')
  await expect(summary.locator('[data-testid="library-detail-price-heading"]')).toHaveText('Listing status unavailable')
  await expect(summary.locator('[data-testid="library-detail-price-myr"]')).toHaveText('—')
  await expect(summary).not.toContainText('×')
  await expect(summary).not.toContainText('RM ')

  // The browser-local mock stood in for the create response, so nothing was
  // stored. That is the point: the UI must not claim a listing on the strength
  // of a body it could not read, and an authenticated re-read agrees with it —
  // the old fallback object would have rendered `Sell price · ×2.5` here while
  // the server still held no listing at all.
  const stored = await page.request.get(`/api/listings?library_card_id=${FIXTURE_LIBRARY_CARD_ID}`)
  expect(stored.status()).toBe(200)
  expect(await stored.json()).toEqual({ listing: null })

  // Restore the fixture to its confirmed ×2.5 state through the same UI, and
  // prove the success path still reaches its toast when the body is sound.
  controls.listingCreate = 'normal'
  await dialog.getByRole('button', { name: 'Close' }).click()
  dialog = await openDetail(page)
  await dialog.getByRole('button', { name: 'List on Bazaar' }).click()
  await dialog.getByRole('button', { name: 'Singles' }).click()
  const confirmedCreate = page.waitForResponse(response =>
    response.url() === `${APP_ORIGIN}/api/listings` && response.request().method() === 'POST')
  await dialog.getByRole('button', { name: 'Confirm Listing' }).click()
  expect((await confirmedCreate).status()).toBe(201)
  const successToast = page.locator('div.toast', { hasText: 'Card listed on Bazaar' })
  await expect(successToast).toBeVisible()
  await expect(successToast).toHaveClass(/bg-green-700/)
  await expect(dialog.locator('[data-testid="library-detail-price-heading"]')).toHaveText('Sell price · ×2.5')
  await expect(dialog.locator('[data-testid="library-detail-listing-error"]')).toHaveCount(0)

  expect(violations).toEqual([])
})
