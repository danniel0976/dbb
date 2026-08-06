/**
 * Phase 42 focused checks — Library card-detail price summary.
 *
 * Covers the CKD USD baseline / MYR sell-price block on the Details tab: the
 * rounding rule, multiplier switching, the honest loading / missing / failed
 * states, and the wiring in CardDetailModal. Exercises the extracted pure logic
 * directly and asserts component wiring from source, mirroring the repo's other
 * focused-check scripts (phase41-test-search-sort-filter.mjs). Self-contained:
 * no dev server, Supabase, Docker or network dependency, so it is safe under
 * the CI scripts/phase*-test-*.mjs glob.
 *
 * Run: node scripts/phase42-test-library-price-detail.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  OWNER_LISTING_STATUS,
  PRICE_STATUS,
  activeListingMultiplier,
  buildPriceSummary,
  formatMyr,
  formatUsd,
  normalizeMultiplier,
  priceCacheKey,
  readCkdUsd,
  sellPriceMyr,
} from '../src/components/library-detail/priceSummary.js'
import { MULTIPLIERS } from '../src/components/library-detail/constants.js'
import { sellPrice } from '../src/lib/pricingCache.js'

// Comments are stripped before any source assertion below. The PR #8 review
// (F3) noted that a prose comment containing the same words would satisfy an
// `includes()` check, so these guards now only ever match executable source.
// This does not make them DOM assertions — the behavioural proof for the two
// PR #8 blockers still lives in tests/phase42-library-price-rendered-uat.spec.js,
// which needs a local Supabase and cannot run under the CI glob.
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => {
      const at = line.indexOf('//')
      if (at === -1) return line
      // Only strip a `//` that is not inside a string or a JSX attribute value.
      const before = line.slice(0, at)
      const quotes = (before.match(/'/g) || []).length
      const dquotes = (before.match(/"/g) || []).length
      const backticks = (before.match(/`/g) || []).length
      if (quotes % 2 || dquotes % 2 || backticks % 2) return line
      if (/[:=]\s*$/.test(before.trimEnd().slice(0, -1))) return line
      return before
    })
    .join('\n')
}
const readSource = (rel) => stripComments(readFileSync(new URL(rel, import.meta.url), 'utf8'))

const modalSource = readSource('../src/components/CardDetailModal.js')
const listingSource = readSource('../src/components/library-detail/ListingSection.js')
const claimSaleSource = readSource('../src/components/library-detail/ClaimSaleForm.js')

let passed = 0
function check(name, fn) {
  fn()
  passed++
  console.log(`  ok - ${name}`)
}

console.log('\n=== Phase 42: Library card-detail price summary ===\n')

check('offered multipliers are the DBB tiers 2.5 / 2.8 / 3.0', () => {
  assert.deepEqual(MULTIPLIERS, [2.5, 2.8, 3.0])
})

check('MYR sell price is CKD USD x multiplier rounded to the nearest RM 0.50', () => {
  assert.equal(sellPriceMyr(1.0, 2.5), 2.5)
  assert.equal(sellPriceMyr(1.2, 2.5), 3.0)   // 3.00 exact
  assert.equal(sellPriceMyr(1.1, 2.5), 3.0)   // 2.75 -> 3.00 (half rounds up)
  assert.equal(sellPriceMyr(0.59, 2.5), 1.5)  // 1.475 -> 1.50
  assert.equal(sellPriceMyr(4.0, 2.8), 11.0)  // 11.20 -> 11.00
  assert.equal(sellPriceMyr(4.0, 3.0), 12.0)
  assert.equal(sellPriceMyr(0, 3.0), null, 'zero MYR is unavailable')
  assert.equal(sellPriceMyr(0.01, 2.5), null, 'a positive baseline that rounds to zero is unavailable')
})

check('positive prices match the server rounding rule and non-positive results are unavailable', () => {
  for (const usd of [0, 0.13, 0.59, 1.0, 1.1, 1.77, 4.0, 12.34, 199.99]) {
    for (const m of MULTIPLIERS) {
      const serverPrice = sellPrice(usd, m)
      assert.equal(
        sellPriceMyr(usd, m),
        serverPrice > 0 ? serverPrice : null,
        `display validity diverges at ${usd} x ${m}`
      )
    }
  }
})

check('no FX conversion factor is introduced anywhere in the block', () => {
  const priceSource = readFileSync(new URL('../src/components/library-detail/priceSummary.js', import.meta.url), 'utf8')
  const code = priceSource.replace(/\/\/.*$/gm, '')
  for (const token of ['fxRate', 'FX_RATE', 'exchangeRate', 'usdToMyr', 'USD_MYR', 'MYR_PER_USD']) {
    assert.ok(!code.includes(token), `price summary must not carry an FX rate (${token})`)
  }
  assert.ok(!/\*\s*4\.\d/.test(code), 'price summary must not multiply by a hardcoded FX rate')
  assert.ok(priceSource.includes('Math.round(ckdUsd * multiplier * 2) / 2'), 'must use the RM 0.50 rounding rule')
})

check('missing / malformed baselines are reported as absent, never as zero', () => {
  assert.equal(sellPriceMyr(null, 2.5), null)
  assert.equal(sellPriceMyr(undefined, 2.5), null)
  assert.equal(sellPriceMyr(Number.NaN, 2.5), null)
  assert.equal(sellPriceMyr(Infinity, 2.5), null)
  assert.equal(sellPriceMyr(2.0, Number.NaN), null)
})

check('batch payload is read from the "<id>:<foil>" key for the requested finish', () => {
  const payload = {
    prices: {
      'abc:normal': { ckd_usd: 2.0 },
      'abc:foil': { ckd_usd: 8.0 },
      'abc:etched': { ckd_usd: null },
    },
  }
  assert.equal(priceCacheKey('abc', 'foil'), 'abc:foil')
  assert.equal(priceCacheKey('abc'), 'abc:normal')
  assert.equal(priceCacheKey('abc', ''), 'abc:normal')
  assert.equal(readCkdUsd(payload, 'abc', 'normal'), 2.0)
  assert.equal(readCkdUsd(payload, 'abc', 'foil'), 8.0)
  assert.equal(readCkdUsd(payload, 'abc', 'etched'), null, 'null cached price is unavailable')
  assert.equal(readCkdUsd(payload, 'missing', 'normal'), null)
  assert.equal(readCkdUsd(null, 'abc', 'normal'), null)
  assert.equal(readCkdUsd({}, 'abc', 'normal'), null)
  assert.equal(readCkdUsd({ prices: { 'abc:normal': { ckd_usd: '2.00' } } }, 'abc', 'normal'), null, 'non-numeric price is unavailable')
  assert.equal(readCkdUsd({ prices: { 'abc:normal': { ckd_usd: -1 } } }, 'abc', 'normal'), null, 'negative price is unavailable')
})

check('a stored listing multiplier is snapped onto an offered tier, or rejected', () => {
  assert.equal(normalizeMultiplier('2.80'), 2.8, 'numeric strings from Postgres must resolve')
  assert.equal(normalizeMultiplier(3), 3.0)
  assert.equal(normalizeMultiplier(2.5), 2.5)
  assert.equal(normalizeMultiplier(2.7), null)
  assert.equal(normalizeMultiplier(null), null)
  assert.equal(normalizeMultiplier(undefined), null)
  assert.equal(normalizeMultiplier('abc'), null)
})

check('an active persisted listing controls the authoritative sell price', () => {
  const ckdUsd = 4.0
  const at = (m) => buildPriceSummary({
    status: PRICE_STATUS.READY,
    ckdUsd,
    listingStatus: OWNER_LISTING_STATUS.READY,
    listing: { id: 'listing-1', status: 'active', multiplier: m, expires_at: '2099-01-01T00:00:00.000Z' },
    now: Date.parse('2026-08-03T00:00:00.000Z'),
  })
  assert.equal(at(2.5).sellLabel, 'RM 10.00')
  assert.equal(at(2.8).sellLabel, 'RM 11.00')
  assert.equal(at(3.0).sellLabel, 'RM 12.00')
  for (const m of MULTIPLIERS) {
    assert.equal(at(m).baselineLabel, '$4.00', 'baseline must not change with the multiplier')
    assert.equal(at(m).multiplier, m, 'selected tier must be reflected back')
    assert.equal(at(m).status, PRICE_STATUS.READY)
    assert.equal(at(m).authoritative, true)
    assert.equal(at(m).priceLabel, 'Sell price')
  }
})

check('in-modal list and relist responses immediately change the authoritative multiplier', () => {
  const summarize = (listing) => buildPriceSummary({
    status: PRICE_STATUS.READY,
    ckdUsd: 4,
    listingStatus: listing ? OWNER_LISTING_STATUS.READY : OWNER_LISTING_STATUS.NONE,
    listing,
    now: Date.parse('2026-08-03T00:00:00.000Z'),
  })
  const listed = { id: 'listing-1', status: 'active', multiplier: '3.0', expires_at: '2099-01-01T00:00:00.000Z' }
  const relisted = { ...listed, multiplier: '2.8' }
  assert.equal(summarize(listed).sellLabel, 'RM 12.00')
  assert.equal(summarize(listed).multiplier, 3.0)
  assert.equal(summarize(relisted).sellLabel, 'RM 11.00')
  assert.equal(summarize(relisted).multiplier, 2.8)
  assert.equal(summarize(null).authoritative, false)
  assert.equal(summarize(null).priceLabel, 'Price preview')
})

check('only a current active listing can produce an authoritative sell-price claim', () => {
  const now = Date.parse('2026-08-03T00:00:00.000Z')
  assert.equal(activeListingMultiplier({ id: 'listing-1', status: 'active', multiplier: '2.8' }, now), 2.8)
  assert.equal(activeListingMultiplier({ id: 'listing-1', status: 'expired', multiplier: 3.0 }, now), null)
  assert.equal(activeListingMultiplier({ id: 'listing-1', status: 'active', multiplier: 3.0, expires_at: '2026-08-02T00:00:00.000Z' }, now), null)
  assert.equal(activeListingMultiplier({ id: 'listing-1', status: 'active', multiplier: 2.7 }, now), null)
  assert.equal(activeListingMultiplier({ status: 'active', multiplier: 2.8 }, now), null, 'an unpersisted fallback cannot be authoritative')
  assert.equal(activeListingMultiplier(null, now), null)
})

check('unlisted and expired cards are explicitly non-authoritative previews', () => {
  const now = Date.parse('2026-08-03T00:00:00.000Z')
  for (const listing of [
    null,
    { id: 'listing-1', status: 'expired', multiplier: 3.0 },
    { id: 'listing-1', status: 'active', multiplier: 3.0, expires_at: '2026-08-02T00:00:00.000Z' },
  ]) {
    const summary = buildPriceSummary({
      status: PRICE_STATUS.READY,
      ckdUsd: 4,
      listingStatus: listing ? OWNER_LISTING_STATUS.READY : OWNER_LISTING_STATUS.NONE,
      listing,
      now,
    })
    assert.equal(summary.authoritative, false)
    assert.equal(summary.priceLabel, 'Price preview')
    assert.equal(summary.multiplier, MULTIPLIERS[0], 'preview uses the documented default tier')
  }
})

check('loading and failed owner-listing lookups cannot manufacture a default-tier preview', () => {
  for (const listingStatus of [OWNER_LISTING_STATUS.LOADING, OWNER_LISTING_STATUS.ERROR]) {
    const summary = buildPriceSummary({
      status: PRICE_STATUS.READY,
      ckdUsd: 4.2,
      listingStatus,
      listing: null,
    })
    assert.equal(summary.baselineLabel, '$4.20')
    assert.equal(summary.sellLabel, null)
    assert.equal(summary.multiplier, null)
    assert.equal(summary.authoritative, false)
    assert.equal(summary.sellStatus, listingStatus === OWNER_LISTING_STATUS.LOADING
      ? PRICE_STATUS.LOADING
      : PRICE_STATUS.ERROR)
    assert.notEqual(summary.priceLabel, 'Price preview')
  }
})

check('zero and sub-rounding MYR values remain unavailable while preserving the CKD baseline', () => {
  for (const ckdUsd of [0, 0.01, 0.09]) {
    const summary = buildPriceSummary({
      status: PRICE_STATUS.READY,
      ckdUsd,
      listingStatus: OWNER_LISTING_STATUS.NONE,
      listing: null,
    })
    assert.equal(summary.baselineLabel, `$${ckdUsd.toFixed(2)}`)
    assert.equal(summary.sellStatus, PRICE_STATUS.UNAVAILABLE)
    assert.equal(summary.sellLabel, null)
    assert.equal(summary.myr, null)
  }
})

check('labels are explicit about currency and are formatted to 2dp', () => {
  assert.equal(formatUsd(1.5), '$1.50')
  assert.equal(formatMyr(4), 'RM 4.00')
  assert.equal(formatUsd(null), null)
  assert.equal(formatMyr(null), null)
})

check('loading, unavailable and error states render no price at all', () => {
  for (const status of [PRICE_STATUS.LOADING, PRICE_STATUS.ERROR, PRICE_STATUS.UNAVAILABLE]) {
    const s = buildPriceSummary({ status, ckdUsd: null, listing: null })
    assert.equal(s.status, status, 'non-ready status must be preserved')
    assert.equal(s.baselineLabel, null)
    assert.equal(s.sellLabel, null)
    assert.equal(s.myr, null)
  }
})

check('a ready fetch with no cached baseline degrades to unavailable, not a price', () => {
  const s = buildPriceSummary({ status: PRICE_STATUS.READY, ckdUsd: null, listing: null })
  assert.equal(s.status, PRICE_STATUS.UNAVAILABLE)
  assert.equal(s.sellLabel, null)
})

check('an unrecognised active multiplier becomes a preview rather than an authoritative misprice', () => {
  const s = buildPriceSummary({
    status: PRICE_STATUS.READY,
    ckdUsd: 4.0,
    listingStatus: OWNER_LISTING_STATUS.READY,
    listing: { id: 'listing-1', status: 'active', multiplier: 9.9 },
  })
  assert.equal(s.multiplier, MULTIPLIERS[0])
  assert.equal(s.sellLabel, 'RM 10.00')
  assert.equal(s.authoritative, false)
  assert.equal(s.priceLabel, 'Price preview')
})

check('CardDetailModal renders the price summary at the top of the Details tab', () => {
  const detailsTab = modalSource.slice(
    modalSource.indexOf('const detailsTab = ('),
    modalSource.indexOf('// Tab "Condition Photo"')
  )
  assert.ok(detailsTab.length > 0, 'detailsTab block not found')
  assert.ok(detailsTab.includes('<PriceSummary'), 'Details tab must render the price summary')
  assert.ok(
    detailsTab.indexOf('{artBlock}') < detailsTab.indexOf('<PriceSummary'),
    'price summary belongs directly under the art'
  )
  assert.ok(
    detailsTab.indexOf('<PriceSummary') < detailsTab.indexOf('{metadataBlock}'),
    'price summary must sit above the metadata block'
  )
  assert.ok(detailsTab.includes('<ListingSection'), 'listing controls must be preserved')
})

check('the summary exposes truthful authoritative and preview labels without a manual tier picker', () => {
  assert.ok(modalSource.includes('data-testid="library-detail-price-summary"'), 'summary test hook missing')
  assert.ok(modalSource.includes('data-testid="library-detail-price-usd"'), 'USD test hook missing')
  assert.ok(modalSource.includes('data-testid="library-detail-price-myr"'), 'MYR test hook missing')
  assert.ok(modalSource.includes('CardKingdom baseline'), 'baseline must be labelled as CardKingdom')
  assert.ok(modalSource.includes('USD'), 'baseline currency must be explicit')
  assert.ok(modalSource.includes('{summary.sellLabel}'), 'sell currency must render exactly once from the canonical label')
  // The original defect rendered `RM 10.50 MYR`. A byte-exact negative on one
  // spelling of that node is not a guard — a newline, `{' '}`, or a different
  // element would slip past it. Instead: no `MYR` designator may appear
  // anywhere in the PriceSummary render at all, in any formatting. `formatMyr`
  // already emits the `RM ` prefix, so a second designator is always a bug.
  const myrNodes = [...modalSource.matchAll(/data-testid="library-detail-price-myr"/g)]
  assert.equal(myrNodes.length, 2, 'expected exactly the ready and non-ready MYR nodes')
  const summaryRegion = modalSource.slice(
    modalSource.indexOf('function PriceSummary('),
    modalSource.indexOf('export default function CardDetailModal')
  )
  assert.ok(summaryRegion.length > 0, 'failed to isolate the PriceSummary render')
  // Scoped to the price rows themselves — the explanatory notes below them are
  // prose and may legitimately name the currency.
  const priceRows = summaryRegion.slice(0, summaryRegion.indexOf('data-testid="library-detail-price-note"'))
  assert.ok(priceRows.includes('library-detail-price-myr'), 'failed to isolate the price rows')
  assert.ok(
    !/\bMYR\b/.test(priceRows),
    'the rendered price rows must not emit any MYR designator; formatMyr already prefixes RM'
  )
  // The USD side keeps exactly one designator, rendered as its own element
  // beside the bare `$x.xx` label — not baked into the label string.
  assert.equal(
    (priceRows.match(/\bUSD\b/g) || []).length, 1,
    'the USD designator must be rendered exactly once'
  )
  assert.ok(
    !/formatUsd[\s\S]{0,80}USD/.test(readFileSync(new URL('../src/components/library-detail/priceSummary.js', import.meta.url), 'utf8')),
    'formatUsd must not bake a USD designator into the label'
  )
  assert.ok(modalSource.includes('summary.multiplier == null'), 'unresolved listing state must not render a multiplier')
  assert.ok(modalSource.includes('Preview only — choose a multiplier when listing this card.'), 'preview disclosure missing')
  assert.ok(!modalSource.includes('library-detail-price-multiplier-'), 'summary must not retain its redundant manual tier picker')
})

check('the baseline is fetched from the shared pricing cache endpoint, for the saved finish', () => {
  assert.ok(modalSource.includes("fetch('/api/pricing/batch'"), 'must reuse the existing pricing endpoint')
  assert.ok(modalSource.includes('scryfall_id: libraryRow.scryfall_id, foil: pricedFoil'), 'must request the priced finish')
  assert.ok(modalSource.includes("const pricedFoil = libraryRow.foil || 'normal'"), 'must price the saved finish')
  assert.ok(modalSource.includes('readCkdUsd(data, libraryRow.scryfall_id, pricedFoil)'), 'must read the matching key')
  assert.ok(modalSource.includes('[libraryRow.scryfall_id, pricedFoil]'), 'fetch must key off id and finish')
  assert.ok(modalSource.includes('cancelled = true'), 'in-flight fetch must be guarded against stale writes')
})

check('fetch failure and missing price are distinct, and no other price source is used', () => {
  assert.ok(modalSource.includes('setPriceStatus(PRICE_STATUS.ERROR)'), 'fetch failure must be surfaced')
  assert.ok(modalSource.includes('usd == null ? PRICE_STATUS.UNAVAILABLE : PRICE_STATUS.READY'), 'missing price must be surfaced')
  assert.ok(modalSource.includes('Could not load the CardKingdom price'), 'error copy missing')
  assert.ok(modalSource.includes('No CardKingdom price for this printing'), 'unavailable copy missing')
  assert.ok(modalSource.includes('Loading CardKingdom price'), 'loading copy missing')
  const priceRegion = modalSource.slice(
    modalSource.indexOf('function PriceSummary('),
    modalSource.indexOf('export default function CardDetailModal')
  )
  for (const token of ['scryfall', 'Scryfall', 'prices.usd', 'cardData?.prices']) {
    assert.ok(!priceRegion.includes(token), `price summary must not fall back to ${token}`)
  }
})

check('an unsaved finish edit is disclosed rather than silently mispriced', () => {
  assert.ok(modalSource.includes('finishIsUnsaved={foil !== libraryRow.foil}'), 'unsaved finish must be detected')
  assert.ok(modalSource.includes('Save changes to reprice'), 'unsaved finish must be disclosed')
})

check('CardDetailModal owns listing state and ListingSection reports every persisted transition', () => {
  for (const status of ['LOADING', 'NONE', 'READY', 'ERROR']) {
    assert.ok(modalSource.includes(`OWNER_LISTING_STATUS.${status}`), `modal must represent ${status.toLowerCase()} listing state`)
  }
  assert.ok(modalSource.includes('listingState={ownerListingState}'), 'price and listing controls must receive modal-owned state')
  assert.ok(modalSource.includes('onListingChange={handleListingChange}'), 'persisted transitions must update modal state')
  assert.match(listingSource, /listingState,\s+onListingChange/, 'ListingSection must consume explicit listing state')
  assert.ok(!listingSource.includes('const [listing, setListing]'), 'ListingSection must not retain a stale private listing copy')
  assert.equal(listingSource.match(/onListingChange\(nextListing\)/g)?.length, 2, 'list and relist success must both report the persisted listing')
  assert.ok(listingSource.includes('onListingChange(null)'), 'unlist success must clear modal listing state')
  assert.ok(!listingSource.includes('setListing('), 'all listing writes must flow through the owner callback')
})

check('Claim Sale success propagates the exact returned active listing and fails closed without it', () => {
  assert.ok(listingSource.includes('onListingCreated={onListingChange}'), 'Claim Sale listing must flow through ListingSection')
  assert.ok(modalSource.includes('onListingUncertain={handleListingUncertain}'), 'modal must own ambiguous Claim Sale state')
  assert.ok(listingSource.includes('onListingUncertain={onListingUncertain}'), 'ListingSection must forward ambiguous Claim Sale state')
  assert.ok(claimSaleSource.includes('onListingUncertain?.()'), 'partial Claim Sale success must invalidate confirmed-none state')
  // The parse itself is now guarded (PR #8 review F2): a malformed 201 body is
  // as ambiguous as a missing listing and takes the same fail-closed path.
  assert.match(
    claimSaleSource,
    /try\s*\{\s*data\s*=\s*await res\.json\(\)\s*\}\s*catch\s*\{\s*onListingUncertain\?\.\(\)/,
    'the successful Claim Sale response must be parsed inside a fail-closed guard'
  )
  assert.ok(claimSaleSource.includes('listing.library_card_id === libraryRow.id'), 'the returned listing must match the modal card')
  assert.ok(claimSaleSource.includes("listing.status === 'active'"), 'the returned listing must be active')
  assert.ok(claimSaleSource.includes('onListingCreated(nextListing)'), 'the exact returned listing must reach the modal owner')
  assert.ok(claimSaleSource.includes('Claim sale was created, but its listing could not be confirmed'), 'missing-listing response must fail closed')
  assert.ok(
    claimSaleSource.indexOf('onListingUncertain?.()') <
      claimSaleSource.indexOf("throw new Error('Claim sale was created, but its listing could not be confirmed')"),
    'ambiguous state must reach the modal before the partial-response error is reported'
  )
})

check('the modal schedules a rerender at the active listing expiry boundary', () => {
  assert.ok(modalSource.includes('setTimeout(scheduleExpiryBoundary'), 'expiry must schedule an open-modal invalidation')
  assert.ok(modalSource.includes('setListingClock(Date.now())'), 'expiry must advance the price-summary clock')
  assert.ok(modalSource.includes('now={listingClock}'), 'price summary must use the invalidated clock')
})

check('the unavailable MYR state is rendered explicitly instead of RM 0.00', () => {
  assert.ok(modalSource.includes('summary.sellStatus === PRICE_STATUS.READY'), 'MYR rendering must use its own validity state')
  assert.ok(modalSource.includes('No positive MYR price is available for this printing.'), 'non-positive unavailable copy missing')
})

check('existing detail-modal surfaces are preserved', () => {
  for (const hook of [
    'library-detail-tab-details',
    'library-detail-tab-photo',
    'library-detail-tab-fbsale',
    'library-detail-save-btn',
    'library-detail-panel',
    'library-detail-sheet',
  ]) {
    assert.ok(modalSource.includes(hook), `missing preserved surface ${hook}`)
  }
  assert.ok(modalSource.includes('<PhotoSection'), 'Condition Photo tab must be preserved')
  assert.ok(modalSource.includes('<FacebookSaleImage'), 'Facebook Sale tab must be preserved')
  assert.ok(modalSource.includes('handleDelete'), 'delete flow must be preserved')
  assert.ok(modalSource.includes("document.addEventListener('keydown', onKeyDown)"), 'focus trap / escape must be preserved')
  assert.ok(modalSource.includes('const storedImage = ci?.image_uris?.normal || ci?.image_uris?.small || null'), 'current-main stored catalog image path must be preserved')
  assert.ok(modalSource.includes('if (storedImage)'), 'stored catalog images must bypass invalid synthetic Scryfall lookups')
  assert.ok(modalSource.includes('[libraryRow.scryfall_id, storedImage]'), 'stored image changes must invalidate the image effect')
})

check('the price summary adds no duplicate DOM ids across the desktop/mobile trees', () => {
  const priceRegion = modalSource.slice(
    modalSource.indexOf('function PriceSummary('),
    modalSource.indexOf('export default function CardDetailModal')
  )
  assert.ok(!/\sid=/.test(priceRegion), 'summary must not declare ids (rendered in both breakpoint trees)')
})

console.log(`\n${passed} checks passed\n`)
