// Per-test teardown for the Phase 45C rendered UAT.
//
// The rendered tests drive real product paths, so they leave real rows behind:
// cart items, and — in the reserved-state test — an unpaid order that holds the
// seller's copy. A test that ends mid-flight (assertion failure, timeout, a
// blocked backend request) would otherwise poison every later test and leave
// Dan's fixture in a state his UAT never produced.
//
// This module runs after *every* test and proves, not assumes, the fixture is
// back where the seeder left it:
//   * the buyer's cart is empty,
//   * no fixture order is open,
//   * no order-sourced reservation holds a fixture card,
//   * both listings are active, offering 1, held by exactly their own listing
//     reservation.
//
// Cleanup is the same permitted local fixture scope the seeder uses: delete
// cart rows keyed to the fixture listings, and cancel fixture-only orders
// through the production transition_order RPC. Anything outside that scope
// aborts instead of being touched. Every step is failure-safe — one failing
// step never skips the rest — and all failures are reported together.

const path = require('node:path')
const { createClient } = require('@supabase/supabase-js')
const { APPROVED_BACKEND_ORIGIN } = require('./local-backend-guard')

require('dotenv').config({ path: path.resolve(__dirname, '../../.env.local'), override: false })

const TERMINAL_ORDER_STATUSES = ['order_completed', 'cancelled']
const BUYER_EMAIL = 'dan@dbb.test'

// Service-role client bound to the approved loopback origin explicitly — never
// to NEXT_PUBLIC_SUPABASE_URL, which points at the phone-facing Tailscale host.
function adminClient() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceKey) {
    throw new Error('fixture cleanup: SUPABASE_SERVICE_ROLE_KEY is not available')
  }
  return createClient(APPROVED_BACKEND_ORIGIN, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

async function selectRows(db, table, build) {
  const { data, error } = await build(db.from(table).select('*'))
  if (error) throw new Error(`${table} read failed: ${error.message}`)
  return data || []
}

// Resolve the fixture from the database rather than from a /tmp seed dump, so
// teardown describes the state that actually exists.
async function resolveFixture(db, claimSaleId) {
  const sales = await selectRows(db, 'claim_sales', q => q.eq('id', claimSaleId))
  if (sales.length !== 1) {
    throw new Error(`fixture cleanup: claim sale ${claimSaleId} not found — re-run the seeder`)
  }
  const listings = await selectRows(db, 'listings', q => q.eq('claim_sale_id', claimSaleId))
  if (listings.length === 0) {
    throw new Error(`fixture cleanup: claim sale ${claimSaleId} has no listings — re-run the seeder`)
  }
  const { data: users, error } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 })
  if (error) throw new Error(`fixture cleanup: listUsers failed: ${error.message}`)
  const buyer = (users.users || []).find(u => u.email?.toLowerCase() === BUYER_EMAIL)
  if (!buyer) throw new Error(`fixture cleanup: buyer ${BUYER_EMAIL} not found — re-run the seeder`)

  return {
    claimSaleId,
    sellerId: sales[0].user_id,
    buyerId: buyer.id,
    listingIds: listings.map(row => row.id),
    libraryCardIds: listings.map(row => row.library_card_id),
  }
}

// Delete only cart rows keyed to the fixture listings, then prove both that
// they are gone and that the buyer's cart as a whole is empty.
async function clearFixtureCart(db, fixture, report) {
  const rows = await selectRows(db, 'cart_items', q => q.in('listing_id', fixture.listingIds))
  if (rows.length > 0) {
    const { error } = await db.from('cart_items').delete().in('listing_id', fixture.listingIds)
    if (error) throw new Error(`fixture cart cleanup failed: ${error.message}`)
    report.cart_rows_deleted = rows.length
  }
  const left = await selectRows(db, 'cart_items', q => q.in('listing_id', fixture.listingIds))
  if (left.length !== 0) throw new Error(`fixture cart cleanup incomplete: ${left.length} row(s) remain`)

  const buyerCart = await selectRows(db, 'cart_items', q => q.eq('user_id', fixture.buyerId))
  if (buyerCart.length !== 0) {
    throw new Error(`fixture cart not empty: buyer still holds ${buyerCart.length} row(s)`)
  }
}

// Cancel fixture-only open orders through the production RPC. An order with a
// foreign seller or a single foreign line aborts the teardown rather than being
// cancelled — the same refusal the seeder makes.
async function cancelFixtureOrders(db, fixture, report) {
  const fixtureItems = await selectRows(db, 'order_items', q => q.in('listing_id', fixture.listingIds))
  const candidateIds = [...new Set(fixtureItems.map(row => row.order_id))]
  if (candidateIds.length === 0) return

  for (const order of await selectRows(db, 'orders', q => q.in('id', candidateIds))) {
    if (TERMINAL_ORDER_STATUSES.includes(order.status)) continue
    if (order.seller_id !== fixture.sellerId) {
      throw new Error(
        `Refusing to touch order ${order.id}: seller ${order.seller_id} is outside the fixture`)
    }
    const allItems = await selectRows(db, 'order_items', q => q.eq('order_id', order.id))
    const foreign = allItems.filter(item => !fixture.listingIds.includes(item.listing_id))
    if (foreign.length > 0) {
      throw new Error(
        `Refusing to cancel order ${order.id}: ${foreign.length} line(s) are outside the fixture`)
    }
    const { data: cancelled, error } = await db.rpc('transition_order', {
      p_order_id: order.id,
      p_actor_id: order.seller_id,
      p_action: 'cancel',
      p_reason: 'Phase 45C rendered UAT teardown',
    })
    if (error) throw new Error(`fixture order ${order.id} cancel failed: ${error.message}`)
    if (cancelled?.status !== 'cancelled') {
      throw new Error(`fixture order ${order.id} did not reach cancelled (got ${cancelled?.status})`)
    }
    report.orders_cancelled.push(order.id)
  }

  const stillOpen = (await selectRows(db, 'orders', q => q.in('id', candidateIds)))
    .filter(order => !TERMINAL_ORDER_STATUSES.includes(order.status))
  if (stillOpen.length !== 0) {
    throw new Error(`fixture order cleanup incomplete: ${stillOpen.length} order(s) still open`)
  }
}

// The restoration proof. Cancelling the unpaid order must hand the offered
// copy back: no order-sourced hold survives, and each listing is active,
// offering 1, held by exactly its own listing reservation.
async function assertFixtureRestored(db, fixture) {
  const orderHolds = await selectRows(db, 'marketplace_card_reservations', q => q
    .in('library_card_id', fixture.libraryCardIds).eq('source_kind', 'order'))
  if (orderHolds.length !== 0) {
    throw new Error(`fixture order reservations still hold ${orderHolds.length} card(s)`)
  }

  const listings = await selectRows(db, 'listings', q => q.in('id', fixture.listingIds))
  if (listings.length !== fixture.listingIds.length) {
    throw new Error(
      `fixture listings missing: expected ${fixture.listingIds.length}, found ${listings.length}`)
  }
  for (const listing of listings) {
    if (listing.status !== 'active') {
      throw new Error(`fixture listing ${listing.id} status ${listing.status}, expected active`)
    }
    if (Number(listing.quantity) !== 1) {
      throw new Error(`fixture listing ${listing.id} quantity ${listing.quantity}, expected 1`)
    }
  }

  const reservations = await selectRows(db, 'marketplace_card_reservations', q => q
    .in('library_card_id', fixture.libraryCardIds))
  for (const listing of listings) {
    const held = reservations.filter(row => row.library_card_id === listing.library_card_id)
    if (held.length !== 1) {
      throw new Error(
        `fixture card ${listing.library_card_id} has ${held.length} reservations, expected exactly 1`)
    }
    const [reservation] = held
    if (reservation.source_kind !== 'listing' || reservation.source_id !== listing.id) {
      throw new Error(
        `fixture card ${listing.library_card_id} is held by ${reservation.source_kind} `
        + `${reservation.source_id}, expected its own listing`)
    }
    if (Number(reservation.reserved_quantity) !== 1) {
      throw new Error(
        `fixture card ${listing.library_card_id} reserved_quantity `
        + `${reservation.reserved_quantity}, expected 1`)
    }
  }
}

// Failure-safe: every step runs even if an earlier one throws, and all failures
// are reported together so a broken teardown is never mistaken for a clean one.
async function restoreFixture(claimSaleId) {
  const db = adminClient()
  const report = { cart_rows_deleted: 0, orders_cancelled: [] }
  const problems = []

  let fixture = null
  try {
    fixture = await resolveFixture(db, claimSaleId)
  } catch (error) {
    problems.push(error.message)
  }

  if (fixture) {
    for (const step of [clearFixtureCart, cancelFixtureOrders]) {
      try {
        await step(db, fixture, report)
      } catch (error) {
        problems.push(error.message)
      }
    }
    try {
      await assertFixtureRestored(db, fixture)
    } catch (error) {
      problems.push(error.message)
    }
  }

  if (problems.length > 0) {
    throw new Error(`fixture teardown failed:\n  - ${problems.join('\n  - ')}`)
  }
  return report
}

module.exports = {
  BUYER_EMAIL,
  TERMINAL_ORDER_STATUSES,
  adminClient,
  assertFixtureRestored,
  cancelFixtureOrders,
  clearFixtureCart,
  resolveFixture,
  restoreFixture,
}
