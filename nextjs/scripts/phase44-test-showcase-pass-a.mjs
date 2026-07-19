/**
 * Phase 44 Showcase Pass A focused source/regression guard.
 * Run: node scripts/phase44-test-showcase-pass-a.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildShowcaseShelves, canCommitBazaarRequest } from '../src/lib/bazaarShowcase.js'

const read = relative => readFileSync(new URL(relative, import.meta.url), 'utf8')
const view = read('../src/components/BazaarView.js')
const card = read('../src/components/BazaarCard.js')
const sheet = read('../src/components/FilterSheet.js')
const css = read('../src/app/globals.css')

let passed = 0
function check(name, fn) {
  fn()
  passed++
  console.log(`  ok - ${name}`)
}

console.log('=== Phase 44: Showcase Pass A ===')

check('mode predicate treats search and every facet as Results, but not sort alone', () => {
  const predicate = view.slice(
    view.indexOf('function hasSearchOrFacetPredicates'),
    view.indexOf('function buildChips')
  )
  for (const token of ['filters.search.trim()', 'filters.setCode', 'filters.rarities.length', 'filters.colors.length', 'filters.cardType', 'filters.isFoil !== null', 'filters.minPrice !== null', 'filters.maxPrice !== null']) {
    assert.ok(predicate.includes(token), `mode predicate must include ${token}`)
  }
  assert.ok(!predicate.includes('sortBy'), 'sort alone must preserve Showcase mode')
  assert.ok(view.includes('const isResultsMode = hasSearchOrFacetPredicates(filters)'))
})

check('Singles renders explicit Showcase and Results mode markers', () => {
  assert.ok(view.includes("data-bazaar-mode={isResultsMode ? 'results' : 'showcase'}"))
  assert.ok(view.includes('data-bazaar-showcase'))
  assert.ok(view.includes('data-bazaar-results'))
  assert.ok(view.includes('showcaseShelves.map'))
  assert.ok(view.includes('listings.map'))
})

check('permanent desktop sidebar is replaced by a horizontal rail and anchored popover', () => {
  assert.ok(!view.includes('<aside'), 'Singles must not render a permanent sidebar')
  assert.ok(view.includes('data-bazaar-filter-rail'))
  assert.ok(view.includes('aria-controls="bazaar-desktop-filters"'))
  assert.ok(view.includes('aria-expanded={filterPopoverOpen}'))
  assert.ok(view.includes('role="dialog"'))
})

check('mobile filters retain reducer-backed staged Apply/discard wiring', () => {
  for (const token of ['useReducer(', 'filterSheetReducer', 'initFilterSheetState', "sendMobileFilter({ type: 'OPEN', applied: filters })", "sendMobileFilter({ type: 'EDIT', patch })", "sendMobileFilter({ type: 'CLOSE' })", "sendMobileFilter({ type: 'APPLY' })", 'const next = mobileFilterState.draft', 'open={mobileFilterState.open}', 'filters={mobileFilterState.draft}']) {
    assert.ok(view.includes(token), `mobile staged wiring must include ${token}`)
  }
  assert.ok(sheet.includes('triggerRef?.current?.focus()'), 'sheet must restore trigger focus')
})

check('tiles keep pricing visible, request small art first, and never crop art', () => {
  assert.ok(card.includes('priceData?.ckd_usd'))
  assert.ok(card.includes('RM {myrPrice.toFixed(2)}'))
  assert.ok(card.includes('Price unavailable'))
  assert.ok(card.includes('image_uris?.small || ci?.image_uris?.normal'))
  assert.ok(card.includes('object-contain'))
  assert.ok(!card.includes('object-cover'))
})

check('Showcase uses scroll snap and Results defer offscreen card paint', () => {
  assert.ok(view.includes('snap-x snap-mandatory'))
  assert.ok(view.includes('snap-start'))
  assert.ok(css.includes('.bazaar-result-card'))
  assert.ok(css.includes('content-visibility: auto'))
})

check('Showcase partitions every mixed listing exactly once', () => {
  const listings = Array.from({ length: 30 }, (_, index) => ({
    id: `listing-${index}`,
    library_cards: {
      foil: index % 4 === 0 ? 'foil' : 'normal',
      card_index: { rarity: index % 5 === 0 ? 'rare' : index % 3 === 0 ? 'uncommon' : 'common' },
    },
  }))
  const shelves = buildShowcaseShelves(listings)
  const ids = shelves.flatMap(shelf => shelf.items.map(item => item.id))
  assert.deepEqual(ids, buildShowcaseShelves(listings).flatMap(shelf => shelf.items.map(item => item.id)))
  assert.equal(ids.length, listings.length)
  assert.equal(new Set(ids).size, listings.length)
})

check('stale pagination responses cannot commit after a newer generation', () => {
  let generation = 1
  let results = ['new-page-one']
  let deliverOld
  const deferredOldPage = {
    then(onFulfilled) { deliverOld = onFulfilled },
  }
  deferredOldPage.then(items => {
    if (canCommitBazaarRequest(1, generation)) results.push(...items)
  })
  generation = 2
  deliverOld(['old-page-two'])
  assert.deepEqual(results, ['new-page-one'])
})

check('desktop popover escapes rail clipping and restores focus on Escape', () => {
  assert.ok(view.includes('<div ref={filterPopoverRef} className="relative z-20 mb-5">'))
  assert.ok(view.includes('ref={filterTriggerRef}'))
  assert.ok(view.includes('aria-haspopup="dialog"'))
  assert.ok(view.includes("filterTriggerRef.current?.focus()"))
  assert.ok(view.includes('applyLabel="Apply filters"'))
})

check('no undeclared scaffold state survives the recovery', () => {
  for (const token of ['filterSheetOpen', 'setFilterSheetOpen', 'SORT_LABELS', 'sheet.draft', 'dispatchSheet', 'draftPriceValid', 'setDraftPriceValid']) {
    assert.ok(!view.includes(token), `Bazaar must not reference undeclared scaffold token ${token}`)
  }
})

console.log(`\n${passed} Phase 44 checks passed`)
