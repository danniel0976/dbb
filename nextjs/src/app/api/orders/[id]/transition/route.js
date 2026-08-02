import { NextResponse } from 'next/server'
import { createClient as createAuthClient } from '@/lib/supabaseServer'
import { createClient as createServiceClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

const ACTIONS = ['preparing_order', 'payment_received', 'dropped_off', 'order_completed', 'cancel']

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
  if (!ACTIONS.includes(body.action)) return NextResponse.json({ error: 'Invalid transition action' }, { status: 400 })
  if (body.action === 'cancel' && (typeof body.reason !== 'string' || body.reason.trim().length < 5 || body.reason.length > 500)) {
    return NextResponse.json({ error: 'Cancellation reason must be 5 to 500 characters' }, { status: 400 })
  }

  const sc = makeServiceClient()
  const { data, error } = await sc.rpc('transition_order', {
    p_order_id: id,
    p_actor_id: user.id,
    p_action: body.action,
    p_reason: body.reason?.trim() || null,
  })
  if (error) {
    const message = String(error.message || '')
    const code = ['ORDER_NOT_FOUND', 'ORDER_NOT_AUTHORIZED', 'ORDER_TRANSITION_NOT_ALLOWED',
      'INVALID_CANCELLATION_REASON', 'RESERVATION_DRIFT'].find(value => message.includes(value)) || 'ORDER_TRANSITION_FAILED'
    return NextResponse.json({ error: code, code }, { status: code === 'ORDER_NOT_FOUND' ? 404 : 409 })
  }
  return NextResponse.json({ order: data })
}
