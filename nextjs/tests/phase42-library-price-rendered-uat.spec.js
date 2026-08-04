// @ts-check
const { test, expect } = require('@playwright/test')

const APP_ORIGIN = 'http://localhost:34242'
const SUPABASE_ORIGIN = 'http://127.0.0.1:54321'
const FIXTURE_EMAIL = 'phase42-rendered-uat-20260803@dbb.local'
const FIXTURE_PASSWORD = 'Phase42_Rendered_UAT_2026!'
const FIXTURE_CARD_NAME = 'Phase 42 Rendered UAT Card'
const FIXTURE_SCRYFALL_ID = '42000000-0000-4000-8000-000000000042'
const FIXTURE_LIBRARY_CARD_ID = '42000000-0000-4000-8000-000000000043'
const FIXTURE_CARD_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAAAAACw='
const FIXTURE_CLAIM_SALE_TITLE = 'Phase 42 Rendered UAT Claim Sale'

let fixtureCkdUsd = 4.2

function pricePayload() {
  const round = multiplier => Math.round(fixtureCkdUsd * multiplier * 2) / 2
  return {
    prices: {
      [`${FIXTURE_SCRYFALL_ID}:normal`]: {
        ckd_usd: fixtureCkdUsd,
        myr_2_5: round(2.5),
        myr_2_8: round(2.8),
        myr_3_0: round(3.0),
      },
    },
    cache_age_min: 0,
  }
}

async function installNetworkGuards(page, violations, controls) {
  await page.route('**/*', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin === APP_ORIGIN && url.pathname === '/api/pricing/batch') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(pricePayload()) })
    }
    if (url.origin === APP_ORIGIN && url.pathname === '/api/listings' &&
        request.method() === 'GET' && url.searchParams.get('library_card_id') === FIXTURE_LIBRARY_CARD_ID) {
      if (controls.listingLookup === 'delayed') {
        await new Promise(resolve => { controls.releaseListingLookup = resolve })
      }
      if (controls.listingLookup === 'failed') {
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'deliberate rendered-UAT listing lookup failure' }),
        })
      }
      return route.continue()
    }
    if (url.origin === APP_ORIGIN && url.pathname === '/api/claim-sales' &&
        request.method() === 'POST' && controls.claimSaleResponse === 'missing-listing') {
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ claim_sale: { id: 'missing-listing-response' }, listings: [] }),
      })
    }
    if (url.origin === 'https://api.scryfall.com' && url.pathname === `/cards/${FIXTURE_SCRYFALL_ID}`) {
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

async function loginAndAdmit(page) {
  await page.goto(`${APP_ORIGIN}/library?phase42_origin_probe=1`)
  await expect(page).toHaveURL(`${APP_ORIGIN}/login?phase42_origin_probe=1`)
  await page.getByPlaceholder('you@example.com').fill(FIXTURE_EMAIL)
  await page.getByPlaceholder('••••••••').fill(FIXTURE_PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(`${APP_ORIGIN}/library`)

  const libraryResponse = await page.request.get(`/api/library?q=${encodeURIComponent(FIXTURE_CARD_NAME)}`)
  expect(libraryResponse.status()).toBe(200)
  const libraryBody = await libraryResponse.json()
  expect(libraryBody.cards).toHaveLength(1)
  expect(libraryBody.cards[0].id).toBe(FIXTURE_LIBRARY_CARD_ID)
  expect(libraryBody.cards[0].card_index.name).toBe(FIXTURE_CARD_NAME)
  expect(libraryBody.cards[0].card_index.image_uris.normal).toBe(FIXTURE_CARD_IMAGE)

  const photoResponse = await page.request.get(`/api/photos/${FIXTURE_LIBRARY_CARD_ID}`)
  expect(photoResponse.status()).toBe(200)
  const listing = await readListing(page)
  expect(Number(listing.multiplier)).toBe(2.5)
  expect(listing.status).toBe('active')
  await expect(page.getByRole('button', { name: `View details for ${FIXTURE_CARD_NAME}` })).toBeVisible()
}

async function readListing(page) {
  const response = await page.request.get(`/api/listings?library_card_id=${FIXTURE_LIBRARY_CARD_ID}`)
  expect(response.status()).toBe(200)
  return (await response.json()).listing
}

async function openDetail(page, surface) {
  await page.getByRole('button', { name: `View details for ${FIXTURE_CARD_NAME}` }).click()
  const dialog = page.locator(surface)
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('img', { name: FIXTURE_CARD_NAME })).toHaveAttribute('src', FIXTURE_CARD_IMAGE)
  await expect(dialog.locator('[data-testid="library-detail-price-summary"]')).toBeVisible()
  return dialog
}

async function assertPrice(dialog, { label, multiplier, myr }) {
  const summary = dialog.locator('[data-testid="library-detail-price-summary"]')
  const usd = summary.locator('[data-testid="library-detail-price-usd"]')
  const heading = summary.locator('[data-testid="library-detail-price-heading"]')
  const myrPrice = summary.locator('[data-testid="library-detail-price-myr"]')
  await expect(usd).toHaveText('$4.20 USD')
  await expect(heading).toHaveText(`${label} · ×${multiplier}`)
  await expect(myrPrice).toHaveText(`RM ${myr.toFixed(2)}`)
  await expect(usd).not.toContainText('USD $4.20 USD')
  await expect(myrPrice).not.toContainText('MYR')
  await expect(myrPrice).not.toContainText('RM RM')
}

async function assertUnresolvedListing(dialog, { heading, note }) {
  const summary = dialog.locator('[data-testid="library-detail-price-summary"]')
  const priceHeading = summary.locator('[data-testid="library-detail-price-heading"]')
  await expect(summary.locator('[data-testid="library-detail-price-usd"]')).toHaveText('$4.20 USD')
  await expect(priceHeading).toHaveText(heading)
  await expect(summary.locator('[data-testid="library-detail-price-myr"]')).toHaveText('—')
  await expect(summary.locator('[data-testid="library-detail-listing-note"]')).toHaveText(note)
  await expect(priceHeading).not.toContainText('Price preview')
  await expect(priceHeading).not.toContainText('×')
  await expect(summary).not.toContainText('×2.5')
  await expect(summary).not.toContainText('RM 10.50')
}

async function unlistThroughUi(page, dialog) {
  const responsePromise = page.waitForResponse(response =>
    response.url().startsWith(`${APP_ORIGIN}/api/listings/`) && response.request().method() === 'DELETE'
  )
  await dialog.getByRole('button', { name: /Unlist/i }).click()
  const response = await responsePromise
  expect(response.status()).toBe(200)
  expect((await response.json()).success).toBe(true)
  await expect(dialog.getByRole('button', { name: 'List on Bazaar' })).toBeVisible()
  expect(await readListing(page)).toBeNull()
}

test('Phase 42 authenticated desktop/mobile pricing interactions stay authoritative', async ({ page }) => {
  const violations = []
  const controls = { listingLookup: 'delayed', claimSaleResponse: 'normal', releaseListingLookup: null }
  fixtureCkdUsd = 4.2
  await installNetworkGuards(page, violations, controls)
  await page.setViewportSize({ width: 1440, height: 900 })
  await loginAndAdmit(page)

  let dialog = await openDetail(page, '[data-testid="library-detail-panel"]')
  await assertUnresolvedListing(dialog, {
    heading: 'Checking listing status',
    note: 'Checking Bazaar listing status...',
  })
  expect(typeof controls.releaseListingLookup).toBe('function')
  controls.releaseListingLookup()
  controls.releaseListingLookup = null
  await assertPrice(dialog, { label: 'Sell price', multiplier: 2.5, myr: 10.5 })

  await dialog.getByRole('button', { name: 'Close' }).click()
  controls.listingLookup = 'failed'
  dialog = await openDetail(page, '[data-testid="library-detail-panel"]')
  await assertUnresolvedListing(dialog, {
    heading: 'Listing status unavailable',
    note: 'Could not confirm Bazaar listing status. Price preview unavailable.',
  })
  await expect(dialog.locator('[data-testid="library-detail-listing-error"]')).toHaveText(
    'Could not check Bazaar listing status. Close and reopen to try again.'
  )

  await dialog.getByRole('button', { name: 'Close' }).click()
  controls.listingLookup = 'normal'
  dialog = await openDetail(page, '[data-testid="library-detail-panel"]')
  await assertPrice(dialog, { label: 'Sell price', multiplier: 2.5, myr: 10.5 })
  await unlistThroughUi(page, dialog)
  await assertPrice(dialog, { label: 'Price preview', multiplier: 2.5, myr: 10.5 })

  await dialog.getByRole('button', { name: 'List on Bazaar' }).click()
  await dialog.getByRole('button', { name: /Claim Sale/i }).click()
  await dialog.getByPlaceholder('Claim sale title (e.g. Modern staples sale)').fill(FIXTURE_CLAIM_SALE_TITLE)
  controls.claimSaleResponse = 'missing-listing'
  const missingResponsePromise = page.waitForResponse(response =>
    response.url() === `${APP_ORIGIN}/api/claim-sales` && response.request().method() === 'POST'
  )
  await dialog.getByRole('button', { name: 'Create Claim Sale' }).click()
  const missingResponse = await missingResponsePromise
  expect(missingResponse.status()).toBe(201)
  await expect(page.getByText('Claim sale was created, but its listing could not be confirmed')).toBeVisible()
  await assertUnresolvedListing(dialog, {
    heading: 'Listing status unavailable',
    note: 'Could not confirm Bazaar listing status. Price preview unavailable.',
  })
  await expect(dialog.locator('[data-testid="library-detail-listing-error"]')).toHaveText(
    'Could not check Bazaar listing status. Close and reopen to try again.'
  )
  await expect(dialog.getByRole('button', { name: 'Create Claim Sale' })).toBeHidden()
  expect(await readListing(page)).toBeNull()

  await dialog.getByRole('button', { name: 'Close' }).click()
  controls.claimSaleResponse = 'normal'
  dialog = await openDetail(page, '[data-testid="library-detail-panel"]')
  await assertPrice(dialog, { label: 'Price preview', multiplier: 2.5, myr: 10.5 })
  await dialog.getByRole('button', { name: 'List on Bazaar' }).click()
  await dialog.getByRole('button', { name: /Claim Sale/i }).click()
  await dialog.getByPlaceholder('Claim sale title (e.g. Modern staples sale)').fill(FIXTURE_CLAIM_SALE_TITLE)
  const claimSaleResponsePromise = page.waitForResponse(response =>
    response.url() === `${APP_ORIGIN}/api/claim-sales` && response.request().method() === 'POST'
  )
  await dialog.getByRole('button', { name: 'Create Claim Sale' }).click()
  const claimSaleResponse = await claimSaleResponsePromise
  expect(claimSaleResponse.status()).toBe(201)
  const claimSaleBody = await claimSaleResponse.json()
  const claimListing = claimSaleBody.listings.find(listing => listing.library_card_id === FIXTURE_LIBRARY_CARD_ID)
  expect(claimListing.id).toBeTruthy()
  expect(claimListing.status).toBe('active')
  expect(Number(claimListing.multiplier)).toBe(3)
  await assertPrice(dialog, { label: 'Sell price', multiplier: 3, myr: 12.5 })
  expect(Number((await readListing(page)).multiplier)).toBe(3)

  await dialog.getByRole('button', { name: 'Close' }).click()
  const { setFixtureListing } = await import('../scripts/phase42-uat-harness.mjs')
  const expiring = await setFixtureListing({ multiplier: 3, expiresInMs: 2_000 })
  expect(expiring.status).toBe('active')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()

  dialog = await openDetail(page, '[data-testid="library-detail-sheet"]')
  await assertPrice(dialog, { label: 'Sell price', multiplier: 3, myr: 12.5 })
  await assertPrice(dialog, { label: 'Price preview', multiplier: 2.5, myr: 10.5 })
  await expect(dialog.getByRole('button', { name: 'Relist' })).toBeVisible()

  await dialog.getByRole('button', { name: 'Close' }).click()
  fixtureCkdUsd = 0
  dialog = await openDetail(page, '[data-testid="library-detail-sheet"]')
  const summary = dialog.locator('[data-testid="library-detail-price-summary"]')
  await expect(summary.locator('[data-testid="library-detail-price-usd"]')).toHaveText('$0.00 USD')
  await expect(summary.locator('[data-testid="library-detail-price-myr"]')).toHaveText('—')
  await expect(summary.locator('[data-testid="library-detail-price-note"]')).toContainText('No positive MYR price')
  await expect(summary).not.toContainText('RM 0.00')

  expect(violations).toEqual([])
  expect(page.url().startsWith(`${APP_ORIGIN}/`)).toBe(true)
})
