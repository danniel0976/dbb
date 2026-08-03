import { NextResponse } from 'next/server'
import { createClient as createAuthClient } from '@/lib/supabaseServer'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { ensurePriceCache, lookupPrice, sellPrice } from '@/lib/pricingCache'

export const runtime = 'nodejs'

const TABLE_NOT_EXIST = '42P01'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function serviceClient() {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
}

function codeFromError(error) {
  const message = String(error?.message || '')
  return ['INVALID_QUANTITY', 'OWN_LISTING', 'LISTING_NOT_FOUND', 'LISTING_UNAVAILABLE',
    'CLAIM_SALE_ENDED', 'INSUFFICIENT_STOCK', 'LISTING_CARD_OWNER_MISMATCH',
    'CART_ITEM_CHANGED', 'CART_ITEM_NOT_FOUND']
    .find(code => message.includes(code)) || null
}

function mutationError(error) {
  const code = codeFromError(error)
  const status = ['OWN_LISTING', 'LISTING_CARD_OWNER_MISMATCH'].includes(code) ? 403
    : code === 'LISTING_NOT_FOUND' || code === 'CART_ITEM_NOT_FOUND' ? 404
      : code ? 409 : 503
  const body = { code: code || 'CART_UNAVAILABLE', error: code || 'Cart mutation is temporarily unavailable' }
  if (code === 'INSUFFICIENT_STOCK') {
    try { body.details = JSON.parse(error.details || error.hint || '{}') } catch { /* safe fallback */ }
  }
  return NextResponse.json(body, { status })
}

async function userForRequest() {
  const authClient = await createAuthClient()
  const { data: { user }, error } = await authClient.auth.getUser()
  return error ? null : user
}

export async function GET() {
  const authClient = await createAuthClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'AUTH_REQUIRED', code: 'AUTH_REQUIRED' }, { status: 401 })

  try { await ensurePriceCache() } catch { /* prices are rendered as unavailable */ }
  // Auth has established the buyer; service reads are needed for seller-owned
  // listing/card rows that RLS correctly hides from the buyer after reservation.
  // The explicit user_id predicate keeps this response scoped to that buyer's cart.
  const reader = serviceClient()
  // Temporal expiry cannot fire a row trigger. Reconcile a bounded batch before
  // rendering current availability; checkout still revalidates independently.
  await reader.rpc('phase45c_reconcile_expired_listings', { p_limit: 200 })
  const { data, error } = await reader
    .from('cart_items')
    .select(`
      id, user_id, listing_id, quantity, updated_at, version, created_at,
      listings(
        id, user_id, multiplier, quantity, status, expires_at, claim_sale_id,
        claim_sales!listings_claim_sale_id_fkey(id, title, status, expires_at),
        library_cards(
          id, scryfall_id, foil, condition,
          card_index(name, set_code, set_name, collector_number, rarity, type_line, image_uris)
        )
      )
    `)
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })
  if (error) {
    if (error.code === TABLE_NOT_EXIST || error.code === '42703') return NextResponse.json({ items: [], total_units: 0 })
    console.error('[GET /api/cart]', error.message)
    return NextResponse.json({ error: 'Could not load cart' }, { status: 503 })
  }

  const sellerIds = [...new Set((data || []).map(ci => ci.listings?.user_id).filter(Boolean))]
  const sellerMap = {}
  if (sellerIds.length) {
    const { data: profiles } = await reader.from('profiles').select('id, display_name').in('id', sellerIds)
    for (const profile of profiles || []) sellerMap[profile.id] = profile.display_name
  }

  const now = Date.now()
  const items = (data || []).map(ci => {
    const listing = ci.listings
    const card = listing?.library_cards
    const claimSale = Array.isArray(listing?.claim_sales) ? listing.claim_sales[0] : listing?.claim_sales
    const listingExpired = !listing || !listing.expires_at || new Date(listing.expires_at).getTime() <= now
    const claimEnded = Boolean(claimSale && (claimSale.status !== 'active' || !claimSale.expires_at || new Date(claimSale.expires_at).getTime() <= now))
    const available = Number(listing?.quantity || 0)
    const ckdUsd = card?.scryfall_id ? lookupPrice(card.scryfall_id, card.foil || 'normal') : null
    const unitMyr = ckdUsd != null && listing && Number.isFinite(Number(listing.multiplier))
      ? sellPrice(ckdUsd, Number(listing.multiplier)) : null
    let availabilityState = 'available'
    if (!listing || !card) availabilityState = 'unavailable'
    else if (claimEnded) availabilityState = 'claim_sale_ended'
    else if (listingExpired) availabilityState = 'expired'
    else if (listing.status !== 'active' || available < 1) availabilityState = 'unavailable'
    else if (available < ci.quantity) availabilityState = 'reduced'
    else if (unitMyr == null || !Number.isFinite(unitMyr)) availabilityState = 'price_unavailable'
    const lineMyr = unitMyr != null ? Math.round(unitMyr * ci.quantity * 100) / 100 : null
    return {
      id: ci.id,
      created_at: ci.created_at,
      updated_at: ci.updated_at,
      listing_id: listing?.id || null,
      listing_status: listing?.status || null,
      requested_quantity: ci.quantity,
      available_quantity: available,
      cart_version: ci.version,
      availability_state: availabilityState,
      // A reduced line is stale, not checkout-eligible. Keep the requested
      // quantity visible so the buyer can choose an explicit update.
      is_available: availabilityState === 'available',
      multiplier: listing?.multiplier ?? null,
      seller_id: listing?.user_id || null,
      seller_name: listing?.user_id ? (sellerMap[listing.user_id] || null) : null,
      claim_sale: claimSale ? { id: claimSale.id, title: claimSale.title } : null,
      library_card: card ? {
        id: card.id, scryfall_id: card.scryfall_id, foil: card.foil,
        condition: card.condition, card_index: card.card_index,
      } : null,
      ckd_usd: ckdUsd,
      unit_myr: unitMyr,
      line_myr: lineMyr,
      // Legacy names remain for older consumers, but now reflect quantities.
      quantity: available,
      myr_price: unitMyr,
    }
  })
  return NextResponse.json({ items, total_units: items.reduce((sum, item) => sum + (item.requested_quantity || 0), 0) })
}

export async function POST(request) {
  const user = await userForRequest()
  if (!user) return NextResponse.json({ error: 'AUTH_REQUIRED', code: 'AUTH_REQUIRED' }, { status: 401 })
  let body
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  const listingId = body?.listing_id
  const quantity = body?.quantity === undefined ? 1 : body.quantity
  if (!UUID.test(listingId || '') || !Number.isInteger(quantity) || quantity < 1 || quantity > 9999) {
    return NextResponse.json({ error: 'Choose a whole number of at least 1.', code: 'INVALID_QUANTITY' }, { status: 400 })
  }
  const { data, error } = await serviceClient().rpc('phase45c_cart_add', {
    p_buyer_id: user.id, p_listing_id: listingId, p_quantity: quantity,
  })
  if (error) return mutationError(error)
  return NextResponse.json({ ...(data || {}), code: data?.already_in_cart ? 'ALREADY_IN_CART' : undefined }, { status: data?.already_in_cart ? 200 : 201 })
}
