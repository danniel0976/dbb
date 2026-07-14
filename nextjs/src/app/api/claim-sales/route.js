import { NextResponse } from 'next/server'
import { createClient as createAuthClient } from '@/lib/supabaseServer'
import { createClient as createServiceClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

const VALID_DELIVERY_OPTIONS = ['pickup', 'shipping', 'both']
const DEFAULT_MULTIPLIER = 3.0
const UNDEF_TABLE = '42P01'   // relation does not exist
const UNDEF_COLUMN = '42703'  // column does not exist

function makeServiceClient() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

// GET /api/claim-sales — list active claim sales
// Query: page, sort (newest|most_followed|ending_soon), set_code?, user_id?
export async function GET(request) {
  const { searchParams } = new URL(request.url)
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10))
  const PAGE_SIZE = 20
  const sort = searchParams.get('sort') || 'newest'
  const setCode = searchParams.get('set_code') || null
  const userId = searchParams.get('user_id') || null

  const sc = makeServiceClient()

  // Check if claim_sales table exists
  try {
    // For most_followed sort, we need ALL active claim sales to compute
    // follower counts globally before paginating. For other sorts, we can
    // paginate at the DB level.
    const nowIso = new Date().toISOString()

    let baseQuery = sc
      .from('claim_sales')
      .select(`
        id, title, description, set_code, user_id, expires_at,
        delivery_option, created_at, status
      `, { count: 'exact' })
      .eq('status', 'active')
      .gt('expires_at', nowIso)

    if (setCode) baseQuery = baseQuery.eq('set_code', setCode)
    if (userId) baseQuery = baseQuery.eq('user_id', userId)

    let data, count

    if (sort === 'most_followed') {
      // Fetch ALL active claim sales (no DB pagination) so we can sort globally
      // by follower count. At expected scale (<1000 active sales) this is fine.
      const { data: allSales, error: allErr, count: allCount } = await baseQuery
        .order('created_at', { ascending: false })

      if (allErr) {
        if (allErr.code === UNDEF_TABLE) {
          return NextResponse.json({ claim_sales: [], total: 0, hasMore: false, page, note: 'Claim sales table not yet migrated' })
        }
        throw allErr
      }

      data = allSales || []
      count = allCount || data.length

      // Fetch follower counts for ALL active claim sales
      const allIds = data.map(cs => cs.id)
      let followerCountMap = {}
      if (allIds.length > 0) {
        try {
          const { data: followCounts } = await sc
            .from('follows')
            .select('claim_sale_id')
            .in('claim_sale_id', allIds)
          for (const row of followCounts || []) {
            followerCountMap[row.claim_sale_id] = (followerCountMap[row.claim_sale_id] || 0) + 1
          }
        } catch {
          // follows table might not exist yet
        }
      }

      // Attach follower counts, sort globally, then paginate in JS
      data = data.map(cs => ({
        ...cs,
        _follower_count: followerCountMap[cs.id] || 0,
      })).sort((a, b) => b._follower_count - a._follower_count)

      const from = (page - 1) * PAGE_SIZE
      const paginatedData = data.slice(from, from + PAGE_SIZE)

      // Now fetch seller names + card counts only for the page we need
      const pageIds = paginatedData.map(cs => cs.id)
      const userIds = [...new Set(paginatedData.map(cs => cs.user_id))]
      let sellerMap = {}
      if (userIds.length > 0) {
        const { data: profiles } = await sc
          .from('profiles')
          .select('id, display_name')
          .in('id', userIds)
        for (const p of profiles || []) sellerMap[p.id] = p.display_name
      }

      let cardCountMap = {}
      if (pageIds.length > 0) {
        try {
          const { data: listingCounts } = await sc
            .from('listings')
            .select('claim_sale_id')
            .in('claim_sale_id', pageIds)
            .eq('status', 'active')
          for (const row of listingCounts || []) {
            cardCountMap[row.claim_sale_id] = (cardCountMap[row.claim_sale_id] || 0) + 1
          }
        } catch {}
      }

      let results = paginatedData.map(cs => ({
        ...cs,
        seller_name: sellerMap[cs.user_id] || null,
        card_count: cardCountMap[cs.id] || 0,
        follower_count: cs._follower_count,
      }))
      // Strip internal sort field
      results = results.map(({ _follower_count, ...cs }) => cs)

      return NextResponse.json({
        claim_sales: results,
        total: count,
        hasMore: from + PAGE_SIZE < count,
        page,
      })
    }

    // For ending_soon and newest: paginate at DB level
    if (sort === 'ending_soon') {
      baseQuery = baseQuery.order('expires_at', { ascending: true })
    } else {
      baseQuery = baseQuery.order('created_at', { ascending: false })
    }

    const from = (page - 1) * PAGE_SIZE
    baseQuery = baseQuery.range(from, from + PAGE_SIZE - 1)

    const dbResult = await baseQuery
    data = dbResult.data
    count = dbResult.count

    if (dbResult.error) {
      if (dbResult.error.code === UNDEF_TABLE) {
        return NextResponse.json({ claim_sales: [], total: 0, hasMore: false, page, note: 'Claim sales table not yet migrated' })
      }
      throw dbResult.error
    }

    // Get seller display names
    const userIds = [...new Set((data || []).map(cs => cs.user_id))]
    let sellerMap = {}
    if (userIds.length > 0) {
      const { data: profiles } = await sc
        .from('profiles')
        .select('id, display_name')
        .in('id', userIds)
      for (const p of profiles || []) sellerMap[p.id] = p.display_name
    }

    // Get card counts + follower counts per claim sale
    const claimSaleIds = (data || []).map(cs => cs.id)
    let cardCountMap = {}
    let followerCountMap = {}
    if (claimSaleIds.length > 0) {
      try {
        const { data: listingCounts } = await sc
          .from('listings')
          .select('claim_sale_id')
          .in('claim_sale_id', claimSaleIds)
          .eq('status', 'active')
        for (const row of listingCounts || []) {
          cardCountMap[row.claim_sale_id] = (cardCountMap[row.claim_sale_id] || 0) + 1
        }
      } catch {}

      try {
        const { data: followCounts } = await sc
          .from('follows')
          .select('claim_sale_id')
          .in('claim_sale_id', claimSaleIds)
        for (const row of followCounts || []) {
          followerCountMap[row.claim_sale_id] = (followerCountMap[row.claim_sale_id] || 0) + 1
        }
      } catch {}
    }

    let results = (data || []).map(cs => ({
      ...cs,
      seller_name: sellerMap[cs.user_id] || null,
      card_count: cardCountMap[cs.id] || 0,
      follower_count: followerCountMap[cs.id] || 0,
    }))

    const total = count || 0
    return NextResponse.json({
      claim_sales: results,
      total,
      hasMore: from + PAGE_SIZE < total,
      page,
    })
  } catch (err) {
    console.error('[GET /api/claim-sales]', err?.message || err)
    return NextResponse.json({ claim_sales: [], total: 0, hasMore: false, page: 1 })
  }
}

// POST /api/claim-sales — create a claim sale
// Body: { title, description?, set_code?, duration_hours, delivery_option, card_ids: [library_card_id] }
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

  // Validate
  if (!body.title || typeof body.title !== 'string' || !body.title.trim()) {
    return NextResponse.json({ error: 'Title is required' }, { status: 400 })
  }
  const durationHours = Number(body.duration_hours)
  if (!durationHours || durationHours < 1 || durationHours > 24 || !Number.isInteger(durationHours)) {
    return NextResponse.json({ error: 'duration_hours must be an integer between 1 and 24' }, { status: 400 })
  }
  if (!VALID_DELIVERY_OPTIONS.includes(body.delivery_option)) {
    return NextResponse.json({ error: 'delivery_option must be pickup, shipping, or both' }, { status: 400 })
  }
  if (!Array.isArray(body.card_ids) || body.card_ids.length === 0) {
    return NextResponse.json({ error: 'card_ids must be a non-empty array' }, { status: 400 })
  }

  const cardIds = body.card_ids

  // Optional per-card quantities: { card_id: qty } map or array aligned with card_ids
  let quantityMap = {}
  if (body.quantities && typeof body.quantities === 'object' && !Array.isArray(body.quantities)) {
    quantityMap = body.quantities
  } else if (Array.isArray(body.quantities)) {
    cardIds.forEach((id, i) => { quantityMap[id] = body.quantities[i] ?? 1 })
  }

  // Validate all quantities are positive integers
  for (const id of cardIds) {
    const qty = quantityMap[id] !== undefined ? Number(quantityMap[id]) : 1
    if (!Number.isInteger(qty) || qty < 1) {
      return NextResponse.json(
        { error: 'quantities must be positive integers', library_card_id: id },
        { status: 400 }
      )
    }
    quantityMap[id] = qty
  }

  // Verify all cards belong to this user AND get owned quantities
  const { data: ownedCards, error: ownErr } = await authClient
    .from('library_cards')
    .select('id, quantity')
    .in('id', cardIds)
    .eq('user_id', user.id)

  if (ownErr) {
    return NextResponse.json({ error: 'Failed to verify card ownership' }, { status: 500 })
  }

  const ownedMap = new Map((ownedCards || []).map(c => [c.id, c.quantity]))
  const unowned = cardIds.filter(id => !ownedMap.has(id))
  if (unowned.length > 0) {
    return NextResponse.json({ error: 'One or more cards not found in your library' }, { status: 403 })
  }

  // Validate each card's requested quantity against owned quantity
  for (const id of cardIds) {
    const ownedQty = ownedMap.get(id)
    if (quantityMap[id] > ownedQty) {
      return NextResponse.json(
        { error: `Cannot list ${quantityMap[id]} copies; you only own ${ownedQty} of this card`, library_card_id: id },
        { status: 400 }
      )
    }
  }

  // Photo gate — every card must have a card_photos row
  const sc = makeServiceClient()
  const { data: photoRows } = await sc
    .from('card_photos')
    .select('library_card_id')
    .in('library_card_id', cardIds)

  const photoSet = new Set((photoRows || []).map(p => p.library_card_id))
  const missingPhotos = cardIds.filter(id => !photoSet.has(id))
  if (missingPhotos.length > 0) {
    return NextResponse.json(
      { error: 'All cards in a claim sale must have condition photos', missing_photos: missingPhotos },
      { status: 422 }
    )
  }

  // Create the claim sale
  const expiresAt = new Date(Date.now() + durationHours * 3600 * 1000).toISOString()

  let claimSale
  try {
    const { data, error } = await sc
      .from('claim_sales')
      .insert({
        user_id: user.id,
        title: body.title.trim(),
        description: body.description?.trim() || null,
        set_code: body.set_code?.trim() || null,
        duration_hours: durationHours,
        expires_at: expiresAt,
        status: 'active',
        delivery_option: body.delivery_option,
      })
      .select()
      .single()

    if (error) {
      if (error.code === UNDEF_TABLE) {
        return NextResponse.json({ error: 'Claim sales table not yet migrated. Please run migration-013.' }, { status: 503 })
      }
      throw error
    }
    claimSale = data
  } catch (err) {
    console.error('[POST /api/claim-sales] create', err?.message || err)
    return NextResponse.json({ error: err?.message || 'Failed to create claim sale' }, { status: 500 })
  }

  // Create listings for each card and link to claim sale
  const now = Date.now()
  const listingRows = cardIds.map(cardId => ({
    user_id: user.id,
    library_card_id: cardId,
    multiplier: DEFAULT_MULTIPLIER,
    quantity: quantityMap[cardId] || 1,
    status: 'active',
    expires_at: expiresAt,
    claim_sale_id: claimSale.id,
  }))

  try {
    // Try with claim_sale_id column
    let result = await sc
      .from('listings')
      .upsert(listingRows, { onConflict: 'library_card_id' })
      .select()

    if (result.error?.code === UNDEF_COLUMN) {
      // migration-014 may be pending while claim_sale_id already exists.
      // Preserve claim-sale linkage and retry without quantity first.
      const rowsNoQuantity = listingRows.map(({ quantity: _q, ...r }) => r)
      result = await sc
        .from('listings')
        .upsert(rowsNoQuantity, { onConflict: 'library_card_id' })
        .select()

      if (result.error?.code === UNDEF_COLUMN) {
        // Pre-migration-013 fallback: claim_sale_id is also unavailable.
        const rowsLegacy = rowsNoQuantity.map(({ claim_sale_id: _cs, ...r }) => r)
        result = await sc
          .from('listings')
          .upsert(rowsLegacy, { onConflict: 'library_card_id' })
          .select()
      }
    }

    if (result.error) throw result.error

    return NextResponse.json({
      claim_sale: claimSale,
      listings: result.data,
    }, { status: 201 })
  } catch (err) {
    console.error('[POST /api/claim-sales] listings', err?.message || err)
    // Claim sale was created but listings failed — still return the claim sale
    return NextResponse.json({
      claim_sale: claimSale,
      listings: [],
      warning: 'Claim sale created but failed to link listings. Please run migration-013 for full functionality.',
    }, { status: 201 })
  }
}
