import { NextResponse } from 'next/server'
import { createClient as createAuthClient } from '@/lib/supabaseServer'
import { createClient as createServiceClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

function boundedInt(raw, fallback, min, max) {
  const value = Number.parseInt(raw || '', 10)
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback
}

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

  const paymentHours = boundedInt(process.env.ORDER_PAYMENT_NO_SHOW_HOURS, 24, 1, 168)
  const sellerStaleHours = boundedInt(process.env.ORDER_SELLER_STALE_HOURS, 48, 6, 336)
  const sc = makeServiceClient()
  const { data, error } = await sc.rpc('report_order_no_show', {
    p_order_id: id,
    p_actor_id: user.id,
    p_reason: body.reason.trim(),
    p_payment_wait_hours: paymentHours,
    p_seller_stale_hours: sellerStaleHours,
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 409 })
  return NextResponse.json({ report: data }, { status: 201 })
}
