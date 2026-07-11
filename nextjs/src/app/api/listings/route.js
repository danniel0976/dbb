import { NextResponse } from 'next/server'
import { createClient as createAuthClient } from '@/lib/supabaseServer'
import { createClient as createServiceClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

function makeServiceClient() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

// GET /api/listings
// ?library_card_id=<uuid>  → return listing for that card (owner or null)
// ?status=active&page=N&sort=X&search=Y&...  → bazaar browsing (service role, public)
export async function GET(request) {
  const { searchParams } = new URL(request.url)
  const library_card_id = searchParams.get('library_card_id')

  // Single-card listing lookup (for CardDetailModal)
  if (library_card_id) {
    const authClient = await createAuthClient()
    const { data: { user } } = await authClient.auth.getUser()
    if (!user) return NextResponse.json({ listing: null })

    try {
      const { data, error } = await authClient
        .from('listings')
        .select('id, multiplier, status, created_at')
        .eq('library_card_id', library_card_id)
        .eq('user_id', user.id)
        .maybeSingle()

      if (error) throw error
      return NextResponse.json({ listing: data || null })
    } catch {
      return NextResponse.json({ listing: null })
    }
  }

  // Bazaar browsing — use service role so we can join across RLS-protected tables
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10))
  const PAGE_SIZE = 24
  const sort = searchParams.get('sort') || 'newest'
  const search = (searchParams.get('search') || '').trim()
  const setCode = searchParams.get('setCode') || null
  const isFoil = searchParams.get('isFoil') // 'true'/'false'/null
  const rarities = (searchParams.get('rarities') || '')
    .split(',').filter(Boolean)
  const colors = (searchParams.get('colors') || '')
    .split(',').filter(Boolean)
  const cardType = searchParams.get('cardType') || null

  const sc = makeServiceClient()

  try {
    let query = sc
      .from('listings')
      .select(`
        id, user_id, multiplier, status, created_at,
        library_cards!inner(
          id, scryfall_id, foil, condition, quantity,
          card_index!inner(
            name, set_code, set_name, collector_number, rarity, type_line, colors, cmc
          )
        )
      `, { count: 'exact' })
      .eq('status', 'active')

    // Text search on card name
    if (search) {
      query = query.ilike('library_cards.card_index.name', `%${search}%`)
    }

    // Set filter
    if (setCode) {
      query = query.eq('library_cards.card_index.set_code', setCode)
    }

    // Rarity filter
    if (rarities.length > 0) {
      query = query.in('library_cards.card_index.rarity', rarities)
    }

    // Foil filter
    if (isFoil === 'true') {
      query = query.neq('library_cards.foil', 'normal')
    } else if (isFoil === 'false') {
      query = query.eq('library_cards.foil', 'normal')
    }

    // Color filter (overlaps — card must contain at least one of the selected colors)
    if (colors.length > 0) {
      query = query.overlaps('library_cards.card_index.colors', colors)
    }

    // Type filter
    if (cardType) {
      query = query.ilike('library_cards.card_index.type_line', `%${cardType}%`)
    }

    // Sort
    if (sort === 'name_az') {
      query = query.order('library_cards.card_index.name', { ascending: true })
    } else if (sort === 'rarity') {
      query = query.order('library_cards.card_index.rarity', { ascending: false })
    } else if (sort === 'price_high') {
      query = query.order('multiplier', { ascending: false })
    } else if (sort === 'price_low') {
      query = query.order('multiplier', { ascending: true })
    } else {
      // newest
      query = query.order('created_at', { ascending: false })
    }

    const from = (page - 1) * PAGE_SIZE
    const to = from + PAGE_SIZE - 1
    query = query.range(from, to)

    const { data, error, count } = await query
    if (error) throw error

    // Fetch seller display names
    const userIds = [...new Set((data || []).map(l => l.user_id))]
    let sellerMap = {}
    if (userIds.length > 0) {
      const { data: profiles } = await sc
        .from('profiles')
        .select('id, display_name')
        .in('id', userIds)
      for (const p of profiles || []) sellerMap[p.id] = p.display_name
    }

    const listings = (data || []).map(l => ({
      ...l,
      seller_name: sellerMap[l.user_id] || null,
    }))

    const total = count || 0
    return NextResponse.json({
      listings,
      total,
      hasMore: from + PAGE_SIZE < total,
      page,
    })
  } catch (err) {
    console.error('[GET /api/listings]', err?.message || err)
    return NextResponse.json({ listings: [], total: 0, hasMore: false, page: 1 })
  }
}

// POST /api/listings
// Body: { library_card_id, multiplier }  OR  { items: [{library_card_id, multiplier}] }
export async function POST(request) {
  const authClient = await createAuthClient()
  const { data: { user }, error: authError } = await authClient.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Normalise to array
  const items = body.items
    ? body.items
    : [{ library_card_id: body.library_card_id, multiplier: body.multiplier }]

  const valid = [2.5, 2.8, 3.0]
  for (const item of items) {
    if (!item.library_card_id) {
      return NextResponse.json({ error: 'library_card_id required' }, { status: 400 })
    }
    if (!valid.includes(Number(item.multiplier))) {
      return NextResponse.json({ error: 'multiplier must be 2.5, 2.8 or 3.0' }, { status: 400 })
    }
  }

  // Verify all library cards belong to this user
  const libraryCardIds = items.map(i => i.library_card_id)
  const { data: ownedCards, error: ownErr } = await authClient
    .from('library_cards')
    .select('id')
    .in('id', libraryCardIds)
    .eq('user_id', user.id)

  if (ownErr) {
    return NextResponse.json({ error: 'Failed to verify ownership' }, { status: 500 })
  }

  const ownedIds = new Set((ownedCards || []).map(c => c.id))
  const unowned = libraryCardIds.filter(id => !ownedIds.has(id))
  if (unowned.length > 0) {
    return NextResponse.json({ error: 'One or more cards not found in your library' }, { status: 403 })
  }

  // Upsert listings (handles already-listed cards gracefully)
  const rows = items.map(item => ({
    user_id: user.id,
    library_card_id: item.library_card_id,
    multiplier: Number(item.multiplier),
    status: 'active',
  }))

  const { data, error } = await authClient
    .from('listings')
    .upsert(rows, { onConflict: 'library_card_id' })
    .select()

  if (error) {
    console.error('[POST /api/listings]', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ listings: data }, { status: 201 })
}
