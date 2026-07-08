import { NextResponse } from 'next/server'

// ============================================================================
// CardKingdom price lookup via pre-built price cache
// Cache has two indexes:
//   - "prices": scryfallId -> {n, f, b} (direct lookup by Scryfall ID)
//   - "names": card_name_lower -> {n, f, b} (fallback for different printings)
//
// Pricing model: CKD USD × multiplier = selling price in RM
// The multiplier IS the conversion. No separate USD→MYR step.
// Example: CKD $0.99 × 3.0 = RM 2.97
// ============================================================================

export const runtime = 'nodejs'
export const maxDuration = 30

const CACHE_BUCKET = 'price-cache'
const CACHE_FILE = 'ck-prices.json'
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000 // 24 hours

let priceCache = null          // Map<scryfallId_lowercase, {n, f, b}>
let namePriceCache = null      // Map<name_lower, {n, f, b}>
let priceCacheTimestamp = 0

// ============================================================================
// Fetch price cache from Supabase Storage
// ============================================================================

async function fetchPriceCache() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL

  if (!supabaseUrl) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL env var')
  }

  const cacheUrl = `${supabaseUrl}/storage/v1/object/public/${CACHE_BUCKET}/${CACHE_FILE}?t=${Date.now()}`

  console.log('[Pricing API] Fetching price cache from Supabase Storage...')

  const response = await fetch(cacheUrl, {
    headers: { 'User-Agent': 'DansBizarreBazaar/1.0' },
  })

  if (!response.ok) {
    throw new Error(`Price cache fetch failed: ${response.status} ${response.statusText}`)
  }

  const data = await response.json()

  if (!data || typeof data !== 'object') {
    throw new Error('Invalid price cache data')
  }

  // Support both old format (flat object) and new format ({prices, names})
  const priceMap = new Map()
  const nameMap = new Map()

  if (data.prices && data.names) {
    for (const [id, prices] of Object.entries(data.prices)) {
      priceMap.set(id.toLowerCase(), prices)
    }
    for (const [name, prices] of Object.entries(data.names)) {
      nameMap.set(name.toLowerCase(), prices)
    }
  } else {
    for (const [id, prices] of Object.entries(data)) {
      priceMap.set(id.toLowerCase(), prices)
    }
  }

  console.log(`[Pricing API] Loaded ${priceMap.size} CardKingdom prices by ID, ${nameMap.size} by name`)

  priceCache = priceMap
  namePriceCache = nameMap

  return priceMap
}

// ============================================================================
// Calculate selling price: CKD × multiplier (no exchange rate)
// ============================================================================

// Round to nearest RM 0.50: 1.48→1.50, 1.65→1.50, 1.77→2.00
function sellPrice(ckdPrice, multiplier) {
  if (ckdPrice === null || ckdPrice === undefined) return null
  const raw = ckdPrice * multiplier
  return Math.round(raw * 2) / 2
}

// ============================================================================
// Main GET handler
// ============================================================================

export async function GET(request) {
  const { searchParams } = new URL(request.url)
  const scryfallId = searchParams.get('scryfallId')
  const cardName = searchParams.get('name')
  const forceRefresh = searchParams.get('refresh') === 'true'

  // Ensure price cache is loaded
  const now = Date.now()
  if (!priceCache || forceRefresh || (now - priceCacheTimestamp) > CACHE_DURATION_MS) {
    try {
      await fetchPriceCache()
      priceCacheTimestamp = Date.now()
    } catch (error) {
      console.error('[Pricing API] Failed to load price cache:', error.message)
      if (!priceCache) {
        return NextResponse.json(
          { error: 'Price data unavailable', details: error.message },
          { status: 503 }
        )
      }
    }
  }

  // If no lookup params, return cache status
  if (!scryfallId && !cardName) {
    return NextResponse.json({
      status: 'ok',
      pricesLoaded: priceCache ? priceCache.size : 0,
      namesLoaded: namePriceCache ? namePriceCache.size : 0,
      cacheAge: priceCacheTimestamp ? Math.round((Date.now() - priceCacheTimestamp) / 1000 / 60) : null,
      source: 'cardkingdom_via_mtgjson',
      timestamp: new Date().toISOString(),
    }, {
      headers: { 'Cache-Control': 'public, s-maxage=3600' }
    })
  }

  // Look up in price cache by Scryfall ID
  let result = null
  let source = 'cardkingdom_via_mtgjson'

  if (scryfallId && priceCache) {
    result = priceCache.get(scryfallId.toLowerCase())
  }

  // If not found by ID, try name-based lookup
  if (!result && cardName && namePriceCache) {
    const nameLower = cardName.toLowerCase()
    result = namePriceCache.get(nameLower)
    if (result) {
      source = 'cardkingdom_via_mtgjson_name'
    }
  }

  // If found in cache, return CardKingdom prices
  if (result) {
    return NextResponse.json({
      ckd_usd_price: result.n ?? null,
      ckd_foil_price: result.f ?? null,
      ckd_etched_price: result.e ?? null,
      ckd_buy_price: result.b ?? null,
      // Selling prices: CKD USD × multiplier (multiplier IS the conversion)
      myr_price_2_5: sellPrice(result.n, 2.5),
      myr_price_2_8: sellPrice(result.n, 2.8),
      myr_price_3_0: sellPrice(result.n, 3.0),
      myr_foil_price_2_5: sellPrice(result.f, 2.5),
      myr_foil_price_2_8: sellPrice(result.f, 2.8),
      myr_foil_price_3_0: sellPrice(result.f, 3.0),
      myr_etched_price_2_5: sellPrice(result.e, 2.5),
      myr_etched_price_2_8: sellPrice(result.e, 2.8),
      myr_etched_price_3_0: sellPrice(result.e, 3.0),
      source,
      lastUpdated: new Date(priceCacheTimestamp).toISOString(),
    }, {
      headers: { 'Cache-Control': 'public, s-maxage=3600' }
    })
  }

  // No CK price available — return nulls
  return NextResponse.json({
    ckd_usd_price: null,
    ckd_foil_price: null,
    ckd_etched_price: null,
    ckd_buy_price: null,
    myr_price_2_5: null,
    myr_price_2_8: null,
    myr_price_3_0: null,
    myr_foil_price_2_5: null,
    myr_foil_price_2_8: null,
    myr_foil_price_3_0: null,
    myr_etched_price_2_5: null,
    myr_etched_price_2_8: null,
    myr_etched_price_3_0: null,
    source: null,
    lastUpdated: null,
  }, {
    headers: { 'Cache-Control': 'public, s-maxage=3600' }
  })
}