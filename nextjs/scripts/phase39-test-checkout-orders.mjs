import { readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
let passed = 0
let failed = 0

function source(path) {
  return readFileSync(resolve(ROOT, path), 'utf8')
}

function test(name, check) {
  try {
    check()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (error) {
    console.error(`  ✗ ${name}: ${error.message}`)
    failed++
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const sql = source('supabase/migration-016-orders.sql')
const checkout = source('nextjs/src/app/api/checkout/route.js')
const orders = source('nextjs/src/app/api/orders/route.js')
const transition = source('nextjs/src/app/api/orders/[id]/transition/route.js')
const noShow = source('nextjs/src/app/api/orders/[id]/no-show/route.js')
const merchant = source('nextjs/src/app/api/profile/merchant/route.js')
const merchantGate = source('nextjs/src/lib/merchantProfile.js')
const listings = source('nextjs/src/app/api/listings/route.js')
const listingEdit = source('nextjs/src/app/api/listings/[id]/route.js')
const claimSales = source('nextjs/src/app/api/claim-sales/route.js')
const cart = source('nextjs/src/components/CartView.js')

console.log('\n=== Phase 39 Checkout and Orders Tests ===\n')

test('migration defines seller-grouped order and immutable item snapshot tables', () => {
  for (const table of ['orders', 'order_items', 'checkout_requests', 'order_events', 'order_cancellation_requests', 'order_no_show_reports']) {
    assert(sql.includes(`public.${table}`), `missing ${table}`)
  }
  assert(sql.includes("currency text NOT NULL DEFAULT 'MYR'"), 'MYR currency not fixed')
  assert(sql.includes('card_name text NOT NULL'), 'card name snapshot missing')
})

test('checkout function is atomic, lock-based, quantity-aware, and idempotent', () => {
  assert(sql.includes('CREATE OR REPLACE FUNCTION public.checkout_orders'), 'checkout RPC missing')
  assert(sql.includes('FOR UPDATE'), 'row locking missing')
  assert(sql.includes("ORDER BY value->>'listing_id'"), 'deterministic lock ordering missing')
  assert(sql.includes('UNIQUE (buyer_id, idempotency_key)'), 'idempotency uniqueness missing')
  assert(sql.includes("status = CASE WHEN quantity - 1 = 0 THEN 'reserved'"), 'listing reservation missing')
  assert(sql.includes("current_user IN ('postgres', 'service_role')"), 'trusted reservation mutation bypass missing')
  assert(sql.includes('DELETE FROM public.cart_items'), 'cart cleanup missing')
  assert(sql.includes("'idempotent_replay', true"), 'replay response missing')
})

test('ordinary clients cannot execute trusted checkout or mutation functions', () => {
  for (const fn of ['checkout_orders', 'transition_order', 'request_order_cancellation', 'report_order_no_show']) {
    assert(sql.includes(`REVOKE ALL ON FUNCTION public.${fn}`), `missing revoke for ${fn}`)
  }
  assert(sql.includes('TO service_role'), 'service role grants missing')
})

test('RLS limits order records to buyer and seller participants', () => {
  assert(sql.includes('auth.uid() = buyer_id OR auth.uid() = seller_id'), 'orders participant policy missing')
  assert(sql.includes('participants read order items'), 'order item RLS missing')
  assert(sql.includes('participants read order events'), 'order event RLS missing')
  assert(!sql.includes('FOR INSERT WITH CHECK'), 'authenticated direct write policy should not exist')
})

test('checkout revalidates cart, owner, status, expiry, quantities, and server price', () => {
  assert(checkout.includes(".from('cart_items')"), 'server cart load missing')
  assert(checkout.includes("listing.user_id === user.id"), 'self-owned validation missing')
  assert(checkout.includes("listing.status !== 'active'"), 'active status validation missing')
  assert(checkout.includes('new Date(listing.expires_at)'), 'expiry validation missing')
  assert(checkout.includes('listing.quantity') && checkout.includes('card.quantity'), 'quantity validation missing')
  assert(checkout.includes('ensurePriceCache()') && checkout.includes('sellPrice('), 'server pricing missing')
  assert(!checkout.includes('body.total') && !checkout.includes('body.unit_myr'), 'client price/total is trusted')
})

test('multi-seller checkout uses one trusted RPC and exposes payment only in checkout response', () => {
  assert(checkout.includes("sc.rpc('checkout_orders'"), 'atomic RPC call missing')
  assert(checkout.includes("payment_visibility: 'checkout_response_only'"), 'payment visibility boundary missing')
  assert(checkout.includes("Cache-Control', 'private, no-store"), 'private no-store header missing')
  assert(!orders.includes('merchant_account_number'), 'orders API leaks permanent payment details')
})

test('merchant profiling is self-declared, private, and enforced before every listing path', () => {
  assert(merchant.includes("const BUCKET = 'merchant-payment-qr'"), 'private QR route missing')
  assert(merchant.includes('createSignedUrl') && merchant.includes('createSignedUploadUrl'), 'signed QR access missing')
  assert(sql.includes('merchant_bank_qr_owned_path') && sql.includes("id::text || '/bank_qr.jpg'"), 'bank QR ownership constraint missing')
  assert(sql.includes('merchant_tng_qr_owned_path') && sql.includes("id::text || '/tng_qr.jpg'"), 'TNG QR ownership constraint missing')
  assert(merchantGate.includes('requireCompleteMerchantProfile'), 'merchant gate helper missing')
  assert(listings.includes('requireCompleteMerchantProfile'), 'single listing creation gate missing')
  assert(listingEdit.includes('requireCompleteMerchantProfile'), 'listing edit/relist gate missing')
  assert(claimSales.includes('requireCompleteMerchantProfile'), 'claim sale listing gate missing')
  assert(sql.includes('listings_require_merchant_profile'), 'database merchant gate missing')
})

test('fulfilment is store pickup only with Cards & Hobbies default and address', () => {
  assert(sql.includes("'Cards & Hobbies'"), 'default store missing')
  assert(sql.includes('A-3-5, Parklanes Commercial Hub'), 'store address missing')
  assert(sql.includes('is_default boolean NOT NULL DEFAULT false'), 'default location flag missing')
  assert(claimSales.includes("const VALID_DELIVERY_OPTIONS = ['pickup']"), 'claim sales still permit shipping')
  assert(cart.includes('TCG store pickup') && cart.includes('pickupLocationId'), 'pickup dropdown UI missing')
})

test('role-owned transition sequence and audited seller cancellation are enforced in SQL', () => {
  const sequence = ["p_action = 'preparing_order'", "p_action = 'payment_received'", "p_action = 'dropped_off'", "p_action = 'order_completed'"]
  for (const token of sequence) assert(sql.includes(token), `missing ${token}`)
  assert(sql.includes("p_actor_id = v_order.seller_id"), 'seller ownership missing')
  assert(sql.includes("p_actor_id = v_order.buyer_id"), 'buyer ownership missing')
  assert(sql.includes("p_action = 'cancel' AND p_actor_id = v_order.seller_id"), 'seller-only cancellation missing')
  assert(sql.includes('cancelled_by = p_actor_id') && sql.includes('cancellation_reason'), 'cancellation audit missing')
  assert(transition.includes("const ACTIONS = ['preparing_order', 'payment_received', 'dropped_off', 'order_completed', 'cancel']"), 'route action allowlist missing')
})

test('buyer cancellation request and bounded no-show reports record actor, reason, and timestamps', () => {
  assert(sql.includes('Only the buyer can request cancellation'), 'buyer cancellation ownership missing')
  assert(sql.includes('actor_id uuid NOT NULL') && sql.includes('requested_at timestamptz NOT NULL'), 'cancellation audit fields missing')
  assert(sql.includes("report_type IN ('buyer_unpaid', 'seller_stale_after_payment')"), 'bounded report types missing')
  assert(sql.includes('UNIQUE (order_id, reporter_id, report_type)'), 'repeat-report bound missing')
  assert(noShow.includes('ORDER_PAYMENT_NO_SHOW_HOURS') && noShow.includes('ORDER_SELLER_STALE_HOURS'), 'configurable thresholds missing')
  assert(noShow.includes('boundedInt'), 'threshold safety bounds missing')
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed) process.exit(1)
