/**
 * DBB Collection Import Script
 * 
 * Imports MTG cards from ManaBox CSV format into Supabase DBB schema.
 * Fetches card data from Scryfall API and prices from MTGJSON (CardKingdom).
 * 
 * Usage:
 *   node scripts/import-collection.js <path-to-csv>
 *   node scripts/import-collection.js <path-to-csv> --dry-run
 *   node scripts/import-collection.js --refresh-prices
 * 
 * Options:
 *   --dry-run          Show what would be imported without writing to DB
 *   --refresh-prices   Re-fetch and update prices for all existing cards
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', 'nextjs', '.env.local') })
const { createClient } = require('@supabase/supabase-js')
const { parse } = require('csv-parse/sync')
const fs = require('fs')
const path = require('path')
const https = require('https')
const { createGunzip } = require('zlib')

// Configuration
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
// Exchange rate no longer needed — pricing is CKD × multiplier, no FX conversion
const MTGJSON_PRICES_URL = 'https://mtgjson.com/api/v5/AllPricesToday.json.gz'
const SCRYFALL_BASE = 'https://api.scryfall.com'
const BATCH_SIZE = 10
const DELAY_MS = 100 // ms between Scryfall requests

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ Missing Supabase credentials')
  console.error('Required: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY')
  console.error('Make sure nextjs/.env.local exists with these values')
  process.exit(1)
}

// Initialize Supabase client with service role key for writes
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

// Exchange rate removed — pricing is CKD × multiplier (2.5/2.8/3.0), no FX conversion needed

// ============================================================================
// MTGJSON Price Lookup
// ============================================================================

async function fetchMTGJSONPrices() {
  // AllPricesToday keys are MTGJSON UUIDs, NOT Scryfall IDs — never look up
  // prices in it directly. We read the pre-built cache instead (built daily by
  // scripts/build-price-cache.js, keyed by Scryfall ID with a name-fallback
  // index — see scripts/README-price-pipeline.md).
  console.log('💰 Loading CardKingdom price cache (Scryfall-ID keyed)...')

  const localPath = path.join(__dirname, 'data', 'ck-prices.json')
  let cache
  if (fs.existsSync(localPath)) {
    cache = JSON.parse(fs.readFileSync(localPath, 'utf8'))
  } else {
    const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/price-cache/ck-prices.json`
    console.log('   Local cache missing, fetching from Supabase Storage...')
    const res = await fetch(url, { headers: { 'User-Agent': 'DansBizarreBazaar/1.0' } })
    if (!res.ok) throw new Error(`Price cache fetch failed: HTTP ${res.status}`)
    cache = await res.json()
  }

  const toRecord = (rec) => ({
    ckd_usd_price: rec.n ?? null,
    ckd_foil_price: rec.f ?? null,
    ckd_etched_price: rec.e ?? null,
    ckd_buy_price: rec.b ?? null,
    source: 'cardkingdom_via_mtgjson',
  })

  const byId = new Map()
  const byName = new Map()
  for (const [id, rec] of Object.entries(cache.prices || {})) byId.set(id.toLowerCase(), toRecord(rec))
  for (const [name, rec] of Object.entries(cache.names || {})) byName.set(name.toLowerCase(), toRecord(rec))

  console.log(`   ✅ Loaded ${byId.size} CK prices by Scryfall ID, ${byName.size} by name`)
  if (cache._meta?.built) console.log(`   Cache built: ${cache._meta.built}`)

  return {
    size: byId.size,
    // Name fallback covers DB printings CK doesn't stock (cheapest printing)
    get(scryfallId, cardName) {
      let rec = scryfallId ? byId.get(String(scryfallId).toLowerCase()) : undefined
      if (!rec && cardName) rec = byName.get(String(cardName).toLowerCase())
      return rec
    },
  }
}

// ============================================================================
// Scryfall API
// ============================================================================

async function scryfallGet(setCode, collectorNumber) {
  const url = `${SCRYFALL_BASE}/cards/${encodeURIComponent(setCode)}/${encodeURIComponent(collectorNumber)}`
  
  const response = await fetch(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'DansBizarreBazaar/1.0' }
  })

  if (!response.ok) {
    if (response.status === 404) return null
    throw new Error(`Scryfall returned ${response.status}`)
  }

  return response.json()
}

async function scryfallSearchByName(name, setCode) {
  const url = `${SCRYFALL_BASE}/cards/search?q=${encodeURIComponent(`!"${name}" e:${setCode}`)}`
  
  const response = await fetch(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'DansBizarreBazaar/1.0' }
  })

  if (!response.ok) return null

  const data = await response.json()
  return data.data && data.data.length > 0 ? data.data[0] : null
}

// ============================================================================
// CSV Parsing
// ============================================================================

function mapCondition(condition) {
  if (!condition) return 'NM'
  const c = condition.toLowerCase()
  if (c === 'near_mint' || c === 'nm' || c === 'mint') return 'NM'
  if (c === 'light_play' || c === 'lp') return 'LP'
  if (c === 'moderately_played' || c === 'mp') return 'MP'
  if (c === 'heavily_played' || c === 'hp') return 'HP'
  if (c === 'damaged' || c === 'dmg') return 'DMG'
  return 'NM'
}

function parseManaboxCSV(csvPath) {
  const content = fs.readFileSync(csvPath, 'utf-8')
  
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  })

  console.log(`📊 Parsed ${records.length} cards from CSV`)

  return records.map((row, index) => ({
    card_name: row['Name'] || row['Card Name'] || row['name'] || row['Card'],
    set_code: row['Set code'] || row['Set'] || row['set_code'] || row['Set Code'],
    collector_number: row['Collector number'] || row['Collector No'] || row['collector_number'] || row['Number'] || row['#'],
    foil_type: (() => {
      const v = (row['Foil'] || 'normal').toLowerCase().replace(/[\s-]/g, '_')
      if (v === 'normal' || v === 'no' || v === 'false' || v === '') return 'nonfoil'
      return v // 'foil', 'etched', 'surge_foil', 'gilded_foil', etc.
    })(),
    is_foil: !['normal', 'no', 'false', ''].includes((row['Foil'] || 'normal').toLowerCase()),
    condition: mapCondition(row['Condition'] || row['condition'] || 'near_mint'),
    quantity: parseInt(row['Quantity'] || row['qty'] || '1', 10),
    scryfall_id: row['Scryfall ID'] || null,
    _original: row,
    _rowIndex: index + 1,
  })).filter(card => card.card_name && card.set_code)
}

// ============================================================================
// Process a single card (fetch from Scryfall + enrich with CK prices)
// ============================================================================

async function processCard(card, priceLookup) {
  // Fetch from Scryfall
  let scryfallData = null
  
  if (card.scryfall_id) {
    const url = `${SCRYFALL_BASE}/cards/${card.scryfall_id}`
    try {
      const response = await fetch(url, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'DansBizarreBazaar/1.0' }
      })
      if (response.ok) scryfallData = await response.json()
    } catch (e) {
      // Fall through to set/number lookup
    }
  }

  if (!scryfallData && card.set_code && card.collector_number) {
    try {
      scryfallData = await scryfallGet(card.set_code, card.collector_number)
    } catch (e) {
      // Fall through to name search
    }
  }

  if (!scryfallData && card.card_name) {
    try {
      scryfallData = await scryfallSearchByName(card.card_name, card.set_code)
    } catch (e) {
      // Nothing more we can do
    }
  }

  if (!scryfallData || scryfallData.object !== 'card') {
    throw new Error('Card not found in Scryfall')
  }

  // Build card data from Scryfall
  const processedCard = {
    scryfall_id: scryfallData.id,
    card_name: scryfallData.name,
    set_code: scryfallData.set,
    set_name: scryfallData.set_name,
    collector_number: scryfallData.collector_number,
    rarity: scryfallData.rarity || 'common',
    card_type: scryfallData.type_line,
    colors: scryfallData.colors || [],
    is_foil: card.is_foil,
    foil_type: card.foil_type,
    condition: card.condition || 'NM',
    image_png_url: scryfallData.image_uris?.png || scryfallData.card_faces?.[0]?.image_uris?.png,
    image_crop_url: scryfallData.image_uris?.normal || scryfallData.card_faces?.[0]?.image_uris?.normal,
  }

  // Get CardKingdom price from MTGJSON lookup
  const ckPrice = priceLookup.get(scryfallData.id, scryfallData.name)

  if (ckPrice) {
    // Pick the right base price based on finish type
    const isEtched = card.foil_type === 'etched'
    const isFoil = card.is_foil && !isEtched
    processedCard.ckd_usd_price =
      isEtched && ckPrice.ckd_etched_price ? ckPrice.ckd_etched_price :
      isFoil && ckPrice.ckd_foil_price ? ckPrice.ckd_foil_price :
      ckPrice.ckd_usd_price
    processedCard.ckd_foil_price = ckPrice.ckd_foil_price
    processedCard.ckd_etched_price = ckPrice.ckd_etched_price
    processedCard.pricing_source = 'cardkingdom_via_mtgjson'
  } else {
    // Fallback to Scryfall prices (market/TCGPlayer, NOT CardKingdom)
    const prices = scryfallData.prices || {}
    processedCard.ckd_usd_price =
      card.foil_type === 'etched' && prices.usd_etched ? parseFloat(prices.usd_etched) :
      card.is_foil && prices.usd_foil ? parseFloat(prices.usd_foil) :
      prices.usd ? parseFloat(prices.usd) : null
    processedCard.ckd_foil_price = prices.usd_foil ? parseFloat(prices.usd_foil) : null
    processedCard.ckd_etched_price = prices.usd_etched ? parseFloat(prices.usd_etched) : null
    processedCard.pricing_source = 'scryfall_market'
  }

  // Calculate selling prices: CKD × multiplier (no FX conversion)
  const basePrice = processedCard.ckd_usd_price
  processedCard.myr_price_2_5 = basePrice ? Math.round(basePrice * 2.5 * 2) / 2 : null
  processedCard.myr_price_2_8 = basePrice ? Math.round(basePrice * 2.8 * 2) / 2 : null
  processedCard.myr_price_3_0 = basePrice ? Math.round(basePrice * 3.0 * 2) / 2 : null
  processedCard.pricing_last_updated = new Date().toISOString()

  return processedCard
}

// ============================================================================
// Upsert card to Supabase
// ============================================================================

async function upsertCard(cardData) {
  const { _original, _rowIndex, quantity, ...cleanData } = cardData

  // Check if card exists by scryfall_id + is_foil
  const { data: existing } = await supabase
    .from('cards')
    .select('id')
    .eq('scryfall_id', cleanData.scryfall_id)
    .eq('is_foil', cleanData.is_foil)
    .single()

  if (existing) {
    const { data, error } = await supabase
      .from('cards')
      .update(cleanData)
      .eq('id', existing.id)
      .select()
      .single()

    if (error) throw error
    return { ...data, _action: 'updated' }
  } else {
    const { data, error } = await supabase
      .from('cards')
      .insert([cleanData])
      .select()
      .single()

    if (error) throw error
    return { ...data, _action: 'inserted' }
  }
}

// ============================================================================
// Refresh prices for all existing cards
// ============================================================================

async function refreshPrices(priceLookup, dryRun = false) {
  console.log('\n🔄 Refreshing prices for all existing cards...\n')

  // Fetch all cards (paginated — supabase caps responses at 1000 rows)
  const cards = []
  for (let from = 0; ; from += 1000) {
    const { data: page, error } = await supabase
      .from('cards')
      .select('id, scryfall_id, card_name, is_foil, foil_type, ckd_usd_price, ckd_etched_price, myr_price_2_5, myr_price_2_8, myr_price_3_0, pricing_source')
      .order('card_name')
      .range(from, from + 999)

    if (error) {
      console.error('❌ Failed to fetch cards:', error.message)
      process.exit(1)
    }
    if (!page || page.length === 0) break
    cards.push(...page)
    if (page.length < 1000) break
  }

  console.log(`   Found ${cards.length} cards in database\n`)

  let updated = 0
  let unchanged = 0
  let notFound = 0
  let failed = 0

  for (let i = 0; i < cards.length; i++) {
    const card = cards[i]
    const ckPrice = priceLookup.get(card.scryfall_id, card.card_name)

    if (!ckPrice) {
      notFound++
      if (i % 50 === 0) console.log(`   ⚠️  No CK price: ${card.card_name} (${card.scryfall_id})`)
      continue
    }

    const isEtched = card.foil_type === 'etched'
    const isFoil = card.is_foil && !isEtched
    const newPrice =
      isEtched && ckPrice.ckd_etched_price ? ckPrice.ckd_etched_price :
      isFoil && ckPrice.ckd_foil_price ? ckPrice.ckd_foil_price :
      ckPrice.ckd_usd_price

    // Always recalculate MYR selling prices even if USD price unchanged
    // (previous runs may have used wrong FX-based conversion)
    const needsMyrUpdate = card.ckd_usd_price !== null && (
      Math.abs(card.myr_price_2_5 - Math.round(card.ckd_usd_price * 2.5 * 2) / 2) > 0.01 ||
      Math.abs(card.myr_price_2_8 - Math.round(card.ckd_usd_price * 2.8 * 2) / 2) > 0.01 ||
      Math.abs(card.myr_price_3_0 - Math.round(card.ckd_usd_price * 3.0 * 2) / 2) > 0.01
    )

    // Also update if ckd_etched_price is newly available (was null, now has a value)
    const needsEtchedUpdate = ckPrice.ckd_etched_price != null && card.ckd_etched_price == null

    if (Math.abs((card.ckd_usd_price || 0) - (newPrice || 0)) < 0.01 && card.pricing_source === 'cardkingdom_via_mtgjson' && !needsMyrUpdate && !needsEtchedUpdate) {
      unchanged++
      continue
    }

    // Price changed or source needs update
    const updateData = {
      ckd_usd_price: newPrice,
      ckd_foil_price: ckPrice.ckd_foil_price,
      ckd_etched_price: ckPrice.ckd_etched_price,
      // Selling prices: CKD × multiplier (no FX conversion)
      myr_price_2_5: newPrice ? Math.round(newPrice * 2.5 * 2) / 2 : null,
      myr_price_2_8: newPrice ? Math.round(newPrice * 2.8 * 2) / 2 : null,
      myr_price_3_0: newPrice ? Math.round(newPrice * 3.0 * 2) / 2 : null,
      pricing_source: 'cardkingdom_via_mtgjson',
      pricing_last_updated: new Date().toISOString(),
    }

    if (dryRun) {
      console.log(`   📝 Would update: ${card.card_name} $${card.ckd_usd_price} → $${newPrice}`)
      updated++
    } else {
      const { error: updateError } = await supabase
        .from('cards')
        .update(updateData)
        .eq('id', card.id)

      if (updateError) {
        console.error(`   ❌ Failed to update ${card.card_name}: ${updateError.message}`)
        failed++
      } else {
        updated++
      }
    }
  }

  console.log('\n' + '='.repeat(50))
  console.log('📊 PRICE REFRESH SUMMARY')
  console.log('='.repeat(50))
  console.log(`✅ Updated: ${updated}`)
  console.log(`⚪ Unchanged: ${unchanged}`)
  console.log(`⚠️  Not found in MTGJSON: ${notFound}`)
  console.log(`❌ Failed: ${failed}`)
  console.log('='.repeat(50))

  if (dryRun) {
    console.log('\n⚠️  DRY RUN — no changes were written to database')
  }
}

// ============================================================================
// Main: Import CSV
// ============================================================================

async function importCollection(csvPath, priceLookup, dryRun = false) {
  console.log('🚀 Starting DBB Collection Import\n')
  console.log(`📁 CSV File: ${csvPath}`)
  console.log('💱 Pricing: CKD × multiplier (2.5/2.8/3.0), no FX conversion')
  if (dryRun) console.log('🔍 DRY RUN — no changes will be written\n')

  // Parse CSV
  let cards
  try {
    cards = parseManaboxCSV(csvPath)
  } catch (error) {
    console.error('❌ Failed to parse CSV:', error.message)
    process.exit(1)
  }

  if (cards.length === 0) {
    console.error('❌ No valid cards found in CSV')
    process.exit(1)
  }

  // Process cards in batches
  const results = { success: 0, updated: 0, inserted: 0, failed: [] }

  console.log(`⚙️  Processing ${cards.length} cards in batches of ${BATCH_SIZE}...\n`)

  for (let i = 0; i < cards.length; i += BATCH_SIZE) {
    const batch = cards.slice(i, i + BATCH_SIZE)
    const batchNum = Math.floor(i / BATCH_SIZE) + 1
    const totalBatches = Math.ceil(cards.length / BATCH_SIZE)
    console.log(`📦 Batch ${batchNum}/${totalBatches} (${batch.length} cards)`)

    for (const card of batch) {
      try {
        const processedCard = await processCard(card, priceLookup)

        if (!processedCard.scryfall_id) {
          throw new Error('No Scryfall ID resolved')
        }

        if (dryRun) {
          console.log(`   📝 Would import: ${processedCard.card_name} (${processedCard.set_code}) $${processedCard.ckd_usd_price}`)
          results.success++
        } else {
          const result = await upsertCard(processedCard)
          if (result._action === 'updated') {
            results.updated++
          } else {
            results.inserted++
          }
          results.success++
          console.log(`   ${result._action === 'updated' ? '✏️' : '✅'} ${processedCard.card_name}`)
        }

        // Rate limit Scryfall requests
        await new Promise(resolve => setTimeout(resolve, DELAY_MS))
      } catch (error) {
        results.failed.push({ ...card, error: error.message })
        console.error(`   ❌ ${card.card_name} (${card.set_code}): ${error.message}`)
      }
    }
  }

  // Summary
  console.log('\n' + '='.repeat(50))
  console.log('📊 IMPORT SUMMARY')
  console.log('='.repeat(50))
  console.log(`✅ Total Success: ${results.success}`)
  console.log(`   ├─ Inserted: ${results.inserted}`)
  console.log(`   └─ Updated: ${results.updated}`)
  console.log(`❌ Total Failed: ${results.failed.length}`)
  console.log('='.repeat(50))

  // Save failed imports
  if (results.failed.length > 0) {
    const failPath = path.join(path.dirname(csvPath), 'failed-imports.json')
    fs.writeFileSync(failPath, JSON.stringify(results.failed, null, 2))
    console.log(`\n⚠️  Failed imports saved to: ${failPath}`)
  }

  if (dryRun) {
    console.log('\n⚠️  DRY RUN — no changes were written to database')
  }

  console.log('\n✨ Import complete!\n')
}

// ============================================================================
// CLI Entry Point
// ============================================================================

const STAGE = 'import-collection'

async function main() {
  console.log(`=== STAGE START: ${STAGE} ===`)
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const doRefreshPrices = args.includes('--refresh-prices')
  // --rate flag removed (no FX conversion needed, pricing is CKD × multiplier only)

  // Fetch MTGJSON prices
  let priceLookup
  try {
    priceLookup = await fetchMTGJSONPrices()
  } catch (error) {
    console.warn('⚠️  Failed to fetch MTGJSON prices:', error.message)
    console.warn('   Continuing without pricing data...\n')
    priceLookup = new Map()
  }

  if (doRefreshPrices) {
    await refreshPrices(priceLookup, dryRun)
  } else {
    const csvPath = args.find(a => !a.startsWith('--'))
    if (!csvPath) {
      console.log('Usage: node scripts/import-collection.js <path-to-csv> [--dry-run] [--refresh-prices]')
,      console.log('       node scripts/import-collection.js --refresh-prices [--dry-run]')
      process.exit(1)
    }
    if (!fs.existsSync(csvPath)) {
      console.error(`❌ File not found: ${csvPath}`)
      process.exit(1)
    }
    await importCollection(csvPath, priceLookup, dryRun)
  }
  console.log(`=== STAGE OK: ${STAGE} ===`)
}

main().catch(error => {
  console.error('\n❌ Fatal error:', error.message)
  console.error(error.stack)
  console.error(`=== STAGE FAILED: ${STAGE} — ${error.message} ===`)
  process.exit(1)
})