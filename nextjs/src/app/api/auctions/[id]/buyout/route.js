import { NextResponse } from 'next/server'
import { createClient as createAuthClient } from '@/lib/supabaseServer'
import { createClient as createServiceClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const QR_BUCKET = 'merchant-payment-qr'
const QR_TTL_SECONDS = 300
function makeServiceClient() { return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY) }
function privateJson(body, init = {}) { const response = NextResponse.json(body, init); response.headers.set('Cache-Control', 'private, no-store, max-age=0'); return response }
async function signedQr(sc, path) { if (!path) return null; const { data } = await sc.storage.from(QR_BUCKET).createSignedUrl(path, QR_TTL_SECONDS); return data?.signedUrl || null }
async function checkoutResult(sc, buyerId, orderIds, idempotentReplay) {
  const { data: orders, error } = await sc.from('orders').select(`
    id, buyer_id, seller_id, pickup_location_id, status, currency, total_myr, created_at,
    pickup_locations(name, address, operating_notes),
    order_items(id, quantity, unit_myr, line_myr, card_name, set_code, set_name, collector_number, finish, condition)
  `).in('id', orderIds).eq('buyer_id', buyerId).order('created_at', { ascending: true })
  if (error || (orders || []).length !== orderIds.length) throw new Error('Could not load checkout result')
  const sellerIds = [...new Set(orders.map(order => order.seller_id))]
  const { data: profiles, error: profileError } = await sc.from('profiles').select(`
    id, display_name, merchant_bank_name, merchant_account_name, merchant_account_number,
    merchant_duitnow_id, merchant_payment_instructions, merchant_bank_qr_path,
    merchant_tng_qr_path, merchant_profile_completed_at
  `).in('id', sellerIds)
  if (profileError) throw new Error('Could not load seller payment details')
  const paymentBySeller = new Map()
  for (const profile of profiles || []) {
    if (!profile.merchant_profile_completed_at) throw new Error('Seller payment profile is incomplete')
    const [bankQrUrl, tngQrUrl] = await Promise.all([signedQr(sc, profile.merchant_bank_qr_path), signedQr(sc, profile.merchant_tng_qr_path)])
    paymentBySeller.set(profile.id, {
      seller_name: profile.display_name || 'Seller', bank_name: profile.merchant_bank_name,
      account_name: profile.merchant_account_name, account_number: profile.merchant_account_number,
      duitnow_id: profile.merchant_duitnow_id, payment_instructions: profile.merchant_payment_instructions,
      bank_qr_url: bankQrUrl, tng_qr_url: tngQrUrl, qr_expires_in_seconds: QR_TTL_SECONDS,
    })
  }
  return { orders: orders.map(order => ({ ...order, payment: paymentBySeller.get(order.seller_id) })), idempotent_replay: idempotentReplay, payment_visibility: 'checkout_response_only' }
}
function codeOf(error) { return String(error?.message || '').split(/[\s:]/, 1)[0] || 'RPC_ERROR' }
function statusOf(code) { if (code === 'SELLER_CANNOT_BUY') return 403; if (code === 'NO_BUYOUT_PRICE' || code === 'BUYOUT_UNAVAILABLE') return 422; if (code === 'AUCTION_NOT_FOUND') return 404; if (code === 'AUCTION_ENDED') return 410; if (code === 'RESERVATION_TRANSFER_FAILED') return 500; return 409 }

export async function POST(request, { params }) {
  const { id } = await params
  if (!UUID.test(id || '')) return privateJson({ error: 'Invalid auction id' }, { status: 400 })
  const authClient = await createAuthClient()
  const { data: { user }, error: authError } = await authClient.auth.getUser()
  if (authError || !user) return privateJson({ error: 'Unauthorized' }, { status: 401 })
  let body
  try { body = await request.json() } catch { return privateJson({ error: 'Invalid JSON' }, { status: 400 }) }
  if (!UUID.test(body?.idempotency_key || '') || !UUID.test(body?.pickup_location_id || '')) return privateJson({ error: 'Valid idempotency_key and pickup_location_id UUIDs are required' }, { status: 400 })
  const sc = makeServiceClient()
  const { data: auction, error: auctionError } = await sc.from('auctions').select('seller_id').eq('id', id).maybeSingle()
  if (auctionError) return privateJson({ error: 'Could not load auction' }, { status: 500 })
  if (!auction) return privateJson({ error: 'Auction not found' }, { status: 404 })
  if (auction.seller_id === user.id) return privateJson({ error: 'SELLER_CANNOT_BUY' }, { status: 403 })
  const { data, error } = await sc.rpc('checkout_auction_buyout', { p_buyer_id: user.id, p_idempotency_key: body.idempotency_key, p_pickup_location_id: body.pickup_location_id, p_auction_id: id })
  if (error) {
    const code = codeOf(error)
    return privateJson({ error: code }, { status: statusOf(code) })
  }
  if (data?.result_code === 'AUCTION_ENDED') return privateJson({ result_code: data.result_code, error: 'Auction has ended' }, { status: 410 })
  if (data?.result_code !== 'CHECKOUT_COMPLETE') return privateJson({ error: 'Checkout returned an unexpected result' }, { status: 500 })
  try { return privateJson(await checkoutResult(sc, user.id, data.order_ids || [], Boolean(data.idempotent_replay)), { status: 201 }) } catch (error) { console.error('[POST /api/auctions/:id/buyout]', error.message); return privateJson({ error: 'Orders were created, but payment details could not be displayed.' }, { status: 500 }) }
}
