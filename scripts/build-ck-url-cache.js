#!/usr/bin/env node
/**
 * Build CK URL cache by downloading individual MTGJSON set files
 * Each set file is small (~1-5MB), avoiding the 610MB AllPrintings problem
 * 
 * Output: scripts/data/ck-urls.json
 */

const fs = require('fs')
const path = require('path')

const MTGJSON_BASE = 'https://mtgjson.com/api/v5'
const OUTPUT = path.join(__dirname, 'data', 'ck-urls.json')

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchSet(setCode) {
  const url = `${MTGJSON_BASE}/${setCode}.json`
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'DBB-Backfill/1.0 (contact@lovelikenotomorrow.com)' }
  })
  if (!resp.ok) return null
  return resp.json()
}

async function main() {
  // Load env for Supabase access
  const envPath = path.join(__dirname, '..', 'nextjs', '.env.local')
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
  
  const modulePath = path.join(__dirname, '..', 'nextjs', 'node_modules')
  const { createClient } = require(require.resolve('@supabase/supabase-js', { paths: [modulePath] }))
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  
  // Get all unique set codes from DB
  console.log('📊 Fetching set codes from DB...')
  const allCards = []
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase
      .from('cards')
      .select('scryfall_id')
      .eq('is_available', true)
      .range(offset, offset + 999)
    if (error) throw error
    if (!data || data.length === 0) break
    allCards.push(...data)
    if (data.length < 1000) break
  }
  
  // Get set codes from Scryfall IDs
  // Scryfall IDs contain no set info, so let's just get all cards with set_code
  const { data: cardSets } = await supabase
    .from('cards')
    .select('scryfall_id, set_code, is_foil')
    .eq('is_available', true)
  
  const setCodes = [...new Set(cardSets.map(c => c.set_code))]
  console.log(`   Found ${setCodes.length} sets`)
  
  // Build scryfall_id -> {set_code, is_foil} map
  const sfIdMap = new Map()
  for (const c of cardSets) {
    sfIdMap.set(c.scryfall_id.toLowerCase(), { set: c.set_code, foil: c.is_foil })
  }
  
  // Download each set from MTGJSON and extract CK URLs
  const urlMap = {}
  let totalCards = 0
  let withCk = 0
  let setsFailed = 0
  
  for (let i = 0; i < setCodes.length; i++) {
    const setCode = setCodes[i]
    console.log(`   [${i+1}/${setCodes.length}] Fetching ${setCode}...`)
    
    let setData
    try {
      setData = await fetchSet(setCode)
      if (!setData) {
        console.log(`      ⚠️  ${setCode} not found on MTGJSON, skipping`)
        setsFailed++
        continue
      }
    } catch (err) {
      console.log(`      ⚠️  ${setCode} fetch error: ${err.message}`)
      setsFailed++
      await sleep(500)
      continue
    }
    
    const cards = setData.data?.cards || setData.cards || []
    for (const card of cards) {
      totalCards++
      const sfId = (card.identifiers?.scryfallId || '').toLowerCase()
      if (!sfId) continue
      
      const purchaseUrls = card.purchaseUrls || {}
      const identifiers = card.identifiers || {}
      
      const ckUrl = purchaseUrls.cardKingdom || null
      const ckFoilUrl = purchaseUrls.cardKingdomFoil || null
      const ckId = identifiers.cardKingdomId || null
      
      if (ckUrl || ckId) {
        withCk++
        urlMap[sfId] = {
          ck_url: ckUrl || (ckId ? `https://www.cardkingdom.com/mtg-singles/product/${ckId}` : null),
          ck_foil_url: ckFoilUrl,
          ck_id: ckId,
        }
      }
    }
    
    await sleep(200) // Rate limit
  }
  
  console.log(`\n📊 Total cards parsed: ${totalCards}`)
  console.log(`   With CK URL/ID: ${withCk}`)
  console.log(`   Unique Scryfall IDs: ${Object.keys(urlMap).length}`)
  console.log(`   Sets failed: ${setsFailed}`)
  
  // Match against our DB cards
  let matched = 0
  let unmatched = 0
  for (const [sfId, cardInfo] of sfIdMap) {
    if (urlMap[sfId]) {
      matched++
    } else {
      unmatched++
    }
  }
  console.log(`\n📊 DB cards matched with CK URL: ${matched}/${cardSets.length}`)
  console.log(`   DB cards without CK URL: ${unmatched}`)
  
  const output = {
    _meta: {
      built: new Date().toISOString(),
      totalCards,
      withCkUrl: withCk,
      uniqueScryfallIds: Object.keys(urlMap).length,
      dbCardsMatched: matched,
      dbCardsUnmatched: unmatched,
    },
    urls: urlMap,
  }
  
  fs.writeFileSync(OUTPUT, JSON.stringify(output))
  console.log(`\n✅ Saved to ${OUTPUT}`)
  console.log(`   File size: ${(fs.statSync(OUTPUT).size / 1024 / 1024).toFixed(1)}MB`)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})