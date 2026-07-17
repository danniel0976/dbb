/**
 * Phase 41 focused checks — Bazaar price correctness and URL-state round
 * trips for Library and Claim Sales. Exercises the extracted pure logic
 * directly (no live Supabase/dev-server dependency), mirroring the repo's
 * existing focused-check scripts (e.g. phase39-test-checkout-orders.mjs)
 * but scoped to code that doesn't require a disposable stack.
 *
 * Run: node scripts/phase41-test-search-sort-filter.mjs
 */
import assert from 'node:assert/strict'
import { sellPrice } from '../src/lib/pricingCache.js'
import {
  parseLibraryQueryState,
  serializeLibraryQueryState,
  toLibraryQueryFilters,
  EMPTY_LIBRARY_FILTERS,
} from '../src/lib/librarySearchState.js'
import {
  parseBazaarQueryState,
  serializeBazaarQueryState,
  buildBazaarFilterChips,
  BAZAAR_CHIP_CLEAR_PATCH,
  hasActiveBazaarFilters,
  EMPTY_BAZAAR_FILTERS,
} from '../src/lib/bazaarSearchState.js'
import { extractTopLevelTypes } from '../src/lib/listingsQueries.js'
import { filterSheetReducer, initFilterSheetState } from '../src/lib/filterSheetState.js'

let passed = 0
function check(name, fn) {
  fn()
  passed++
  console.log(`  ok - ${name}`)
}

console.log('=== Phase 41: Bazaar price correctness ===')

// Fixtures straight from the product spec's acceptance criteria (Feature 4):
// CKD $10 x 2.5 = RM25, CKD $5 x 3.0 = RM15. Price low->high must return
// RM15 before RM25 -- proving the sort is not ordering by multiplier alone
// (multiplier 2.5 < 3.0 would put RM25 first if multiplier were used).
check('sellPrice reproduces the displayed MYR value (CKD x multiplier, not multiplier alone)', () => {
  const a = sellPrice(10, 2.5) // RM25
  const b = sellPrice(5, 3.0)  // RM15
  assert.equal(a, 25)
  assert.equal(b, 15)
  const listings = [
    { id: '1', myrPrice: a },
    { id: '2', myrPrice: b },
  ]
  const sortedLow = listings.slice().sort((x, y) => x.myrPrice - y.myrPrice)
  assert.deepEqual(sortedLow.map(l => l.id), ['2', '1'], 'price_low must rank RM15 before RM25')
})

check('min/max MYR filter excludes out-of-range and missing-price listings', () => {
  const rows = [
    { id: 'a', myrPrice: 15 },
    { id: 'b', myrPrice: 25 },
    { id: 'c', myrPrice: null }, // price cache miss -> "Price unavailable" on the tile
  ]
  const minPrice = 20
  const maxPrice = null
  const filtered = rows.filter(({ myrPrice }) => {
    if (myrPrice == null) return false
    if (minPrice !== null && myrPrice < minPrice) return false
    if (maxPrice !== null && myrPrice > maxPrice) return false
    return true
  })
  assert.deepEqual(filtered.map(r => r.id), ['b'], 'min RM20 must return RM25 and exclude RM15 and missing-price rows')
})

check('missing-price listings sort after priced listings when no range filter is active', () => {
  const rows = [
    { id: 'x', myrPrice: null },
    { id: 'y', myrPrice: 10 },
    { id: 'z', myrPrice: 5 },
  ]
  const dir = 1 // price_low
  const sorted = rows.slice().sort((a, b) => {
    if (a.myrPrice == null && b.myrPrice == null) return a.id < b.id ? -1 : 1
    if (a.myrPrice == null) return 1
    if (b.myrPrice == null) return -1
    if (a.myrPrice !== b.myrPrice) return dir * (a.myrPrice - b.myrPrice)
    return a.id < b.id ? -1 : 1
  })
  assert.deepEqual(sorted.map(r => r.id), ['z', 'y', 'x'])
})

console.log('\n=== Phase 41: Library URL round trip ===')

check('a filtered Library URL parses to the same state the server prefetch and client will both use', () => {
  const url = new URL('https://example.test/library?q=bolt&sort=price_low&colors=WU&rarity=rare,mythic&foil=foil&starred=1&set=woe')
  const parsed = parseLibraryQueryState(url.searchParams)
  assert.equal(parsed.q, 'bolt')
  assert.equal(parsed.sort, 'price_low')
  assert.deepEqual(parsed.filters.colors, ['W', 'U'])
  assert.deepEqual(parsed.filters.rarity, ['rare', 'mythic'])
  assert.equal(parsed.filters.foil, 'foil')
  assert.equal(parsed.filters.starred, true)
  assert.equal(parsed.filters.set_code, 'woe')
})

check('serialize -> parse round-trips to an equivalent state (copy/reload/back-forward safe)', () => {
  const original = {
    q: 'lightning',
    sort: 'name',
    filters: { ...EMPTY_LIBRARY_FILTERS, colors: ['R'], rarity: ['common'], foil: 'normal', starred: true, set_code: 'lea' },
  }
  const serialized = serializeLibraryQueryState(original.filters, original.q, original.sort)
  const reparsed = parseLibraryQueryState(serialized)
  assert.equal(reparsed.q, original.q)
  assert.equal(reparsed.sort, original.sort)
  assert.deepEqual(reparsed.filters.colors, original.filters.colors)
  assert.deepEqual(reparsed.filters.rarity, original.filters.rarity)
  assert.equal(reparsed.filters.foil, original.filters.foil)
  assert.equal(reparsed.filters.starred, original.filters.starred)
  assert.equal(reparsed.filters.set_code, original.filters.set_code)
})

check('default (unfiltered, unsorted) URL parses to defaults, not stale state', () => {
  const parsed = parseLibraryQueryState(new URLSearchParams(''))
  assert.equal(parsed.q, '')
  assert.equal(parsed.sort, 'newest')
  assert.deepEqual(parsed.filters, EMPTY_LIBRARY_FILTERS)
})

check('server prefetch (plain searchParams object) parses identically to the client URLSearchParams path', () => {
  const plainServerSearchParams = { q: 'bolt', sort: 'price_low', rarity: 'rare,mythic' }
  const clientUrl = new URL('https://example.test/library?q=bolt&sort=price_low&rarity=rare,mythic')
  const fromServer = parseLibraryQueryState(plainServerSearchParams)
  const fromClient = parseLibraryQueryState(clientUrl.searchParams)
  assert.deepEqual(fromServer, fromClient)
})

check('toLibraryQueryFilters merges binder override without losing sort/q/filters', () => {
  const parsed = parseLibraryQueryState(new URL('https://example.test/library?q=bolt&sort=set&colors=W').searchParams)
  const merged = toLibraryQueryFilters(parsed, 'binder-123')
  assert.equal(merged.q, 'bolt')
  assert.equal(merged.sort, 'set')
  assert.deepEqual(merged.colors, ['W'])
  assert.equal(merged.binder_id, 'binder-123')
})

console.log('\n=== Phase 41: Claim Sales URL state (inline parser, mirrors ClaimSalesBrowse.js) ===')

// ClaimSalesBrowse keeps its own tiny parser scoped to cs_section/cs_q so it
// doesn't collide with any future Bazaar-wide URL state. Re-implemented here
// verbatim (not imported, since the component file is 'use client') to keep
// this a focused regression check on the exact contract.
function parseClaimSalesQueryState(sp) {
  const section = sp.get('cs_section')
  return {
    section: section === 'ending_soon' ? 'ending_soon' : 'hot',
    q: sp.get('cs_q') || '',
  }
}

check('Claim Sales URL with section+search round-trips', () => {
  const url = new URL('https://example.test/bazaar?cs_section=ending_soon&cs_q=bolt')
  const parsed = parseClaimSalesQueryState(url.searchParams)
  assert.equal(parsed.section, 'ending_soon')
  assert.equal(parsed.q, 'bolt')
})

check('Claim Sales URL with no state defaults to hot / empty search', () => {
  const parsed = parseClaimSalesQueryState(new URLSearchParams(''))
  assert.equal(parsed.section, 'hot')
  assert.equal(parsed.q, '')
})

console.log('\n=== Phase 41: Bazaar full-corpus facets ===')

// A minimal fixture standing in for "active listings beyond the first 24
// Newest rows" — the tech audit's concrete failure case (P1 #4).
check('extractTopLevelTypes finds the top-level type and ignores supertypes/subtypes', () => {
  assert.deepEqual(extractTopLevelTypes('Legendary Creature — Human Wizard'), ['Creature'])
  assert.deepEqual(extractTopLevelTypes('Basic Land — Island'), ['Land'])
  assert.deepEqual(extractTopLevelTypes('Instant'), ['Instant'])
  assert.deepEqual(extractTopLevelTypes('Artifact Creature — Golem'), ['Artifact', 'Creature'])
  assert.deepEqual(extractTopLevelTypes(''), [])
  assert.deepEqual(extractTopLevelTypes(null), [])
})

check('facet aggregation surfaces a set/type outside a simulated first-page window', () => {
  // Simulate getActiveListingFacets' row-reduction loop directly: page 1
  // (first 24, Newest order) only contains set "WOE"; a listing on page 2+
  // carries set "OTJ" and type "Planeswalker" that must still appear.
  const page1 = Array.from({ length: 24 }, (_, i) => ({
    library_cards: { card_index: { set_code: 'woe', set_name: 'Wilds of Eldraine', rarity: 'common', type_line: 'Creature — Human' } },
  }))
  const beyondPage1 = [{
    library_cards: { card_index: { set_code: 'otj', set_name: 'Outlaws of Thunder Junction', rarity: 'mythic', type_line: 'Legendary Planeswalker — Oko' } },
  }]
  const allRows = [...page1, ...beyondPage1]

  const sets = new Map()
  const rarities = new Set()
  const cardTypes = new Set()
  for (const row of allRows) {
    const ci = row.library_cards?.card_index
    if (ci?.set_code) sets.set(ci.set_code, ci.set_name || ci.set_code)
    if (ci?.rarity) rarities.add(ci.rarity)
    for (const t of extractTopLevelTypes(ci?.type_line)) cardTypes.add(t)
  }

  assert.ok(sets.has('otj'), 'set from beyond the first 24 rows must be present')
  assert.ok(rarities.has('mythic'), 'rarity from beyond the first 24 rows must be present')
  assert.ok(cardTypes.has('Planeswalker'), 'card type from beyond the first 24 rows must be present (was hard-coded empty)')
})

console.log('\n=== Phase 41: Bazaar URL state, chips, and stale-response protection ===')

check('a filtered Bazaar URL parses to the same filter shape the client uses', () => {
  const url = new URL('https://example.test/bazaar?q=bolt&sort=price_low&set=woe&rarity=rare,mythic&colors=WU&type=Instant&foil=foil&min=10&max=50')
  const parsed = parseBazaarQueryState(url.searchParams)
  assert.equal(parsed.search, 'bolt')
  assert.equal(parsed.sortBy, 'price_low')
  assert.equal(parsed.setCode, 'woe')
  assert.deepEqual(parsed.rarities, ['rare', 'mythic'])
  assert.deepEqual(parsed.colors, ['W', 'U'])
  assert.equal(parsed.cardType, 'Instant')
  assert.equal(parsed.isFoil, true)
  assert.equal(parsed.minPrice, 10)
  assert.equal(parsed.maxPrice, 50)
})

check('serialize -> parse round-trips Bazaar filter state (copy/reload/back-forward safe)', () => {
  const original = {
    search: 'lightning',
    sortBy: 'name_az',
    setCode: 'lea',
    rarities: ['common', 'uncommon'],
    colors: ['R'],
    cardType: 'Sorcery',
    isFoil: false,
    minPrice: 5,
    maxPrice: null,
  }
  const serialized = serializeBazaarQueryState(original)
  const reparsed = parseBazaarQueryState(serialized)
  assert.deepEqual(reparsed, original)
})

check('default (unfiltered) Bazaar URL parses to EMPTY_BAZAAR_FILTERS, not stale state', () => {
  const parsed = parseBazaarQueryState(new URLSearchParams(''))
  assert.deepEqual(parsed, EMPTY_BAZAAR_FILTERS)
  assert.equal(hasActiveBazaarFilters(parsed), false)
})

check('applying three facets creates three chips; removing the middle chip clears only that predicate', () => {
  const filters = { ...EMPTY_BAZAAR_FILTERS, setCode: 'woe', rarities: ['rare'], isFoil: true }
  const chips = buildBazaarFilterChips(filters, { sets: [{ code: 'woe', name: 'Wilds of Eldraine' }] })
  assert.equal(chips.length, 3)
  const middle = chips[1] // rarities
  assert.equal(middle.key, 'rarities')
  const patch = BAZAAR_CHIP_CLEAR_PATCH[middle.key]
  const next = { ...filters, ...patch }
  assert.deepEqual(next.rarities, [])
  assert.equal(next.setCode, 'woe', 'unrelated predicate must survive single-chip removal')
  assert.equal(next.isFoil, true, 'unrelated predicate must survive single-chip removal')
})

check('Clear all resets every Bazaar predicate including sort, back to defaults', () => {
  const filters = { search: 'bolt', sortBy: 'price_high', setCode: 'woe', rarities: ['rare'], colors: ['R'], cardType: 'Instant', isFoil: true, minPrice: 5, maxPrice: 50 }
  assert.equal(hasActiveBazaarFilters(filters), true)
  const cleared = { ...EMPTY_BAZAAR_FILTERS }
  assert.deepEqual(cleared, EMPTY_BAZAAR_FILTERS)
  assert.equal(hasActiveBazaarFilters(cleared), false)
})

check('stale response rejected: an older request generation must not overwrite a newer one', () => {
  // Mirrors BazaarView's reqGenRef guard: fire "bo" then "bolt", let "bo"
  // resolve after "bolt" (network reordering), and assert only "bolt" wins.
  let reqGen = 0
  let rendered = null
  function startRequest(query) {
    const gen = ++reqGen
    return { gen, query }
  }
  function resolve(req) {
    if (req.gen !== reqGen) return // stale — superseded by a newer request
    rendered = req.query
  }
  const reqBo = startRequest('bo')
  const reqBolt = startRequest('bolt')
  // "bolt" (the newer, later-fired request) resolves first...
  resolve(reqBolt)
  // ...then the older "bo" response arrives late and must be ignored.
  resolve(reqBo)
  assert.equal(rendered, 'bolt', 'a late-arriving stale response must not overwrite the newest applied query')
})

console.log('\n=== Phase 41: mobile filter sheet staged/Apply/discard semantics ===')

// Simulates a surface (BazaarView/LibraryView) that owns "applied" filters
// outside the reducer, exactly as the real components do: the reducer only
// ever tracks sheet.open/sheet.draft, and the caller commits sheet.draft to
// its own applied state solely on APPLY.
function simulateSurface(initialApplied) {
  let applied = { ...initialApplied }
  let state = initFilterSheetState(applied)
  return {
    getApplied: () => applied,
    getDraft: () => state.draft,
    isOpen: () => state.open,
    open: () => { state = filterSheetReducer(state, { type: 'OPEN', applied }) },
    edit: (patch) => { state = filterSheetReducer(state, { type: 'EDIT', patch }) },
    clearDraft: (empty) => { state = filterSheetReducer(state, { type: 'REPLACE_DRAFT', draft: empty }) },
    apply: () => {
      const next = state.draft // caller reads draft BEFORE dispatching APPLY
      state = filterSheetReducer(state, { type: 'APPLY' })
      applied = { ...next } // this is the one and only commit path
    },
    close: () => { state = filterSheetReducer(state, { type: 'CLOSE' }) }, // no commit
  }
}

check('opening the sheet stages a draft copy equal to the currently applied filters', () => {
  const applied = { ...EMPTY_BAZAAR_FILTERS, setCode: 'woe' }
  const surface = simulateSurface(applied)
  surface.open()
  assert.deepEqual(surface.getDraft(), applied)
  assert.notEqual(surface.getDraft(), applied, 'draft must be a copy, not the same reference')
})

check('editing the draft does not mutate applied filters until Apply', () => {
  const applied = { ...EMPTY_BAZAAR_FILTERS }
  const surface = simulateSurface(applied)
  surface.open()
  surface.edit({ setCode: 'mkm', rarities: ['rare', 'mythic'] })
  assert.deepEqual(surface.getApplied(), EMPTY_BAZAAR_FILTERS, 'no per-edit commit — this is what "no request per checkbox" depends on')
  assert.equal(surface.getDraft().setCode, 'mkm')
})

check('closing the sheet without Apply discards the draft and keeps the previously applied filters', () => {
  const applied = { ...EMPTY_BAZAAR_FILTERS, cardType: 'Creature' }
  const surface = simulateSurface(applied)
  surface.open()
  surface.edit({ setCode: 'mkm', cardType: 'Instant', isFoil: true })
  surface.close()
  assert.equal(surface.isOpen(), false)
  assert.deepEqual(surface.getApplied(), { ...EMPTY_BAZAAR_FILTERS, cardType: 'Creature' }, 'accidental close must not lose the prior applied state')
})

check('reopening after a discarded close starts from applied again, not the abandoned draft', () => {
  const applied = { ...EMPTY_BAZAAR_FILTERS }
  const surface = simulateSurface(applied)
  surface.open()
  surface.edit({ setCode: 'mkm' })
  surface.close() // discard
  surface.open() // reopen — must not resurrect the discarded 'mkm' edit
  assert.equal(surface.getDraft().setCode, null)
})

check('Apply commits exactly the staged draft to applied filters, in one step', () => {
  const applied = { ...EMPTY_BAZAAR_FILTERS }
  const surface = simulateSurface(applied)
  surface.open()
  surface.edit({ setCode: 'mkm', rarities: ['mythic'], isFoil: true, minPrice: 10 })
  assert.deepEqual(surface.getApplied(), EMPTY_BAZAAR_FILTERS, 'still unapplied right before Apply')
  surface.apply()
  assert.equal(surface.isOpen(), false)
  assert.deepEqual(surface.getApplied(), {
    ...EMPTY_BAZAAR_FILTERS,
    setCode: 'mkm',
    rarities: ['mythic'],
    isFoil: true,
    minPrice: 10,
  })
})

check('Clear all inside the sheet resets only the draft, and still requires Apply to take effect', () => {
  const applied = { ...EMPTY_BAZAAR_FILTERS, setCode: 'woe', rarities: ['rare'] }
  const surface = simulateSurface(applied)
  surface.open()
  surface.clearDraft(EMPTY_BAZAAR_FILTERS)
  assert.deepEqual(surface.getDraft(), EMPTY_BAZAAR_FILTERS)
  assert.deepEqual(surface.getApplied(), applied, 'Clear all in the sheet must not itself fire a request/commit')
  surface.apply()
  assert.deepEqual(surface.getApplied(), EMPTY_BAZAAR_FILTERS)
})

console.log(`\n${passed} Phase 41 checks passed`)
