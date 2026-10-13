import assert from 'node:assert/strict'
import {
  SCAN_SOURCE_MAX_PAGES,
  SCAN_SOURCE_PAGE_SIZE,
  buildNameMatchPlans,
  runNameMatchPlans,
} from '../src/lib/catalogNameSearch.mjs'

function likeRegex(pattern) {
  const body = [...pattern].map(char => {
    if (char === '%') return '.*'
    if (char === '_') return '.'
    return char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }).join('')
  return new RegExp(`^${body}$`, 'i')
}

function fixtureQuery(rows) {
  return async (plan, page = { from: 0, to: rows.length - 1 }) => {
    const patterns = plan?.patterns || []
    const matches = rows
      .filter(row => patterns.length === 0 || patterns.some(pattern => likeRegex(pattern).test(row.name)))
      .sort((a, b) => (
        a.name.localeCompare(b.name) ||
        a.set_code.localeCompare(b.set_code) ||
        a.collector_number.localeCompare(b.collector_number, undefined, { numeric: true }) ||
        a.scryfall_id.localeCompare(b.scryfall_id)
      ))
    return {
      data: matches.slice(page.from, page.to + 1),
      count: matches.length,
      error: null,
    }
  }
}

function row(scryfall_id, name, collector_number = '1') {
  return { scryfall_id, name, set_code: 'tst', collector_number }
}

const catalog = [
  row('incidental-lightnmg', 'Lightnmg Bolt Trap'),
  row('incidental-sh0ck', 'Sh0ck Trooper'),
  row('shock', 'Shock'),
  ...Array.from({ length: 500 }, (_, index) => (
    row(`alpha-bolt-${String(index + 1).padStart(3, '0')}`, 'Alpha Bolt', String(index + 1))
  )),
  row('lightning-bolt', 'Lightning Bolt'),
  row('lightning-strike', 'Lightning Strike'),
  row('bolt-bend', 'Bolt Bend'),
]

async function searchNames(query, limit = 5) {
  const result = await runNameMatchPlans(
    buildNameMatchPlans(query, { scan: true }),
    fixtureQuery(catalog),
    { pool: true, page: 1, limit }
  )
  assert.equal(result.error, null)
  return result.data.map(card => card.name)
}

// An exact incidental OCR-looking row must not suppress a tolerant plan that
// contains the intended name.
{
  const names = await searchNames('lightnmg bolt')
  assert(names.includes('Lightnmg Bolt Trap'))
  assert(names.includes('Lightning Bolt'), `expected Lightning Bolt in top five, got ${names.join(', ')}`)
  assert(names.indexOf('Lightning Bolt') < 5)
}

// A five-character single-token substitution uses the bounded wildcard tier.
{
  const names = await searchNames('sh0ck')
  assert(names.includes('Sh0ck Trooper'))
  assert(names.includes('Shock'), `expected Shock in top five, got ${names.join(', ')}`)
  assert(names.indexOf('Shock') < 5)
}

// More printings than the old 3×40 window may sort before the intended name.
// The bounded source pool still has to retrieve the intended name, and fair
// paging must give each name a slot before a print-heavy name receives another.
{
  assert(SCAN_SOURCE_PAGE_SIZE * SCAN_SOURCE_MAX_PAGES > 500)
  const names = await searchNames('lightnmg bolt')
  assert.equal(names.filter(name => name === 'Alpha Bolt').length, 1)
  assert(names.indexOf('Lightning Bolt') < 5)
}

// Repeated execution over the same local catalog fixture is deterministic.
assert.deepEqual(await searchNames('lightnmg bolt'), await searchNames('lightnmg bolt'))

console.log('CATALOG_SCAN_RETRIEVAL_LOCAL_PASS')
