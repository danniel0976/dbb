import { NextResponse } from 'next/server'
import { createClient as createAuthClient } from '@/lib/supabaseServer'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { requireCompleteMerchantProfile } from '@/lib/merchantProfile'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UNDEF_TABLE = '42P01'
const UNDEF_COLUMN = '42703'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const VALID_INCREMENTS = ['any', '1', '5', '10']
const VALID_DURATIONS = [1, 3, 6, 12, 24]
const VALID_FINISHES = ['normal', 'foil', 'etched']

function makeServiceClient() {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
}

async function authenticate() {
  const authClient = await createAuthClient()
  const { data: { user }, error } = await authClient.auth.getUser()
  return { authClient, user: error ? null : user }
}

function invalidTitle(value) {
  if (typeof value !== 'string') return { error: 'TITLE_NOT_ALLOWED' }
  const title = value.normalize('NFKC').replace(/\s+/gu, ' ').trim()
  if (title.length < 3) return { error: 'TITLE_NOT_ALLOWED' }
  if (title.length > 60) return { error: 'TITLE_NOT_ALLOWED' }
  if (/(?:https?|ftp):\/\/|www\./iu.test(title)) return { error: 'TITLE_NOT_ALLOWED' }
  if (/(?:\+?60|0[1-9])[0-9\s-]{7,12}/u.test(title) || /\b\d{10,11}\b/u.test(title)) {
    return { error: 'TITLE_NOT_ALLOWED' }
  }
  if (/@[\p{L}\p{N}_]{2,}|(?:t\.me|wa\.me|tiktok\.com)\//iu.test(title)) {
    return { error: 'TITLE_NOT_ALLOWED' }
  }
  if (/\b(?:spam|scam|free|giveaway)\b/iu.test(title)) return { error: 'TITLE_NOT_ALLOWED' }
  if (!/[A-Za-z0-9À-ɏ]/.test(title)) return { error: 'TITLE_NOT_ALLOWED' }
  return { title }
}

function codeOf(error) {
  return String(error?.message || '').split(/[\s:]/, 1)[0] || 'RPC_ERROR'
}

function statusOf(code) {
  if (['NOT_OWNER', 'NOT_A_MERCHANT', 'MERCHANT_INCOMPLETE', 'MERCHANT_PROFILE_REQUIRED'].includes(code)) return 403
  if (code === 'AUCTION_NOT_FOUND') return 404
  if (['TITLE_TOO_SHORT', 'TITLE_TOO_LONG', 'TITLE_INVALID', 'INVALID_INCREMENT', 'BID_INCREMENT_INVALID', 'INVALID_DURATION', 'DURATION_INVALID', 'STARTING_BID_TOO_LOW', 'STARTING_BID_TOO_HIGH', 'STARTING_BID_INVALID', 'BUYOUT_MUST_EXCEED_START', 'BUYOUT_TOO_HIGH', 'BUYOUT_INVALID', 'SOFT_CLOSE_INVALID', 'INVALID_QUANTITY'].includes(code)) return 400
  if (['PHOTO_REQUIRED', 'NO_LOT_ITEMS', 'EMPTY_LOT', 'LOT_TOO_MANY_ITEMS', 'LOT_TOO_MANY_COPIES'].includes(code)) return 422
  if (['CARD_UNAVAILABLE', 'CARD_NOT_OWNED', 'LOT_UNAVAILABLE', 'DUPLICATE_LOT_ITEM', 'RESERVATION_CONFLICT', 'RESERVATION_TRANSFER_FAILED', 'AUCTION_NOT_DRAFT', 'STATUS_NOT_DRAFT', 'ALREADY_PUBLISHED'].includes(code)) return 409
  return 500
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

function validateDraft(body) {
  const title = invalidTitle(body.title)
  if (title.error) return title
  if (!Number.isInteger(body.starting_bid_myr) || body.starting_bid_myr < 1 || body.starting_bid_myr > 99999) {
    return { error: 'STARTING_BID_INVALID', reason: 'starting_bid_myr must be a whole number from 1 to 99999' }
  }
  if (!VALID_INCREMENTS.includes(body.bid_increment)) {
    return { error: 'BID_INCREMENT_INVALID', reason: 'bid_increment must be any, 1, 5, or 10' }
  }
  if (!VALID_DURATIONS.includes(body.duration_hours)) {
    return { error: 'DURATION_INVALID', reason: 'duration_hours must be 1, 3, 6, 12, or 24' }
  }
  if (body.buyout_myr !== undefined && body.buyout_myr !== null &&
      (!Number.isInteger(body.buyout_myr) || body.buyout_myr <= body.starting_bid_myr || body.buyout_myr > 99999)) {
    return { error: 'BUYOUT_INVALID', reason: 'buyout_myr must exceed starting_bid_myr and be at most 99999' }
  }
  if (body.soft_close_enabled !== undefined && typeof body.soft_close_enabled !== 'boolean') {
    return { error: 'SOFT_CLOSE_INVALID', reason: 'soft_close_enabled must be boolean' }
  }
  return { title: title.title }
}

function validateItems(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 20) {
    return { error: 'LOT_ITEM_COUNT_INVALID', reason: 'items must contain 1 to 20 distinct cards' }
  }
  const seen = new Set()
  for (const item of items) {
    if (!UUID.test(item?.library_card_id || '')) return { error: 'LIBRARY_CARD_ID_INVALID', reason: 'Each item needs a valid library_card_id' }
    if (seen.has(item.library_card_id.toLowerCase())) return { error: 'DUPLICATE_LOT_ITEM', reason: 'Each library card may appear only once' }
    seen.add(item.library_card_id.toLowerCase())
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 100) return { error: 'INVALID_QUANTITY', reason: 'Each quantity must be a whole number from 1 to 100' }
  }
  if (items.reduce((total, item) => total + item.quantity, 0) > 100) return { error: 'LOT_TOO_MANY_COPIES' }
  return { items }
}

async function loadAuction(sc, id) {
  const { data, error } = await sc.from('auctions').select(
    'id, title, seller_id, status, starting_bid_myr, buyout_myr, bid_increment, duration_hours, soft_close_enabled, soft_close_extension_minutes, expires_at, created_at, published_at, original_expires_at, extension_minutes, extended_at, current_bid_myr, bid_count'
  ).eq('id', id).maybeSingle()
  if (error) throw error
  if (!data) return null
  const [{ data: seller }, { data: itemRows, error: itemError }] = await Promise.all([
    sc.from('profiles').select('id, display_name').eq('id', data.seller_id).maybeSingle(),
    sc.from('auction_items').select('id, library_card_id, quantity, card_name, scryfall_id, finish, condition, set_code, set_name, collector_number').eq('auction_id', id).order('id', { ascending: true }),
  ])
  if (itemError) throw itemError
  const items = itemRows || []
  return {
    ...data,
    seller: { id: data.seller_id, display_name: seller?.display_name || null },
    seller_name: seller?.display_name || null,
    items,
  }
}

export async function GET(request) {
  const { user } = await authenticate()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { searchParams } = new URL(request.url)
  const parsedPage = Number.parseInt(searchParams.get('page') || '1', 10)
  const page = Number.isFinite(parsedPage) ? Math.max(1, parsedPage) : 1
  const sort = searchParams.get('sort') || 'new'
  const search = (searchParams.get('search') || '').trim()
  const sc = makeServiceClient()
  const now = new Date()
  let query = sc.from('auctions').select(
    'id, title, seller_id, status, starting_bid_myr, buyout_myr, current_bid_myr, bid_count, bid_increment, duration_hours, soft_close_enabled, expires_at, created_at',
    { count: 'exact' }
  ).eq('status', 'active')
  query = query.gt('expires_at', now.toISOString())

  if (sort === 'expiring_12h') {
    query = query.gt('expires_at', new Date(now.getTime() + 60 * 60 * 1000).toISOString())
      .lte('expires_at', new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString())
      .order('expires_at', { ascending: true })
  } else if (sort === 'expiring_soon') {
    query = query.gt('expires_at', now.toISOString())
      .lte('expires_at', new Date(now.getTime() + 60 * 60 * 1000).toISOString())
      .order('expires_at', { ascending: true })
  } else {
    query = query.gte('created_at', new Date(now.getTime() - 12 * 60 * 60 * 1000).toISOString())
      .order('created_at', { ascending: false })
  }
  if (search) query = query.ilike('title', `%${search}%`)
  const from = (page - 1) * 20
  const { data, count, error } = await query.range(from, from + 19)
  if (error) {
    if (error.code === UNDEF_TABLE || error.code === UNDEF_COLUMN) {
      return NextResponse.json({ auctions: [], total: 0, hasMore: false, page })
    }
    console.error('[GET /api/auctions]', error.message)
    return NextResponse.json({ auctions: [], total: 0, hasMore: false, page }, { status: 503 })
  }

  const rows = data || []
  const sellerIds = [...new Set(rows.map(row => row.seller_id).filter(Boolean))]
  let profiles = []
  if (sellerIds.length) {
    const result = await sc.from('profiles').select('id, display_name').in('id', sellerIds)
    if (!result.error) profiles = result.data || []
  }
  const sellerNames = new Map(profiles.map(profile => [profile.id, profile.display_name || null]))
  const auctionIds = rows.map(row => row.id)
  const lotMap = new Map()
  if (auctionIds.length) {
    const { data: lotRows, error: lotError } = await sc.from('auction_items').select(
      'auction_id, quantity, scryfall_id, library_cards(scryfall_id, card_index(image_uris))'
    ).in('auction_id', auctionIds).order('id', { ascending: true })
    if (!lotError) {
      for (const item of lotRows || []) {
        const summary = lotMap.get(item.auction_id) || { item_count: 0, total_quantity: 0, first_image_url: null, first_scryfall_id: null }
        summary.item_count += 1
        summary.total_quantity += item.quantity || 0
        const scryfallId = item.scryfall_id || item.library_cards?.scryfall_id || null
        const imageUris = item.library_cards?.card_index?.image_uris
        if (!summary.first_scryfall_id) summary.first_scryfall_id = scryfallId
        if (!summary.first_image_url) summary.first_image_url = imageUris?.small || imageUris?.normal || null
        lotMap.set(item.auction_id, summary)
      }
    }
  }
  const total = count || 0
  return NextResponse.json({
    auctions: rows.map(row => ({
      ...row,
      seller: { id: row.seller_id, display_name: sellerNames.get(row.seller_id) || null },
      seller_name: sellerNames.get(row.seller_id) || null,
      lot_summary: lotMap.get(row.id) || { item_count: 0, total_quantity: 0, first_image_url: null, first_scryfall_id: null },
    })),
    total,
    hasMore: from + rows.length < total,
    page,
  })
}

export async function POST(request) {
  const { authClient, user } = await authenticate()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const merchantGate = await requireCompleteMerchantProfile(authClient, user.id)
  if (merchantGate) return NextResponse.json({ error: merchantGate.error, code: merchantGate.code }, { status: merchantGate.status })

  let body
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  const validation = validateDraft(body || {})
  if (validation.error) return NextResponse.json(validation, { status: validation.error === 'TITLE_NOT_ALLOWED' ? 422 : 400 })
  const itemValidation = validateItems(body.items)
  if (itemValidation.error) return NextResponse.json(itemValidation, { status: itemValidation.error === 'LOT_TOO_MANY_COPIES' ? 422 : 400 })

  const sc = makeServiceClient()
  const { data, error } = await sc.rpc('create_auction_draft', {
    p_seller_id: user.id,
    p_title: validation.title,
    p_starting_bid_myr: body.starting_bid_myr,
    p_bid_increment: body.bid_increment,
    p_duration_hours: body.duration_hours,
    p_buyout_myr: body.buyout_myr === undefined ? null : body.buyout_myr,
    p_soft_close_enabled: body.soft_close_enabled === undefined ? false : body.soft_close_enabled,
  })
  if (error) {
    console.error('[POST /api/auctions]', error.message)
    const code = codeOf(error)
    return NextResponse.json(errorBody(code, error), { status: statusOf(code) })
  }
  const auctionId = data
  const ids = itemValidation.items.map(item => item.library_card_id)
  const { data: cards, error: cardError } = await sc.from('library_cards').select('id, user_id, quantity, scryfall_id, foil, condition, language').in('id', ids)
  if (cardError) {
    await sc.from('auctions').delete().eq('id', auctionId)
    return NextResponse.json({ error: 'Could not validate auction items' }, { status: 500 })
  }
  const cardMap = new Map((cards || []).map(card => [card.id.toLowerCase(), card]))
  const missingOwnership = itemValidation.items.filter(item => {
    const card = cardMap.get(item.library_card_id.toLowerCase())
    return !card || card.user_id !== user.id || item.quantity > card.quantity
  }).map(item => item.library_card_id)
  if (missingOwnership.length) {
    await sc.from('auctions').delete().eq('id', auctionId)
    return NextResponse.json({ error: 'CARD_UNAVAILABLE', code: 'CARD_UNAVAILABLE', unavailable_items: missingOwnership }, { status: 409 })
  }
  const scryfallIds = [...new Set((cards || []).map(card => card.scryfall_id).filter(Boolean))]
  const { data: cardIndexRows } = scryfallIds.length
    ? await sc.from('card_index').select('scryfall_id, name, set_code, set_name, collector_number').in('scryfall_id', scryfallIds)
    : { data: [] }
  const indexMap = new Map((cardIndexRows || []).map(card => [card.scryfall_id, card]))
  const { data: photos } = await sc.from('card_photos').select('library_card_id').in('library_card_id', ids)
  const photoIds = new Set((photos || []).map(photo => photo.library_card_id.toLowerCase()))
  const missingPhotos = ids.filter(id => !photoIds.has(id.toLowerCase()))
  if (missingPhotos.length) {
    await sc.from('auctions').delete().eq('id', auctionId)
    return NextResponse.json({ error: 'PHOTO_REQUIRED', code: 'PHOTO_REQUIRED', missing_photos: missingPhotos }, { status: 422 })
  }
  const rows = itemValidation.items.map(item => {
    const card = cardMap.get(item.library_card_id.toLowerCase())
    const indexed = indexMap.get(card.scryfall_id) || {}
    const finish = VALID_FINISHES.includes(card.foil) ? card.foil : 'normal'
    return { auction_id: auctionId, library_card_id: item.library_card_id, quantity: item.quantity, card_name: indexed.name || 'Unknown card', scryfall_id: card.scryfall_id, set_code: indexed.set_code || null, set_name: indexed.set_name || null, collector_number: indexed.collector_number || null, finish, condition: card.condition || null, language: card.language || null }
  })
  const { error: itemError } = await sc.from('auction_items').insert(rows)
  if (itemError) {
    await sc.from('auctions').delete().eq('id', auctionId)
    const code = itemError.code === '23505' ? 'DUPLICATE_LOT_ITEM' : 'CARD_UNAVAILABLE'
    return NextResponse.json(errorBody(code, itemError), { status: statusOf(code) })
  }
  try {
    const auction = await loadAuction(sc, auctionId)
    return NextResponse.json({ auction }, { status: 201 })
  } catch (loadError) {
    console.error('[POST /api/auctions] response load', loadError?.message || loadError)
    return NextResponse.json({ error: 'Could not load created auction' }, { status: 500 })
  }
}
