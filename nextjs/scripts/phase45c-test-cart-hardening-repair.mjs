// Focused source-contract checks for the blockers found in the independent
// Phase 45C review. These are intentionally narrow: real SQL barriers and
// authenticated API/UAT remain release-owner gates.
import fs from 'node:fs'

const read = path => fs.readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const migration = read('supabase/migrations/20260726000000_phase45c_cart_hardening.sql')
const contract = read('supabase/migrations/20260726000001_phase45c_cart_hardening_contract.sql')
const cart = read('nextjs/src/app/api/cart/route.js')
const cartItem = read('nextjs/src/app/api/cart/[id]/route.js')
const checkout = read('nextjs/src/app/api/checkout/route.js')
const transition = read('nextjs/src/app/api/orders/[id]/transition/route.js')
const cancel = read('nextjs/src/app/api/claim-sales/[id]/cancel/route.js')
const cartUi = read('nextjs/src/components/CartView.js')
const inspector = read('nextjs/src/components/ClaimSaleInspector.js')
const bazaar = read('nextjs/src/components/BazaarView.js')
const expiryRoute = read('nextjs/src/app/api/maintenance/phase45c-expiry/route.js')

const checks = [
  [migration, "phase45c:buyer:", 'checkout/cart buyer serialization lock'],
  [migration, 'phase45c_lock_claim_sale_resources', 'one Claim Sale lock hierarchy helper'],
  [migration, 'phase45c_expire_claim_sale', 'expiry uses the shared lock hierarchy'],
  [migration, 'Deliberately passive', 'parent status trigger cannot invert child locks'],
  [migration, "ORDER BY value->>'listing_id'", 'checkout listing UUID ordering'],
  [migration, 'ORDER BY lc.id FOR UPDATE', 'card UUID ordering'],
  [migration, 'ORDER BY l.id, mcr.library_card_id FOR UPDATE', 'listing reservation ordering'],
  [migration, 'phase45c_claim_sale_status_sync', 'Claim Sale status cleanup trigger'],
  [migration, 'phase45c_reconcile_expired_listings', 'temporal expiry reservation reconciler'],
  [migration, 'phase45c_cancel_claim_sale', 'atomic Claim Sale cancellation RPC'],
  [migration, 'CART_STALE', 'complete locked-cart snapshot assertion'],
  [migration, "v_item->>'multiplier'", 'locked listing multiplier price binding'],
  [migration, 'listing backfill exceeds physical inventory', 'conflict-safe reservation backfill'],
  [migration, 'phase45c_listing_card_owned', 'listing/card seller ownership join gate'],
  [migration, 'LISTING_CARD_OWNER_MISMATCH', 'safe cross-owner stock error'],
  [migration, 'OLD.library_card_id IS DISTINCT FROM NEW.library_card_id', 'retarget removes old reservation key'],
  [migration, 'm.library_card_id = l.library_card_id', 'bootstrap compares reservation card key'],
  [migration, 'm.reserved_quantity = l.quantity', 'bootstrap compares exact reservation quantity'],
  [migration, "jsonb_typeof(value->'quantity') <> 'number'", 'checkout validates JSON integer type before cast'],
  [migration, "!~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5]", 'checkout validates strict UUID shape before cast'],
  [migration, "0|[1-9][0-9]{0,3}", 'checkout bounds integer text before cast'],
  [expiryRoute, 'zero-token maintenance endpoint', 'hourly expiry cleanup contract'],
  [expiryRoute, "rpc('phase45c_reconcile_expired_listings'", 'maintenance invokes transactional expiry RPC'],
  [expiryRoute, 'MAINTENANCE_UNAUTHORIZED', 'maintenance route requires scheduler authentication'],
  [contract, 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE', 'cart contract is separated from expand'],
  [migration, 'v_item.quantity = p_quantity', 'absolute PATCH replay distinction'],
  [migration, 'ORDER_NOT_AUTHORIZED', 'terminal replay authorization'],
  [cart, 'is_available: availabilityState === \'available\'', 'reduced cart lines are stale'],
  [cartItem, 'expected_version', 'PATCH remains compare-and-set'],
  [checkout, 'multiplier: Number(listing.multiplier)', 'API sends price snapshot binding'],
  [transition, "const code = ['ORDER_NOT_FOUND', 'ORDER_NOT_AUTHORIZED'", 'safe transition error contract'],
  [cancel, "rpc('phase45c_cancel_claim_sale'", 'cancel route uses atomic lifecycle RPC'],
  [cartUi, 'Update to {item.available_quantity}', 'actionable reduced-cart update'],
  [cartUi, 'available_quantity: availableQuantity', 'quantity update applies available stock immediately'],
  [cartUi, 'availability_state: data.availability_state', 'quantity update resolves rendered availability state'],
  [cartUi, 'Line total RM', 'exact line-total presentation'],
  [inspector, 'href="/cart"', 'Claim Sale already-in-cart link'],
  [bazaar, 'data?.already_in_cart', 'Singles duplicate response parity'],
]

for (const [source, needle, description] of checks) {
  if (!source.includes(needle)) throw new Error(`FAIL: ${description}`)
  console.log(`PASS: ${description}`)
}
