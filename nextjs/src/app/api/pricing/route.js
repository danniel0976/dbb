import { NextResponse } from 'next/server'

// ============================================================================
// MTGJSON AllPricesToday price cache
// Fetches real CardKingdom prices (not Scryfall/TCGPlayer)
// Caches for 24 hours, refreshes on demand or via ?refresh=true
//
// MTGJSON format (as of v5.3):
//   { "data": { "<uuid>": { "paper": { "cardkingdom": {
//     "retail": { "normal": { "2026-07-07": 7.99 }, "foil": { "2026-07-07": 9.99 } },
//     "buylist": { "normal": { "2026-07-07": 2.0 }, "foil": { "2026-07-07": 4.0 } },
//     "currency": "USD"
//   }}}}}
//   Prices are nested under date keys — we take the latest date.
// ============================================================================

// Force Node.js runtime — needed for streaming and large JSON parsing
export const runtime = 'nodejs'
export const maxDuration = 60

const MTGJSON_URL = 'https://mtgjson.com/api/v5/AllPricesToday.json'
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000 // 24 hours
const EXCHANGE_RATE_API = 'https://open.er-api.com/v6/latest/USD'
const DEFAULT_USD_MYR = 4.70

let priceCache = null          // Map<scryfallId_lowercase, priceObj>
let priceCacheTimestamp = 0    // ms since epoch
let exchangeRate = DEFAULT_USD_MYR
let exchangeRateTimestamp = 0

// ============================================================================
// Extract the latest price from a date-keyed object like {"2026-07-07": 7.99, "2026-07-06": 7.50}
// ============================================================================

function getLatestPrice(dateObj) {
  if (!dateObj || typeof dateObj !== 'object') return null
  const dates = Object.keys(dateObj).sort()
  if (dates.length === 0) return null
  const val = dateObj[dates[dates.length - 1]]
  return typeof val === 'number' ? val : parseFloat(val)
}

// ============================================================================
// Extract CardKingdom prices from the MTGJSON card entry
// ============================================================================

function extractCKPrices(uuid, entry) {
  const paper = entry.paper
  if (!paper || typeof paper !== 'object') return null

  const ck = paper.cardkingdom || paper.cardKingdom || paper.CardKingdom
  if (!ck || typeof ck !== 'object') return null

  const retail = ck.retail || ck.Retail || {}
  const buylist = ck.buylist || ck.Buylist || {}

  // Normal (non-foil) retail price
  const normalRetail = getLatestPrice(retail.normal || retail.Normal)
  // Foil retail price
  const foilRetail = getLatestPrice(retail.foil || retail.Foil)
  // Normal buylist price
  const normalBuylist = getLatestPrice(buylist.normal || buylist.Normal)
  // Foil buylist price
  const foilBuylist = getLatestPrice(buylist.foil || buylist.Foil)

  // Need at least one retail price
  if (normalRetail === null && foilRetail === null) return null

  return {
    ckd_usd_price: normalRetail,
    ckd_foil_price: foilRetail,
    ckd_buy_price: normalBuylist,
    ckd_buy_price_foil: foilBuylist,
    source: 'cardkingdom_via_mtgjson',
  }
}

// ============================================================================
// Fetch and parse MTGJSON AllPricesToday
// Uses streaming JSON parse to handle the large file (~200MB uncompressed)
// ============================================================================

async function fetchMTGJSONPrices() {
  console.log('[Pricing API] Fetching MTGJSON AllPricesToday...')

  const response = await fetch(MTGJSON_URL, {
    headers: { 'User-Agent': 'DansBizarreBazaar/1.0', 'Accept': 'application/json' },
  })

  if (!response.ok) {
    throw new Error(`MTGJSON responded with ${response.status}`)
  }

  // Parse the full JSON — AllPricesToday is ~200MB uncompressed
  // but the uncompressed endpoint streams fine in Node.js serverless
  console.log('[Pricing API] Parsing MTGJSON response...')
  const data = await response.json()

  if (!data || !data.data) {
    throw new Error('MTGJSON response missing data field')
  }

  // Build lookup map: scryfallId (lowercase) -> CK price object
  const lookup = new Map()
  let ckCount = 0

  for (const [uuid, priceData] of Object.entries(data.data)) {
    if (!priceData || typeof priceData !== 'object') continue

    const ckPrices = extractCKPrices(uuid, priceData)
    if (ckPrices) {
      lookup.set(uuid.toLowerCase(), ckPrices)
      ckCount++
    }
  }

  console.log(`[Pricing API] Loaded ${ckCount} CardKingdom prices from MTGJSON`)
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
// Scryfall fallback for cards not in MTGJSON
// ============================================================================

async function scryfallFallback(scryfallId, cardName, setName, collectorNumber) {
  let scryfallUrl
  if (scryfallId) {
    scryfallUrl = `https://api.scryfall.com/cards/${scryfallId}`
  } else if (setName && collectorNumber) {
    scryfallUrl = `https://api.scryfall.com/cards/named?set=${encodeURIComponent(setName)}&number=${encodeURIComponent(collectorNumber)}`
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
  const setName = searchParams.get('set')
  const collectorNumber = searchParams.get('cn')
  const forceRefresh = searchParams.get('refresh') === 'true'
  const rate = parseFloat(searchParams.get('rate')) || exchangeRate || DEFAULT_USD_MYR

  // Ensure price cache is loaded
  const now = Date.now()
  if (!priceCache || forceRefresh || (now - priceCacheTimestamp) > CACHE_DURATION_MS) {
    try {
      priceCache = await fetchMTGJSONPrices()
      priceCacheTimestamp = Date.now()
      // Also refresh exchange rate if stale (>24h)
      if (!exchangeRateTimestamp || (now - exchangeRateTimestamp) > CACHE_DURATION_MS) {
        await fetchExchangeRate()
      }
    } catch (error) {
      console.error('[Pricing API] Failed to load MTGJSON prices:', error.message)
      // If we have a stale cache, use it
      if (!priceCache) {
        return NextResponse.json(
          { error: 'Price data unavailable', details: error.message },
          { status: 503 }
        )
      }
    }
  }

  // If no lookup params, return cache status
  if (!scryfallId && !cardName && !setName) {
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

  // Look up in MTGJSON price cache
  let result = null

  if (scryfallId && priceCache) {
    result = priceCache.get(scryfallId.toLowerCase())
  }

  // If found in MTGJSON cache, return CardKingdom prices
  if (result) {
    const usdMyr = rate || exchangeRate || DEFAULT_USD_MYR
    return NextResponse.json({
      ckd_usd_price: result.ckd_usd_price,
      ckd_foil_price: result.ckd_foil_price,
      ckd_buy_price: result.ckd_buy_price,
      myr_price_2_5: calculateMYR(result.ckd_usd_price, usdMyr * 2.5),
      myr_price_2_8: calculateMYR(result.ckd_usd_price, usdMyr * 2.8),
      myr_price_3_0: calculateMYR(result.ckd_usd_price, usdMyr * 3.0),
      myr_foil_price_2_5: calculateMYR(result.ckd_foil_price, usdMyr * 2.5),
      myr_foil_price_2_8: calculateMYR(result.ckd_foil_price, usdMyr * 2.8),
      myr_foil_price_3_0: calculateMYR(result.ckd_foil_price, usdMyr * 3.0),
      usd_myr_rate: usdMyr,
      source: 'cardkingdom_via_mtgjson',
      lastUpdated: new Date(priceCacheTimestamp).toISOString(),
    }, {
      headers: { 'Cache-Control': 'public, s-maxage=3600' }
    })
  }

  // Fallback to Scryfall if not in MTGJSON
  const fallback = await scryfallFallback(scryfallId, cardName, setName, collectorNumber)
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

  // Not found anywhere
  return NextResponse.json(
    { error: 'Card not found', ckd_usd_price: null },
    { status: 404 }
  )
}