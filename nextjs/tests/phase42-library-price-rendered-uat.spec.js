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

async function installNetworkGuards(page, violations) {
  await page.route('**/*', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin === APP_ORIGIN && url.pathname === '/api/pricing/batch') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(pricePayload()) })
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
  await expect(summary.locator('[data-testid="library-detail-price-usd"]')).toContainText('USD $4.20')
  await expect(summary.getByText(new RegExp(`${label} · ×${String(multiplier).replace('.', '\\.')}\\b`))).toBeVisible()
  await expect(summary.locator('[data-testid="library-detail-price-myr"]')).toContainText(`RM ${myr.toFixed(2)}`)
}

async function unlistThroughUi(page, dialog) {
  const responsePromise = page.waitForResponse(response =>
    response.url().startsWith(`${APP_ORIGIN}/api/listings/`) &&
    response.request().method() === 'DELETE'
  )
  await dialog.getByRole('button', { name: /Unlist/i }).click()
  const response = await responsePromise
  expect(response.status()).toBe(200)
  expect((await response.json()).success).toBe(true)
  await expect(dialog.getByRole('button', { name: 'List on Bazaar' })).toBeVisible()
  expect(await readListing(page)).toBeNull()
}

async function listThroughUi(page, dialog, multiplier) {
  await dialog.getByRole('button', { name: 'List on Bazaar' }).click()
  await dialog.getByRole('button', { name: /Singles/i }).click()
  await dialog.getByRole('button', { name: new RegExp(`×${String(multiplier).replace('.', '\\.')}\\b`) }).click()
  const responsePromise = page.waitForResponse(response =>
    response.url() === `${APP_ORIGIN}/api/listings` && response.request().method() === 'POST'
  )
  await dialog.getByRole('button', { name: 'Confirm Listing' }).click()
  const response = await responsePromise
  expect(response.status()).toBe(201)
  const body = await response.json()
  expect(Number(body.listings[0].multiplier)).toBe(multiplier)
  await expect(dialog.getByText('Listed on Bazaar')).toBeVisible()
  const persisted = await readListing(page)
  expect(Number(persisted.multiplier)).toBe(multiplier)
  expect(persisted.status).toBe('active')
}

test('Phase 42 authenticated desktop/mobile pricing interactions stay authoritative', async ({ page }) => {
  const violations = []
  fixtureCkdUsd = 4.2
  await installNetworkGuards(page, violations)
  await page.setViewportSize({ width: 1440, height: 900 })
  await loginAndAdmit(page)

  let dialog = await openDetail(page, '[data-testid="library-detail-panel"]')
  await assertPrice(dialog, { label: 'Sell price', multiplier: 2.5, myr: 10.5 })

  await unlistThroughUi(page, dialog)
  await assertPrice(dialog, { label: 'Price preview', multiplier: 2.5, myr: 10.5 })
  await expect(dialog.locator('[data-testid="library-detail-price-preview-note"]')).toContainText('Preview only')

  await listThroughUi(page, dialog, 2.8)
  await assertPrice(dialog, { label: 'Sell price', multiplier: 2.8, myr: 12.0 })

  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toBeHidden()
  const { setFixtureListing } = await import('../scripts/phase42-uat-harness.mjs')
  const expired = await setFixtureListing({ multiplier: 2.8, expired: true })
  expect(expired.status).toBe('expired')
  expect((await readListing(page)).status).toBe('expired')

  dialog = await openDetail(page, '[data-testid="library-detail-panel"]')
  await expect(dialog.getByRole('button', { name: 'Relist' })).toBeVisible()
  await expect(dialog.getByText(/Price preview · ×2\.5/)).toBeVisible()
  await dialog.getByRole('button', { name: 'Relist' }).click()
  await dialog.getByRole('button', { name: /×3\b/ }).click()
  const relistResponsePromise = page.waitForResponse(response =>
    response.url().startsWith(`${APP_ORIGIN}/api/listings/`) && response.request().method() === 'PATCH'
  )
  await dialog.getByRole('button', { name: 'Relist', exact: true }).click()
  const relistResponse = await relistResponsePromise
  expect(relistResponse.status()).toBe(200)
  const relistedBody = await relistResponse.json()
  expect(Number(relistedBody.listing.multiplier)).toBe(3)
  await assertPrice(dialog, { label: 'Sell price', multiplier: 3, myr: 12.5 })
  expect(Number((await readListing(page)).multiplier)).toBe(3)

  await dialog.getByRole('button', { name: 'Close' }).click()
  await setFixtureListing({ multiplier: 2.5, expired: false })
  expect(Number((await readListing(page)).multiplier)).toBe(2.5)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()

  dialog = await openDetail(page, '[data-testid="library-detail-sheet"]')
  await assertPrice(dialog, { label: 'Sell price', multiplier: 2.5, myr: 10.5 })
  await unlistThroughUi(page, dialog)
  await assertPrice(dialog, { label: 'Price preview', multiplier: 2.5, myr: 10.5 })
  await listThroughUi(page, dialog, 3)
  await assertPrice(dialog, { label: 'Sell price', multiplier: 3, myr: 12.5 })

  await dialog.getByRole('button', { name: 'Close' }).click()
  fixtureCkdUsd = 0
  dialog = await openDetail(page, '[data-testid="library-detail-sheet"]')
  const summary = dialog.locator('[data-testid="library-detail-price-summary"]')
  await expect(summary.locator('[data-testid="library-detail-price-usd"]')).toContainText('USD $0.00')
  await expect(summary.locator('[data-testid="library-detail-price-myr"]')).toHaveText('—')
  await expect(summary.locator('[data-testid="library-detail-price-note"]')).toContainText('No positive MYR price')
  await expect(summary).not.toContainText('RM 0.00')

  expect(violations).toEqual([])
  expect(page.url().startsWith(`${APP_ORIGIN}/`)).toBe(true)
})
