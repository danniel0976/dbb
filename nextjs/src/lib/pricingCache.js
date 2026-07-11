// Shared in-memory price cache singleton.
// Imported by /api/pricing (GET) and /api/pricing/batch (POST).
// Fields in each entry: n=normal, f=foil, e=etched, b=buylist (CKD USD)

const CACHE_BUCKET = 'price-cache'
const CACHE_FILE = 'ck-prices.json'
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000

let _priceCache = null       // Map<scryfallId_lower, {n,f,e,b}>
let _namePriceCache = null   // Map<name_lower, {n,f,e,b}>
let _cacheTimestamp = 0

async function fetchPriceCache() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!supabaseUrl) throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL env var')

  const res = await fetch(
    `${supabaseUrl}/storage/v1/object/public/${CACHE_BUCKET}/${CACHE_FILE}?t=${Date.now()}`,
    { headers: { 'User-Agent': 'DansBizarreBazaar/1.0' } }
  )
  if (!res.ok) throw new Error(`Price cache fetch failed: ${res.status} ${res.statusText}`)

  const data = await res.json()
  if (!data || typeof data !== 'object') throw new Error('Invalid price cache data')

  const pm = new Map()
  const nm = new Map()

  if (data.prices && data.names) {
    for (const [id, p] of Object.entries(data.prices)) pm.set(id.toLowerCase(), p)
    for (const [name, p] of Object.entries(data.names)) nm.set(name.toLowerCase(), p)
  } else {
    for (const [id, p] of Object.entries(data)) pm.set(id.toLowerCase(), p)
  }

  _priceCache = pm
  _namePriceCache = nm
  _cacheTimestamp = Date.now()
  console.log(`[PricingCache] Loaded ${pm.size} CK prices by ID, ${nm.size} by name`)
}

export async function ensurePriceCache(forceRefresh = false) {
  const now = Date.now()
  if (!_priceCache || forceRefresh || now - _cacheTimestamp > CACHE_DURATION_MS) {
    await fetchPriceCache()
  }
  return {
    priceCache: _priceCache,
    namePriceCache: _namePriceCache,
    cacheTimestamp: _cacheTimestamp,
  }
}

// CKD USD × multiplier, rounded to nearest RM 0.50 (e.g. 1.48→1.50, 1.65→1.50, 1.77→2.00)
export function sellPrice(ckdUsd, multiplier) {
  if (ckdUsd == null) return null
  return Math.round(ckdUsd * multiplier * 2) / 2
}

// Look up CKD USD for a single scryfall_id + foil type ('normal'|'foil'|'etched')
export function lookupPrice(scryfallId, foil = 'normal') {
  if (!_priceCache) return null
  const entry = _priceCache.get(scryfallId.toLowerCase())
  if (!entry) return null
  if (foil === 'foil') return entry.f ?? null
  if (foil === 'etched') return entry.e ?? null
  return entry.n ?? null
}

// Look up the raw entry (all fields) for a scryfall_id
export function lookupEntry(scryfallId) {
  if (!_priceCache) return null
  return _priceCache.get(scryfallId.toLowerCase()) || null
}

export function getCacheStats() {
  return {
    pricesLoaded: _priceCache ? _priceCache.size : 0,
    namesLoaded: _namePriceCache ? _namePriceCache.size : 0,
    cacheAgeMin: _cacheTimestamp ? Math.round((Date.now() - _cacheTimestamp) / 60000) : null,
    lastUpdated: _cacheTimestamp ? new Date(_cacheTimestamp).toISOString() : null,
  }
}
