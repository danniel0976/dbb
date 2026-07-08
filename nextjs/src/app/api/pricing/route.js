import { NextResponse } from 'next/server'

// ============================================================================
// CardKingdom price lookup via pre-built price cache
// Cache is built daily by build-price-cache.js and stored in Supabase Storage
// Falls back to Scryfall for cards not in the cache
// ============================================================================

export const runtime = 'nodejs'
export const maxDuration = 30

const CACHE_BUCKET = 'price-cache'
const CACHE_FILE = 'ck-prices.json'
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000 // 24 hours
const EXCHANGE_RATE_API = 'https://open.er-api.com/v6/latest/USD'
const DEFAULT_USD_MYR = 4.70

let priceCache = null          // Map<scryfallId_lowercase, {n, f, b}>
let priceCacheTimestamp = 0
let exchangeRate = DEFAULT_USD_MYR
let exchangeRateTimestamp = 0

// ============================================================================
// Fetch price cache from Supabase Storage (compact, ~5-10MB)
// ============================================================================

async function fetchPriceCache() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL

  if (!supabaseUrl) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL env var')
  }

  // Fetch from Supabase Storage public URL
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

  const lookup = new Map()
  for (const [uuid, prices] of Object.entries(data)) {
    lookup.set(uuid.toLowerCase(), prices)
  }

  console.log(`[Pricing API] Loaded ${lookup.size} CardKingdom prices from cache`)
  return lookup
}

// ============================================================================
// Fetch live USD/MYR exchange rate
// ============================================================================

async function fetchExchangeRate() {
  try {
    const response = await fetch(EXCHANGE_RATE_API, {
      headers: { 'User-Agent': 'DansBizarreBazaar/1.0' },
    })
    if (response.ok) {
      const data = await response.json()
      if (data.rates && data.rates.MYR) {
        exchangeRate = data.rates.MYR
        exchangeRateTimestamp = Date.now()
        console.log(`[Pricing API] Updated USD/MYR rate: ${exchangeRate}`)
        return exchangeRate
      }
    }
  } catch (e) {
    console.error('[Pricing API] Failed to fetch exchange rate:', e.message)
  }
  return exchangeRate || DEFAULT_USD_MYR
}

// ============================================================================
// Scryfall fallback for cards not in cache
// ============================================================================

async function scryfallFallback(scryfallId, cardName, setName, collectorNumber) {
  let scryfallUrl
  if (scryfallId) {
    scryfallUrl = `https://api.scryfall.com/cards/${scryfallId}`
  } else if (cardName) {
    scryfallUrl = `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(cardName)}`
  } else {
    return null
  }

  try {
    const response = await fetch(scryfallUrl, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'DansBizarreBazaar/1.0' },
      next: { revalidate: 86400 },
    })

    if (!response.ok) return null

    const card = await response.json()
    const prices = card.prices || {}

    return {
      ckd_usd_price: prices.usd ? parseFloat(prices.usd) : null,
      ckd_foil_price: prices.usd_foil ? parseFloat(prices.usd_foil) : null,
      ckd_buy_price: null,
      source: 'scryfall_market',
      note: 'Prices are TCGPlayer/market average, NOT CardKingdom. CK price not available.',
      lastUpdated: card.updated_at || new Date().toISOString(),
    }
  } catch (error) {
    console.error('[Pricing API] Scryfall fallback error:', error.message)
    return null
  }
}

// ============================================================================
// Calculate MYR prices
// ============================================================================

function calculateMYR(usdPrice, rate) {
  if (usdPrice === null || usdPrice === undefined) return null
  return Math.round(usdPrice * rate * 100) / 100
}

// ============================================================================
// Main GET handler
// ============================================================================

export async function GET(request) {
  const { searchParams } = new URL(request.url)
  const scryfallId = searchParams.get('scryfallId')
  const cardName = searchParams.get('name')
  const forceRefresh = searchParams.get('refresh') === 'true'
  const rate = parseFloat(searchParams.get('rate')) || exchangeRate || DEFAULT_USD_MYR

  // Ensure price cache is loaded
  const now = Date.now()
  if (!priceCache || forceRefresh || (now - priceCacheTimestamp) > CACHE_DURATION_MS) {
    try {
      priceCache = await fetchPriceCache()
      priceCacheTimestamp = Date.now()
      // Also refresh exchange rate if stale
      if (!exchangeRateTimestamp || (now - exchangeRateTimestamp) > CACHE_DURATION_MS) {
        await fetchExchangeRate()
      }
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
      cacheAge: priceCacheTimestamp ? Math.round((Date.now() - priceCacheTimestamp) / 1000 / 60) : null,
      exchangeRate: exchangeRate || DEFAULT_USD_MYR,
      source: 'cardkingdom_via_mtgjson',
      timestamp: new Date().toISOString(),
    }, {
      headers: { 'Cache-Control': 'public, s-maxage=3600' }
    })
  }

  // Look up in price cache
  let result = null
  if (scryfallId && priceCache) {
    result = priceCache.get(scryfallId.toLowerCase())
  }

  // If found in cache, return CardKingdom prices
  if (result) {
    const usdMyr = rate || exchangeRate || DEFAULT_USD_MYR
    return NextResponse.json({
      ckd_usd_price: result.n,
      ckd_foil_price: result.f,
      ckd_buy_price: result.b,
      myr_price_2_5: calculateMYR(result.n, usdMyr * 2.5),
      myr_price_2_8: calculateMYR(result.n, usdMyr * 2.8),
      myr_price_3_0: calculateMYR(result.n, usdMyr * 3.0),
      myr_foil_price_2_5: calculateMYR(result.f, usdMyr * 2.5),
      myr_foil_price_2_8: calculateMYR(result.f, usdMyr * 2.8),
      myr_foil_price_3_0: calculateMYR(result.f, usdMyr * 3.0),
      usd_myr_rate: usdMyr,
      source: 'cardkingdom_via_mtgjson',
      lastUpdated: new Date(priceCacheTimestamp).toISOString(),
    }, {
      headers: { 'Cache-Control': 'public, s-maxage=3600' }
    })
  }

  // Fallback to Scryfall
  const fallback = await scryfallFallback(scryfallId, cardName)
  if (fallback) {
    const usdMyr = rate || exchangeRate || DEFAULT_USD_MYR
    return NextResponse.json({
      ...fallback,
      myr_price_2_5: calculateMYR(fallback.ckd_usd_price, usdMyr * 2.5),
      myr_price_2_8: calculateMYR(fallback.ckd_usd_price, usdMyr * 2.8),
      myr_price_3_0: calculateMYR(fallback.ckd_usd_price, usdMyr * 3.0),
      usd_myr_rate: usdMyr,
    }, {
      headers: { 'Cache-Control': 'public, s-maxage=3600' }
    })
  }

  return NextResponse.json(
    { error: 'Card not found', ckd_usd_price: null },
    { status: 404 }
  )
}