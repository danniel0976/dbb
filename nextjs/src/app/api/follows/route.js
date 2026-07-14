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

// GET /api/follows — current user's follows
// Query: check=<claim_sale_id> → returns { following: true/false } for a single claim sale
// No check param → returns all follows (claim_sales + users)
// Returns: followed claim sales (with details) + followed users (with display_name)
export async function GET(request) {
  const { searchParams } = new URL(request.url)
  const checkId = searchParams.get('check')

  const authClient = await createAuthClient()
  const { data: { user }, error: authError } = await authClient.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Single follow-check mode
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

  const sc = makeServiceClient()

  try {
    // Check if follows table exists
    const { data: testRow, error: testErr } = await sc
      .from('follows')
      .select('id')
      .eq('follower_id', user.id)
      .limit(1)

    if (testErr && testErr.code === UNDEF_TABLE) {
      return NextResponse.json({ claim_sales: [], users: [], note: 'Follows table not yet migrated' })
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

    return NextResponse.json({
      claim_sales: followedClaimSales,
      users: followedUsers,
    })
  } catch (err) {
    console.error('[GET /api/follows]', err?.message || err)
    return NextResponse.json({ claim_sales: [], users: [] })
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

  const { claim_sale_id, followee_id } = body

  if (!claim_sale_id && !followee_id) {
    return NextResponse.json({ error: 'Must provide claim_sale_id or followee_id' }, { status: 400 })
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
    return NextResponse.json({ error: err?.message || 'Failed to follow' }, { status: 500 })
  }
}

// DELETE /api/follows — unfollow
// Query param: claim_sale_id or followee_id
export async function DELETE(request) {
  const authClient = await createAuthClient()
  const { data: { user }, error: authError } = await authClient.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const claim_sale_id = searchParams.get('claim_sale_id')
  const followee_id = searchParams.get('followee_id')

  if (!claim_sale_id && !followee_id) {
    return NextResponse.json({ error: 'Must provide claim_sale_id or followee_id' }, { status: 400 })
  }

  try {
    let q = authClient
      .from('follows')
      .delete()
      .eq('follower_id', user.id)

    if (claim_sale_id) q = q.eq('claim_sale_id', claim_sale_id)
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
    return NextResponse.json({ error: err?.message || 'Failed to unfollow' }, { status: 500 })
  }
}