// phase29-test-quantity-validation.mjs
// Mechanical tests for Phase 29 listing quantity validation.
// Tests the server-side validation logic without requiring a running server.
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
// Resolve from nextjs/scripts/ to repo root
const ROOT = resolve(__dirname, '../..')

const PASS = '\x1b[32mPASS\x1b[0m'
const FAIL = '\x1b[31mFAIL\x1b[0m'
const tests = []
let passed = 0, failed = 0

function test(name, fn) {
  tests.push({ name, fn })
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed')
}

function readSrc(rel) {
  return readFileSync(resolve(ROOT, rel), 'utf8')
}

// Test 1: Migration file exists and has correct structure
test('migration-014 file exists with quantity column and CHECK constraint', () => {
  const sql = readSrc('supabase/migration-014-listing-quantity.sql')
  assert(sql.includes('ADD COLUMN IF NOT EXISTS quantity integer'), 'Must add quantity integer column')
  assert(sql.includes('NOT NULL DEFAULT 1'), 'Must be NOT NULL DEFAULT 1')
  assert(sql.includes('listings_quantity_positive'), 'Must have quantity_positive constraint')
  assert(sql.includes('CHECK (quantity > 0)'), 'Must check quantity > 0')
})

// Test 2: POST /api/listings validates quantity as positive integer
test('POST /api/listings source validates quantity as positive integer', () => {
  const src = readSrc('nextjs/src/app/api/listings/route.js')
  assert(src.includes('_quantity'), 'Must compute _quantity from item')
  assert(src.includes('Number.isInteger(qty)'), 'Must validate integer')
  assert(src.includes('qty < 1'), 'Must reject quantity < 1')
  assert(src.includes('item._quantity > ownedQty'), 'Must reject oversell against owned quantity')
})

// Test 3: GET /api/listings includes quantity in select
test('GET /api/listings includes quantity in bazaar browse select', () => {
  const src = readSrc('nextjs/src/app/api/listings/route.js')
  assert(src.includes('expires_at, quantity,'), 'Bazaar browse must select quantity')
})

// Test 4: GET /api/listings/card/[scryfallId] includes quantity
test('GET /api/listings/card/[scryfallId] includes quantity', () => {
  const src = readSrc('nextjs/src/app/api/listings/card/[scryfallId]/route.js')
  assert(src.includes('expires_at, quantity,'), 'Card listings must select quantity')
})

// Test 5: PATCH /api/listings/[id] supports quantity with validation
test('PATCH /api/listings/[id] supports quantity with oversell validation', () => {
  const src = readSrc('nextjs/src/app/api/listings/[id]/route.js')
  assert(src.includes('body.quantity !== undefined'), 'Must handle quantity in PATCH')
  assert(src.includes('Number.isInteger(qty)'), 'Must validate integer in PATCH')
  assert(src.includes('qty > ownedQty'), 'Must reject oversell in PATCH')
})

// Test 6: POST /api/claim-sales validates per-card quantities
test('POST /api/claim-sales accepts and validates quantities', () => {
  const src = readSrc('nextjs/src/app/api/claim-sales/route.js')
  assert(src.includes('quantityMap'), 'Must have quantityMap logic')
  assert(src.includes('body.quantities'), 'Must accept quantities from body')
  assert(src.includes('Number.isInteger(qty)'), 'Must validate integer quantities')
  assert(src.includes('quantityMap[id] > ownedQty'), 'Must reject oversell in claim sales')
  assert(src.includes('quantity: quantityMap[cardId]'), 'Must pass quantity to listing rows')
})

// Test 7: PATCH /api/library/[id] has oversell protection
test('PATCH /api/library/[id] rejects quantity reduction below active listing', () => {
  const src = readSrc('nextjs/src/app/api/library/[id]/route.js')
  assert(src.includes('checkOversell'), 'Must have checkOversell function')
  assert(src.includes('l.quantity > newQuantity'), 'Must compare listing qty vs new qty')
  assert(src.includes('status: 409'), 'Must return 409 conflict')
})

// Test 8: CardDetailModal has listing quantity picker
test('CardDetailModal has listing quantity picker (1..owned)', () => {
  const src = readSrc('nextjs/src/components/CardDetailModal.js')
  assert(src.includes('listQuantity'), 'Must have listQuantity state')
  assert(src.includes('ownedQty'), 'Must compute ownedQty')
  assert(src.includes('max={ownedQty}'), 'Must cap at ownedQty')
  assert(src.includes('quantity: listQuantity'), 'Must send quantity in POST')
})

// Test 9: CardDetailModal ClaimSaleForm has quantity picker
test('CardDetailModal ClaimSaleForm passes quantities', () => {
  const src = readSrc('nextjs/src/components/CardDetailModal.js')
  assert(src.includes('csQuantity'), 'Must have csQuantity state')
  assert(src.includes('quantities: { [libraryRow.id]: csQuantity }'), 'Must pass quantities to claim sale')
})

// Test 10: LibraryView bulk list sends quantities
test('LibraryView bulk list sends per-card quantities', () => {
  const src = readSrc('nextjs/src/components/LibraryView.js')
  assert(src.includes('listQuantities'), 'Must have listQuantities state')
  assert(src.includes('quantity: listQuantities[id] || 1'), 'Singles must send per-card quantity')
  assert(src.includes('quantities,'), 'Claim sale must send quantities map')
})

// Test 11: BazaarDetailModal displays quantity per seller
test('BazaarDetailModal displays quantity when > 1', () => {
  const src = readSrc('nextjs/src/components/BazaarDetailModal.js')
  assert(src.includes('s.quantity > 1'), 'Must show quantity badge when > 1')
  assert(src.includes('{s.quantity}'), 'Must display quantity')
})

// Test 12: Seller-count tiles — BazaarCard shows seller count, no seller name
test('BazaarCard tile shows seller_count and no seller display name', () => {
  const src = readSrc('nextjs/src/components/BazaarCard.js')
  assert(src.includes('seller_count'), 'Must show seller_count')
  assert(!src.includes('seller_name'), 'Must NOT show seller_name on tile')
})

// Run all tests
console.log('\n=== Phase 29 Mechanical Tests ===\n')
for (const { name, fn } of tests) {
  try {
    fn()
    console.log(`  ${PASS} ${name}`)
    passed++
  } catch (err) {
    console.log(`  ${FAIL} ${name}`)
    console.log(`       ${err.message}`)
    failed++
  }
}
console.log(`\n  ${passed} passed, ${failed} failed, ${tests.length} total\n`)
process.exit(failed > 0 ? 1 : 0)