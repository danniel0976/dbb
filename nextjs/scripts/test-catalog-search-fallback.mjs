import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isMissingColumnError } from '../src/lib/catalogSearchCompatibility.mjs'

assert.equal(
  isMissingColumnError(
    { code: '42703', message: 'column card_index.catalog_current does not exist' },
    'catalog_current'
  ),
  true
)
assert.equal(
  isMissingColumnError(
    { code: '42703', message: 'column card_index.rarity_rank does not exist' },
    'catalog_current'
  ),
  false
)
assert.equal(
  isMissingColumnError(
    { code: 'XX000', message: 'catalog_current failed for an unrelated reason' },
    'catalog_current'
  ),
  false
)
assert.equal(isMissingColumnError(null, 'catalog_current'), false)

const routeSource = readFileSync(new URL('../src/app/api/catalog/search/route.js', import.meta.url), 'utf8')
assert.match(routeSource, /isMissingColumnError/)
assert.match(routeSource, /searchParams\.get\('collector_number'\)/, 'scanner printing-only retrieval must accept an exact collector number')
assert.match(routeSource, /eq\('collector_number',\s*collector_number\)/, 'exact collector filtering must stay on catalog rows')
const confirmedMissingIndex = routeSource.indexOf("isMissingColumnError(error, 'catalog_current')")
const omitIndex = routeSource.indexOf('await runFallback(false)')
assert(confirmedMissingIndex >= 0, 'route must confirm catalog_current is the missing column')
assert(omitIndex > confirmedMissingIndex, 'route must omit catalog_current only after confirmation')

console.log('CATALOG_SEARCH_FALLBACK_PASS')
