// Unit tests for OCR-tolerant catalog name retrieval.
//
// The catalog API filters names with a substring ILIKE, which is exact about the
// characters it is handed: one OCR substitution ("lightnmg bolt") matches zero
// rows, so the scanner's client-side fuzzy ranking never gets a candidate to
// rank. These tests pin the bounded, extension-free escalation that fixes that
// without changing ordinary manual search.
//
// Run: node scripts/test-catalog-name-search.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  NAME_MATCH_SUBSTRING,
  NAME_MATCH_TOKENS,
  NAME_MATCH_SPLIT,
  NAME_MATCH_WILDCARD,
  SCAN_MAX_NAME_PATTERNS,
  buildNameMatchPlans,
  buildNameOrFilter,
  runNameMatchPlans,
} from '../src/lib/catalogNameSearch.mjs'

const tierNames = plans => plans.map(plan => plan.tier)
const patternsFor = (plans, tier) => plans.find(plan => plan.tier === tier)?.patterns ?? []

// ─── Manual search semantics are untouched ────────────────────────────────

// Without the scanner flag there is exactly one plan, and it is the substring
// ILIKE the route already issues today.
{
  const plans = buildNameMatchPlans('lightning bolt')
  assert.deepEqual(tierNames(plans), [NAME_MATCH_SUBSTRING])
  assert.deepEqual(plans[0].patterns, ['%lightning bolt%'])
  assert.deepEqual(buildNameMatchPlans('lightnmg bolt', { scan: false }).length, 1)
}

// An empty query produces no name plan at all, so filter-only searches keep
// working exactly as before.
assert.deepEqual(buildNameMatchPlans('', { scan: true }), [])
assert.deepEqual(buildNameMatchPlans('   ', { scan: true }), [])
assert.deepEqual(buildNameMatchPlans(null, { scan: true }), [])

// ─── Scan retrieval: a typo in one word must not hide the card ────────────

// "lightnmg bolt": the substring plan matches nothing, so a token plan follows
// that can still reach Lightning Bolt through its clean word.
{
  const plans = buildNameMatchPlans('lightnmg bolt', { scan: true })
  assert.deepEqual(tierNames(plans), [NAME_MATCH_SUBSTRING, NAME_MATCH_TOKENS, NAME_MATCH_SPLIT])
  assert.deepEqual(plans[0].patterns, ['%lightnmg bolt%'])
  const tokens = patternsFor(plans, NAME_MATCH_TOKENS)
  assert(tokens.includes('%bolt%'), 'clean OCR word must stay reachable')
  assert(tokens.includes('%lightnmg%'))
}

// Single-word reads have no clean sibling word, so the split plan carries the
// recovery: halves are non-overlapping, so one survives any single substitution.
{
  const plans = buildNameMatchPlans('lightnmg', { scan: true })
  // A lone token equals the substring plan, so no redundant token plan is issued.
  assert.deepEqual(tierNames(plans), [NAME_MATCH_SUBSTRING, NAME_MATCH_SPLIT])
  assert.deepEqual(patternsFor(plans, NAME_MATCH_SPLIT), ['%ligh%', '%tnmg%'])
}
{
  // Typo in the head: the tail half is clean and still finds "Lightning".
  const split = patternsFor(buildNameMatchPlans('llghtning', { scan: true }), NAME_MATCH_SPLIT)
  assert.deepEqual(split, ['%llgh%', '%tning%'])
}

// A short single-token OCR substitution cannot use meaningful halves. A
// bounded one-character wildcard plan recovers "sh0ck" → "Shock" without an
// extension or migration.
{
  const plans = buildNameMatchPlans('sh0ck', { scan: true })
  assert.deepEqual(tierNames(plans), [NAME_MATCH_SUBSTRING, NAME_MATCH_WILDCARD])
  assert(patternsFor(plans, NAME_MATCH_WILDCARD).includes('%sh_ck%'))
  assert(patternsFor(plans, NAME_MATCH_WILDCARD).length <= SCAN_MAX_NAME_PATTERNS)
}

// ─── Bounded and injection-safe ───────────────────────────────────────────

// Connective words are dropped when real words remain, so the token plan does
// not degenerate into "%the%" over the whole catalog.
{
  const tokens = patternsFor(buildNameMatchPlans('jace, the mmd sculptor', { scan: true }), NAME_MATCH_TOKENS)
  assert(!tokens.includes('%the%'), 'stopwords must not widen the token plan')
  assert(tokens.includes('%sculptor%'))
  assert(tokens.includes('%jace%'))
}

// Pathological OCR cannot fan the OR filter out without bound.
{
  const noisy = 'aaaaaaaa bbbbbbbb cccccccc dddddddd eeeeeeee ffffffff gggggggg'
  for (const plan of buildNameMatchPlans(noisy, { scan: true })) {
    assert(plan.patterns.length <= SCAN_MAX_NAME_PATTERNS, `${plan.tier} plan must stay bounded`)
  }
}

// Every pattern that can reach an `or=` filter is plain alphanumerics between
// wildcards: PostgREST treats commas, parentheses and quotes as syntax.
{
  const plans = buildNameMatchPlans("jace, the mind sculptor (foil) 1/2", { scan: true })
  for (const plan of plans) {
    if (plan.tier === NAME_MATCH_SUBSTRING) continue
    for (const pattern of plan.patterns) {
      assert.match(pattern, /^%[a-z0-9]+%$/, `unsafe or-filter pattern: ${pattern}`)
    }
  }
}

// The or-filter is PostgREST's name.ilike list, and it refuses unsafe patterns
// rather than emitting a filter that could be reinterpreted as syntax.
assert.equal(buildNameOrFilter(['%bolt%', '%light%']), 'name.ilike.%bolt%,name.ilike.%light%')
assert.equal(buildNameOrFilter(['%jace, the%']), null)
assert.equal(buildNameOrFilter([]), null)
assert.equal(buildNameOrFilter(null), null)

// ─── Escalation runs only when a cheaper plan matched nothing ─────────────

const plan = tier => ({ tier, patterns: [`%${tier}%`] })

// Manual search keeps the existing first-match behavior.
{
  const seen = []
  const result = await runNameMatchPlans(
    [plan('a'), plan('b')],
    async p => { seen.push(p.tier); return { data: [{ id: 1 }], count: 3, error: null } }
  )
  assert.deepEqual(seen, ['a'])
  assert.equal(result.tier, 'a')
  assert.equal(result.count, 3)
}

// Scanner retrieval must not let an incidental substring hit suppress a later
// tolerant plan that carries the intended card. Pool mode executes both plans
// and deduplicates their rows by Scryfall id.
{
  const seen = []
  const result = await runNameMatchPlans(
    [plan('substring'), plan('tolerant')],
    async p => {
      seen.push(p.tier)
      return p.tier === 'substring'
        ? { data: [{ scryfall_id: 'incidental', name: 'Sh0ck Trooper' }], count: 1, error: null }
        : { data: [{ scryfall_id: 'intended', name: 'Shock' }], count: 1, error: null }
    },
    { pool: true, page: 1, limit: 20 }
  )
  assert.deepEqual(seen, ['substring', 'tolerant'])
  assert.deepEqual(result.data.map(row => row.scryfall_id), ['incidental', 'intended'])
  assert.equal(result.count, 2)
}

// Pool mode pages each plan through a bounded source window instead of trusting
// the first alphabetic printing page to contain every relevant name.
{
  const pages = []
  const result = await runNameMatchPlans(
    [plan('substring')],
    async (_plan, sourcePage) => {
      pages.push(sourcePage.page)
      return sourcePage.page === 1
        ? {
            data: [
              { scryfall_id: 'heavy-1', name: 'Alpha Bolt' },
              { scryfall_id: 'heavy-2', name: 'Alpha Bolt' },
            ],
            count: 3,
            error: null,
          }
        : { data: [{ scryfall_id: 'target', name: 'Lightning Bolt' }], count: 3, error: null }
    },
    { pool: true, page: 1, limit: 20, sourcePageSize: 2, maxSourcePages: 2 }
  )
  assert.deepEqual(pages, [1, 2])
  assert(result.data.some(row => row.scryfall_id === 'target'))
}

// Candidate pages are name-fair: a print-heavy alphabetically earlier card may
// contribute one row before the next name, but cannot consume the whole page.
{
  const result = await runNameMatchPlans(
    [plan('substring')],
    async () => ({
      data: [
        ...Array.from({ length: 5 }, (_, index) => ({
          scryfall_id: `heavy-${index + 1}`,
          name: 'Alpha Bolt',
        })),
        { scryfall_id: 'target', name: 'Lightning Bolt' },
      ],
      count: 6,
      error: null,
    }),
    { pool: true, page: 1, limit: 2 }
  )
  assert.deepEqual(result.data.map(row => row.name), ['Alpha Bolt', 'Lightning Bolt'])
}

// Escalation is decided on the total count, not the page's row length, so a
// deep page of a matching plan never falls through to a broader one.
{
  const seen = []
  await runNameMatchPlans(
    [plan('a'), plan('b')],
    async p => { seen.push(p.tier); return { data: [], count: 12, error: null } }
  )
  assert.deepEqual(seen, ['a'])
}

// Only a genuinely empty result escalates, and the last plan's result is what
// the caller returns.
{
  const seen = []
  const result = await runNameMatchPlans(
    [plan('a'), plan('b'), plan('c')],
    async p => {
      seen.push(p.tier)
      return p.tier === 'c'
        ? { data: [{ id: 1 }], count: 1, error: null }
        : { data: [], count: 0, error: null }
    }
  )
  assert.deepEqual(seen, ['a', 'b', 'c'])
  assert.equal(result.tier, 'c')
}

// Every plan empty: the caller still gets a well-formed empty result.
{
  const result = await runNameMatchPlans(
    [plan('a'), plan('b')],
    async () => ({ data: [], count: 0, error: null })
  )
  assert.equal(result.tier, 'b')
  assert.equal(result.count, 0)
  assert.deepEqual(result.data, [])
}

// A query error is surfaced immediately — broadening the name filter must never
// be used to paper over a failed query.
{
  const seen = []
  const result = await runNameMatchPlans(
    [plan('a'), plan('b')],
    async p => { seen.push(p.tier); return { data: null, count: null, error: { code: '42P01' } } }
  )
  assert.deepEqual(seen, ['a'])
  assert.equal(result.error.code, '42P01')
}

// A filter-only search still runs exactly one query, with no name plan.
{
  const seen = []
  const result = await runNameMatchPlans([], async p => { seen.push(p); return { data: [], count: 0, error: null } })
  assert.deepEqual(seen, [null])
  assert.equal(result.tier, null)
}

// ─── Route wiring ─────────────────────────────────────────────────────────

const routeSource = readFileSync(new URL('../src/app/api/catalog/search/route.js', import.meta.url), 'utf8')

// The broadened retrieval is scanner-gated, so manual search keeps its exact
// substring semantics.
assert.match(routeSource, /searchParams\.get\('scan'\)/)
assert.match(routeSource, /buildNameMatchPlans\(q, \{ scan(: scan)? \}\)/)
assert.match(routeSource, /runNameMatchPlans/)
assert.match(routeSource, /const runPlan = async \(namePlan, queryPage/)
assert.match(routeSource, /\.range\(queryPage\.from, queryPage\.to\)/)
assert.match(routeSource, /runNameMatchPlans\([\s\S]*?\{ pool: scan, page, limit \}/)
// The plan's own patterns drive the name filter — no second hard-coded ILIKE.
assert.match(routeSource, /ilike\('name', plan\.patterns\[0\]\)/)
assert.match(routeSource, /\.or\(/)
// The tier actually used is reported, so UAT can tell recovered scans apart.
assert.match(routeSource, /name_match/)

const regressionSource = readFileSync(new URL('./regression-suite.mjs', import.meta.url), 'utf8')
assert.match(regressionSource, /node scripts\/test-catalog-name-search\.mjs/)
assert.match(regressionSource, /node scripts\/test-catalog-scan-retrieval-local\.mjs/)

console.log('CATALOG_NAME_SEARCH_PASS')
