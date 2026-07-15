import { NextResponse } from 'next/server'
import { createClient as createAuthClient } from '@/lib/supabaseServer'
import { ensurePriceCache, lookupPrice, sellPrice } from '@/lib/pricingCache'

export const runtime = 'nodejs'

const TABLE_NOT_EXIST = '42P01'

export async function GET() {
  const authClient = await createAuthClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    await ensurePriceCache()
  } catch {
    // price cache unavailable — proceed, prices will be null
  }

  try {
    const { data, error } = await authClient
      .from('cart_items')
      .select(`
        id, created_at,
        listings(
          id, user_id, multiplier, quantity, status, expires_at,
          library_cards(
            id, scryfall_id, foil, condition,
            card_index(name, set_code, set_name, collector_number, rarity, type_line)
          )
        )
      `)
      .eq('user_id', user.id)
      .order('created_at', { ascending: true })

    if (error) {
      if (error.code === TABLE_NOT_EXIST) return NextResponse.json({ items: [] })
      throw error
    }

    // Collect seller ids for profile lookup
    const sellerIds = [...new Set(
      (data || [])
        .map(ci => ci.listings?.user_id)
        .filter(Boolean)
    )]

    let sellerMap = {}
    if (sellerIds.length > 0) {
      const { data: profiles } = await authClient
        .from('profiles')
        .select('id, display_name')
        .in('id', sellerIds)
      for (const p of profiles || []) sellerMap[p.id] = p.display_name
    }

    const now = new Date()
    const items = (data || []).map(ci => {
      const listing = ci.listings
      const lc = listing?.library_cards
      const notExpired = !listing?.expires_at || new Date(listing.expires_at) > now
      const isAvailable = listing?.status === 'active' && notExpired && Number(listing?.quantity) > 0
      const ckdUsd = (lc?.scryfall_id && lc?.foil)
        ? lookupPrice(lc.scryfall_id, lc.foil)
        : null
      const myrPrice = (isAvailable && ckdUsd != null)
        ? sellPrice(ckdUsd, Number(listing.multiplier))
        : null
      return {
        id: ci.id,
        created_at: ci.created_at,
        listing_id: listing?.id || null,
        listing_status: listing?.status || null,
        is_available: isAvailable,
        multiplier: listing?.multiplier ?? null,
        quantity: listing?.quantity ?? null,
        seller_id: listing?.user_id || null,
        seller_name: listing?.user_id ? (sellerMap[listing.user_id] || null) : null,
        library_card: lc ? {
          id: lc.id,
          scryfall_id: lc.scryfall_id,
          foil: lc.foil,
          condition: lc.condition,
          card_index: lc.card_index,
        } : null,
        ckd_usd: ckdUsd,
        myr_price: myrPrice,
      }
    })

    return NextResponse.json({ items })
  } catch (err) {
    if (err?.code === TABLE_NOT_EXIST) return NextResponse.json({ items: [] })
    console.error('[GET /api/cart]', err?.message || err)
    return NextResponse.json({ items: [] })
  }
}

export async function POST(request) {
  const authClient = await createAuthClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { listing_id } = body
  if (!listing_id) return NextResponse.json({ error: 'listing_id required' }, { status: 400 })

  // Verify listing exists, is active, and doesn't belong to the current user
  const { data: listing, error: listingErr } = await authClient
    .from('listings')
    .select('id, user_id, status, expires_at')
    .eq('id', listing_id)
    .maybeSingle()

  if (listingErr || !listing) {
    return NextResponse.json({ error: 'Listing not found' }, { status: 404 })
  }

  if (listing.user_id === user.id) {
    return NextResponse.json({ error: 'Cannot add your own listing to cart' }, { status: 403 })
  }

  if (listing.status !== 'active') {
    return NextResponse.json({ error: 'Listing is no longer available' }, { status: 409 })
  }

  // Check expiry if column exists
  if (listing.expires_at && new Date(listing.expires_at) <= new Date()) {
    return NextResponse.json({ error: 'Listing has expired' }, { status: 409 })
  }

  try {
    const { data, error } = await authClient
      .from('cart_items')
      .insert({ user_id: user.id, listing_id })
      .select()
      .single()

    if (error) {
      if (error.code === '23505') {
        return NextResponse.json({ message: 'Already in cart', already: true })
      }
      if (error.code === TABLE_NOT_EXIST) {
        return NextResponse.json({ error: 'Cart not yet available' }, { status: 503 })
      }
      throw error
    }

    return NextResponse.json({ item: data }, { status: 201 })
  } catch (err) {
    console.error('[POST /api/cart]', err?.message || err)
    return NextResponse.json({ error: err?.message || 'Failed to add to cart' }, { status: 500 })
  }
}
