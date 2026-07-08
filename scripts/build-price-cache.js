/**
 * Daily CardKingdom price cache refresh — VPS-SAFE version.
 *
 * Strategy (see scripts/README-price-pipeline.md):
 *   - AllPricesToday keys are MTGJSON UUIDs. The DB and pricing API use Scryfall IDs.
 *   - The uuid->scryfall translation comes from a small pre-built artifact
 *     (scripts/data/ck-uuid-map.json.gz, ~5MB, built on the MacBook by
 *     build-ck-cache-macbook.py — NEVER parse AllIdentifiers on the VPS: OOM).
 *   - This script only downloads AllPricesToday (~5MB gz), so it runs fine
 *     on the 1.9GB VPS. Peak memory well under 500MB.
 *
 * Output format (matches /api/pricing/route.js):
 *   { prices: { scryfallId: {n,f,b} }, names: { name_lower: {n,f,b} }, _meta }
 *   n = CK retail normal, f = CK retail foil, b = CK buylist normal (USD).
 *   names index keeps the CHEAPEST normal-retail printing so name-fallback
 *   quotes never overprice a card.
 *
 * Usage: node scripts/build-price-cache.js
 */

const path = require('path')
const fs = require('fs')
const zlib = require('zlib')

// Load env vars from nextjs/.env.local
const envPath = path.join(__dirname, '..', 'nextjs', '.env.local')
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const BUCKET = 'price-cache'
const CACHE_FILE = 'ck-prices.json'
const MAP_LOCAL = path.join(__dirname, 'data', 'ck-uuid-map.json.gz')
const MAP_STORAGE_URL = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/ck-uuid-map.json.gz`
const PRICES_URL = 'https://mtgjson.com/api/v5/AllPricesToday.json.gz'
const UA = 'Mozilla/5.0 (DBB price bot)'

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

function getLatestPrice(series) {
  if (!series || typeof series !== 'object') return null
  const dates = Object.keys(series).sort()
  if (!dates.length) return null
  const v = series[dates[dates.length - 1]]
  const num = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(num) ? num : null
}

async function fetchGzJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  return JSON.parse(zlib.gunzipSync(buf).toString('utf8'))
}

async function loadUuidMap() {
  if (fs.existsSync(MAP_LOCAL)) {
    console.log(`Loading uuid map from ${MAP_LOCAL}`)
    return JSON.parse(zlib.gunzipSync(fs.readFileSync(MAP_LOCAL)).toString('utf8'))
  }
  console.log('Local uuid map missing, fetching from Supabase Storage...')
  return fetchGzJson(MAP_STORAGE_URL)
}

async function main() {
  // uuid -> [scryfallId, cardName], only for CK-priced cards (~97k entries)
  const uuidMap = await loadUuidMap()
  console.log(`UUID map entries: ${Object.keys(uuidMap).length}`)

  console.log('Downloading AllPricesToday...')
  const priceData = await fetchGzJson(PRICES_URL)
  const entries = priceData.data || {}
  console.log(`Price entries: ${Object.keys(entries).length}`)

  const prices = {}
  const names = {}
  let unmapped = 0

  for (const [uuid, entry] of Object.entries(entries)) {
    const ck = entry && entry.paper && entry.paper.cardkingdom
    if (!ck) continue
    const retail = ck.retail || {}
    const buylist = ck.buylist || {}
    const n = getLatestPrice(retail.normal)
    const f = getLatestPrice(retail.foil)
    const b = getLatestPrice(buylist.normal)
    if (n === null && f === null && b === null) continue

    const mapped = uuidMap[uuid]
    if (!mapped) { unmapped++; continue }
    const [scryfallId, cardName] = mapped

    const rec = {}
    if (n !== null) rec.n = n
    if (f !== null) rec.f = f
    if (b !== null) rec.b = b
    prices[scryfallId.toLowerCase()] = rec

    if (cardName) {
      const key = cardName.toLowerCase()
      const cur = names[key]
      if (!cur || (n !== null && (cur.n === undefined || n < cur.n))) {
        names[key] = rec
      }
    }
  }

  const output = JSON.stringify({
    prices,
    names,
    _meta: {
      source: 'cardkingdom via mtgjson AllPricesToday',
      built: new Date().toISOString(),
      ids: Object.keys(prices).length,
      names: Object.keys(names).length,
      unmapped_uuids: unmapped,
    },
  })
  console.log(`CK prices: ${Object.keys(prices).length} ids, ${Object.keys(names).length} names, ` +
    `${unmapped} unmapped (new printings — rebuild uuid map on the MacBook if this grows), ` +
    `${(output.length / 1024 / 1024).toFixed(1)} MB`)

  // Keep a repo-local copy as backup
  const localPath = path.join(__dirname, 'data', CACHE_FILE)
  fs.mkdirSync(path.dirname(localPath), { recursive: true })
  fs.writeFileSync(localPath, output)
  console.log(`Saved ${localPath}`)

  // Upload to Supabase Storage
  const uploadRes = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${CACHE_FILE}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'x-upsert': 'true',
    },
    body: output,
  })
  if (!uploadRes.ok) {
    throw new Error(`Storage upload failed: HTTP ${uploadRes.status} ${await uploadRes.text()}`)
  }
  console.log('Uploaded to Supabase Storage')

  // Verify coverage against the live DB (paginated — PostgREST caps at 1000/page)
  const dbCards = []
  for (let offset = 0; ; offset += 1000) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/cards?select=scryfall_id,card_name&limit=1000&offset=${offset}`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
    )
    const page = await res.json()
    if (!Array.isArray(page) || !page.length) break
    dbCards.push(...page)
    if (page.length < 1000) break
  }
  let byId = 0, byName = 0, neither = 0
  const misses = []
  for (const card of dbCards) {
    const sid = (card.scryfall_id || '').toLowerCase()
    const nm = (card.card_name || '').toLowerCase()
    if (prices[sid]) byId++
    else if (names[nm]) byName++
    else { neither++; if (misses.length < 10) misses.push(card.card_name) }
  }
  console.log(`DB coverage: ${dbCards.length} cards — ${byId} by id, ${byName} by name, ${neither} missing`)
  if (misses.length) console.log('  missing:', misses.join(', '))

  console.log('Done!')
}

main().catch(err => {
  console.error('Fatal:', err.message)
  process.exit(1)
})
