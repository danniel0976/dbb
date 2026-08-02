#!/usr/bin/env node

// Idempotent, disposable Phase 45C phone click-through fixture.
// Run with NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 so the public
// phone-facing URL in .env.local is never changed and the local-host guard
// remains intact.
//
// Reset semantics: this script restores the exact fresh click-through state.
// Before re-seeding the listings it neutralises only the local artifacts a
// previous UAT run leaves behind — cart rows for the two fixture listings and
// open orders whose every line is a fixture listing sold by the fixture seller
// (cancelled through the production transition_order RPC, not by hand-editing
// rows). Anything outside that synthetic scope aborts the run instead of being
// touched, and every cleanup step is asserted rather than assumed.
//
// Fixture isolation: the reset owns exactly two shared surfaces and must leave
// the rest of each intact.
//   * follows — only Dan's follow of the fixture seller and of the fixture
//     claim sale are cleared. Every other follow row Dan holds is snapshotted
//     before the delete and re-asserted afterwards.
//   * price-cache/ck-prices.json — the fixture's four synthetic keys (two
//     `d2000000-…` scryfall ids and two `uat …` names) are merged into whatever
//     the bucket already holds; the object is never replaced wholesale, and
//     every pre-existing key is re-asserted byte-for-byte after the write.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import {
  buildPriceCacheMerge,
  assertPriceCachePreserved,
  isPlainObject,
} from './lib/price-cache-merge.mjs'

config({ path: path.resolve(new URL('../.env.local', import.meta.url).pathname), override: false })

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !serviceKey) throw new Error('Missing Supabase environment')
const parsed = new URL(url)
if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
  throw new Error(`Refusing non-local Supabase host: ${parsed.hostname}`)
}

const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
const SELLER_EMAIL = 'seller_uat@dbb.test'
const SELLER_PASSWORD = 'password1234'
const SELLER_NAME = 'seller_uat'
const CLAIM_TITLE = 'seller_uat Test Claim Sale'
const CARD_IDS = [
  'd2000000-0000-4000-8000-000000000001',
  'd2000000-0000-4000-8000-000000000002',
]

// The only price-cache keys this fixture owns. Both namespaces are synthetic
// (`d2000000-…` scryfall ids, `uat …` card names) so they can never collide
// with a real Card Kingdom row.
const FIXTURE_PRICE_IDS = {
  [CARD_IDS[0]]: { n: 0.25, f: 0.75, e: null, b: null },
  [CARD_IDS[1]]: { n: 1.5, f: 4.0, e: null, b: null },
}
const FIXTURE_PRICE_NAMES = {
  'uat lightning bolt': { n: 0.25, f: 0.75, e: null, b: null },
  'uat counterspell': { n: 1.5, f: 4.0, e: null, b: null },
}
const PRICE_CACHE_BUCKET = 'price-cache'
const PRICE_CACHE_FILE = 'ck-prices.json'

function deterministicUuid(label) {
  const digest = crypto.createHash('sha256').update(`phase45c-clickthrough:${label}`).digest('hex')
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`
}

async function findUser(email) {
  const { data, error } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 })
  if (error) throw error
  return (data.users || []).find(user => user.email?.toLowerCase() === email) || null
}

async function ensureUser(email, password, metadata) {
  let user = await findUser(email)
  if (!user) {
    const result = await db.auth.admin.createUser({
      email, password, email_confirm: true, user_metadata: metadata,
    })
    if (result.error) throw result.error
    user = result.data.user
  }
  if (!user?.id) throw new Error(`Could not resolve ${email}`)
  return user
}

async function upsert(table, rows, onConflict = 'id') {
  const { error } = await db.from(table).upsert(rows, { onConflict })
  if (error) throw new Error(`${table} upsert failed: ${error.message}`)
}

async function readPriceCache() {
  const { data, error } = await db.storage.from(PRICE_CACHE_BUCKET).download(PRICE_CACHE_FILE)
  if (error) {
    if (/not found|does not exist|Object not found/i.test(error.message || '')) return null
    throw new Error(`price-cache read failed: ${error.message}`)
  }
  const text = await data.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (parseError) {
    throw new Error(`price-cache is not valid JSON; refusing to overwrite it: ${parseError.message}`)
  }
  if (!isPlainObject(parsed)) {
    throw new Error('price-cache is not a JSON object; refusing to overwrite it')
  }
  return parsed
}

// Merge the fixture's four synthetic keys into the shared cache object without
// replacing it. Every key the bucket already held is snapshotted before the
// write and re-asserted after it, so an unrelated Card Kingdom import survives
// a fixture reset untouched.
async function ensureUatPriceCache() {
  const { error: bucketError } = await db.storage.createBucket(PRICE_CACHE_BUCKET, { public: true })
  if (bucketError && !/already exists|duplicate/i.test(bucketError.message || '')) {
    throw new Error(`price-cache bucket setup failed: ${bucketError.message}`)
  }

  const existing = await readPriceCache()
  // buildPriceCacheMerge owns both invariants: it aborts on a nested `prices`
  // or `names` that is not a plain object, and it classifies fixture keys by
  // own-property test so an inherited name such as `constructor` stays in the
  // preserved set. It throws before anything is uploaded.
  const { preserved, merged } = buildPriceCacheMerge({
    existing,
    fixturePrices: FIXTURE_PRICE_IDS,
    fixtureNames: FIXTURE_PRICE_NAMES,
  })

  const { error: uploadError } = await db.storage
    .from(PRICE_CACHE_BUCKET)
    .upload(PRICE_CACHE_FILE, Buffer.from(JSON.stringify(merged)), {
      contentType: 'application/json',
      upsert: true,
    })
  if (uploadError) throw new Error(`price-cache fixture upload failed: ${uploadError.message}`)

  const after = await readPriceCache()
  if (!after) throw new Error('price-cache fixture write did not produce a readable object')
  assertPriceCachePreserved({
    after,
    preserved,
    fixturePrices: FIXTURE_PRICE_IDS,
    fixtureNames: FIXTURE_PRICE_NAMES,
  })

  return {
    fixture_price_keys: Object.keys(FIXTURE_PRICE_IDS).length + Object.keys(FIXTURE_PRICE_NAMES).length,
    preserved_price_ids: Object.keys(preserved.prices).length,
    preserved_price_names: Object.keys(preserved.names).length,
    preserved_other_keys: Object.keys(preserved.other),
  }
}

const seller = await ensureUser(SELLER_EMAIL, SELLER_PASSWORD, {
  username: SELLER_NAME, display_name: SELLER_NAME,
})
const dan = await ensureUser('dan@dbb.test', SELLER_PASSWORD, {
  username: 'dan_uat', display_name: 'Dan UAT',
})

const profile = {
  merchant_bank_name: 'DBB local UAT only',
  merchant_account_name: SELLER_NAME,
  merchant_account_number: '0000000000',
  merchant_duitnow_id: null,
  merchant_payment_instructions: 'Synthetic fixture; not payment data.',
  merchant_profile_completed_at: '2026-07-26T00:00:00.000Z',
}
for (const [id, displayName, username] of [[seller.id, SELLER_NAME, SELLER_NAME], [dan.id, 'Dan UAT', 'dan_uat']]) {
  const { error } = await db.from('profiles').update({ display_name: displayName, username, ...(id === seller.id ? profile : {}) }).eq('id', id)
  if (error) throw new Error(`profiles update failed: ${error.message}`)
}

const binderId = deterministicUuid(`${seller.id}:binder`)
await upsert('binders', [{
  id: binderId, user_id: seller.id, name: 'seller_uat Bazaar Fixture',
  description: 'Disposable synthetic Phase 45C click-through fixture.', is_default: false,
}], 'id')

const { data: catalog, error: catalogError } = await db.from('card_index').select('scryfall_id, name').in('scryfall_id', CARD_IDS)
if (catalogError) throw catalogError
if ((catalog || []).length !== CARD_IDS.length) throw new Error(`Expected ${CARD_IDS.length} catalog cards, found ${(catalog || []).length}`)

const priceCacheReset = await ensureUatPriceCache()

const libraryCards = CARD_IDS.map((scryfallId, index) => ({
  id: deterministicUuid(`${seller.id}:card:${scryfallId}`), user_id: seller.id, binder_id: binderId,
  scryfall_id: scryfallId, quantity: 3, foil: index === 0 ? 'normal' : 'foil',
  condition: index === 0 ? 'NM' : 'LP', language: 'en', starred: false,
  purchase_price: null, purchase_currency: null, date_added: '2026-07-26T00:00:00.000Z',
}))
await upsert('library_cards', libraryCards, 'id')

const claimSaleId = deterministicUuid(`${seller.id}:claim-sale`)
await upsert('claim_sales', [{
  id: claimSaleId, user_id: seller.id, title: CLAIM_TITLE,
  description: 'Synthetic local UAT claim sale: tap Follow, then tap again to unfollow.',
  set_code: 'uat', duration_hours: 24,
  expires_at: '2099-12-31T23:59:59.000Z', status: 'active', delivery_option: 'pickup',
  created_at: '2026-07-26T00:00:00.000Z',
}], 'id')

const listings = libraryCards.map((card, index) => ({
  id: deterministicUuid(`${seller.id}:listing:${index + 1}`), user_id: seller.id,
  library_card_id: card.id, multiplier: index === 0 ? 2.5 : 2.8, quantity: 1,
  status: 'active', created_at: '2026-07-26T00:00:00.000Z',
  expires_at: '2099-12-31T23:59:59.000Z', claim_sale_id: claimSaleId,
}))
const listingIds = listings.map(listing => listing.id)
const libraryCardIds = libraryCards.map(card => card.id)

async function select(table, build) {
  const { data, error } = await build(db.from(table).select('*'))
  if (error) throw new Error(`${table} read failed: ${error.message}`)
  return data || []
}

// --- Neutralise prior UAT artifacts (fixture scope only) --------------------
const cleanup = { cart_rows_deleted: 0, orders_cancelled: [] }

const cartRows = await select('cart_items', q => q.in('listing_id', listingIds))
if (cartRows.length > 0) {
  const { error } = await db.from('cart_items').delete().in('listing_id', listingIds)
  if (error) throw new Error(`fixture cart cleanup failed: ${error.message}`)
  cleanup.cart_rows_deleted = cartRows.length
}
const cartLeft = await select('cart_items', q => q.in('listing_id', listingIds))
if (cartLeft.length !== 0) {
  throw new Error(`fixture cart cleanup incomplete: ${cartLeft.length} rows remain`)
}

const fixtureOrderItems = await select('order_items', q => q.in('listing_id', listingIds))
const candidateOrderIds = [...new Set(fixtureOrderItems.map(row => row.order_id))]
if (candidateOrderIds.length > 0) {
  const orders = await select('orders', q => q.in('id', candidateOrderIds))
  for (const order of orders) {
    if (['order_completed', 'cancelled'].includes(order.status)) continue
    if (order.seller_id !== seller.id) {
      throw new Error(`Refusing to touch order ${order.id}: seller ${order.seller_id} is outside the fixture`)
    }
    const allItems = await select('order_items', q => q.eq('order_id', order.id))
    const foreign = allItems.filter(item => !listingIds.includes(item.listing_id))
    if (foreign.length > 0) {
      throw new Error(`Refusing to cancel order ${order.id}: ${foreign.length} line(s) are outside the fixture`)
    }
    const { data: cancelled, error } = await db.rpc('transition_order', {
      p_order_id: order.id,
      p_actor_id: order.seller_id,
      p_action: 'cancel',
      p_reason: 'Phase 45C disposable click-through fixture reset',
    })
    if (error) throw new Error(`fixture order ${order.id} cancel failed: ${error.message}`)
    if (cancelled?.status !== 'cancelled') {
      throw new Error(`fixture order ${order.id} did not reach cancelled (got ${cancelled?.status})`)
    }
    cleanup.orders_cancelled.push(order.id)
  }
}

const openOrders = (await select('orders', q => q.in('id', candidateOrderIds)))
  .filter(order => !['order_completed', 'cancelled'].includes(order.status))
if (openOrders.length !== 0) {
  throw new Error(`fixture order cleanup incomplete: ${openOrders.length} order(s) still open`)
}
const orderHolds = await select('marketplace_card_reservations', q => q
  .in('library_card_id', libraryCardIds).eq('source_kind', 'order'))
if (orderHolds.length !== 0) {
  throw new Error(`fixture order reservations still hold ${orderHolds.length} card(s)`)
}

// --- Restore the offered listings ------------------------------------------
await upsert('listings', listings, 'id')

// Dan must begin with a clean Follow button for both the fixture seller and the
// fixture claim sale — and only for those two. A blanket delete on
// follower_id would silently destroy every unrelated follow Dan holds, so the
// reset snapshots them first, scopes each delete to one fixture target, and
// re-asserts the untouched rows afterwards.
const danFollowsBefore = await select('follows', q => q.eq('follower_id', dan.id))
const isFixtureFollow = row => row.followee_id === seller.id || row.claim_sale_id === claimSaleId
const unrelatedFollowsBefore = danFollowsBefore.filter(row => !isFixtureFollow(row))

// Written out target by target on purpose: a literal column keeps the delete
// scope readable and lets the tracked gate scan for an unscoped form.
const sellerFollowDelete = await db.from('follows').delete()
  .eq('follower_id', dan.id).eq('followee_id', seller.id)
if (sellerFollowDelete.error) {
  throw new Error(`Dan seller follow cleanup failed: ${sellerFollowDelete.error.message}`)
}
const saleFollowDelete = await db.from('follows').delete()
  .eq('follower_id', dan.id).eq('claim_sale_id', claimSaleId)
if (saleFollowDelete.error) {
  throw new Error(`Dan claim sale follow cleanup failed: ${saleFollowDelete.error.message}`)
}

const danFollowsAfter = await select('follows', q => q.eq('follower_id', dan.id))
const fixtureFollowsLeft = danFollowsAfter.filter(isFixtureFollow)
if (fixtureFollowsLeft.length !== 0) {
  throw new Error(`fixture follow cleanup incomplete: ${fixtureFollowsLeft.length} row(s) remain`)
}
const survivingIds = new Set(danFollowsAfter.map(row => row.id))
const destroyed = unrelatedFollowsBefore.filter(row => !survivingIds.has(row.id))
if (destroyed.length !== 0) {
  throw new Error(`fixture reset destroyed ${destroyed.length} unrelated follow row(s) for Dan`)
}
const followsReset = {
  fixture_follows_deleted: danFollowsBefore.length - unrelatedFollowsBefore.length,
  unrelated_follows_preserved: unrelatedFollowsBefore.length,
}

// --- Assert the exact fresh click-through state -----------------------------
const finalListings = await select('listings', q => q.in('id', listingIds))
if (finalListings.length !== listingIds.length) {
  throw new Error(`Expected ${listingIds.length} fixture listings, found ${finalListings.length}`)
}
for (const listing of finalListings) {
  const expected = listings.find(row => row.id === listing.id)
  if (listing.status !== 'active') throw new Error(`Listing ${listing.id} status ${listing.status}, expected active`)
  if (Number(listing.quantity) !== 1) throw new Error(`Listing ${listing.id} quantity ${listing.quantity}, expected 1`)
  if (listing.claim_sale_id !== claimSaleId) throw new Error(`Listing ${listing.id} is not linked to the fixture claim sale`)
  if (Number(listing.multiplier) !== expected.multiplier) {
    throw new Error(`Listing ${listing.id} multiplier ${listing.multiplier}, expected ${expected.multiplier}`)
  }
  if (new Date(listing.expires_at).getTime() <= Date.now()) {
    throw new Error(`Listing ${listing.id} is already expired`)
  }
}

// Offered supply (listings.quantity = 1) is deliberately smaller than the
// seller's inventory (library_cards.quantity = 3): the buyer surfaces must show
// the offered amount, never the private inventory count.
const finalCards = await select('library_cards', q => q.in('id', libraryCardIds))
for (const card of finalCards) {
  if (Number(card.quantity) !== 3) throw new Error(`Library card ${card.id} quantity ${card.quantity}, expected 3`)
}

const finalReservations = await select('marketplace_card_reservations', q => q.in('library_card_id', libraryCardIds))
for (const listing of listings) {
  const held = finalReservations.filter(row => row.library_card_id === listing.library_card_id)
  if (held.length !== 1) {
    throw new Error(`Card ${listing.library_card_id} has ${held.length} reservations, expected exactly 1`)
  }
  const [reservation] = held
  if (reservation.source_kind !== 'listing' || reservation.source_id !== listing.id) {
    throw new Error(`Card ${listing.library_card_id} is held by ${reservation.source_kind} ${reservation.source_id}, expected its own listing`)
  }
  if (Number(reservation.reserved_quantity) !== 1) {
    throw new Error(`Card ${listing.library_card_id} reserved_quantity ${reservation.reserved_quantity}, expected 1`)
  }
}

const danCart = await select('cart_items', q => q.eq('user_id', dan.id))
if (danCart.length !== 0) {
  throw new Error(`Dan still has ${danCart.length} cart row(s) after reset`)
}

const rows = { seller, dan, claimSaleId, binderId, libraryCards, listings, catalog }
fs.writeFileSync('/tmp/phase45c-clickthrough-seed.json', JSON.stringify(rows, null, 2))
console.log(JSON.stringify({
  fixture: 'phase45c-clickthrough', supabase_host: parsed.hostname,
  seller: { id: seller.id, email: SELLER_EMAIL, display_name: SELLER_NAME },
  dan: { id: dan.id, email: 'dan@dbb.test' },
  claim_sale: { id: claimSaleId, title: CLAIM_TITLE },
  listings: listings.map((listing, index) => ({
    id: listing.id,
    card: catalog.find(c => c.scryfall_id === CARD_IDS[index])?.name || CARD_IDS[index],
    status: 'active',
    offered_quantity: 1,
    seller_inventory_quantity: 3,
  })),
  dan_fixture_follows: 0,
  dan_cart_rows: 0,
  reset: { ...cleanup, follows: followsReset, price_cache: priceCacheReset },
  asserted: 'listings active qty 1, one listing reservation per card, no order holds, empty Dan cart, '
    + 'unrelated follows preserved, unrelated price-cache keys preserved',
}, null, 2))
