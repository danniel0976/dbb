// Run from nextjs/ dir: node scripts/test-manabox-parse.js
const path = require('path')
const fs = require('fs')
const { parse } = require('csv-parse/sync')
const { parseRow, aggregateRows } = require('../src/lib/manabox')

const CSV_PATH = path.resolve(__dirname, '../../scripts/data/ManaBox_Collection.csv')

if (!fs.existsSync(CSV_PATH)) {
  console.error('CSV not found at:', CSV_PATH)
  process.exit(1)
}

const text = fs.readFileSync(CSV_PATH, 'utf8')
const rawRows = parse(text, { columns: true, bom: true, trim: true, skip_empty_lines: true })

const mapped = rawRows.map(parseRow)
const valid = mapped.filter(r => !r._skip)
const skipped = mapped.filter(r => r._skip)

console.log('=== ManaBox Parse Smoke Test ===')
console.log(`Total rows:   ${rawRows.length}`)
console.log(`Valid rows:   ${valid.length}`)
console.log(`Skipped rows: ${skipped.length}`)

if (skipped.length > 0) {
  console.log('\nSkipped row reasons:')
  const reasons = {}
  skipped.forEach(r => { reasons[r._reason] = (reasons[r._reason] || 0) + 1 })
  Object.entries(reasons).forEach(([reason, count]) => console.log(`  ${count}x ${reason}`))
  console.log('\nFirst 5 skipped:')
  skipped.slice(0, 5).forEach(r => console.log(`  [${r._set_code}] ${r._name} — ${r._reason}`))
}

const aggregated = aggregateRows(mapped)
console.log(`\nAggregated unique keys: ${aggregated.length}`)
console.log('\nFirst 5 aggregated rows:')
aggregated.slice(0, 5).forEach(r => {
  console.log(`  ${r._name} (${r._set_code}) — ${r.foil}/${r.condition}/${r.language} qty:${r.quantity} id:${r.scryfall_id}`)
})
