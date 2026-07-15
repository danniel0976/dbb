import { NextResponse } from 'next/server'
import { createClient as createAuthClient } from '@/lib/supabaseServer'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { ensurePriceCache, lookupPrice, sellPrice } from '@/lib/pricingCache'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const QR_BUCKET = 'merchant-payment-qr'
const QR_TTL_SECONDS = 300

function makeServiceClient() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

function privateJson(body, init = {}) {
  const response = NextResponse.json(body, init)
  response.headers.set('Cache-Control', 'private, no-store, max-age=0')
  return response
}

async function authenticate() {
  const authClient = await createAuthClient()
  const { data: { user }, error } = await authClient.auth.getUser()
  return error ? null : user
}

async function signedQr(sc, path) {
  if (!path) return null
  const { data } = await sc.storage.from(QR_BUCKET).createSignedUrl(path, QR_TTL_SECONDS)
  return data?.signedUrl || null
}

async function checkoutResult(sc, buyerId, orderIds, idempotentReplay) {
  const { data: orders, error } = await sc
    .from('orders')
    .select(`
      id, buyer_id, seller_id, pickup_location_id, status, currency, total_myr, created_at,
      pickup_locations(name, address, operating_notes),
      order_items(id, quantity, unit_myr, line_myr, card_name, set_code, set_name, collector_number, foil, condition)
    `)
    .in('id', orderIds)
    .eq('buyer_id', buyerId)
    .order('created_at', { ascending: true })
  if (error || (orders || []).length !== orderIds.length) throw new Error('Could not load checkout result')

  const sellerIds = [...new Set(orders.map(order => order.seller_id))]
  const { data: profiles, error: profileError } = await sc
    .from('profiles')
    .select(`
      id, display_name, merchant_bank_name, merchant_account_name,
      merchant_account_number, merchant_duitnow_id, merchant_payment_instructions,
      merchant_bank_qr_path, merchant_tng_qr_path, merchant_profile_completed_at
    `)
    .in('id', sellerIds)
  if (profileError) throw new Error('Could not load seller payment details')

  const paymentBySeller = new Map()
  for (const profile of profiles || []) {
    if (!profile.merchant_profile_completed_at) throw new Error('Seller payment profile is incomplete')
    const [bankQrUrl, tngQrUrl] = await Promise.all([
      signedQr(sc, profile.merchant_bank_qr_path),
      signedQr(sc, profile.merchant_tng_qr_path),
    ])
    paymentBySeller.set(profile.id, {
      seller_name: profile.display_name || 'Seller',
      bank_name: profile.merchant_bank_name,
      account_name: profile.merchant_account_name,
      account_number: profile.merchant_account_number,
      duitnow_id: profile.merchant_duitnow_id,
      payment_instructions: profile.merchant_payment_instructions,
      bank_qr_url: bankQrUrl,
      tng_qr_url: tngQrUrl,
      qr_expires_in_seconds: QR_TTL_SECONDS,
    })
  }

  return {
    orders: orders.map(order => ({ ...order, payment: paymentBySeller.get(order.seller_id) })),
    idempotent_replay: idempotentReplay,
    payment_visibility: 'checkout_response_only',
  }
}

export async function GET() {
  const user = await authenticate()
  if (!user) return privateJson({ error: 'Unauthorized' }, { status: 401 })
  const sc = makeServiceClient()
  const { data, error } = await sc
    .from('pickup_locations')
    .select('id, slug, name, address, operating_notes, is_default')
    .eq('active', true)
    .order('is_default', { ascending: false })
    .order('name', { ascending: true })
  if (error) return privateJson({ error: 'Checkout is not configured yet' }, { status: 503 })
  return privateJson({ locations: data || [] })
}

export async function POST(request) {
  const user = await authenticate()
  if (!user) return privateJson({ error: 'Unauthorized' }, { status: 401 })

  let body
  try { body = await request.json() } catch {
    return privateJson({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (!UUID.test(body.idempotency_key || '')) {
    return privateJson({ error: 'A valid idempotency_key UUID is required' }, { status: 400 })
  }
  if (!UUID.test(body.pickup_location_id || '')) {
    return privateJson({ error: 'A valid pickup_location_id UUID is required' }, { status: 400 })
  }

  const sc = makeServiceClient()

  // A retry after the first transaction committed must return the same order set,
  // even though the original cart rows have already been removed.
  const { data: prior } = await sc
    .from('checkout_requests')
    .select('status, order_ids')
    .eq('buyer_id', user.id)
    .eq('idempotency_key', body.idempotency_key)
    .maybeSingle()
  if (prior?.status === 'completed' && prior.order_ids?.length) {
    try {
      return privateJson(await checkoutResult(sc, user.id, prior.order_ids, true))
    } catch (error) {
      return privateJson({ error: error.message }, { status: 500 })
    }
  }

  const { data: location } = await sc
    .from('pickup_locations')
    .select('id')
    .eq('id', body.pickup_location_id)
    .eq('active', true)
    .maybeSingle()
  if (!location) return privateJson({ error: 'Pickup location is unavailable' }, { status: 409 })

  try {
    await ensurePriceCache()
  } catch (error) {
    console.error('[POST /api/checkout] price cache', error?.message || error)
    return privateJson({ error: 'Current prices are temporarily unavailable. Checkout was not created.' }, { status: 503 })
  }

  const { data: cartRows, error: cartError } = await sc
    .from('cart_items')
    .select(`
      id, user_id, listing_id,
      listings(
        id, user_id, library_card_id, multiplier, quantity, status, expires_at,
        library_cards(
          id, user_id, scryfall_id, quantity, foil, condition,
          card_index(name, set_code, set_name, collector_number)
        )
      )
    `)
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })
  if (cartError) return privateJson({ error: 'Could not revalidate cart' }, { status: 503 })
  if (!cartRows?.length) return privateJson({ error: 'Cart is empty' }, { status: 400 })
  if (cartRows.length > 100) return privateJson({ error: 'Checkout is limited to 100 cart items' }, { status: 400 })

  const now = Date.now()
  const conflicts = []
  const trustedItems = []
  for (const row of cartRows) {
    const listing = row.listings
    const card = listing?.library_cards
    let reason = null
    if (!listing || !card) reason = 'Listing or inventory is missing'
    else if (listing.user_id === user.id) reason = 'You cannot buy your own listing'
    else if (listing.status !== 'active') reason = 'Listing is no longer active'
    else if (!listing.expires_at || new Date(listing.expires_at).getTime() <= now) reason = 'Listing has expired'
    else if (!Number.isInteger(listing.quantity) || listing.quantity < 1 || card.quantity < 1) reason = 'Insufficient quantity'

    const ckdUsd = !reason ? lookupPrice(card.scryfall_id, card.foil) : null
    const unitMyr = ckdUsd == null ? null : sellPrice(ckdUsd, Number(listing.multiplier))
    if (!reason && (!Number.isFinite(unitMyr) || unitMyr <= 0)) reason = 'Current price is unavailable'

    if (reason) {
      conflicts.push({ cart_item_id: row.id, listing_id: row.listing_id, reason })
      continue
    }
    trustedItems.push({
      cart_item_id: row.id,
      listing_id: listing.id,
      unit_myr: unitMyr,
      card_name: card.card_index?.name || 'Unknown card',
      set_code: card.card_index?.set_code || null,
      set_name: card.card_index?.set_name || null,
      collector_number: card.card_index?.collector_number || null,
    })
  }
  if (conflicts.length) {
    return privateJson({ error: 'Checkout conflicts must be resolved before ordering', conflicts }, { status: 409 })
  }

  const sellerIds = [...new Set(cartRows.map(row => row.listings.user_id))]
  const { data: sellers, error: sellersError } = await sc
    .from('profiles')
    .select('id, merchant_profile_completed_at, merchant_bank_name, merchant_account_name, merchant_account_number, merchant_duitnow_id')
    .in('id', sellerIds)
  if (sellersError) return privateJson({ error: 'Could not verify seller payment profiles' }, { status: 503 })
  const completeSellerIds = new Set((sellers || []).filter(seller =>
    seller.merchant_profile_completed_at && seller.merchant_bank_name?.trim() && seller.merchant_account_name?.trim() &&
    (seller.merchant_account_number?.trim() || seller.merchant_duitnow_id?.trim())
  ).map(seller => seller.id))
  const incompleteSellers = sellerIds.filter(id => !completeSellerIds.has(id))
  if (incompleteSellers.length) {
    return privateJson({ error: 'One or more sellers cannot accept payment yet', seller_ids: incompleteSellers }, { status: 409 })
  }

  const { data: rpcData, error: rpcError } = await sc.rpc('checkout_orders', {
    p_buyer_id: user.id,
    p_idempotency_key: body.idempotency_key,
    p_pickup_location_id: body.pickup_location_id,
    p_items: trustedItems,
  })
  if (rpcError) {
    console.error('[POST /api/checkout] atomic checkout', rpcError.message)
    return privateJson({ error: rpcError.message || 'Checkout conflict; no order was created' }, { status: 409 })
  }

  const orderIds = rpcData?.order_ids || []
  if (!orderIds.length) return privateJson({ error: 'Checkout returned no orders' }, { status: 500 })
  try {
    return privateJson(await checkoutResult(sc, user.id, orderIds, Boolean(rpcData.idempotent_replay)), { status: 201 })
  } catch (error) {
    console.error('[POST /api/checkout] response', error.message)
    return privateJson({ error: 'Orders were created, but payment details could not be displayed. Contact support before retrying payment.' }, { status: 500 })
  }
}
