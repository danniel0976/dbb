import { NextResponse } from 'next/server'
import { createClient as createAuthClient } from '@/lib/supabaseServer'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { requireCompleteMerchantProfile } from '@/lib/merchantProfile'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
function makeServiceClient() { return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY) }
function codeOf(error) { return String(error?.message || '').split(/[\s:]/, 1)[0] || 'RPC_ERROR' }
function statusOf(code) {
  if (['NOT_OWNER'].includes(code)) return 403
  if (code === 'AUCTION_NOT_FOUND') return 404
  if (['MERCHANT_INCOMPLETE', 'NOT_A_MERCHANT', 'MERCHANT_PROFILE_REQUIRED'].includes(code)) return 403
  if (['EMPTY_LOT', 'NO_LOT_ITEMS', 'LOT_TOO_MANY_ITEMS', 'LOT_TOO_MANY_COPIES', 'PHOTO_REQUIRED'].includes(code)) return 422
  if (['TITLE_TOO_SHORT', 'TITLE_TOO_LONG', 'INVALID_INCREMENT', 'INVALID_DURATION', 'STARTING_BID_TOO_LOW', 'STARTING_BID_TOO_HIGH', 'BUYOUT_MUST_EXCEED_START', 'BUYOUT_TOO_HIGH', 'INVALID_QUANTITY'].includes(code)) return 400
  return ['STATUS_NOT_DRAFT', 'AUCTION_NOT_DRAFT', 'ALREADY_PUBLISHED', 'DUPLICATE_LOT_ITEM', 'RESERVATION_CONFLICT', 'LOT_UNAVAILABLE', 'CARD_UNAVAILABLE', 'RESERVATION_TRANSFER_FAILED'].includes(code) ? 409 : 500
}

function errorBody(code, error) {
  const body = { error: code, code }
  if (code === 'PHOTO_REQUIRED') {
    try { body.missing_photos = JSON.parse(error?.details || '{}')?.missing_photos || [] } catch { body.missing_photos = [] }
  }
  if (code === 'LOT_UNAVAILABLE' || code === 'CARD_UNAVAILABLE') {
    try {
      const parsed = JSON.parse(error?.details || '[]')
      body.unavailable_items = Array.isArray(parsed) ? parsed : (parsed?.unavailable_items || [])
    } catch { body.unavailable_items = [] }
  }
  return body
}

export async function POST(request, { params }) {
  const { id } = await params
  if (!UUID.test(id || '')) return NextResponse.json({ error: 'Invalid auction id' }, { status: 400 })
  const authClient = await createAuthClient()
  const { data: { user }, error: authError } = await authClient.auth.getUser()
  if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const merchantGate = await requireCompleteMerchantProfile(authClient, user.id)
  if (merchantGate) return NextResponse.json({ error: merchantGate.error, code: merchantGate.code }, { status: merchantGate.status })
  const sc = makeServiceClient()
  const { data, error } = await sc.rpc('publish_auction', { p_seller_id: user.id, p_auction_id: id })
  if (error) {
    const code = codeOf(error)
    return NextResponse.json(errorBody(code, error), { status: statusOf(code) })
  }
  return NextResponse.json({ auction_id: data?.auction_id || id, expires_at: data?.expires_at })
}
