#!/usr/bin/env node
/**
 * Backfill colors and card_type from Scryfall API
 * 
 * These fields were not populated during initial import.
 * This script fetches missing data for all cards that have NULL colors or card_type.
 * 
 * Usage:
 *   node scripts/backfill-colors-types.js [--dry-run]
 */

const fs = require('fs')
const path = require('path')

// Load env
const envPath = path.join(__dirname, '..', 'nextjs', '.env.local')
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}

// Resolve supabase-js from the nextjs project
const modulePath = path.join(__dirname, '..', 'nextjs', 'node_modules')
const { createClient } = require(require.resolve('@supabase/supabase-js', { paths: [modulePath] }))
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

const SCRYFALL_BATCH_URL = 'https://api.scryfall.com/cards/collection'
const SCRYFALL_HEADERS = { 'Content-Type': 'application/json', 'User-Agent': 'DBB-Backfill/1.0 (contact@lovelikenotomorrow.com)' }

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchScryfallBatch(identifiers) {
  const resp = await fetch(SCRYFALL_BATCH_URL, {
    method: 'POST',
    headers: SCRYFALL_HEADERS,
    body: JSON.stringify({ identifiers }),
  })
  if (resp.status === 429) {
    console.log('   ⏳ Rate limited, waiting 1s...')
    await sleep(1000)
    return fetchScryfallBatch(identifiers)
  }
  return resp.json()
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')

  console.log('🔄 Backfilling colors and card_type from Scryfall')
  if (dryRun) console.log('   (dry run — no changes will be written)\n')

  // Fetch all available cards
  const allCards = []
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase
      .from('cards')
      .select('id, scryfall_id, card_name, colors, card_type, is_available')
      .eq('is_available', true)
      .range(offset, offset + 999)

    if (error) {
      console.error('❌ Failed to fetch cards:', error.message)
      process.exit(1)
    }
    if (!data || data.length === 0) break
    allCards.push(...data)
    if (data.length < 1000) break
  }

  // Filter to cards missing colors or card_type
  const needsUpdate = allCards.filter(c => !c.colors || c.colors.length === 0 || !c.card_type)
  console.log(`📊 Total available: ${allCards.length}, needing update: ${needsUpdate.length}`)

  if (needsUpdate.length === 0) {
    console.log('✅ All cards already have colors and card_type!')
    return
  }

  let updated = 0
  let notFound = 0
  let failed = 0
  const BATCH_SIZE = 75 // Scryfall allows max 75 per collection request

  for (let i = 0; i < needsUpdate.length; i += BATCH_SIZE) {
    const batch = needsUpdate.slice(i, i + BATCH_SIZE)
    const identifiers = batch.map(c => ({ id: c.scryfall_id }))

    console.log(`   Fetching batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(needsUpdate.length / BATCH_SIZE)} (${batch.length} cards)...`)

    let result
    try {
      result = await fetchScryfallBatch(identifiers)
    } catch (err) {
      console.error('   ❌ Scryfall request failed:', err.message)
      failed += batch.length
      await sleep(1000)
      continue
    }

    if (!result.data || result.data.length === 0) {
      console.error('   ❌ No data in Scryfall response',
        'not_found:', (result.not_found || []).length,
        'object:', result.object,
        'total_cards:', result.total_cards,
        'has_more:', result.has_more,
        'code:', result.code,
        'status:', result.status,
        'details:', result.details || 'none',
        'warnings:', result.warnings || 'none'
      )
      failed += batch.length
      await sleep(500)
      continue
    }

    // Build a map of scryfall_id -> data
    const scryfallMap = new Map()
    for (const card of result.data) {
      scryfallMap.set(card.id, card)
    }
    // Also check not_found
    const notFoundIds = new Set((result.not_found || []).map(n => n.id))

    for (const localCard of batch) {
      const scryfData = scryfallMap.get(localCard.scryfall_id)

      if (!scryfData) {
        if (notFoundIds.has(localCard.scryfall_id)) {
          notFound++
        } else {
          failed++
        }
        continue
      }

      // Extract colors and type_line
      const colors = scryfData.colors || []
      // For double-faced cards, use the front face
      const typeLine = scryfData.type_line || scryfData.card_faces?.[0]?.type_line || null
      const colorIdentity = scryfData.color_identity || []

      // Use color_identity for the filter (includes abilities)
      // Use colors for the card's actual color
      const updateData = {
        colors: colorIdentity.length > 0 ? colorIdentity : colors,
        card_type: typeLine,
      }

      if (dryRun) {
        console.log(`   📝 Would update: ${localCard.card_name} → colors: ${JSON.stringify(updateData.colors)}, type: ${updateData.card_type}`)
        updated++
      } else {
        const { error } = await supabase
          .from('cards')
          .update(updateData)
          .eq('id', localCard.id)

        if (error) {
          console.error(`   ❌ Failed to update ${localCard.card_name}:`, error.message)
          failed++
        } else {
          updated++
        }
      }
    }

    // Respect Scryfall rate limit (no more than ~10 requests/second)
    await sleep(150)
  }

  console.log(`\n✅ Updated: ${updated}`)
  console.log(`⚠️  Not found on Scryfall: ${notFound}`)
  console.log(`❌ Failed: ${failed}`)
  console.log(`📊 Total processed: ${updated + notFound + failed}/${needsUpdate.length}`)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})