import { NextResponse } from 'next/server'
import { createClient as createAuthClient } from '@/lib/supabaseServer'
import { createClient as createServiceClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function serviceClient() {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
}

function mutationError(error) {
  const message = String(error?.message || '')
  const code = ['INVALID_QUANTITY', 'LISTING_NOT_FOUND', 'LISTING_UNAVAILABLE', 'CLAIM_SALE_ENDED',
    'INSUFFICIENT_STOCK', 'LISTING_CARD_OWNER_MISMATCH', 'CART_ITEM_CHANGED', 'CART_ITEM_NOT_FOUND'].find(value => message.includes(value))
    || 'CART_UNAVAILABLE'
  const status = code === 'LISTING_NOT_FOUND' || code === 'CART_ITEM_NOT_FOUND' ? 404 : code === 'CART_UNAVAILABLE' ? 503 : 409
  const result = { error: code, code }
  if (code === 'CART_ITEM_CHANGED') {
    try { result.current = JSON.parse(error.details || error.hint || '{}') } catch { /* details are optional */ }
  }
  if (code === 'INSUFFICIENT_STOCK') {
    try { result.details = JSON.parse(error.details || error.hint || '{}') } catch { /* details are optional */ }
  }
  return NextResponse.json(result, { status })
}

async function authenticatedUser() {
  const authClient = await createAuthClient()
  const { data: { user }, error } = await authClient.auth.getUser()
  return error ? null : user
}

export async function PATCH(request, { params }) {
  const { id } = await params
  const user = await authenticatedUser()
  if (!user) return NextResponse.json({ error: 'AUTH_REQUIRED', code: 'AUTH_REQUIRED' }, { status: 401 })
  if (!UUID.test(id || '')) return NextResponse.json({ error: 'Cart item not found', code: 'CART_ITEM_NOT_FOUND' }, { status: 404 })
  let body
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  if (!Number.isInteger(body?.quantity) || body.quantity < 1 || body.quantity > 9999 ||
      !Number.isInteger(body?.expected_version) || body.expected_version < 1) {
    return NextResponse.json({ error: 'Choose a whole number of at least 1.', code: 'INVALID_QUANTITY' }, { status: 400 })
  }
  const { data, error } = await serviceClient().rpc('phase45c_cart_update', {
    p_buyer_id: user.id,
    p_cart_item_id: id,
    p_quantity: body.quantity,
    p_expected_version: body.expected_version,
  })
  if (error) return mutationError(error)
  return NextResponse.json(data || {})
}

export async function DELETE(request, { params }) {
  const { id } = await params
  const user = await authenticatedUser()
  if (!user) return NextResponse.json({ error: 'AUTH_REQUIRED', code: 'AUTH_REQUIRED' }, { status: 401 })
  if (!UUID.test(id || '')) return NextResponse.json({ success: true })
  const { data, error } = await serviceClient().rpc('phase45c_cart_delete', {
    p_buyer_id: user.id, p_cart_item_id: id,
  })
  if (error) return mutationError(error)
  return NextResponse.json(data || { success: true })
}
