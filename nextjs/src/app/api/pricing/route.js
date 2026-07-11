import { NextResponse } from 'next/server'
import { ensurePriceCache, sellPrice, getCacheStats } from '@/lib/pricingCache'

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

export async function GET(request) {
  const { searchParams } = new URL(request.url)
  const scryfallId = searchParams.get('scryfallId')
  const cardName = searchParams.get('name')
  const forceRefresh = searchParams.get('refresh') === 'true'

  let cacheData
  try {
    cacheData = await ensurePriceCache(forceRefresh)
  } catch (error) {
    console.error('[Pricing API] Failed to load price cache:', error.message)
    return NextResponse.json(
      { error: 'Price data unavailable', details: error.message },
      { status: 503 }
    )
  }

  const { priceCache, namePriceCache, cacheTimestamp } = cacheData

  // If no lookup params, return cache status
  if (!scryfallId && !cardName) {
    const stats = getCacheStats()
    return NextResponse.json({
      status: 'ok',
      ...stats,
      source: 'cardkingdom_via_mtgjson',
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
    result = namePriceCache.get(cardName.toLowerCase())
    if (result) source = 'cardkingdom_via_mtgjson_name'
  }

  const lastUpdated = cacheTimestamp ? new Date(cacheTimestamp).toISOString() : null

  if (result) {
    return NextResponse.json({
      ckd_usd_price: result.n ?? null,
      ckd_foil_price: result.f ?? null,
      ckd_etched_price: result.e ?? null,
      ckd_buy_price: result.b ?? null,
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
      lastUpdated,
    }, {
      headers: { 'Cache-Control': 'public, s-maxage=3600' }
    })
  }

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
