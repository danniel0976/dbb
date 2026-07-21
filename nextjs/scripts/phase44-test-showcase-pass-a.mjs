/**
 * Phase 44 Showcase Pass A focused source/regression guard.
 *
 * Superseded scope (this revision): Dan moved the Hot Selling / Latest
 * showcase off Bazaar entirely onto a new Home page (`/`). Bazaar (`/bazaar`)
 * is grid-only again — no Showcase/Results mode split. The checks below
 * were rewritten to match that: they guard against the showcase mode
 * machinery creeping back into BazaarView, and confirm the extracted
 * ShowcaseRow/heroListings/HomeView pieces exist and are wired correctly.
 * The original per-tile, filter-rail, mobile-sheet, and pagination-guard
 * checks are unaffected by the move and are kept as-is.
 *
 * Run: node scripts/phase44-test-showcase-pass-a.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { buildShowcaseShelves, canCommitBazaarRequest } from '../src/lib/bazaarShowcase.js'

const read = relative => readFileSync(new URL(relative, import.meta.url), 'utf8')
const view = read('../src/components/BazaarView.js')
const card = read('../src/components/BazaarCard.js')
const sheet = read('../src/components/FilterSheet.js')
const css = read('../src/app/globals.css')
const bazaarPage = read('../src/app/bazaar/page.js')
const homePage = read('../src/app/page.js')
const homeView = read('../src/components/HomeView.js')
const showcaseRow = read('../src/components/ShowcaseRow.js')
const heroListingsLib = read('../src/lib/heroListings.js')
const dbbNav = read('../src/components/DBBNav.js')

let passed = 0
function check(name, fn) {
  fn()
  passed++
  console.log(`  ok - ${name}`)
}

console.log('=== Phase 44: Showcase Pass A (moved to Home) ===')

check('Bazaar no longer has a Showcase/Results mode split', () => {
  for (const token of [
    'isResultsMode', 'hasSearchOrFacetPredicates', 'data-bazaar-mode', 'data-bazaar-showcase',
    'hotListings', 'latestListings', 'showcaseShelves', 'buildShowcaseShelves',
    'ShowcaseRow', 'ShowcaseSection', 'HERO SECTION',
  ]) {
    assert.ok(!view.includes(token), `BazaarView must not reference removed showcase token ${token}`)
  }
})

check('Bazaar grid renders unconditionally and is the only results surface', () => {
  assert.ok(view.includes('data-bazaar-results'))
  assert.ok(view.includes('listings.map'))
  assert.ok(view.includes("grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 min-[900px]:grid-cols-4 lg:gap-5 min-[1440px]:grid-cols-5"))
})

check('infinite-scroll sentinel/observer are unconditional (no mode gate)', () => {
  assert.ok(view.includes("document.getElementById('bazaar-sentinel')"))
  assert.ok(view.includes('id="bazaar-sentinel"'))
  assert.ok(!/if \(!isResultsMode\) return/.test(view))
})

check('bazaar/page.js no longer fetches or passes hero listings', () => {
  for (const token of ['hotListings', 'latestListings', 'HERO_COUNT', 'getHeroListings']) {
    assert.ok(!bazaarPage.includes(token), `bazaar/page.js must not reference ${token}`)
  }
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

check('Results grid defers offscreen card paint', () => {
  assert.ok(css.includes('.bazaar-result-card'))
  assert.ok(css.includes('content-visibility: auto'))
})

check('bazaarShowcase.js helpers still partition/guard correctly (used by Home + pagination)', () => {
  const listings = Array.from({ length: 30 }, (_, index) => ({
    id: `listing-${index}`,
    library_cards: {
      foil: index % 4 === 0 ? 'foil' : 'normal',
      card_index: { rarity: index % 5 === 0 ? 'rare' : index % 3 === 0 ? 'uncommon' : 'common' },
    },
  }))
  const shelves = buildShowcaseShelves(listings)
  const ids = shelves.flatMap(shelf => shelf.items.map(item => item.id))
  assert.deepEqual(
    shelves.find(shelf => shelf.key === 'fresh-arrivals').items.map(item => item.id),
    listings.slice(0, 12).map(item => item.id),
    'Fresh arrivals must be the first up-to-12 listings in current order'
  )
  assert.equal(ids.length, listings.length)
  assert.equal(new Set(ids).size, listings.length)
})

check('loadListings binds caught errors and guards bare catch regressions', () => {
  assert.ok(view.includes('} catch (err) {'), 'loadListings must declare its caught error')
  for (const match of view.matchAll(/catch\s*\{([\s\S]*?)\}/g)) {
    assert.ok(!/\berr\b/.test(match[1]), 'a bare catch body must not reference err')
  }
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

check('Home page (/) redirects guests to /login and renders HomeView for signed-in users', () => {
  assert.ok(homePage.includes("if (!user) redirect('/login')"))
  assert.ok(homePage.includes('getHeroListings'))
  assert.ok(homePage.includes('<HomeView'))
  assert.ok(homePage.includes('<DBBNav'))
})

check('HomeView renders the showcase rows and reuses BazaarDetailModal for the inspector', () => {
  assert.ok(homeView.includes("import ShowcaseRow from '@/components/ShowcaseRow'"))
  assert.ok(homeView.includes("import BazaarDetailModal from '@/components/BazaarDetailModal'"))
  assert.ok(homeView.includes('data-home-showcase'))
  assert.ok(homeView.includes('title="Hot Selling"'))
  assert.ok(homeView.includes('title="Latest"'))
})

check('ShowcaseRow is a standalone component (not a local BazaarView function)', () => {
  assert.ok(showcaseRow.includes('export default function ShowcaseRow'))
  assert.ok(!view.includes('function ShowcaseRow'))
})

check('heroListings.js owns the hot/latest query logic shared by Home', () => {
  assert.ok(heroListingsLib.includes('export async function getHeroListings'))
  assert.ok(heroListingsLib.includes("eq('status', 'active')"))
})

check('DBBNav adds Home as the first primary link and wordmark points at /', () => {
  assert.ok(dbbNav.includes("{ href: '/', label: 'Home', icon: Home }"))
  const primaryLinksBlock = dbbNav.slice(dbbNav.indexOf('const PRIMARY_LINKS'), dbbNav.indexOf(']', dbbNav.indexOf('const PRIMARY_LINKS')))
  assert.ok(primaryLinksBlock.trim().startsWith("const PRIMARY_LINKS = [\n  { href: '/', label: 'Home'"), 'Home must be the first primary link')
  assert.ok(dbbNav.includes('<Link href="/" className="text-lg font-bold'))
  assert.ok(dbbNav.includes("href === '/' ? pathname === '/' : pathname?.startsWith(href)"), 'isActive must not treat every route as matching Home')
})

console.log(`\n${passed} Phase 44 checks passed`)
