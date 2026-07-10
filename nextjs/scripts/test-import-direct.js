// Direct integration test for import logic — run from nextjs/ dir
const path = require('path')
const fs = require('fs')
const { parse } = require('csv-parse/sync')
const { createClient } = require('@supabase/supabase-js')
const { parseRow, aggregateRows } = require('../src/lib/manabox')

const USER_ID = '93238ea1-8b81-4047-a73e-a1c28c8f4cfa'
const CSV_PATH = path.resolve(__dirname, '../../scripts/data/ManaBox_Collection.csv')

const SCRYFALL_BATCH = 75
const SCRYFALL_DELAY = 100
const RPC_CHUNK = 500

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

const db = createClient(
  'https://mnyhpwqskzadkplnhbrx.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1ueWhwd3Fza3phZGtwbG5oYnJ4Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MTI2MjU4MSwiZXhwIjoyMDk2ODM4NTgxfQ.0RKvfOwGAxytcE0DpwHHUqGxPTnW50MYknU9mxny1qY'
)

async function main() {
  console.log('=== DBB Import Integration Test ===\n')

  // Parse CSV
  const text = fs.readFileSync(CSV_PATH, 'utf8')
  const rawRows = parse(text, { columns: true, bom: true, trim: true, skip_empty_lines: true })
  console.log(`Parsed ${rawRows.length} CSV rows`)

  const mapped = rawRows.map((row, i) => ({ ...parseRow(row), _line: i + 2 }))
  const skipped = mapped.filter(r => r._skip)
  const aggregated = aggregateRows(mapped)
  console.log(`Valid: ${mapped.length - skipped.length}, Skipped: ${skipped.length}, Aggregated unique keys: ${aggregated.length}`)

  // Get default binder
  const { data: binder } = await db.from('binders').select('id,name').eq('user_id', USER_ID).eq('is_default', true).single()
  console.log(`\nTarget binder: ${binder.name} (${binder.id})`)

  // Collect IDs not in card_index
  const allIds = [...new Set(aggregated.map(r => r.scryfall_id))]
  const existingSet = new Set()
  for (let i = 0; i < allIds.length; i += 200) {
    const batch = allIds.slice(i, i + 200)
    const { data: batchExisting } = await db.from('card_index').select('scryfall_id').in('scryfall_id', batch)
    if (batchExisting) batchExisting.forEach(r => existingSet.add(r.scryfall_id))
  }
  const toHydrate = allIds.filter(id => !existingSet.has(id))
  console.log(`\ncard_index: ${existingSet.size} already cached, ${toHydrate.length} to hydrate from Scryfall`)

  // Hydrate via Scryfall (limit output for test)
  const notFoundIds = new Set()
  let hydrated = 0
  const batches = Math.ceil(toHydrate.length / SCRYFALL_BATCH)
  console.log(`Fetching ${batches} Scryfall batches (${SCRYFALL_DELAY}ms delay between)...`)

  for (let i = 0; i < toHydrate.length; i += SCRYFALL_BATCH) {
    if (i > 0) await sleep(SCRYFALL_DELAY)
    const batch = toHydrate.slice(i, i + SCRYFALL_BATCH)
    const batchNum = Math.floor(i / SCRYFALL_BATCH) + 1
    if (batchNum === 1 || batchNum % 5 === 0 || batchNum === batches) {
      process.stdout.write(`  batch ${batchNum}/${batches}...\r`)
    }

    let sfData
    try {
      const resp = await fetch('https://api.scryfall.com/cards/collection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'DansBizarreBazaar/1.0' },
        body: JSON.stringify({ identifiers: batch.map(id => ({ id })) }),
      })
      sfData = await resp.json()
    } catch (e) {
      console.error(`  batch ${batchNum} network error:`, e.message)
      batch.forEach(id => notFoundIds.add(id))
      continue
    }

    if (sfData.not_found) sfData.not_found.forEach(nf => { if (nf.id) notFoundIds.add(nf.id) })

    const cardRows = (sfData.data || []).map(card => {
      const face = card.card_faces?.[0]
      return {
        scryfall_id: card.id,
        name: card.name,
        set_code: card.set,
        set_name: card.set_name,
        collector_number: card.collector_number,
        rarity: card.rarity,
        colors: card.color_identity || [],
        type_line: card.type_line || face?.type_line || null,
        cmc: card.cmc ?? null,
        mana_cost: card.mana_cost || face?.mana_cost || null,
      }
    })

    if (cardRows.length > 0) {
      const { error } = await db.from('card_index').upsert(cardRows, { onConflict: 'scryfall_id' })
      if (error) console.error('  upsert error:', error.message)
      else hydrated += cardRows.length
    }
  }
  console.log(`\nHydrated ${hydrated} cards into card_index, ${notFoundIds.size} not found on Scryfall`)

  // Import rows
  const importRows = aggregated.filter(r => !notFoundIds.has(r.scryfall_id))
  console.log(`\nImporting ${importRows.length} rows via RPC...`)

  let totalInserted = 0, totalMerged = 0
  for (let i = 0; i < importRows.length; i += RPC_CHUNK) {
    const chunk = importRows.slice(i, i + RPC_CHUNK).map(r => ({
      scryfall_id: r.scryfall_id,
      quantity: r.quantity,
      foil: r.foil,
      condition: r.condition,
      language: r.language,
      purchase_price: r.purchase_price,
      purchase_currency: r.purchase_currency,
      date_added: r.date_added,
    }))

    const { data: rpcResult, error: rpcErr } = await db.rpc('import_library_cards', {
      p_user_id: USER_ID,
      p_binder_id: binder.id,
      p_rows: chunk,
    })

    if (rpcErr) { console.error('RPC error:', rpcErr.message); continue }
    if (rpcResult?.[0]) {
      totalInserted += rpcResult[0].inserted || 0
      totalMerged += rpcResult[0].merged || 0
    }
  }

  // Final counts
  const { count: libCount } = await db.from('library_cards').select('*', {count:'exact',head:true}).eq('user_id', USER_ID)
  const { count: ciCount } = await db.from('card_index').select('*', {count:'exact',head:true})

  console.log('\n=== Results ===')
  console.log(`Inserted: ${totalInserted}`)
  console.log(`Merged:   ${totalMerged}`)
  console.log(`Skipped:  ${skipped.length + notFoundIds.size}`)
  console.log(`\nlibrary_cards total for user: ${libCount}`)
  console.log(`card_index total:              ${ciCount}`)
}

main().catch(console.error)
