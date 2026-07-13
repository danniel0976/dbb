import { NextResponse } from 'next/server'
import { createClient as createAuthClient } from '@/lib/supabaseServer'
import { createClient as createServiceClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

const UNDEF_TABLE = '42P01'

function makeServiceClient() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

// GET /api/claim-sales/[id] — single claim sale detail
export async function GET(request, { params }) {
  const { id } = await params
  const authClient = await createAuthClient()
  const { data: { user } } = await authClient.auth.getUser()
  const sc = makeServiceClient()

  try {
    // Fetch claim sale
    const { data: claimSale, error: csError } = await sc
      .from('claim_sales')
      .select(`
        id, title, description, set_code, user_id, duration_hours,
        expires_at, status, delivery_option, created_at
      `)
      .eq('id', id)
      .maybeSingle()

    if (csError) {
      if (csError.code === UNDEF_TABLE) {
        return NextResponse.json({ error: 'Claim sales not yet available' }, { status: 503 })
      }
      throw csError
    }

    if (!claimSale) {
      return NextResponse.json({ error: 'Claim sale not found' }, { status: 404 })
    }

    // Get seller display name
    const { data: seller } = await sc
      .from('profiles')
      .select('display_name')
      .eq('id', claimSale.user_id)
      .maybeSingle()

    // Get listings linked to this claim sale with card details
    let listings = []
    try {
      const { data: listingData, error: listErr } = await sc
        .from('listings')
        .select(`
          id, multiplier, status, created_at, expires_at, quantity,
          library_cards!inner(
            id, scryfall_id, foil, condition, quantity,
            card_index!inner(
              name, set_code, set_name, collector_number, rarity, type_line, colors, cmc
            )
          )
        `)
        .eq('claim_sale_id', id)

      if (!listErr && listingData) {
        listings = listingData
      }
    } catch {
      // claim_sale_id column might not exist
    }

    // Check if current user follows this claim sale
    let isFollowing = false
    if (user) {
      try {
        const { data: followRow } = await sc
          .from('follows')
          .select('id')
          .eq('follower_id', user.id)
          .eq('claim_sale_id', id)
          .maybeSingle()
        isFollowing = !!followRow
      } catch {
        // follows table might not exist
      }
    }

    // Get follower count
    let followerCount = 0
    try {
      const { count } = await sc
        .from('follows')
        .select('id', { count: 'exact', head: true })
        .eq('claim_sale_id', id)
      followerCount = count || 0
    } catch {
      // follows table might not exist
    }

    return NextResponse.json({
      ...claimSale,
      seller_name: seller?.display_name || null,
      is_owner: user?.id === claimSale.user_id,
      listings,
      is_following: isFollowing,
      follower_count: followerCount,
    })
  } catch (err) {
    console.error('[GET /api/claim-sales/[id]]', err?.message || err)
    return NextResponse.json({ error: 'Failed to load claim sale' }, { status: 500 })
  }
}