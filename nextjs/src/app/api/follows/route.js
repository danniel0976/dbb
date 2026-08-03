import { NextResponse } from 'next/server'
import { createClient as createAuthClient } from '@/lib/supabaseServer'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { collectInBatches, dedupeValidIds } from '@/lib/postgrestBatch'

export const runtime = 'nodejs'

const UNDEF_TABLE = '42P01'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function makeServiceClient() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

// GET /api/follows — current user's follows
// Query: check=<claim_sale_id> → returns { following: true/false } for a single claim sale
//         check_user=<user_id> → returns { following: true/false } for a single user
//         ids=id1,id2,... → returns { followed_ids: [ids that the user follows] } (batch check)
// No check param → returns all follows (claim_sales + users)
// Returns: followed claim sales (with details) + followed users (with display_name)
export async function GET(request) {
  const { searchParams } = new URL(request.url)
  const checkId = searchParams.get('check')
  const checkAuctionId = searchParams.get('check_auction')

  const authClient = await createAuthClient()
  const { data: { user }, error: authError } = await authClient.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Single auction follow-check mode.
  if (checkAuctionId) {
    try {
      const { data, error } = await authClient
        .from('follows')
        .select('id')
        .eq('follower_id', user.id)
        .eq('auction_id', checkAuctionId)
        .limit(1)
      if (error && (error.code === UNDEF_TABLE || error.code === '42703')) return NextResponse.json({ following: false })
      if (error) throw error
      return NextResponse.json({ following: (data || []).length > 0 })
    } catch (err) {
      console.error('[GET /api/follows check_auction]', err?.message || err)
      return NextResponse.json({ following: false })
    }
  }

  // Single follow-check mode (claim sale or user)
  if (checkId) {
    try {
      const { data, error } = await authClient
        .from('follows')
        .select('id')
        .eq('follower_id', user.id)
        .eq('claim_sale_id', checkId)
        .limit(1)
      if (error && error.code === UNDEF_TABLE) {
        return NextResponse.json({ following: false })
      }
      if (error) throw error
      return NextResponse.json({ following: (data || []).length > 0 })
    } catch (err) {
      console.error('[GET /api/follows check]', err?.message || err)
      return NextResponse.json({ following: false })
    }
  }

  // User follow-check mode
  const checkUserId = searchParams.get('check_user')
  if (checkUserId) {
    try {
      const { data, error } = await authClient
        .from('follows')
        .select('id')
        .eq('follower_id', user.id)
        .eq('followee_id', checkUserId)
        .limit(1)
      if (error && error.code === UNDEF_TABLE) {
        return NextResponse.json({ following: false })
      }
      if (error) throw error
      return NextResponse.json({ following: (data || []).length > 0 })
    } catch (err) {
      console.error('[GET /api/follows check_user]', err?.message || err)
      return NextResponse.json({ following: false })
    }
  }

  // Batch follow-check mode: ids=id1,id2,... → returns followed_ids array
  const batchIds = searchParams.get('ids')
  if (batchIds) {
    const idList = batchIds.split(',').map(s => s.trim()).filter(Boolean)
    if (idList.length === 0) {
      return NextResponse.json({ followed_ids: [] })
    }
    try {
      const { data, error } = await authClient
        .from('follows')
        .select('claim_sale_id')
        .eq('follower_id', user.id)
        .in('claim_sale_id', idList)
      if (error && error.code === UNDEF_TABLE) {
        return NextResponse.json({ followed_ids: [] })
      }
      if (error) throw error
      const followedIds = (data || []).map(r => r.claim_sale_id).filter(Boolean)
      return NextResponse.json({ followed_ids: followedIds })
    } catch (err) {
      console.error('[GET /api/follows batch]', err?.message || err)
      return NextResponse.json({ followed_ids: [] })
    }
  }

  // Batch auction follow-check mode: auction_ids=id1,id2,...
  const auctionIds = searchParams.get('auction_ids')
  if (auctionIds) {
    const ids = dedupeValidIds(auctionIds.split(',').map(s => s.trim()).filter(Boolean)) || []
    if (!ids.length) return NextResponse.json({ followed_auction_ids: [] })
    try {
      const result = await collectInBatches(ids, batch => authClient
        .from('follows')
        .select('auction_id')
        .eq('follower_id', user.id)
        .in('auction_id', batch))
      if (result.error && (result.error.code === UNDEF_TABLE || result.error.code === '42703')) return NextResponse.json({ followed_auction_ids: [] })
      if (result.error) throw result.error
      return NextResponse.json({ followed_auction_ids: (result.data || []).map(row => row.auction_id).filter(Boolean) })
    } catch (err) {
      console.error('[GET /api/follows auction batch]', err?.message || err)
      return NextResponse.json({ followed_auction_ids: [] })
    }
  }

  const sc = makeServiceClient()

  try {
    // Check if follows table exists
    const { data: testRow, error: testErr } = await sc
      .from('follows')
      .select('id')
      .eq('follower_id', user.id)
      .limit(1)

    if (testErr && testErr.code === UNDEF_TABLE) {
      return NextResponse.json({ claim_sales: [], users: [], auctions: [], note: 'Follows table not yet migrated' })
    }

    // Fetch followed claim sales
    let followedClaimSales = []
    try {
      const { data: csFollows, error: csErr } = await sc
        .from('follows')
        .select(`
          claim_sale_id,
          claim_sales(
            id, title, description, set_code, expires_at, status,
            delivery_option, created_at, user_id
          )
        `)
        .eq('follower_id', user.id)
        .not('claim_sale_id', 'is', null)

      if (!csErr && csFollows) {
        const claimSaleIds = csFollows.map(f => f.claim_sale_id).filter(Boolean)
        let sellerMap = {}
        if (claimSaleIds.length > 0) {
          const sellerIds = [...new Set(csFollows.map(f => f.claim_sales?.user_id).filter(Boolean))]
          if (sellerIds.length > 0) {
            const { data: profiles } = await sc
              .from('profiles')
              .select('id, display_name')
              .in('id', sellerIds)
            for (const p of profiles || []) sellerMap[p.id] = p.display_name
          }
        }
        followedClaimSales = csFollows
          .filter(f => f.claim_sales)
          .map(f => ({
            ...f.claim_sales,
            seller_name: sellerMap[f.claim_sales.user_id] || null,
          }))
      }
    } catch {
      // claim_sales table might not exist
    }

    // Fetch followed users
    let followedUsers = []
    try {
      const { data: userFollows, error: userErr } = await sc
        .from('follows')
        .select(`
          followee_id,
          profiles!follows_followee_id_fkey(id, display_name)
        `)
        .eq('follower_id', user.id)
        .not('followee_id', 'is', null)

      if (!userErr && userFollows) {
        followedUsers = userFollows
          .filter(f => f.profiles)
          .map(f => ({
            id: f.followee_id,
            display_name: f.profiles.display_name,
          }))
      }
    } catch {
      // profiles relation might fail
    }

    // Fetch followed auctions. This is optional while the auction migration is
    // being rolled out, so an absent relation/column leaves the other lists intact.
    let followedAuctions = []
    try {
      const { data: auctionFollows, error: auctionErr } = await sc
        .from('follows')
        .select(`
          auction_id,
          auctions(
            id, title, seller_id, status, starting_bid_myr, buyout_myr,
            current_bid_myr, bid_count, bid_increment, duration_hours,
            soft_close_enabled, expires_at, created_at
          )
        `)
        .eq('follower_id', user.id)
        .not('auction_id', 'is', null)
      if (!auctionErr && auctionFollows) {
        const sellerIds = [...new Set(auctionFollows.map(row => row.auctions?.seller_id).filter(Boolean))]
        const { data: profiles } = sellerIds.length
          ? await sc.from('profiles').select('id, display_name').in('id', sellerIds)
          : { data: [] }
        const sellerMap = new Map((profiles || []).map(profile => [profile.id, profile.display_name || null]))
        followedAuctions = auctionFollows.filter(row => row.auctions).map(row => ({
          ...row.auctions,
          seller_name: sellerMap.get(row.auctions.seller_id) || null,
        }))
      }
    } catch {
      // auctions table/relation might not exist yet
    }

    return NextResponse.json({
      claim_sales: followedClaimSales,
      users: followedUsers,
      auctions: followedAuctions,
    })
  } catch (err) {
    console.error('[GET /api/follows]', err?.message || err)
    return NextResponse.json({ claim_sales: [], users: [], auctions: [] })
  }
}

// POST /api/follows — follow a claim sale or user
// Body: { claim_sale_id? } or { followee_id? }
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
  body = body || {}

  const { claim_sale_id, followee_id, auction_id } = body

  const targets = [followee_id, claim_sale_id, auction_id].filter(value => value !== undefined && value !== null && value !== '')
  if (targets.length !== 1) {
    return NextResponse.json({ error: 'Must provide claim_sale_id, auction_id, or followee_id' }, { status: 400 })
  }

  if (targets.some(value => !UUID.test(value))) {
    return NextResponse.json({ error: 'Follow target must be a valid UUID' }, { status: 400 })
  }

  // Prevent self-follow
  if (followee_id === user.id) {
    return NextResponse.json({ error: 'Cannot follow yourself' }, { status: 400 })
  }

  const insertRow = {
    follower_id: user.id,
  }
  if (claim_sale_id) insertRow.claim_sale_id = claim_sale_id
  if (followee_id) insertRow.followee_id = followee_id
  if (auction_id) insertRow.auction_id = auction_id

  // Validate claim sale is active and unexpired before following
  if (claim_sale_id) {
    const sc = makeServiceClient()
    try {
      const { data: cs, error: csErr } = await sc
        .from('claim_sales')
        .select('status, expires_at')
        .eq('id', claim_sale_id)
        .maybeSingle()
      if (csErr && csErr.code !== UNDEF_TABLE) {
        throw csErr
      }
      if (!cs) {
        return NextResponse.json({ error: 'Claim sale not found' }, { status: 404 })
      }
      if (cs.status !== 'active') {
        return NextResponse.json({ error: `Cannot follow a ${cs.status} claim sale` }, { status: 400 })
      }
      if (cs.expires_at && new Date(cs.expires_at).getTime() <= Date.now()) {
        return NextResponse.json({ error: 'Cannot follow an expired claim sale' }, { status: 400 })
      }
    } catch (err) {
      // If claim_sales table doesn't exist, allow the follow (graceful degradation)
      if (err?.code !== UNDEF_TABLE) {
        console.error('[POST /api/follows] claim sale validation', err?.message || err)
        return NextResponse.json({ error: 'Failed to validate claim sale' }, { status: 500 })
      }
    }
  }

  // Validate auction is active and unexpired before following it.
  if (auction_id) {
    const sc = makeServiceClient()
    try {
      const { data: auction, error: auctionErr } = await sc
        .from('auctions')
        .select('seller_id, status, expires_at')
        .eq('id', auction_id)
        .maybeSingle()
      if (auctionErr && auctionErr.code !== UNDEF_TABLE && auctionErr.code !== '42703') throw auctionErr
      if (auctionErr?.code === UNDEF_TABLE || auctionErr?.code === '42703') return NextResponse.json({ error: 'Auctions are not available yet' }, { status: 503 })
      if (!auction) return NextResponse.json({ error: 'Auction not found' }, { status: 404 })
      if (auction.seller_id === user.id) return NextResponse.json({ error: 'Cannot follow your own auction' }, { status: 403 })
      if (auction.status !== 'active') return NextResponse.json({ error: `Cannot follow a ${auction.status} auction` }, { status: 400 })
      if (auction.expires_at && new Date(auction.expires_at).getTime() <= Date.now()) return NextResponse.json({ error: 'Cannot follow an expired auction' }, { status: 400 })
    } catch (err) {
      if (err?.code !== UNDEF_TABLE && err?.code !== '42703') {
        console.error('[POST /api/follows] auction validation', err?.message || err)
        return NextResponse.json({ error: 'Failed to validate auction' }, { status: 500 })
      }
    }
  }

  try {
    const { data, error } = await authClient
      .from('follows')
      .insert(insertRow)
      .select()
      .single()

    if (error) {
      if (error.code === UNDEF_TABLE) {
        return NextResponse.json({ error: 'Follows table not yet migrated. Please run migration-013.' }, { status: 503 })
      }
      // Unique constraint violation = already following
      if (error.code === '23505') {
        return NextResponse.json({ following: true, message: 'Already following' })
      }
      throw error
    }

    return NextResponse.json({ following: true, id: data.id }, { status: 201 })
  } catch (err) {
    console.error('[POST /api/follows]', err?.message || err)
    return NextResponse.json({
      error: 'Follow request could not be completed',
      code: 'FOLLOW_CREATE_FAILED',
    }, { status: 500 })
  }
}

// DELETE /api/follows — unfollow
// Query param: claim_sale_id, auction_id, or followee_id
export async function DELETE(request) {
  const authClient = await createAuthClient()
  const { data: { user }, error: authError } = await authClient.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const claim_sale_id = searchParams.get('claim_sale_id')
  const auction_id = searchParams.get('auction_id')
  const followee_id = searchParams.get('followee_id')

  if (!claim_sale_id && !auction_id && !followee_id) {
    return NextResponse.json({ error: 'Must provide claim_sale_id, auction_id, or followee_id' }, { status: 400 })
  }

  try {
    let q = authClient
      .from('follows')
      .delete()
      .eq('follower_id', user.id)

    if (claim_sale_id) q = q.eq('claim_sale_id', claim_sale_id)
    if (auction_id) q = q.eq('auction_id', auction_id)
    if (followee_id) q = q.eq('followee_id', followee_id)

    const { error } = await q

    if (error) {
      if (error.code === UNDEF_TABLE) {
        return NextResponse.json({ success: true, note: 'Follows table not yet migrated' })
      }
      throw error
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[DELETE /api/follows]', err?.message || err)
    return NextResponse.json({
      error: 'Unfollow request could not be completed',
      code: 'FOLLOW_DELETE_FAILED',
    }, { status: 500 })
  }
}
