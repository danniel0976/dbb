/**
 * DBB Collection Import Script
 * 
 * Imports MTG cards from ManaBox CSV format into Supabase DBB schema.
 * Fetches data from Scryfall API and CardKingdom API for pricing.
 * 
 * Usage: node scripts/import-collection.js <path-to-csv>
 */

require('dotenv').config({ path: '/root/.openclaw/workspace/dbb/nextjs/.env.local' })
const { createClient } = require('@supabase/supabase-js')
const { parse } = require('csv-parse/sync')
const fs = require('fs')
const path = require('path')
const { scryfallAPI, mtgjsonAPI, cardProcessingService } = require('../nextjs/src/lib/api')

// Configuration
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const EXCHANGE_RATE = parseFloat(process.env.USD_MYR_RATE) || 4.70
const BATCH_SIZE = 10
const DELAY_MS = 1000 // Respect Scryfall rate limits (100 calls/hour for anonymous)

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ Missing Supabase credentials in .env.local')
  console.error('Required: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

// Initialize Supabase client with service role key for writes
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  db: { schema: 'dbb' }
})

// Parse ManaBox CSV
function parseManaboxCSV(csvPath) {
  const content = fs.readFileSync(csvPath, 'utf-8')
  
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  })

  console.log(`📊 Parsed ${records.length} cards from CSV`)

  // Map condition from ManaBox format to our format
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

  // Map to our expected format (ManaBox CSV columns)
  return records.map((row, index) => {
    // ManaBox CSV format:
    // Name, Set code, Set name, Collector number, Foil, Rarity, Quantity, ..., Scryfall ID, Condition
    
    return {
      card_name: row['Name'] || row['Card Name'] || row['name'] || row['Card'],
      set_code: row['Set code'] || row['Set'] || row['set_code'] || row['Set Code'],
      collector_number: row['Collector number'] || row['Collector No'] || row['collector_number'] || row['Number'] || row['#'],
      is_foil: (row['Foil'] || 'normal').toLowerCase() === 'foil' || row['Foil'] === 'Yes' || row['Foil'] === 'etched',
      condition: mapCondition(row['Condition'] || row['condition'] || 'near_mint'),
      quantity: parseInt(row['Quantity'] || row['qty'] || '1', 10),
      scryfall_id: row['Scryfall ID'] || null,
      _original: row, // Keep original for debugging
      _rowIndex: index + 1,
    }
  }).filter(card => card.card_name && card.set_code)
}

// Insert card into Supabase
async function insertCard(cardData) {
  // Remove internal fields that aren't in our schema
  const { _original, _rowIndex, quantity, ...cleanData } = cardData
  
  const { data, error } = await supabase
    .from('cards')
    .insert([cleanData])
    .select()
    .single()

  if (error) {
    throw error
  }

  return data
}

// Update existing card or insert new one
async function upsertCard(cardData) {
  // Remove internal fields that aren't in our schema
  const { _original, _rowIndex, quantity, ...cleanData } = cardData
  
  // Check if card exists by Scryfall ID
  const { data: existing } = await supabase
    .from('cards')
    .select('id')
    .eq('scryfall_id', cleanData.scryfall_id)
    .eq('is_foil', cleanData.is_foil)
    .single()

  if (existing) {
    // Update existing
    const { data, error } = await supabase
      .from('cards')
      .update(cleanData)
      .eq('id', existing.id)
      .select()
      .single()

    if (error) throw error
    console.log(`✏️  Updated: ${cleanData.card_name}`)
    return { ...data, _action: 'updated' }
  } else {
    // Insert new
    const data = await insertCard(cleanData)
    console.log(`✅ Inserted: ${cleanData.card_name}`)
    return { ...data, _action: 'inserted' }
  }
}

// Main import function
async function importCollection(csvPath) {
  console.log('🚀 Starting DBB Collection Import\n')
  console.log(`📁 CSV File: ${csvPath}`)
  console.log(`💱 Exchange Rate: 1 USD = ${EXCHANGE_RATE} MYR\n`)

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

  // Fetch MTGJSON pricelist once (includes CardKingdom data)
  console.log('💰 Fetching MTGJSON pricelist (includes CardKingdom)...')
  let priceLookup
  try {
    priceLookup = await mtgjsonAPI.fetchCKDPriceLookup()
    console.log(`   Loaded ${priceLookup.size} CardKingdom price entries\n`)
  } catch (error) {
    console.warn('⚠️  Failed to fetch MTGJSON prices:', error.message)
    console.warn('   Continuing without pricing data...\n')
    priceLookup = new Map()
  }

  // Process cards in batches
  const results = {
    success: [],
    failed: [],
    updated: 0,
    inserted: 0,
  }

  console.log(`⚙️  Processing ${cards.length} cards in batches of ${BATCH_SIZE}...\n`)

  for (let i = 0; i < cards.length; i += BATCH_SIZE) {
    const batch = cards.slice(i, i + BATCH_SIZE)
    const batchNum = Math.floor(i / BATCH_SIZE) + 1
    const totalBatches = Math.ceil(cards.length / BATCH_SIZE)
    
    console.log(`📦 Batch ${batchNum}/${totalBatches} (${batch.length} cards)`)

    const batchResults = await Promise.all(
      batch.map(async (card) => {
        try {
          // Process card through APIs
          const processedCard = await cardProcessingService.processCard(
            card,
            priceLookup,
            EXCHANGE_RATE
          )

          if (!processedCard.scryfall_id) {
            throw new Error(processedCard.error || 'No Scryfall ID')
          }

          // Upsert to Supabase
          const result = await upsertCard(processedCard)
          
          results[result._action === 'updated' ? 'updated' : 'inserted']++
          results.success.push(result)

          return { success: true, card: processedCard }
        } catch (error) {
          const failRecord = {
            ...card,
            error: error.message,
          }
          results.failed.push(failRecord)
          console.error(`   ❌ ${card.card_name} (${card.set_code}): ${error.message}`)
          return { success: false, card: card, error: error.message }
        }
      })
    )

    // Progress update
    const successCount = results.success.length
    const failCount = results.failed.length
    console.log(`   ✓ ${successCount} succeeded, ${failCount} failed\n`)

    // Rate limiting delay between batches
    if (i + BATCH_SIZE < cards.length) {
      await new Promise(resolve => setTimeout(resolve, DELAY_MS))
    }
  }

  // Summary
  console.log('\n' + '='.repeat(50))
  console.log('📊 IMPORT SUMMARY')
  console.log('='.repeat(50))
  console.log(`✅ Total Success: ${results.success.length}`)
  console.log(`   ├─ Inserted: ${results.inserted}`)
  console.log(`   └─ Updated: ${results.updated}`)
  console.log(`❌ Total Failed: ${results.failed.length}`)
  console.log('='.repeat(50))

  // Save failed imports to file
  if (results.failed.length > 0) {
    const failPath = path.join(path.dirname(csvPath), 'failed-imports.json')
    fs.writeFileSync(failPath, JSON.stringify(results.failed, null, 2))
    console.log(`\n⚠️  Failed imports saved to: ${failPath}`)
  }

  console.log('\n✨ Import complete!\n')
}

// CLI entry point
if (require.main === module) {
  const csvPath = process.argv[2]

  if (!csvPath) {
    console.log('Usage: node scripts/import-collection.js <path-to-csv>')
    console.log('\nExample:')
    console.log('  node scripts/import-collection.js ./manabox-collection.csv')
    console.log('\nCSV should have columns:')
    console.log('  - Card Name (or "name", "Card")')
    console.log('  - Set (or "set_code", "Set Code")')
    console.log('  - Collector No (or "collector_number", "Number", "#")')
    console.log('  - Foil (optional, "true"/"false" or "Yes"/"No")')
    console.log('  - Condition (optional, defaults to "NM")')
    console.log('  - Quantity (optional)\n')
    process.exit(1)
  }

  if (!fs.existsSync(csvPath)) {
    console.error(`❌ File not found: ${csvPath}`)
    process.exit(1)
  }

  importCollection(csvPath).catch(error => {
    console.error('\n❌ Fatal error:', error.message)
    console.error(error.stack)
    process.exit(1)
  })
}

module.exports = { importCollection, parseManaboxCSV }
