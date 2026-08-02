import { NextResponse } from 'next/server'
import { createClient as createAuthClient } from '@/lib/supabaseServer'
import { createClient as createServiceClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

function makeServiceClient() {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
}

export async function POST(request, { params }) {
  const { id } = await params
  const authClient = await createAuthClient()
  const { data: { user }, error: authError } = await authClient.auth.getUser()
  if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  let body
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (typeof body.reason !== 'string' || body.reason.trim().length < 5 || body.reason.length > 500) {
    return NextResponse.json({ error: 'Reason must be 5 to 500 characters' }, { status: 400 })
  }
  const sc = makeServiceClient()
  const { data, error } = await sc.rpc('request_order_cancellation', {
    p_order_id: id,
    p_actor_id: user.id,
    p_reason: body.reason.trim(),
  })
  if (error) {
    const message = String(error?.message || '')
    const mappings = [
      ['ORDER_NOT_FOUND', 'ORDER_NOT_FOUND', 404],
      ['ORDER_CANCELLATION_NOT_AUTHORIZED', 'ORDER_CANCELLATION_NOT_AUTHORIZED', 403],
      ['ORDER_ALREADY_FINAL', 'ORDER_ALREADY_FINAL', 409],
      ['INVALID_CANCELLATION_REASON', 'INVALID_CANCELLATION_REASON', 400],
    ]
    const hit = mappings.find(([needle]) => message.includes(needle))
    if (hit) {
      return NextResponse.json({ error: hit[1], code: hit[1] }, { status: hit[2] })
    }
    console.error('[POST /api/orders/[id]/cancellation-request]', error.message)
    return NextResponse.json({ error: 'ORDER_CANCELLATION_REQUEST_FAILED', code: 'ORDER_CANCELLATION_REQUEST_FAILED' }, { status: 500 })
  }
  return NextResponse.json({ request: data }, { status: 201 })
}
