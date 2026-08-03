import { NextResponse } from 'next/server'
import { createClient as createAuthClient } from '@/lib/supabaseServer'
import { createClient as createServiceClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const UNDEF_TABLE = '42P01'
function makeServiceClient() { return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY) }
function codeOf(error) { return String(error?.message || '').split(/[\s:]/, 1)[0] || 'RPC_ERROR' }
function detailFloor(error) {
  try { return JSON.parse(error?.details || '{}')?.floor || null } catch { return null }
}
function statusOf(code) {
  if (code === 'SELLER_CANNOT_BID') return 403
  if (['BID_TOO_LOW', 'USE_BUYOUT', 'BID_CEILING', 'BID_TOO_HIGH'].includes(code)) return 409
  if (code === 'AUCTION_NOT_FOUND') return 404
  if (code === 'AUCTION_ENDED') return 410
  return 400
}

export async function POST(request, { params }) {
  const { id } = await params
  if (!UUID.test(id || '')) return NextResponse.json({ error: 'Invalid auction id' }, { status: 400 })
  const authClient = await createAuthClient()
  const { data: { user }, error: authError } = await authClient.auth.getUser()
  if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  let body
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  if (!Number.isInteger(body?.amount_myr) || body.amount_myr < 1) return NextResponse.json({ error: 'AMOUNT_INVALID' }, { status: 400 })
  const sc = makeServiceClient()
  const { data: auction, error: auctionError } = await sc.from('auctions').select('seller_id, current_bid_myr, bid_increment').eq('id', id).maybeSingle()
  if (auctionError) {
    if (auctionError.code === UNDEF_TABLE) return NextResponse.json({ error: 'Auctions not yet available' }, { status: 503 })
    return NextResponse.json({ error: 'Could not load auction' }, { status: 500 })
  }
  if (!auction) return NextResponse.json({ error: 'Auction not found' }, { status: 404 })
  if (auction.seller_id === user.id) return NextResponse.json({ error: 'SELLER_CANNOT_BID' }, { status: 403 })
  const { data, error } = await sc.rpc('place_auction_bid', { p_auction_id: id, p_bidder_id: user.id, p_amount_myr: body.amount_myr })
  if (error) {
    const code = codeOf(error)
    const response = { error: code }
    if (code === 'BID_TOO_LOW') response.min_next_bid_myr = detailFloor(error)
    return NextResponse.json(response, { status: statusOf(code) })
  }
  const resultCode = data?.result_code || 'BID_ACCEPTED'
  if (resultCode === 'AUCTION_ENDED') return NextResponse.json({ result_code: resultCode }, { status: 410 })
  const step = auction.bid_increment === '5' ? 5 : auction.bid_increment === '10' ? 10 : 1
  return NextResponse.json({
    result_code: resultCode,
    current_bid_myr: data?.current_bid_myr ?? body.amount_myr,
    min_next_bid_myr: data?.min_next_bid_myr ?? body.amount_myr + step,
    expires_at: data?.expires_at,
    bid_count: data?.bid_count,
    soft_close_extension_minutes: data?.soft_close_extension_minutes,
  })
}
