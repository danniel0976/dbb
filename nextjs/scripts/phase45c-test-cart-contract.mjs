// Focused source-contract checks for the 45C cart slice. Runtime SQL/API and
// concurrent gates remain the release owner's responsibility.
import fs from 'node:fs'

const read = path => fs.readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const cart = read('nextjs/src/app/api/cart/route.js')
const item = read('nextjs/src/app/api/cart/[id]/route.js')
const checkout = read('nextjs/src/app/api/checkout/route.js')
const ui = read('nextjs/src/components/CartView.js')
const clientUuid = read('nextjs/src/lib/clientUuid.mjs')
const nav = read('nextjs/src/components/DBBNav.js')
const cartBadge = read('nextjs/src/lib/cartBadge.mjs')
const runtime = read('nextjs/scripts/phase45c-runtime-cart-uat.mjs')
const migration = read('supabase/migrations/20260726000000_phase45c_cart_hardening.sql')
const contract = read('supabase/migrations/20260726000001_phase45c_cart_hardening_contract.sql')

const checks = [
  [cart, "p_quantity: quantity", 'cart add forwards requested quantity'],
  [cart, 'requested_quantity', 'cart GET exposes requested quantity'],
  [cart, 'claim_sale:', 'cart GET exposes Claim Sale context'],
  [cart, 'claim_sales!listings_claim_sale_id_fkey', 'cart GET disambiguates Claim Sale relationship'],
  [cart, 'const reader = serviceClient()', 'cart GET reads seller-owned rows through scoped service client'],
  [checkout, 'claim_sales!listings_claim_sale_id_fkey', 'checkout cart read disambiguates Claim Sale relationship'],
  [item, 'expected_version', 'absolute quantity PATCH uses CAS version'],
  [checkout, 'p_request_fingerprint', 'checkout binds fingerprint'],
  [ui, 'cart_item_id: item.id, quantity: item.requested_quantity', 'checkout sends snapshot quantities'],
  [ui, 'useState(createClientUuid)', 'cart initializes its idempotency key without assuming crypto.randomUUID'],
  [clientUuid, 'typeof cryptoApi?.randomUUID', 'cart UUID uses the native browser API when present'],
  [clientUuid, 'bytes[6] = (bytes[6] & 0x0f) | 0x40', 'cart UUID fallback preserves RFC 4122 version 4 format'],
  [nav, "window.addEventListener('dbb-cart-updated'", 'cart badge refreshes immediately after a cart mutation'],
  [cartBadge, "new Event('dbb-cart-updated')", 'cart mutations publish a badge refresh event'],
  [ui, 'Decrease quantity', 'cart UI quantity controls are present'],
  [migration, 'marketplace_card_reservations', 'migration transfers shared reservations'],
  [migration, 'ORDER BY value->>\'listing_id\'', 'checkout locks listings deterministically'],
  [migration, 'cart_items_quantity_range', 'cart quantity constraint is defined'],
  [migration, 'featured_listing_id', 'featured listing is post-baseline expand'],
  [contract, 'DROP POLICY IF EXISTS cart_items_insert_own', 'cart write contract is separate from expand'],
  // The acquisition write must END at the sentinel: psql meta-commands consume
  // the rest of their line, so any SQL trailing \echo would release the lock
  // immediately and fabricate overlap. Terminating the write here also keeps the
  // transaction open on stdin, so the hold is released by this process rather
  // than by a pre-queued timer.
  [runtime, '\\\\echo BARRIER_ACQUIRED\n`)', 'barrier sentinel is newline-delimited and ends the acquisition write'],
  [runtime, 'child.stdin.end(`\nSELECT pg_sleep(0.05);\nCOMMIT;\n`)', 'barrier hold and COMMIT are newline-delimited on the release write'],
  [runtime, 'await holder.acquired', 'overlap waits for explicit barrier acquisition'],
  [runtime, 'BARRIER_LISTING_NOT_FOUND', 'barrier fails closed when its listing is absent'],
]

for (const [source, needle, description] of checks) {
  if (!source.includes(needle)) throw new Error(`FAIL: ${description}`)
  console.log(`PASS: ${description}`)
}
