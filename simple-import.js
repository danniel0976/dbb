/**
 * Simple DBB Import Script
 * Standalone importer for ManaBox CSV
 * Usage: node simple-import.js my-collection.csv
 */

const { createClient } = require('@supabase/supabase-js')
const { parse } = require('csv-parse/sync')
const fs = require('fs')
const axios = require('axios')

// Config
const SUPABASE_URL = 'https://mnyhpwqskzadkplnhbrx.supabase.co'
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1ueWhwd3Fza3phZGtwbG5oYnJ4Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MTI2MjU4MSwiZXhwIjoyMDk2ODM4NTgxfQ.0RKvfOwGAxytcE0DpwHHUqGxPTnW50MYknU9mxny1qY'
const EXCHANGE_RATE = 4.70

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

console.log('🚀 Starting DBB Simple Import\n')

// Read CSV
const csvPath = process.argv[2]
if (!csvPath) {
  console.error('❌ Usage: node simple-import.js <csv-file>')
  process.exit(1)
}

console.log(`📁 CSV File: ${csvPath}`)
console.log(`💱 Exchange Rate: 1 USD = ${EXCHANGE_RATE} MYR\n`)

const content = fs.readFileSync(csvPath, 'utf-8')
const records = parse(content, { columns: true, skip_empty_lines: true })

console.log(`📊 Parsed ${records.length} cards from CSV\n`)

// Fetch CardKingdom pricelist
console.log('💰 Fetching CardKingdom pricelist...')
axios.get('https://api.cardkingdom.com/api/v2/pricelist', { timeout: 30000 })
  .then(response => {
    const pricelist = response.data
    const priceLookup = new Map()
    
    if (pricelist.products) {
      for (const product of pricelist.products) {
        if (product.ScryfallID) {
          priceLookup.set(product.ScryfallID.toLowerCase(), {
            ckd_usd_price: parseFloat(product.PriceRetail) || 0,
            is_foil: product.IsFoil || false,
          })
        }
      }
    }
    
    console.log(`   Loaded ${priceLookup.size} prices from CardKingdom\n`)
    
    // Process cards
    processCards(records, priceLookup)
  })
  .catch(err => {
    console.error('❌ Failed to fetch CardKingdom pricelist:', err.message)
    console.log('   Continuing without pricing data...\n')
    processCards(records, new Map())
  })

async function processCards(records, priceLookup) {
  let success = 0
  let failed = 0
  const errors = []
  
  console.log(`⚙️  Processing ${records.length} cards in batches of 20...\n`)
  
  const batchSize = 20
  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize)
    const batchNum = Math.floor(i / batchSize) + 1
    const totalBatches = Math.ceil(records.length / batchSize)
    
    console.log(`📦 Batch ${batchNum}/${totalBatches} (${batch.length} cards)`)
    
    for (const row of batch) {
      try {
        const scryfallId = row['Scryfall ID']
        const isFoil = row['Foil']?.toLowerCase() === 'foil' || row['Foil']?.toLowerCase() === 'etched'
        
        // Get price from lookup
        const priceInfo = scryfallId ? priceLookup.get(scryfallId.toLowerCase()) : null
        let ckdUsdPrice = 0
        
        if (priceInfo && priceInfo.is_foil === isFoil) {
          ckdUsdPrice = priceInfo.ckd_usd_price
        } else if (priceInfo) {
          // If foil status doesn't match, use non-foil price as fallback
          ckdUsdPrice = priceInfo.ckd_usd_price
        }
        
        // Calculate MYR prices
        const myr25 = ckdUsdPrice > 0 ? Math.round(ckdUsdPrice * EXCHANGE_RATE * 2.5 * 100) / 100 : null
        const myr28 = ckdUsdPrice > 0 ? Math.round(ckdUsdPrice * EXCHANGE_RATE * 2.8 * 100) / 100 : null
        const myr30 = ckdUsdPrice > 0 ? Math.round(ckdUsdPrice * EXCHANGE_RATE * 3.0 * 100) / 100 : null
        
        // Map condition
        const conditionMap = {
          'near_mint': 'NM', 'nm': 'NM', 'light_played': 'LP', 
          'moderately_played': 'MP', 'heavily_played': 'HP', 'damaged': 'DMG'
        }
        const condition = conditionMap[row['Condition']?.toLowerCase()] || 'NM'
        
        // Insert into Supabase
        const { error } = await supabase
          .from('cards')
          .insert([{
            scryfall_id: scryfallId || null,
            card_name: row['Name'],
            set_code: row['Set code'],
            set_name: row['Set name'],
            collector_number: row['Collector number'],
            rarity: row['Rarity'],
            is_foil: isFoil,
            condition: condition,
            ckd_usd_price: ckdUsdPrice || null,
            myr_price_2_5: myr25,
            myr_price_2_8: myr28,
            myr_price_3_0: myr30,
            usd_myr_rate: EXCHANGE_RATE,
            is_available: !(row['Binder Name']?.includes('[SOLD]') || row['Quantity'] == 0),
          }])
        
        if (error) throw error
        
        success++
        console.log(`   ✅ ${row['Name']} (${row['Set code']} #${row['Collector number']}) - RM${myr28?.toFixed(2) || 'N/A'}`)
      } catch (err) {
        failed++
        errors.push({ card: row['Name'], error: err.message })
        console.log(`   ❌ ${row['Name']} - ${err.message}`)
      }
      
      // Small delay to respect rate limits
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    
    console.log()
  }
  
  console.log('📊 IMPORT SUMMARY')
  console.log('=' .repeat(50))
  console.log(`✅ Total Success: ${success}`)
  console.log(`❌ Total Failed: ${failed}`)
  console.log('=' .repeat(50))
  
  if (errors.length > 0) {
    fs.writeFileSync('failed-imports.json', JSON.stringify(errors, null, 2))
    console.log('\n⚠️  Failed imports saved to: failed-imports.json')
  }
  
  console.log('\n✨ Import complete!')
  console.log('\n🌐 View your collection at: https://nextjs-oin5wztup-chippyandluke.vercel.app')
}
