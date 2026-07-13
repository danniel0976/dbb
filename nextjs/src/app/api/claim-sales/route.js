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
    let q = sc
      .from('claim_sales')
      .select(`
        id, title, description, set_code, user_id, expires_at,
        delivery_option, created_at, status
      `, { count: 'exact' })
      .eq('status', 'active')
      .gt('expires_at', new Date().toISOString())

    if (setCode) q = q.eq('set_code', setCode)
    if (userId) q = q.eq('user_id', userId)

    // Sorting
    if (sort === 'ending_soon') {
      q = q.order('expires_at', { ascending: true })
    } else if (sort === 'most_followed') {
      // We'll need to sort by follower count after fetching
      q = q.order('created_at', { ascending: false })
    } else {
      q = q.order('created_at', { ascending: false })
    }

    const from = (page - 1) * PAGE_SIZE
    q = q.range(from, from + PAGE_SIZE - 1)

    const { data, error, count } = await q

    if (error) {
      if (error.code === UNDEF_TABLE) {
        return NextResponse.json({ claim_sales: [], total: 0, hasMore: false, page, note: 'Claim sales table not yet migrated' })
      }
      throw error
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

    // Get card counts per claim sale
    const claimSaleIds = (data || []).map(cs => cs.id)
    let cardCountMap = {}
    let followerCountMap = {}
    if (claimSaleIds.length > 0) {
      // Card counts via listings joined to claim_sale_id
      try {
        const { data: listingCounts } = await sc
          .from('listings')
          .select('claim_sale_id')
          .in('claim_sale_id', claimSaleIds)
          .eq('status', 'active')
        for (const row of listingCounts || []) {
          cardCountMap[row.claim_sale_id] = (cardCountMap[row.claim_sale_id] || 0) + 1
        }
      } catch {
        // claim_sale_id column might not exist yet
      }

      // Follower counts via follows table
      try {
        const { data: followCounts } = await sc
          .from('follows')
          .select('claim_sale_id')
          .in('claim_sale_id', claimSaleIds)
        for (const row of followCounts || []) {
          followerCountMap[row.claim_sale_id] = (followerCountMap[row.claim_sale_id] || 0) + 1
        }
      } catch {
        // follows table might not exist yet
      }
    }

    let results = (data || []).map(cs => ({
      ...cs,
      seller_name: sellerMap[cs.user_id] || null,
      card_count: cardCountMap[cs.id] || 0,
      follower_count: followerCountMap[cs.id] || 0,
    }))

    // Sort by most_followed if requested
    if (sort === 'most_followed') {
      results.sort((a, b) => (b.follower_count || 0) - (a.follower_count || 0))
    }

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

  // Verify all cards belong to this user
  const { data: ownedCards, error: ownErr } = await authClient
    .from('library_cards')
    .select('id')
    .in('id', cardIds)
    .eq('user_id', user.id)

  if (ownErr) {
    return NextResponse.json({ error: 'Failed to verify card ownership' }, { status: 500 })
  }

  const ownedIds = new Set((ownedCards || []).map(c => c.id))
  const unowned = cardIds.filter(id => !ownedIds.has(id))
  if (unowned.length > 0) {
    return NextResponse.json({ error: 'One or more cards not found in your library' }, { status: 403 })
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
      // claim_sale_id column doesn't exist — insert without it
      const rowsNoClaim = listingRows.map(({ claim_sale_id: _, ...r }) => r)
      result = await sc
        .from('listings')
        .upsert(rowsNoClaim, { onConflict: 'library_card_id' })
        .select()
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