import assert from 'node:assert/strict'
import {
  SCAN_SOURCE_MAX_PAGES,
  SCAN_SOURCE_PAGE_SIZE,
  buildNameMatchPlans,
  runNameMatchPlans,
} from '../src/lib/catalogNameSearch.mjs'
import { readScannerFrame, SCANNER_OCR_REGIONS } from '../src/lib/cardScannerCapture.mjs'
import { rankScannerResults } from '../src/lib/cardScanner.mjs'
import { routeScannerMatch, scannerRetrievalSeed } from '../src/lib/cardScannerSession.mjs'

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

// Carry separate raw OCR regions through the real capture/evidence module,
// local name retrieval and ranker. The fake worker supplies text, not evidence.
async function rawEvidence(titleText, infoText) {
  const regions = []
  const evidence = await readScannerFrame({
    frame: {},
    prepare: (_frame, region) => { regions.push(region); return region.role },
    worker: {
      async reinitialize(language) { assert.equal(language, 'eng') },
      async setParameters() {},
      async recognize(role) {
        assert(['info', 'title'].includes(role))
        return { data: { text: role === 'info' ? infoText : titleText } }
      },
    },
  })
  assert.deepEqual(regions, [SCANNER_OCR_REGIONS.info, SCANNER_OCR_REGIONS.title])
  assert.equal(evidence.rawText, `${titleText}\n${infoText}`)
  return evidence
}

const ocrCatalog = [
  { ...row('correct', 'Lightning Bolt', '169'), set_code: 'mom', rarity: 'rare' },
  { ...row('other-printing', 'Lightning Bolt', '12'), set_code: 'tst', rarity: 'common' },
  row('other-name', 'Lightning Strike'),
]

function groupsFor(rows) {
  const groups = new Map()
  for (const card of rows) {
    if (!groups.has(card.name)) groups.set(card.name, { name: card.name, editions: [] })
    groups.get(card.name).editions.push(card)
  }
  return [...groups.values()]
}

async function retrieveAndRank(evidence) {
  const seed = scannerRetrievalSeed(evidence)
  assert(seed)
  // Mirror the printing-only set/collector filter locally; no server/DB claim.
  const rows = seed.query ? ocrCatalog : ocrCatalog.filter(card => (
    card.set_code === seed.set && card.collector_number === evidence.collectorNumber
  ))
  const result = await runNameMatchPlans(
    buildNameMatchPlans(seed.query, { scan: true }), fixtureQuery(rows),
    { pool: true, page: 1, limit: 40 }
  )
  assert.equal(result.error, null)
  return rankScannerResults(groupsFor(result.data), evidence)
}

for (const title of ['Lightning Bolt', 'Lightnmg Bolt']) {
  const evidence = await rawEvidence(title, '0169 R\nMOM • EN')
  assert.equal(evidence.nameQuery, title.toLowerCase())
  assert.equal(evidence.setCode, 'mom')
  assert.equal(evidence.collectorNumber, '169')
  assert.equal(evidence.rarity, 'rare')
  assert.deepEqual(scannerRetrievalSeed(evidence), { query: title.toLowerCase(), set: '' })
  const ranked = await retrieveAndRank(evidence)
  assert.equal(ranked[0].name, 'Lightning Bolt')
  assert.equal(ranked[0].editions[0].scryfall_id, 'correct')
  assert.deepEqual(ranked[0].editions[0].scanMatches, {
    name: title === 'Lightning Bolt' ? 'exact' : 'fuzzy', set: true, collector: true, rarity: true,
  })
  if (title === 'Lightnmg Bolt') assert.equal(routeScannerMatch(ranked, evidence).kind, 'uncertain')
}

// No metadata means no score delta or invented mismatches: each printing has
// the same exact-name-only score.
{
  const evidence = await rawEvidence('Lightning Bolt', '')
  assert.equal(evidence.setCode, null)
  assert.equal(evidence.collectorNumber, null)
  assert.equal(evidence.rarity, null)
  const ranked = await retrieveAndRank(evidence)
  for (const edition of ranked.find(group => group.name === 'Lightning Bolt').editions) {
    assert.deepEqual(edition.scanMatches, { name: 'exact', set: null, collector: null, rarity: null })
    assert.equal(edition.scanScore, 10000)
  }
}

// A metadata-only read must stay assisted even with an exact printing match.
{
  const evidence = await rawEvidence('', '0169 R\nMOM EN')
  assert.equal(evidence.nameQuery, '')
  const ranked = await retrieveAndRank(evidence)
  assert.equal(ranked[0].editions[0].scryfall_id, 'correct')
  assert.equal(ranked[0].scanMatches.name, 'none')
  const decision = routeScannerMatch(ranked, evidence)
  assert.equal(decision.kind, 'uncertain')
  assert.equal(decision.reason, 'printing-only')
}

// Known limitation, NOT catalog-wide recall: all plans can miss an intended
// row beyond the 600-row source window. Name fairness cannot rank unseen rows.
{
  const cap = SCAN_SOURCE_PAGE_SIZE * SCAN_SOURCE_MAX_PAGES
  assert.equal(cap, 600)
  const cappedCatalog = [
    ...Array.from({ length: cap }, (_, index) => row(`early-${index}`, 'Alpha Lightning Bolt', String(index + 1))),
    row('omitted-target', 'Lightning Bolt'),
  ]
  const pages = []
  const query = fixtureQuery(cappedCatalog)
  const result = await runNameMatchPlans(
    buildNameMatchPlans('lightnmg bolt', { scan: true }),
    async (plan, page) => {
      const response = await query(plan, page)
      pages.push({ tier: plan.tier, page: page.page, to: page.to, count: response.count })
      return response
    },
    { pool: true, page: 1, limit: 40 }
  )
  assert.equal(cappedCatalog.length, 601)
  assert(pages.some(page => page.count === 601))
  assert(pages.every(page => page.page <= 3 && page.to < cap))
  assert.equal(result.count, cap, 'reported count describes bounded deduplicated rows, not source matches')
  assert(!result.data.some(card => card.scryfall_id === 'omitted-target'))
  const ranked = rankScannerResults(groupsFor(result.data), { nameQuery: 'lightnmg bolt' })
  assert(!ranked.some(group => group.name === 'Lightning Bolt'))
  console.log('SOURCE_CAP_CHARACTERIZATION: 601 matching rows; target beyond 600 omitted; cap remains unresolved')
}

console.log('CATALOG_SCAN_RETRIEVAL_LOCAL_PASS')
