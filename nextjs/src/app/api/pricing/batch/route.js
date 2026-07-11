import { NextResponse } from 'next/server'
import { ensurePriceCache, lookupEntry, sellPrice, getCacheStats } from '@/lib/pricingCache'

export const runtime = 'nodejs'
export const maxDuration = 30

// POST /api/pricing/batch
// Body: { items: [{scryfall_id, foil}] }  (cap 5000)
// Returns: { prices: { "<id>:<foil>": { ckd_usd, myr_2_5, myr_2_8, myr_3_0 } }, cache_age_min }
//
// Multiplier math (reusable for Phase 8 bazaar listings):
//   MYR price = CKD USD × multiplier, rounded to nearest RM 0.50
//   Multipliers: 2.5 / 2.8 / 3.0 (Dan's selling tiers)
export async function POST(request) {
  try {
    const body = await request.json()
    const items = body?.items

    if (!Array.isArray(items)) {
      return NextResponse.json({ error: 'items must be an array' }, { status: 400 })
    }
    if (items.length > 5000) {
      return NextResponse.json({ error: 'Maximum 5000 items per request' }, { status: 400 })
    }

    try {
      await ensurePriceCache()
    } catch (err) {
      console.error('[Pricing batch] Cache load failed:', err.message)
      return NextResponse.json({ error: 'Price data unavailable', details: err.message }, { status: 503 })
    }

    const prices = {}
    for (const item of items) {
      const { scryfall_id, foil = 'normal' } = item
      if (!scryfall_id) continue

      const key = `${scryfall_id}:${foil}`
      const entry = lookupEntry(scryfall_id)

      let ckdUsd = null
      if (entry) {
        if (foil === 'foil') ckdUsd = entry.f ?? null
        else if (foil === 'etched') ckdUsd = entry.e ?? null
        else ckdUsd = entry.n ?? null
      }

      prices[key] = {
        ckd_usd: ckdUsd,
        myr_2_5: sellPrice(ckdUsd, 2.5),
        myr_2_8: sellPrice(ckdUsd, 2.8),
        myr_3_0: sellPrice(ckdUsd, 3.0),
      }
    }

    const stats = getCacheStats()
    return NextResponse.json({ prices, cache_age_min: stats.cacheAgeMin })
  } catch (err) {
    console.error('[Pricing batch] Unexpected error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
