import { NextResponse } from 'next/server'
import { createClient as createAuthClient } from '@/lib/supabaseServer'
import { createClient as createServiceClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const UNDEF_TABLE = '42P01'
const UNDEF_COLUMN = '42703'
const VALID_INCREMENTS = ['any', '1', '5', '10']
const VALID_DURATIONS = [1, 3, 6, 12, 24]
const VALID_FINISHES = ['normal', 'foil', 'etched']

function makeServiceClient() {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
}

async function authenticate() {
  const authClient = await createAuthClient()
  const { data: { user }, error } = await authClient.auth.getUser()
  return error ? null : user
}

function rpcCode(error) {
  return String(error?.message || '').split(/[\s:]/, 1)[0] || 'RPC_ERROR'
}

function rpcStatus(code) {
  if (['NOT_OWNER', 'CARD_NOT_OWNED'].includes(code)) return 403
  if (code === 'AUCTION_NOT_FOUND') return 404
  if (['TITLE_TOO_SHORT', 'TITLE_TOO_LONG', 'INVALID_INCREMENT', 'INVALID_DURATION', 'STARTING_BID_TOO_LOW', 'STARTING_BID_TOO_HIGH', 'BUYOUT_MUST_EXCEED_START', 'BUYOUT_TOO_HIGH', 'INVALID_QUANTITY'].includes(code)) return 400
  if (code === 'PHOTO_REQUIRED') return 422
  return 409
}

function titleValidation(value) {
  if (typeof value !== 'string') return { error: 'TITLE_NOT_ALLOWED' }
  const title = value.normalize('NFKC').replace(/\s+/gu, ' ').trim()
  if (title.length < 3 || title.length > 60) return { error: 'TITLE_NOT_ALLOWED' }
  if (/(?:https?|ftp):\/\/|www\./iu.test(title)) return { error: 'TITLE_NOT_ALLOWED' }
  if (/(?:\+?60|0[1-9])[0-9\s-]{7,12}/u.test(title) || /\b\d{10,11}\b/u.test(title)) return { error: 'TITLE_NOT_ALLOWED' }
  if (/@[\p{L}\p{N}_]{2,}|(?:t\.me|wa\.me|tiktok\.com)\//iu.test(title)) return { error: 'TITLE_NOT_ALLOWED' }
  if (/\b(?:spam|scam|free|giveaway)\b/iu.test(title)) return { error: 'TITLE_NOT_ALLOWED' }
  if (!/[A-Za-z0-9À-ɏ]/.test(title)) return { error: 'TITLE_NOT_ALLOWED' }
  return { title }
}

function validateHeader(body) {
  const fields = {}
  if (Object.prototype.hasOwnProperty.call(body, 'title')) {
    const result = titleValidation(body.title)
    if (result.error) return result
    fields.p_title = result.title
  }
  if (Object.prototype.hasOwnProperty.call(body, 'starting_bid_myr')) {
    if (!Number.isInteger(body.starting_bid_myr) || body.starting_bid_myr < 1 || body.starting_bid_myr > 99999) return { error: 'STARTING_BID_INVALID', reason: 'starting_bid_myr must be a whole number from 1 to 99999' }
    fields.p_starting_bid_myr = body.starting_bid_myr
  }
  if (Object.prototype.hasOwnProperty.call(body, 'bid_increment')) {
    if (!VALID_INCREMENTS.includes(body.bid_increment)) return { error: 'BID_INCREMENT_INVALID', reason: 'bid_increment must be any, 1, 5, or 10' }
    fields.p_bid_increment = body.bid_increment
  }
  if (Object.prototype.hasOwnProperty.call(body, 'duration_hours')) {
    if (!VALID_DURATIONS.includes(body.duration_hours)) return { error: 'DURATION_INVALID', reason: 'duration_hours must be 1, 3, 6, 12, or 24' }
    fields.p_duration_hours = body.duration_hours
  }
  if (Object.prototype.hasOwnProperty.call(body, 'buyout_myr')) {
    if (body.buyout_myr !== null && (!Number.isInteger(body.buyout_myr) || body.buyout_myr < 1 || body.buyout_myr > 99999)) return { error: 'BUYOUT_INVALID', reason: 'buyout_myr must be a whole number from 1 to 99999' }
    fields.p_buyout_myr = body.buyout_myr
    if (body.buyout_myr === null) fields.p_clear_buyout = true
  }
  if (Object.prototype.hasOwnProperty.call(body, 'soft_close_enabled')) {
    if (typeof body.soft_close_enabled !== 'boolean') return { error: 'SOFT_CLOSE_INVALID', reason: 'soft_close_enabled must be boolean' }
    fields.p_soft_close_enabled = body.soft_close_enabled
  }
  return { fields }
}

export async function GET(request, { params }) {
  const { id } = await params
  if (!UUID.test(id || '')) return NextResponse.json({ error: 'Invalid auction id' }, { status: 400 })
  const viewer = await authenticate()
  if (!viewer) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const sc = makeServiceClient()
  try {
    const { data: auction, error: auctionError } = await sc.from('auctions').select(
      'id, title, seller_id, status, starting_bid_myr, buyout_myr, current_bid_myr, current_bid_id, bid_count, bid_increment, duration_hours, soft_close_enabled, soft_close_extension_minutes, expires_at, created_at, published_at, original_expires_at, extension_minutes, extended_at'
    ).eq('id', id).maybeSingle()
    if (auctionError) {
      if (auctionError.code === UNDEF_TABLE || auctionError.code === UNDEF_COLUMN) return NextResponse.json({ error: 'Auctions not yet available' }, { status: 503 })
      throw auctionError
    }
    if (!auction) return NextResponse.json({ error: 'Auction not found' }, { status: 404 })
    if ((auction.status === 'draft' || auction.status === 'cancelled') && auction.seller_id !== viewer.id) {
      return NextResponse.json({ error: 'Auction not found' }, { status: 404 })
    }

    const [{ data: seller }, itemsResult, bidsResult, followResult] = await Promise.all([
      sc.from('profiles').select('display_name').eq('id', auction.seller_id).maybeSingle(),
      sc.from('auction_items').select(`
        library_card_id, quantity, card_name, scryfall_id, finish, condition,
        set_code, set_name, collector_number,
        library_cards(scryfall_id, foil, condition, card_index(name, set_code, set_name, collector_number, image_uris))
      `).eq('auction_id', id).order('id', { ascending: true }),
      sc.from('auction_bids').select('id, bidder_id, amount_myr, created_at').eq('auction_id', id)
        .order('amount_myr', { ascending: false }).order('created_at', { ascending: true }).order('id', { ascending: true }).limit(10),
      sc.from('follows').select('id').eq('follower_id', viewer.id).eq('auction_id', id).limit(1),
    ])
    if (itemsResult.error && itemsResult.error.code !== UNDEF_TABLE && itemsResult.error.code !== UNDEF_COLUMN) throw itemsResult.error
    if (bidsResult.error && bidsResult.error.code !== UNDEF_TABLE && bidsResult.error.code !== UNDEF_COLUMN) throw bidsResult.error
    if (followResult.error && followResult.error.code !== UNDEF_TABLE && followResult.error.code !== UNDEF_COLUMN) throw followResult.error
    const items = (itemsResult.data || []).map(item => ({
      library_card_id: item.library_card_id,
      quantity: item.quantity,
      card_name: item.card_name || item.library_cards?.card_index?.name || null,
      scryfall_id: item.scryfall_id || item.library_cards?.scryfall_id || null,
      finish: VALID_FINISHES.includes(item.finish) ? item.finish : (VALID_FINISHES.includes(item.library_cards?.foil) ? item.library_cards.foil : 'normal'),
      condition: item.condition || item.library_cards?.condition || null,
      set_code: item.set_code || item.library_cards?.card_index?.set_code || null,
      set_name: item.set_name || item.library_cards?.card_index?.set_name || null,
      collector_number: item.collector_number || item.library_cards?.card_index?.collector_number || null,
      image_uris: item.library_cards?.card_index?.image_uris || null,
    }))

    const bidderLabels = new Map()
    const bidHistory = (bidsResult.data || []).map((bid, index) => {
      if (!bidderLabels.has(bid.bidder_id)) bidderLabels.set(bid.bidder_id, `Bidder #${bidderLabels.size + 1}`)
      return { id: bid.id, bidder_label: bidderLabels.get(bid.bidder_id), amount_myr: bid.amount_myr, created_at: bid.created_at }
    })
    const currentBidRow = (bidsResult.data || []).find(bid => bid.id === auction.current_bid_id)
    const currentBid = currentBidRow ? {
      id: currentBidRow.id,
      bidder_label: bidderLabels.get(currentBidRow.bidder_id) || 'Bidder #1',
      amount_myr: currentBidRow.amount_myr,
      created_at: currentBidRow.created_at,
    } : null
    const step = auction.bid_increment === '5' ? 5 : auction.bid_increment === '10' ? 10 : 1
    const minNextBid = auction.current_bid_myr == null ? auction.starting_bid_myr : auction.current_bid_myr + step
    return NextResponse.json({
      ...auction,
      seller: { id: auction.seller_id, display_name: seller?.display_name || null },
      seller_name: seller?.display_name || null,
      items,
      current_bid: currentBid,
      bid_history: bidHistory,
      is_seller: viewer.id === auction.seller_id,
      is_following: !followResult.error && (followResult.data || []).length > 0,
      min_next_bid_myr: minNextBid,
      extension_minutes: auction.extension_minutes || 0,
      extended_at: auction.extended_at || null,
      original_expires_at: auction.original_expires_at || null,
      soft_close_enabled: Boolean(auction.soft_close_enabled),
      soft_close_extension_minutes: auction.soft_close_extension_minutes || 0,
    })
  } catch (error) {
    console.error('[GET /api/auctions/:id]', error?.message || error)
    return NextResponse.json({ error: 'Failed to load auction' }, { status: 500 })
  }
}

export async function PATCH(request, { params }) {
  const { id } = await params
  if (!UUID.test(id || '')) return NextResponse.json({ error: 'Invalid auction id' }, { status: 400 })
  const user = await authenticate()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  let body
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  body = body || {}
  const sc = makeServiceClient()
  let rpcName
  let payload
  if (body.action) {
    if (!['add_item', 'remove_item', 'update_item'].includes(body.action)) return NextResponse.json({ error: 'ACTION_INVALID' }, { status: 400 })
    if (!UUID.test(body.library_card_id || '')) return NextResponse.json({ error: 'A valid library_card_id is required' }, { status: 400 })
    if (body.action !== 'remove_item' && (!Number.isInteger(body.quantity) || body.quantity < 1 || body.quantity > 100)) return NextResponse.json({ error: 'QUANTITY_INVALID' }, { status: 400 })
    rpcName = { add_item: 'add_auction_draft_item', remove_item: 'remove_auction_draft_item', update_item: 'update_auction_draft_item' }[body.action]
    payload = { p_seller_id: user.id, p_auction_id: id, p_library_card_id: body.library_card_id }
    if (body.action !== 'remove_item') payload.p_quantity = body.quantity
  } else {
    const validation = validateHeader(body)
    if (validation.error) return NextResponse.json(validation, { status: validation.error === 'TITLE_NOT_ALLOWED' ? 422 : 400 })
    if (!Object.keys(validation.fields).length) return NextResponse.json({ error: 'No fields to update' }, { status: 400 })
    rpcName = 'update_auction_draft'
    payload = { p_seller_id: user.id, p_auction_id: id, ...validation.fields }
  }
  const { error } = await sc.rpc(rpcName, payload)
  if (error) {
    const code = rpcCode(error)
    return NextResponse.json({ error: code }, { status: rpcStatus(code) })
  }
  return NextResponse.json({})
}

export async function DELETE(request, { params }) {
  const { id } = await params
  if (!UUID.test(id || '')) return NextResponse.json({ error: 'Invalid auction id' }, { status: 400 })
  const user = await authenticate()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const sc = makeServiceClient()
  const { data: auction, error: fetchError } = await sc.from('auctions').select('seller_id, status').eq('id', id).maybeSingle()
  if (fetchError) {
    if (fetchError.code === UNDEF_TABLE || fetchError.code === UNDEF_COLUMN) return NextResponse.json({ error: 'Auctions not yet available' }, { status: 503 })
    return NextResponse.json({ error: 'Could not load auction' }, { status: 500 })
  }
  if (!auction) return NextResponse.json({ error: 'Auction not found' }, { status: 404 })
  if (auction.status !== 'draft') return NextResponse.json({ error: 'NOT_DRAFT' }, { status: 409 })
  if (auction.seller_id !== user.id) return NextResponse.json({ error: 'NOT_OWNER' }, { status: 403 })
  const { data: deleted, error: delError } = await sc.from('auctions').delete().eq('id', id).eq('seller_id', user.id).eq('status', 'draft').select('id').single()
  if (delError || !deleted) return NextResponse.json({ error: 'AUCTION_ALREADY_PUBLISHED' }, { status: 409 })
  return NextResponse.json({})
}
