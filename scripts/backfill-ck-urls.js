#!/usr/bin/env node
/**
 * Build CK URL cache from MTGJSON per-set files
 * Downloads each set JSON individually (small files) to avoid the 610MB AllPrintings problem
 * Then backfills the ck_product_url column in Supabase
 */

const fs = require('fs')
const path = require('path')

const MTGJSON_BASE = 'https://mtgjson.com/api/v5'
const OUTPUT = path.join(__dirname, 'data', 'ck-urls.json')

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function main() {
  // Load env
  const envPath = path.join(__dirname, '..', 'nextjs', '.env.local')
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
  
  const { createClient } = require(require.resolve('@supabase/supabase-js', { paths: [path.join(__dirname, '..', 'nextjs', 'node_modules')] }))
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  
  // Get all set codes from DB
  console.log('📊 Fetching set codes from DB...')
  const { data: cardSets } = await supabase
    .from('cards')
    .select('scryfall_id, set_code')
    .eq('is_available', true)
  
  const setCodes = [...new Set(cardSets.map(c => c.set_code))]
  console.log(`   Found ${setCodes.length} sets, ${cardSets.length} cards`)
  
  // Build scryfall_id -> set_code map
  const sfIdToSet = new Map()
  for (const c of cardSets) {
    sfIdToSet.set(c.scryfall_id.toLowerCase(), c.set_code)
  }
  
  // Download each set and extract CK URLs
  const urlMap = {}
  let totalCards = 0
  let withCk = 0
  let setsFailed = 0
  
  for (let i = 0; i < setCodes.length; i++) {
    const setCode = setCodes[i]
    process.stdout.write(`\r   [${i+1}/${setCodes.length}] ${setCode}...`)
    
    let setData
    try {
      const resp = await fetch(`${MTGJSON_BASE}/${setCode}.json`, {
        headers: { 'User-Agent': 'DBB-Backfill/1.0 (contact@lovelikenotomorrow.com)' }
      })
      if (!resp.ok) {
        console.log(` ⚠️ HTTP ${resp.status}`)
        setsFailed++
        continue
      }
      setData = await resp.json()
    } catch (err) {
      console.log(` ⚠️ ${err.message}`)
      setsFailed++
      await sleep(500)
      continue
    }
    
    const cards = setData.data?.cards || setData.cards || []
    for (const card of cards) {
      totalCards++
      const sfId = (card.identifiers?.scryfallId || '').toLowerCase()
      if (!sfId) continue
      
      const ckUrl = card.purchaseUrls?.cardKingdom || null
      const ckFoilUrl = card.purchaseUrls?.cardKingdomFoil || null
      const ckEtchedUrl = card.purchaseUrls?.cardKingdomEtched || null
      const ckId = card.identifiers?.cardKingdomId || null

      if (ckUrl || ckId) {
        withCk++
        urlMap[sfId] = {
          ck_url: ckUrl,
          ck_foil_url: ckFoilUrl,
          ck_etched_url: ckEtchedUrl,
          ck_id: ckId,
        }
      }
    }
    
    await sleep(150) // Rate limit
  }
  
  console.log(`\n\n📊 Total cards parsed: ${totalCards}`)
  console.log(`   With CK URL/ID: ${withCk}`)
  console.log(`   Unique Scryfall IDs: ${Object.keys(urlMap).length}`)
  console.log(`   Sets failed: ${setsFailed}`)
  
  // Count DB matches
  let matched = 0
  for (const sfId of sfIdToSet.keys()) {
    if (urlMap[sfId]) matched++
  }
  console.log(`   DB cards matched: ${matched}/${cardSets.length}`)
  
  // Save cache
  const output = {
    _meta: {
      built: new Date().toISOString(),
      totalCards,
      withCkUrl: withCk,
      uniqueScryfallIds: Object.keys(urlMap).length,
      dbCardsMatched: matched,
    },
    urls: urlMap,
  }
  
  fs.writeFileSync(OUTPUT, JSON.stringify(output))
  console.log(`\n✅ Cache saved to ${OUTPUT} (${(fs.statSync(OUTPUT).size / 1024 / 1024).toFixed(1)}MB)`)
  
  // Now backfill the DB
  console.log('\n📊 Backfilling ck_product_url in DB...')
  let updated = 0
  let failed = 0
  const batchSize = 100
  const entries = Object.entries(urlMap).filter(([sfId]) => sfIdToSet.has(sfId))
  
  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize)
    const updates = batch.map(([sfId, urls]) => ({
      scryfall_id: sfId,
      ck_product_url: urls.ck_url || (urls.ck_id ? `https://www.cardkingdom.com/mtg-singles/product/${urls.ck_id}` : null),
      ck_foil_product_url: urls.ck_foil_url || null,
      ck_etched_product_url: urls.ck_etched_url || null,
    }))

    // Update by scryfall_id
    for (const upd of updates) {
      const { error } = await supabase
        .from('cards')
        .update({
          ck_product_url: upd.ck_product_url,
          ck_foil_product_url: upd.ck_foil_product_url,
          ck_etched_product_url: upd.ck_etched_product_url,
        })
        .eq('scryfall_id', upd.scryfall_id)
      
      if (error) {
        console.error(`   ❌ Error updating ${upd.scryfall_id}:`, error.message)
        failed++
      } else {
        updated++
      }
    }
    
    process.stdout.write(`\r   Updated: ${updated}/${entries.length} (failed: ${failed})`)
    await sleep(50)
  }
  
  console.log(`\n\n✅ Backfill complete: ${updated} updated, ${failed} failed`)
  
  // Check for cards without CK URL
  const { count: totalAvailable } = await supabase
    .from('cards')
    .select('*', { count: 'exact', head: true })
    .eq('is_available', true)
  
  const { count: withUrl } = await supabase
    .from('cards')
    .select('*', { count: 'exact', head: true })
    .eq('is_available', true)
    .not('ck_product_url', 'is', null)
  
  console.log(`\n📊 DB Summary:`)
  console.log(`   Total available cards: ${totalAvailable}`)
  console.log(`   With CK URL: ${withUrl}`)
  console.log(`   Without CK URL: ${totalAvailable - withUrl}`)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})