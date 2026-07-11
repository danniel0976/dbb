import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabaseServer'
import { ensurePriceCache, lookupEntry } from '@/lib/pricingCache'

// GET /api/profile/value
// Returns the total CKD USD collection value for the authenticated user.
// Lazy/non-blocking — called client-side after page render.
export async function GET() {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Fetch all library cards (scryfall_id, foil, quantity)
  const { data: cards, error: cardsError } = await supabase
    .from('library_cards')
    .select('scryfall_id, foil, quantity')
    .eq('user_id', user.id)

  if (cardsError) return NextResponse.json({ error: cardsError.message }, { status: 500 })
  if (!cards || cards.length === 0) {
    return NextResponse.json({ total_usd: 0, total_myr: 0, priced_count: 0, total_count: 0 })
  }

  try {
    await ensurePriceCache()
  } catch (err) {
    return NextResponse.json({ error: 'Price data unavailable' }, { status: 503 })
  }

  let totalUsd = 0
  let pricedCount = 0

  for (const card of cards) {
    const entry = lookupEntry(card.scryfall_id)
    if (!entry) continue

    let ckdUsd = null
    if (card.foil === 'foil') ckdUsd = entry.f ?? null
    else if (card.foil === 'etched') ckdUsd = entry.e ?? null
    else ckdUsd = entry.n ?? null

    if (ckdUsd != null) {
      totalUsd += ckdUsd * (card.quantity || 1)
      pricedCount++
    }
  }

  const totalUsdRounded = Math.round(totalUsd * 100) / 100
  return NextResponse.json({
    total_usd: totalUsdRounded,
    total_myr: Math.round(totalUsdRounded * 3.0 * 100) / 100,
    priced_count: pricedCount,
    total_count: cards.length,
  })
}
