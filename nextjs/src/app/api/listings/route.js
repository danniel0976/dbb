import { NextResponse } from 'next/server'
import { createClient as createAuthClient } from '@/lib/supabaseServer'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { requireCompleteMerchantProfile } from '@/lib/merchantProfile'

export const runtime = 'nodejs'

const VALID_MULTIPLIERS = [2.5, 2.8, 3.0]
const VALID_DURATIONS = [1, 3, 6, 12, 24]
const MAX_DURATION_HOURS = 24
// Postgres "undefined column" error — expires_at column not yet migrated
const UNDEF_COLUMN = '42703'

function makeServiceClient() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

// GET /api/listings
// ?library_card_id=<uuid>  → return listing for that card (owner or null)
// ?status=active&page=N&...  → bazaar browsing (service role, public)
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
        .select('id, multiplier, status, created_at, expires_at, quantity')
        .eq('library_card_id', library_card_id)
        .eq('user_id', user.id)
        .maybeSingle()

      if (error) throw error
      return NextResponse.json({ listing: data || null })
    } catch (err) {
      // Fallback without expires_at AND quantity if either column doesn't exist yet
      if (err?.code !== UNDEF_COLUMN) {
        return NextResponse.json({ listing: null })
      }
      try {
        const authClient2 = await createAuthClient()
        const { data, error: err2 } = await authClient2
          .from('listings')
          .select('id, multiplier, status, created_at')
          .eq('library_card_id', library_card_id)
          .eq('user_id', user.id)
          .maybeSingle()
        if (err2) throw err2
        return NextResponse.json({ listing: data || null })
      } catch {
        return NextResponse.json({ listing: null })
      }
    }
  }

  // Bazaar browsing — service role so we can join across RLS-protected tables
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10))
  const PAGE_SIZE = 24
  const sort = searchParams.get('sort') || 'newest'
  const search = (searchParams.get('search') || '').trim()
  const setCode = searchParams.get('setCode') || null
  const isFoil = searchParams.get('isFoil')
  const rarities = (searchParams.get('rarities') || '').split(',').filter(Boolean)
  const colors = (searchParams.get('colors') || '').split(',').filter(Boolean)
  const cardType = searchParams.get('cardType') || null

  const sc = makeServiceClient()

  const buildQuery = (withExpiry) => {
    const selectCols = withExpiry
      ? `id, user_id, multiplier, status, created_at, expires_at, quantity,
        library_cards!inner(
          id, scryfall_id, foil, condition, quantity,
          card_index!inner(
            name, set_code, set_name, collector_number, rarity, type_line, colors, cmc, image_uris
          )
        )`
      : `id, user_id, multiplier, status, created_at,
        library_cards!inner(
          id, scryfall_id, foil, condition, quantity,
          card_index!inner(
            name, set_code, set_name, collector_number, rarity, type_line, colors, cmc, image_uris
          )
        )`
    let q = sc
      .from('listings')
      .select(selectCols, { count: 'exact' })
      .eq('status', 'active')

    if (withExpiry) q = q.gt('expires_at', new Date().toISOString())

    if (search) q = q.ilike('library_cards.card_index.name', `%${search}%`)
    if (setCode) q = q.eq('library_cards.card_index.set_code', setCode)
    if (rarities.length > 0) q = q.in('library_cards.card_index.rarity', rarities)
    if (isFoil === 'true') q = q.neq('library_cards.foil', 'normal')
    else if (isFoil === 'false') q = q.eq('library_cards.foil', 'normal')
    if (colors.length > 0) q = q.overlaps('library_cards.card_index.colors', colors)
    if (cardType) q = q.ilike('library_cards.card_index.type_line', `%${cardType}%`)

    if (sort === 'name_az') q = q.order('library_cards.card_index.name', { ascending: true })
    else if (sort === 'rarity') q = q.order('library_cards.card_index.rarity', { ascending: false })
    else if (sort === 'price_high') q = q.order('multiplier', { ascending: false })
    else if (sort === 'price_low') q = q.order('multiplier', { ascending: true })
    else q = q.order('created_at', { ascending: false })

    const from = (page - 1) * PAGE_SIZE
    q = q.range(from, from + PAGE_SIZE - 1)
    return q
  }

  try {
    let result = await buildQuery(true)
    if (result.error?.code === UNDEF_COLUMN) {
      result = await buildQuery(false)
    }
    const { data, error, count } = result
    if (error) throw error

    // Bazaar tiles deliberately do not expose a seller identity. Count the
    // distinct sellers offering each exact printing; identities remain in the
    // card-detail seller selector.
    const scryfallIds = [...new Set((data || [])
      .map(l => l.library_cards?.scryfall_id)
      .filter(Boolean))]
    const sellersByCard = new Map()
    if (scryfallIds.length > 0) {
      const { data: sellerRows } = await sc
        .from('listings')
        .select('user_id, library_cards!inner(scryfall_id)')
        .eq('status', 'active')
        .gt('expires_at', new Date().toISOString())
        .in('library_cards.scryfall_id', scryfallIds)

      for (const row of sellerRows || []) {
        const cardId = row.library_cards?.scryfall_id
        if (!cardId) continue
        if (!sellersByCard.has(cardId)) sellersByCard.set(cardId, new Set())
        sellersByCard.get(cardId).add(row.user_id)
      }
    }

    const listings = (data || []).map(l => ({
      ...l,
      seller_count: sellersByCard.get(l.library_cards?.scryfall_id)?.size || 1,
    }))

    const total = count || 0
    const from = (page - 1) * PAGE_SIZE
    return NextResponse.json({ listings, total, hasMore: from + PAGE_SIZE < total, page })
  } catch (err) {
    console.error('[GET /api/listings]', err?.message || err)
    return NextResponse.json({ listings: [], total: 0, hasMore: false, page: 1 })
  }
}

// POST /api/listings
// Body: { library_card_id, multiplier, duration_hours }
//    OR { items: [{library_card_id, multiplier, duration_hours}], duration_hours }
// duration_hours is REQUIRED (1 | 3 | 6 | 12 | 24); max 24h enforced server-side
export async function POST(request) {
  const authClient = await createAuthClient()
  const { data: { user }, error: authError } = await authClient.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const merchantGate = await requireCompleteMerchantProfile(authClient, user.id)
  if (merchantGate) {
    return NextResponse.json({ error: merchantGate.error, code: merchantGate.code }, { status: merchantGate.status })
  }

  let body
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Normalise to array; top-level duration_hours applies to all items if not per-item
  const topDuration = body.duration_hours
  const items = body.items
    ? body.items.map(i => ({ ...i, duration_hours: i.duration_hours ?? topDuration }))
    : [{ library_card_id: body.library_card_id, multiplier: body.multiplier, duration_hours: topDuration, quantity: body.quantity }]

  for (const item of items) {
    if (!item.library_card_id) {
      return NextResponse.json({ error: 'library_card_id required' }, { status: 400 })
    }
    if (!VALID_MULTIPLIERS.includes(Number(item.multiplier))) {
      return NextResponse.json({ error: 'multiplier must be 2.5, 2.8 or 3.0' }, { status: 400 })
    }
    const dur = Number(item.duration_hours)
    if (!dur || !VALID_DURATIONS.includes(dur)) {
      return NextResponse.json(
        { error: 'duration_hours required and must be 1, 3, 6, 12, or 24' },
        { status: 400 }
      )
    }
    if (dur > MAX_DURATION_HOURS) {
      return NextResponse.json({ error: 'Maximum listing duration is 24 hours' }, { status: 400 })
    }
    // Validate quantity: integer ≥ 1 (default 1)
    const qty = item.quantity !== undefined ? Number(item.quantity) : 1
    if (!Number.isInteger(qty) || qty < 1) {
      return NextResponse.json(
        { error: 'quantity must be a positive integer' },
        { status: 400 }
      )
    }
    item._quantity = qty
  }

  // Verify all library cards belong to this user AND fetch owned quantities
  const libraryCardIds = items.map(i => i.library_card_id)
  const { data: ownedCards, error: ownErr } = await authClient
    .from('library_cards')
    .select('id, quantity')
    .in('id', libraryCardIds)
    .eq('user_id', user.id)

  if (ownErr) {
    return NextResponse.json({ error: 'Failed to verify ownership' }, { status: 500 })
  }

  const ownedMap = new Map((ownedCards || []).map(c => [c.id, c.quantity]))
  const unowned = libraryCardIds.filter(id => !ownedMap.has(id))
  if (unowned.length > 0) {
    return NextResponse.json({ error: 'One or more cards not found in your library' }, { status: 403 })
  }

  // Validate each item's quantity against owned quantity
  for (const item of items) {
    const ownedQty = ownedMap.get(item.library_card_id)
    if (item._quantity > ownedQty) {
      return NextResponse.json(
        { error: `Cannot list ${item._quantity} copies; you only own ${ownedQty} of this card`, library_card_id: item.library_card_id },
        { status: 400 }
      )
    }
  }

  // Photo gate — every card being listed must have a photo
  const sc2 = makeServiceClient()
  const { data: photoRows } = await sc2
    .from('card_photos')
    .select('library_card_id')
    .in('library_card_id', libraryCardIds)

  const photoSet = new Set((photoRows || []).map(p => p.library_card_id))
  const missingPhotos = libraryCardIds.filter(id => !photoSet.has(id))
  if (missingPhotos.length > 0) {
    return NextResponse.json(
      { error: 'A real-life card photo is required before listing. Please photograph your card first.', missing_photos: missingPhotos },
      { status: 422 }
    )
  }

  const now = Date.now()
  const rows = items.map(item => ({
    user_id: user.id,
    library_card_id: item.library_card_id,
    multiplier: Number(item.multiplier),
    quantity: item._quantity,
    status: 'active',
    expires_at: new Date(now + Number(item.duration_hours) * 3600 * 1000).toISOString(),
  }))

  // Try with expires_at + quantity; fall back if columns not yet migrated
  let result = await authClient
    .from('listings')
    .upsert(rows, { onConflict: 'library_card_id' })
    .select()

  if (result.error?.code === UNDEF_COLUMN) {
    // migration-014 may be pending while expires_at already exists.
    // Preserve expiry and retry without quantity first.
    const rowsFallback = rows.map(({ quantity: _q, ...r }) => r)
    result = await authClient
      .from('listings')
      .upsert(rowsFallback, { onConflict: 'library_card_id' })
      .select()

    if (result.error?.code === UNDEF_COLUMN) {
      // Pre-migration-009 fallback: expires_at is also unavailable.
      const rowsLegacy = rowsFallback.map(({ expires_at: _e, ...r }) => r)
      result = await authClient
        .from('listings')
        .upsert(rowsLegacy, { onConflict: 'library_card_id' })
        .select()
    }
  }

  if (result.error) {
    console.error('[POST /api/listings]', result.error.message)
    return NextResponse.json({ error: result.error.message }, { status: 500 })
  }

  return NextResponse.json({ listings: result.data }, { status: 201 })
}
