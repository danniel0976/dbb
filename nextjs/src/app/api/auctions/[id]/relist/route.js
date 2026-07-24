import { NextResponse } from 'next/server'
import { createClient as createAuthClient } from '@/lib/supabaseServer'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { requireCompleteMerchantProfile } from '@/lib/merchantProfile'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const VALID_DURATIONS = [1, 3, 6, 12, 24]
function makeServiceClient() { return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY) }
function codeOf(error) { return String(error?.message || '').split(/[\s:]/, 1)[0] || 'RPC_ERROR' }
function statusOf(code) { if (code === 'NOT_OWNER') return 403; if (code === 'AUCTION_NOT_FOUND') return 404; if (code === 'NOT_A_MERCHANT' || code === 'MERCHANT_INCOMPLETE') return 403; if (code === 'INVALID_DURATION') return 400; return 409 }

export async function POST(request, { params }) {
  const { id } = await params
  if (!UUID.test(id || '')) return NextResponse.json({ error: 'Invalid auction id' }, { status: 400 })
  const authClient = await createAuthClient()
  const { data: { user }, error: authError } = await authClient.auth.getUser()
  if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const merchantGate = await requireCompleteMerchantProfile(authClient, user.id)
  if (merchantGate) return NextResponse.json({ error: merchantGate.error, code: merchantGate.code }, { status: merchantGate.status })
  let body
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  if (!VALID_DURATIONS.includes(body?.duration_hours)) return NextResponse.json({ error: 'DURATION_INVALID' }, { status: 400 })
  const sc = makeServiceClient()
  const { data, error } = await sc.rpc('relist_auction', { p_seller_id: user.id, p_old_auction_id: id, p_duration_hours: body.duration_hours })
  if (error) {
    const code = codeOf(error)
    const body = { error: code, code }
    if (code === 'LOT_UNAVAILABLE') {
      try {
        const parsed = JSON.parse(error.details || '[]')
        body.unavailable_items = Array.isArray(parsed) ? parsed : (parsed?.unavailable_items || [])
      } catch { body.unavailable_items = [] }
    }
    return NextResponse.json(body, { status: statusOf(code) })
  }
  const newAuctionId = typeof data === 'string' ? data : data?.new_auction_id
  let expiresAt = typeof data === 'object' ? (data?.expires_at || null) : null
  if (newAuctionId && !expiresAt) {
    const { data: newAuction } = await sc.from('auctions').select('expires_at').eq('id', newAuctionId).maybeSingle()
    expiresAt = newAuction?.expires_at || null
  }
  return NextResponse.json({ result_code: data?.result_code || 'RELISTED', new_auction_id: newAuctionId, expires_at: expiresAt }, { status: 201 })
}
