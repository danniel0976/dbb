// phase30-test-add-card-overhaul.mjs
// Mechanical tests for Phase 30 add-card catalog search overhaul.
// Tests source code statically (no running server required).
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '../..')

const PASS = '\x1b[32mPASS\x1b[0m'
const FAIL = '\x1b[31mFAIL\x1b[0m'
const tests = []
let passed = 0, failed = 0

function test(name, fn) {
  tests.push({ name, fn })
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed')
}

function readSrc(rel) {
  return readFileSync(resolve(ROOT, rel), 'utf8')
}

// ===========================================================================
// CRITICAL FIX: p_rows scalar bug in /api/library/add
// ===========================================================================

test('FIX-1: /api/library/add passes p_rows as an array, NOT JSON.stringify()', () => {
  const src = readSrc('nextjs/src/app/api/library/add/route.js')
  // Must NOT contain JSON.stringify wrapping the array passed to p_rows
  const rpcIdx = src.indexOf("db.rpc('import_library_cards'")
  assert(rpcIdx !== -1, 'Must find import_library_cards RPC call')
  // Extract 400 chars after the rpc call start to see the full block
  const rpcBlock = src.substring(rpcIdx, rpcIdx + 400)
  assert(!rpcBlock.includes('JSON.stringify'), 'p_rows must NOT be wrapped in JSON.stringify()')
  assert(rpcBlock.includes('p_rows: [{'), 'p_rows must be a literal array [{...}]')
})

test('FIX-2: /api/library/add passes all required fields in the row object', () => {
  const src = readSrc('nextjs/src/app/api/library/add/route.js')
  const rpcIdx = src.indexOf("db.rpc('import_library_cards'")
  assert(rpcIdx !== -1, 'Must find import_library_cards RPC call')
  const rpcBlock = src.substring(rpcIdx, rpcIdx + 500)
  assert(rpcBlock.includes('scryfall_id'), 'Row must have scryfall_id')
  assert(rpcBlock.includes('quantity'), 'Row must have quantity')
  assert(rpcBlock.includes('foil'), 'Row must have foil')
  assert(rpcBlock.includes('condition'), 'Row must have condition')
  assert(rpcBlock.includes('language'), 'Row must have language')
  assert(rpcBlock.includes('date_added'), 'Row must have date_added')
})

test('FIX-3: /api/library/add preserves auth, binder ownership, and card validation', () => {
  const src = readSrc('nextjs/src/app/api/library/add/route.js')
  assert(src.includes('auth.getUser'), 'Must authenticate user')
  assert(src.includes('Unauthorized'), 'Must return 401 for unauthenticated')
  assert(src.includes('binders'), 'Must verify binder ownership')
  assert(src.includes('Binder not found'), 'Must return 404 for invalid binder')
  assert(src.includes('card_index'), 'Must verify card exists in catalog')
  assert(src.includes('Card not found in catalog'), 'Must return 404 for invalid card')
  assert(src.includes('VALID_FOIL'), 'Must validate foil values')
  assert(src.includes('VALID_CONDITION'), 'Must validate condition values')
})

// ===========================================================================
// CATALOG SEARCH: filters, sorts, pagination, grouping
// ===========================================================================

test('SEARCH-1: catalog/search supports name search with q parameter', () => {
  const src = readSrc('nextjs/src/app/api/catalog/search/route.js')
  assert(src.includes("searchParams.get('q')"), 'Must read q parameter')
  assert(src.includes("ilike('name'"), 'Must use ILIKE on name')
})

test('SEARCH-2: catalog/search supports set filter', () => {
  const src = readSrc('nextjs/src/app/api/catalog/search/route.js')
  assert(src.includes("searchParams.get('set')"), 'Must read set parameter')
  assert(src.includes("eq('set_code'"), 'Must filter by set_code')
})

test('SEARCH-3: catalog/search supports rarity filter', () => {
  const src = readSrc('nextjs/src/app/api/catalog/search/route.js')
  assert(src.includes("searchParams.get('rarity')"), 'Must read rarity parameter')
  assert(src.includes("eq('rarity'"), 'Must filter by rarity')
})

test('SEARCH-4: catalog/search supports type filter', () => {
  const src = readSrc('nextjs/src/app/api/catalog/search/route.js')
  assert(src.includes("searchParams.get('type')"), 'Must read type parameter')
  assert(src.includes("ilike('type_line'"), 'Must filter by type_line')
})

test('SEARCH-5: catalog/search supports color filter (WUBRGC)', () => {
  const src = readSrc('nextjs/src/app/api/catalog/search/route.js')
  assert(src.includes("searchParams.get('color')"), 'Must read color parameter')
  assert(src.includes('WUBRGC'), 'Must support W U B R G C colors')
  assert(src.includes("overlaps('colors'"), 'Must use array overlaps for colors')
})

test('SEARCH-6: catalog/search supports mana value (cmc) range filter', () => {
  const src = readSrc('nextjs/src/app/api/catalog/search/route.js')
  assert(src.includes('cmc_min'), 'Must support cmc_min')
  assert(src.includes('cmc_max'), 'Must support cmc_max')
  assert(src.includes("gte('cmc'"), 'Must use gte for cmc_min')
  assert(src.includes("lte('cmc'"), 'Must use lte for cmc_max')
})

test('SEARCH-7: catalog/search supports foil availability filter', () => {
  const src = readSrc('nextjs/src/app/api/catalog/search/route.js')
  assert(src.includes('foil_only'), 'Must support foil_only parameter')
  assert(src.includes("contains('finishes'"), 'Must use array contains for finishes')
})

test('SEARCH-8: catalog/search supports sort options (name, set, cmc, rarity)', () => {
  const src = readSrc('nextjs/src/app/api/catalog/search/route.js')
  assert(src.includes('SORT_OPTIONS'), 'Must have sort options')
  assert(src.includes("'name'"), 'Must support sort by name')
  assert(src.includes("'set'"), 'Must support sort by set')
  assert(src.includes("'cmc'"), 'Must support sort by cmc')
  assert(src.includes("'rarity'"), 'Must support sort by rarity')
})

test('SEARCH-9: catalog/search has deterministic sort with tiebreakers', () => {
  const src = readSrc('nextjs/src/app/api/catalog/search/route.js')
  // Every sort option must include name, set_code, and collector_number as tiebreakers
  // so pagination is deterministic
  const sortMatch = src.match(/SORT_OPTIONS\s*=\s*\{([\s\S]*?)\}/)
  assert(sortMatch, 'Must find SORT_OPTIONS definition')
  const sortDef = sortMatch[1]
  // Each sort option should end with the full tiebreaker set
  assert(sortDef.includes("'name', 'set_code', 'collector_number'"),
    'Sort options must include name + set_code + collector_number tiebreakers')
})

test('SEARCH-10: catalog/search uses deterministic pagination (page + limit + range)', () => {
  const src = readSrc('nextjs/src/app/api/catalog/search/route.js')
  assert(src.includes('page'), 'Must have page parameter')
  assert(src.includes('limit'), 'Must have limit parameter')
  assert(src.includes('.range('), 'Must use Supabase range() for pagination')
  assert(src.includes('count: \'exact\''), 'Must use exact count for pagination metadata')
})

test('SEARCH-11: catalog/search does not silently cap at 20 results', () => {
  const src = readSrc('nextjs/src/app/api/catalog/search/route.js')
  assert(src.includes('MAX_LIMIT'), 'Must have a MAX_LIMIT')
  // MAX_LIMIT must be > 20 so relevant results are not silently truncated
  const maxLimitMatch = src.match(/MAX_LIMIT\s*=\s*(\d+)/)
  assert(maxLimitMatch, 'Must define MAX_LIMIT as a number')
  assert(parseInt(maxLimitMatch[1]) >= 40, 'MAX_LIMIT must be at least 40 (not silently capping at 20)')
})

test('SEARCH-12: catalog/search groups results by card name when group=1', () => {
  const src = readSrc('nextjs/src/app/api/catalog/search/route.js')
  assert(src.includes('group'), 'Must support group parameter')
  assert(src.includes('groupMap'), 'Must use a group map for grouping')
  assert(src.includes('editions'), 'Must produce editions array per group')
  assert(src.includes('has_more'), 'Must include has_more flag for pagination')
})

test('SEARCH-13: catalog/search group editions include thumbnail, set, collector, rarity, finishes', () => {
  const src = readSrc('nextjs/src/app/api/catalog/search/route.js')
  const groupFields = ['scryfall_id', 'set_code', 'set_name', 'collector_number', 'rarity', 'image_uris', 'finishes']
  for (const field of groupFields) {
    assert(src.includes(field), `Group edition must include ${field}`)
  }
})

test('SEARCH-14: catalog/search preserves authentication', () => {
  const src = readSrc('nextjs/src/app/api/catalog/search/route.js')
  assert(src.includes('auth.getUser'), 'Must authenticate user')
  assert(src.includes('Unauthorized'), 'Must return 401 for unauthenticated')
})

test('SEARCH-15: catalog/search has defensive fallback for missing migration-007 columns', () => {
  const src = readSrc('nextjs/src/app/api/catalog/search/route.js')
  assert(src.includes('basicSelect'), 'Must have a basic select fallback')
  assert(src.includes('fallbackFilters'), 'Must have fallback filter handling')
  // Fallback must disable foilOnly when finishes column is missing
  assert(src.includes('foilOnly: false'), 'Fallback must disable foilOnly filter')
})

test('SEARCH-16: catalog/search returns empty results when no query or filters provided', () => {
  const src = readSrc('nextjs/src/app/api/catalog/search/route.js')
  // Guard condition: if no q and no filters, return empty without hitting the DB
  assert(src.includes('return NextResponse.json({ results: [], groups: [], total: 0'),
    'Must return empty result when no query/filters provided')
})

// ===========================================================================
// ADD CARD MODAL: explicit submit, abort, clear, grouping UI
// ===========================================================================

test('MODAL-1: AddCardModal does NOT search while typing (no debounce/onChange search)', () => {
  const src = readSrc('nextjs/src/components/AddCardModal.js')
  // handleInput must NOT call doSearch or any fetch
  const handleInputMatch = src.match(/handleInput\s*=[\s\S]*?\n\s*\}/)
  assert(handleInputMatch, 'Must find handleInput function')
  const handleInput = handleInputMatch[0]
  assert(!handleInputMatch[0].includes('doSearch'), 'handleInput must NOT call doSearch')
  assert(!handleInputMatch[0].includes('fetch('), 'handleInput must NOT call fetch')
  assert(!handleInputMatch[0].includes('setTimeout'), 'handleInput must NOT use setTimeout (no debounce)')
  assert(handleInput.includes('setQ('), 'handleInput should only setQ')
  assert(handleInput.includes('zero requests') || handleInput.includes('Do NOT'),
    'Must have comment about zero requests while typing')
})

test('MODAL-2: AddCardModal uses a form with onSubmit for explicit search submission', () => {
  const src = readSrc('nextjs/src/components/AddCardModal.js')
  assert(src.includes('<form'), 'Must have a form element')
  assert(src.includes('onSubmit={handleSubmit}'), 'Form must call handleSubmit on submit')
  assert(src.includes('type="submit"'), 'Must have a submit button')
})

test('MODAL-3: AddCardModal uses AbortController for in-flight request cancellation', () => {
  const src = readSrc('nextjs/src/components/AddCardModal.js')
  assert(src.includes('AbortController'), 'Must use AbortController')
  assert(src.includes('abortRef'), 'Must have abortRef')
  assert(src.includes('.abort()'), 'Must call abort()')
  assert(src.includes('signal: controller.signal'), 'Must pass signal to fetch')
  assert(src.includes('AbortError'), 'Must handle AbortError gracefully')
})

test('MODAL-4: AddCardModal uses generation counter for stale response protection', () => {
  const src = readSrc('nextjs/src/components/AddCardModal.js')
  assert(src.includes('searchGenRef'), 'Must have search generation ref')
  assert(src.includes('searchGenRef.current'), 'Must reference generation counter')
  assert(src.includes('gen !== searchGenRef.current'), 'Must check generation for staleness')
  assert(src.includes('searchGenRef.current++'), 'Must increment generation on clear')
})

test('MODAL-5: Clear button resets all search state', () => {
  const src = readSrc('nextjs/src/components/AddCardModal.js')
  const clearMatch = src.match(/handleClear\s*=[\s\S]*?\n  \}/)
  assert(clearMatch, 'Must find handleClear function')
  const clear = clearMatch[0]
  // Must cancel in-flight
  assert(clear.includes('abort()'), 'Clear must abort in-flight request')
  // Must increment generation to invalidate stale responses
  assert(clear.includes('searchGenRef.current++'), 'Clear must increment generation counter')
  // Must reset all state
  assert(clear.includes('setQ'), 'Clear must reset q')
  assert(clear.includes('setCommittedQ'), 'Clear must reset committedQ')
  assert(clear.includes('setFilters'), 'Clear must reset filters')
  assert(clear.includes('setAppliedFilters'), 'Clear must reset appliedFilters')
  assert(clear.includes('setGroups'), 'Clear must reset groups')
  assert(clear.includes('setTotal'), 'Clear must reset total')
  assert(clear.includes('setPage'), 'Clear must reset page')
  assert(clear.includes('setHasMore'), 'Clear must reset hasMore')
  assert(clear.includes('setSelectedEdition'), 'Clear must reset selectedEdition')
  assert(clear.includes('setError'), 'Clear must reset error')
  assert(clear.includes('setLoading'), 'Clear must reset loading')
  assert(clear.includes('setLoadingMore'), 'Clear must reset loadingMore')
})

test('MODAL-6: AddCardModal results are grouped by card name with expandable editions', () => {
  const src = readSrc('nextjs/src/components/AddCardModal.js')
  assert(src.includes('CardGroup'), 'Must have CardGroup component')
  assert(src.includes('EditionRow'), 'Must have EditionRow component')
  assert(src.includes('editions'), 'Groups must have editions')
  assert(src.includes('expanded'), 'Groups must be expandable')
  assert(src.includes('setExpanded'), 'Must toggle expansion')
})

test('MODAL-7: EditionRow shows thumbnail, set name/code, collector number, rarity, finishes', () => {
  const src = readSrc('nextjs/src/components/AddCardModal.js')
  const editionMatch = src.match(/function EditionRow[\s\S]*?\n}/)
  assert(editionMatch, 'Must find EditionRow component')
  const edition = editionMatch[0]
  assert(edition.includes('CardImage'), 'EditionRow must show card image (thumbnail)')
  assert(edition.includes('set_name'), 'EditionRow must show set name')
  assert(edition.includes('set_code'), 'EditionRow must show set code')
  assert(edition.includes('collector_number'), 'EditionRow must show collector number')
  assert(edition.includes('rarity'), 'EditionRow must show rarity')
  assert(edition.includes('finishes'), 'EditionRow must show finishes')
})

test('MODAL-8: AddCardModal has load-more pagination (no silent truncation)', () => {
  const src = readSrc('nextjs/src/components/AddCardModal.js')
  assert(src.includes('handleLoadMore'), 'Must have handleLoadMore function')
  assert(src.includes('Load more'), 'Must have Load more button')
  assert(src.includes('hasMore'), 'Must track hasMore state')
  assert(src.includes('loadingMore'), 'Must track loadingMore state')
  assert(src.includes('append'), 'doSearch must support append mode for pagination')
})

test('MODAL-9: AddCardModal filter bar has sort, set, rarity, colors, cmc range, foil', () => {
  const src = readSrc('nextjs/src/components/AddCardModal.js')
  assert(src.includes('SORT_OPTIONS'), 'Must have sort options')
  assert(src.includes('RARITY_OPTIONS'), 'Must have rarity options')
  assert(src.includes('COLOR_OPTIONS'), 'Must have color options')
  assert(src.includes('cmcMin'), 'Must have cmc min input')
  assert(src.includes('cmcMax'), 'Must have cmc max input')
  assert(src.includes('foilOnly'), 'Must have foil-only checkbox')
  assert(src.includes('FilterBar'), 'Must have FilterBar component')
})

test('MODAL-10: AddCardModal cleanup aborts in-flight on unmount', () => {
  const src = readSrc('nextjs/src/components/AddCardModal.js')
  // Must have cleanup in useEffect that aborts on unmount
  assert(src.includes('Cleanup on unmount') || src.includes('cleanup'), 'Must have cleanup comment')
  const cleanupMatch = src.match(/return\s*\(\s*\)\s*=>\s*\{[\s\S]*?abortRef[\s\S]*?\}/)
  assert(cleanupMatch, 'Must abort in-flight request on unmount cleanup')
})

test('MODAL-11: AddCardModal separates committed query from input value', () => {
  const src = readSrc('nextjs/src/components/AddCardModal.js')
  assert(src.includes('committedQ'), 'Must have committedQ state')
  assert(src.includes('setCommittedQ'), 'Must set committedQ on submit')
  // The "no results" message should use committedQ, not q
  assert(src.includes('committedQ') && src.includes('No cards found'), 'No-results message should reference committed query')
})

test('MODAL-12: AddCardModal Escape key closes modal or goes back from edition selection', () => {
  const src = readSrc('nextjs/src/components/AddCardModal.js')
  const escMatch = src.match(/Escape[\s\S]*?\n\s*\}/)
  assert(escMatch, 'Must handle Escape key')
  assert(src.includes('selectedEdition'), 'Escape must check selectedEdition state')
  assert(src.includes('setSelectedEdition(null)'), 'Escape from edition goes back')
  assert(src.includes('onClose'), 'Escape from search closes modal')
})

test('MODAL-13: AddCardModal preserves auth/binder/card validation in AddForm', () => {
  const src = readSrc('nextjs/src/app/api/library/add/route.js')
  // The add route still validates everything
  assert(src.includes('auth.getUser'), 'Add route must authenticate')
  assert(src.includes('Binder not found'), 'Add route must validate binder')
  assert(src.includes('Card not found in catalog'), 'Add route must validate card')
})

// ===========================================================================
// CONCURRENCY: stale response protection
// ===========================================================================

test('CONCURRENCY-1: doSearch increments generation before each search', () => {
  const src = readSrc('nextjs/src/components/AddCardModal.js')
  const doSearchMatch = src.match(/doSearch\s*=[\s\S]*?\n  }, \[buildSearchUrl\]\)/)
  assert(doSearchMatch, 'Must find doSearch function')
  const doSearch = doSearchMatch[0]
  assert(doSearch.includes('searchGenRef.current'), 'doSearch must use generation counter')
  assert(doSearch.includes('gen !== searchGenRef.current'), 'doSearch must check for stale responses')
  assert(doSearch.includes('gen = ++searchGenRef.current'), 'doSearch must increment generation at start')
})

test('CONCURRENCY-2: doSearch aborts previous in-flight request before starting new one', () => {
  const src = readSrc('nextjs/src/components/AddCardModal.js')
  const doSearchMatch = src.match(/doSearch\s*=[\s\S]*?\n  }, \[buildSearchUrl\]\)/)
  assert(doSearchMatch, 'Must find doSearch function')
  const doSearch = doSearchMatch[0]
  assert(doSearch.includes('abortRef.current'), 'doSearch must reference abortRef')
  assert(doSearch.includes('abortRef.current.abort()'), 'doSearch must abort previous request')
  assert(doSearch.includes('new AbortController()'), 'doSearch must create new AbortController')
})

test('CONCURRENCY-3: stale fetch response is silently ignored (not set to state)', () => {
  const src = readSrc('nextjs/src/components/AddCardModal.js')
  // After fetch, before setting state, must check generation
  assert(src.includes('if (gen !== searchGenRef.current) return'), 'Must return early if generation is stale')
})

// ===========================================================================
// BUILD: no syntax/import errors
// ===========================================================================

test('BUILD-1: AddCardModal exports default function', () => {
  const src = readSrc('nextjs/src/components/AddCardModal.js')
  assert(src.includes('export default function AddCardModal'), 'Must export default AddCardModal')
})

test('BUILD-2: catalog/search route exports GET function', () => {
  const src = readSrc('nextjs/src/app/api/catalog/search/route.js')
  assert(src.includes('export async function GET'), 'Must export GET function')
})

test('BUILD-3: library/add route exports POST function', () => {
  const src = readSrc('nextjs/src/app/api/library/add/route.js')
  assert(src.includes('export async function POST'), 'Must export POST function')
})

// Run all tests
console.log('\n=== Phase 30 Mechanical Tests ===\n')
for (const { name, fn } of tests) {
  try {
    fn()
    console.log(`  ${PASS} ${name}`)
    passed++
  } catch (err) {
    console.log(`  ${FAIL} ${name}`)
    console.log(`       ${err.message}`)
    failed++
  }
}
console.log(`\n  ${passed} passed, ${failed} failed, ${tests.length} total\n`)
process.exit(failed > 0 ? 1 : 0)