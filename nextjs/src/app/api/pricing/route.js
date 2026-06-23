import { NextResponse } from 'next/server'

// Scryfall API - Free, includes USD market prices
// No API key required, ~100 requests/day allowed for anonymous users
// Docs: https://scryfall.com/docs/api

export async function GET(request) {
  const { searchParams } = new URL(request.url)
  const scryfallId = searchParams.get('scryfallId')
  const cardName = searchParams.get('name')
  const setName = searchParams.get('set')
  const collectorNumber = searchParams.get('cn')

  // Build Scryfall API URL
  let scryfallUrl
  if (scryfallId) {
    scryfallUrl = `https://api.scryfall.com/cards/${scryfallId}`
  } else if (setName && collectorNumber) {
    scryfallUrl = `https://api.scryfall.com/cards/named?set=${encodeURIComponent(setName)}&number=${encodeURIComponent(collectorNumber)}`
  } else if (cardName) {
    scryfallUrl = `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(cardName)}`
  } else {
    return NextResponse.json(
      { error: 'Missing scryfallId or set+cn or name parameter' },
      { status: 400 }
    )
  }

  try {
    const response = await fetch(scryfallUrl, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'DansBizarreBazaar/1.0',
      },
      next: { revalidate: 86400 } // Cache for 24 hours
    })

    if (!response.ok) {
      if (response.status === 404) {
        return NextResponse.json(
          { error: 'Card not found', ckd_usd_price: null },
          { status: 404 }
        )
      }
      if (response.status === 429) {
        return NextResponse.json(
          { error: 'Rate limited by Scryfall', ckd_usd_price: null },
          { status: 429 }
        )
      }
      throw new Error(`Scryfall responded with ${response.status}`)
    }

    const card = await response.json()
    
    // Extract prices from Scryfall
    // Note: These are TCGPlayer/market prices, not specifically CardKingdom
    // CardKingdom doesn't have a public API
    const prices = card.prices || {}
    
    const result = {
      ckd_usd_price: prices.usd ? parseFloat(prices.usd) : null,
      ckd_foil_price: prices.usd_foil ? parseFloat(prices.usd_foil) : null,
      ckd_buy_price: null, // Scryfall doesn't provide buylist prices
      source: 'scryfall',
      note: 'USD prices from Scryfall (market average, includes TCGPlayer). CardKingdom API not publicly available.',
      lastUpdated: card.updated_at || new Date().toISOString(),
    }

    return NextResponse.json(result)
  } catch (error) {
    console.error('[Pricing API] Error:', error.message)
    return NextResponse.json(
      { error: 'Failed to fetch pricing', details: error.message },
      { status: 500 }
    )
  }
}
