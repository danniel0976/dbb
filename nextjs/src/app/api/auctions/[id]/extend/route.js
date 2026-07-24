import { NextResponse } from 'next/server'
import { createClient as createAuthClient } from '@/lib/supabaseServer'
import { createClient as createServiceClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const UNDEF_TABLE = '42P01'
function makeServiceClient() { return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY) }
function codeOf(error) { return String(error?.message || '').split(/[\s:]/, 1)[0] || 'RPC_ERROR' }
function statusOf(code) { if (code === 'NOT_OWNER') return 403; if (code === 'AUCTION_NOT_FOUND') return 404; if (code === 'AUCTION_ENDED') return 410; if (code === 'EXTENSION_ALREADY_USED') return 409; if (code === 'INVALID_EXTENSION') return 400; return 409 }

export async function POST(request, { params }) {
  const { id } = await params
  if (!UUID.test(id || '')) return NextResponse.json({ error: 'Invalid auction id' }, { status: 400 })
  const authClient = await createAuthClient()
  const { data: { user }, error: authError } = await authClient.auth.getUser()
  if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  let body
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  if (![15, 30, 60].includes(body?.extension_minutes)) return NextResponse.json({ error: 'EXTENSION_INVALID' }, { status: 400 })
  if (!UUID.test(body?.idempotency_key || '')) return NextResponse.json({ error: 'A valid idempotency_key UUID is required' }, { status: 400 })
  const sc = makeServiceClient()
  const { data: auction, error: auctionError } = await sc.from('auctions').select('seller_id').eq('id', id).maybeSingle()
  if (auctionError) return NextResponse.json({ error: auctionError.code === UNDEF_TABLE ? 'Auctions not yet available' : 'Could not load auction' }, { status: auctionError.code === UNDEF_TABLE ? 503 : 500 })
  if (!auction) return NextResponse.json({ error: 'Auction not found' }, { status: 404 })
  if (auction.seller_id !== user.id) return NextResponse.json({ error: 'NOT_OWNER' }, { status: 403 })
  const { data, error } = await sc.rpc('extend_auction', { p_seller_id: user.id, p_auction_id: id, p_extension_minutes: body.extension_minutes, p_idempotency_key: body.idempotency_key })
  if (error) {
    const code = codeOf(error)
    if (code === 'AUCTION_ENDED') return NextResponse.json({ result_code: 'AUCTION_ENDED' }, { status: 410 })
    return NextResponse.json({ error: code }, { status: statusOf(code) })
  }
  return NextResponse.json({ result_code: data?.result_code || 'EXTENDED', new_expires_at: data?.new_expires_at || data?.expires_at })
}
