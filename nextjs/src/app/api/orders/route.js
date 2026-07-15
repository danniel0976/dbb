import { NextResponse } from 'next/server'
import { createClient as createAuthClient } from '@/lib/supabaseServer'
import { createClient as createServiceClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const PAYMENT_NO_SHOW_HOURS = boundedInt(process.env.ORDER_PAYMENT_NO_SHOW_HOURS, 24, 1, 168)
const SELLER_STALE_HOURS = boundedInt(process.env.ORDER_SELLER_STALE_HOURS, 48, 6, 336)

function boundedInt(raw, fallback, min, max) {
  const value = Number.parseInt(raw || '', 10)
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback
}

function makeServiceClient() {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
}

function response(body, init) {
  const res = NextResponse.json(body, init)
  res.headers.set('Cache-Control', 'private, no-store, max-age=0')
  return res
}

export async function GET() {
  const authClient = await createAuthClient()
  const { data: { user }, error: authError } = await authClient.auth.getUser()
  if (authError || !user) return response({ error: 'Unauthorized' }, { status: 401 })

  const sc = makeServiceClient()
  const { data, error } = await sc
    .from('orders')
    .select(`
      id, buyer_id, seller_id, pickup_location_id, status, currency, total_myr,
      preparing_order_at, payment_received_at, dropped_off_at, completed_at,
      cancelled_at, cancelled_by, cancellation_reason, created_at, updated_at,
      pickup_locations(name, address, operating_notes),
      order_items(id, quantity, unit_myr, line_myr, card_name, set_code, set_name, collector_number, foil, condition),
      order_cancellation_requests(id, actor_id, reason, requested_at, resolved_at, resolved_by, resolution),
      order_no_show_reports(id, reporter_id, reported_user_id, report_type, reason, eligible_at, created_at)
    `)
    .or(`buyer_id.eq.${user.id},seller_id.eq.${user.id}`)
    .order('created_at', { ascending: false })
    .limit(100)

  if (error) {
    if (error.code === '42P01') return response({ orders: [], configured: false })
    return response({ error: 'Could not load orders' }, { status: 500 })
  }

  const participantIds = [...new Set((data || []).flatMap(order => [order.buyer_id, order.seller_id]))]
  const { data: profiles } = participantIds.length
    ? await sc.from('profiles').select('id, display_name').in('id', participantIds)
    : { data: [] }
  const names = new Map((profiles || []).map(profile => [profile.id, profile.display_name || 'DBB user']))
  const now = Date.now()

  const orders = (data || []).map(order => {
    const role = order.buyer_id === user.id ? 'buyer' : 'seller'
    let noShowEligibleAt = null
    let noShowType = null
    if (role === 'seller' && !order.payment_received_at && ['awaiting_payment', 'preparing_order'].includes(order.status)) {
      noShowEligibleAt = new Date(new Date(order.created_at).getTime() + PAYMENT_NO_SHOW_HOURS * 3600000).toISOString()
      noShowType = 'buyer_unpaid'
    } else if (role === 'buyer' && order.status === 'payment_received' && order.payment_received_at && !order.dropped_off_at) {
      noShowEligibleAt = new Date(new Date(order.payment_received_at).getTime() + SELLER_STALE_HOURS * 3600000).toISOString()
      noShowType = 'seller_stale_after_payment'
    }

    return {
      ...order,
      role,
      buyer_name: names.get(order.buyer_id),
      seller_name: names.get(order.seller_id),
      no_show: noShowType ? {
        type: noShowType,
        eligible_at: noShowEligibleAt,
        eligible: now >= new Date(noShowEligibleAt).getTime(),
        already_reported: (order.order_no_show_reports || []).some(report => report.reporter_id === user.id && report.report_type === noShowType),
      } : null,
    }
  })

  return response({
    orders,
    configured: true,
    thresholds: {
      unpaid_buyer_hours: PAYMENT_NO_SHOW_HOURS,
      seller_stale_after_payment_hours: SELLER_STALE_HOURS,
    },
  })
}
