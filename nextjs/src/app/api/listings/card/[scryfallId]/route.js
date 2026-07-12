import { NextResponse } from 'next/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

const UNDEF_COLUMN = '42703'

function makeServiceClient() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

// GET /api/listings/card/[scryfallId]
// Returns all active (non-expired) listings for a specific scryfall_id (bazaar detail / seller selection)
export async function GET(request, { params }) {
  const { scryfallId } = await params

  if (!scryfallId) {
    return NextResponse.json({ listings: [] })
  }

  const sc = makeServiceClient()

  const runQuery = async (withExpiry) => {
    let q = sc
      .from('listings')
      .select(`
        id, user_id, multiplier, status, created_at, expires_at,
        library_cards!inner(
          id, scryfall_id, foil, condition, quantity,
          card_index!inner(
            name, set_code, set_name, collector_number, rarity, type_line, colors, cmc, mana_cost
          )
        )
      `)
      .eq('status', 'active')
      .eq('library_cards.scryfall_id', scryfallId)
      .order('created_at', { ascending: true })

    if (withExpiry) q = q.gt('expires_at', new Date().toISOString())

    return q
  }

  try {
    let result = await runQuery(true)
    if (result.error?.code === UNDEF_COLUMN) {
      result = await runQuery(false)
    }
    if (result.error) throw result.error

    const userIds = [...new Set((result.data || []).map(l => l.user_id))]
    let sellerMap = {}
    if (userIds.length > 0) {
      const { data: profiles } = await sc
        .from('profiles')
        .select('id, display_name')
        .in('id', userIds)
      for (const p of profiles || []) sellerMap[p.id] = p.display_name
    }

    const listings = (result.data || []).map(l => ({
      ...l,
      seller_name: sellerMap[l.user_id] || null,
    }))

    return NextResponse.json({ listings })
  } catch (err) {
    console.error('[GET /api/listings/card]', err?.message || err)
    return NextResponse.json({ listings: [] })
  }
}
