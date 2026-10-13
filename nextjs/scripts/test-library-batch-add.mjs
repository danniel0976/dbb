import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  MAX_BATCH_CARDS,
  MAX_QUANTITY,
  VALID_CONDITION,
  VALID_FOIL,
  normalizeBatchRequest,
} from '../src/lib/libraryBatchAdd.mjs'

const ID_A = '11111111-1111-4111-8111-111111111111'
const ID_B = '22222222-2222-4222-8222-222222222222'
const BINDER = '33333333-3333-4333-8333-333333333333'

const ok = result => {
  assert.equal(result.error, undefined, `expected success, got ${result.error?.message}`)
  return result
}
const bad = result => {
  assert.ok(result.error, 'expected a validation error')
  return result.error
}

// ─── Shape of a well-formed batch ──────────────────────────────────────────

// The happy path produces exactly the RPC row shape, with the defaults the
// single-card route already applies.
{
  const result = ok(normalizeBatchRequest({
    binder_id: BINDER,
    cards: [{ scryfall_id: ID_A }],
  }))
  assert.equal(result.binderId, BINDER)
  assert.equal(result.requestedCount, 1)
  assert.deepEqual(result.rows, [{
    scryfall_id: ID_A,
    quantity: 1,
    foil: 'normal',
    condition: 'NM',
    language: 'en',
  }])
  assert.deepEqual(result.scryfallIds, [ID_A])
}

// ─── Scanner payload fields only ───────────────────────────────────────────

// A caller cannot smuggle price/date/starred columns into the RPC through this
// route: rows are rebuilt from an allowlist, never spread from the request.
{
  const result = ok(normalizeBatchRequest({
    binder_id: BINDER,
    cards: [{
      scryfall_id: ID_A,
      quantity: 2,
      foil: 'foil',
      condition: 'LP',
      language: 'ja',
      purchase_price: '999.99',
      purchase_currency: 'USD',
      date_added: '1999-01-01T00:00:00.000Z',
      starred: true,
      user_id: 'someone-else',
    }],
  }))
  assert.deepEqual(result.rows, [{
    scryfall_id: ID_A,
    quantity: 2,
    foil: 'foil',
    condition: 'LP',
    language: 'ja',
  }])
}

// ─── Duplicate folding by the full conflict key ────────────────────────────

// The RPC upserts with ON CONFLICT DO UPDATE, which Postgres rejects outright
// when one statement touches the same conflict key twice. Folding duplicates in
// the request is what keeps a legitimate repeated row from failing the batch.
{
  const result = ok(normalizeBatchRequest({
    binder_id: BINDER,
    cards: [
      { scryfall_id: ID_A, quantity: 2 },
      { scryfall_id: ID_B, quantity: 1, foil: 'foil' },
      { scryfall_id: ID_A, quantity: 3 },
    ],
  }))
  assert.equal(result.requestedCount, 3)
  // First-seen order survives folding, so server-side messages line up with the
  // order the user reviewed on the shelf.
  assert.deepEqual(result.rows, [
    { scryfall_id: ID_A, quantity: 5, foil: 'normal', condition: 'NM', language: 'en' },
    { scryfall_id: ID_B, quantity: 1, foil: 'foil', condition: 'NM', language: 'en' },
  ])
  assert.deepEqual(result.scryfallIds, [ID_A, ID_B])
}

// Folding keys on the whole conflict key, so rows that differ in any one of
// foil / condition / language stay separate rows.
{
  const result = ok(normalizeBatchRequest({
    binder_id: BINDER,
    cards: [
      { scryfall_id: ID_A, quantity: 1, foil: 'normal', condition: 'NM', language: 'en' },
      { scryfall_id: ID_A, quantity: 1, foil: 'foil', condition: 'NM', language: 'en' },
      { scryfall_id: ID_A, quantity: 1, foil: 'normal', condition: 'LP', language: 'en' },
      { scryfall_id: ID_A, quantity: 1, foil: 'normal', condition: 'NM', language: 'ja' },
      { scryfall_id: ID_A, quantity: 4, foil: 'normal', condition: 'NM', language: 'en' },
    ],
  }))
  assert.equal(result.rows.length, 4)
  assert.deepEqual(result.rows.map(row => row.quantity), [5, 1, 1, 1])
  // The deduped catalog lookup asks for each printing once.
  assert.deepEqual(result.scryfallIds, [ID_A])
}

// Folding must not push a row past the column's own 1..9999 check constraint —
// that would surface as an opaque 500 from the database instead of a 400 here.
{
  const error = bad(normalizeBatchRequest({
    binder_id: BINDER,
    cards: [
      { scryfall_id: ID_A, quantity: MAX_QUANTITY },
      { scryfall_id: ID_A, quantity: 1 },
    ],
  }))
  assert.equal(error.status, 400)
  assert.match(error.message, /9999/)
}

// ─── Bounded payload ───────────────────────────────────────────────────────

{
  assert.equal(MAX_BATCH_CARDS, 200)

  const atLimit = ok(normalizeBatchRequest({
    binder_id: BINDER,
    cards: Array.from({ length: MAX_BATCH_CARDS }, () => ({ scryfall_id: ID_A, quantity: 1 })),
  }))
  // The limit bounds what the caller sent, before folding collapses it.
  assert.equal(atLimit.requestedCount, MAX_BATCH_CARDS)

  const overLimit = bad(normalizeBatchRequest({
    binder_id: BINDER,
    cards: Array.from({ length: MAX_BATCH_CARDS + 1 }, () => ({ scryfall_id: ID_A })),
  }))
  assert.equal(overLimit.status, 400)
  assert.match(overLimit.message, /at most 200/)
}

// ─── Envelope validation ───────────────────────────────────────────────────

{
  for (const body of [null, undefined, 'cards', 42, []]) {
    const error = bad(normalizeBatchRequest(body))
    assert.equal(error.status, 400)
  }

  assert.match(bad(normalizeBatchRequest({ cards: [{ scryfall_id: ID_A }] })).message, /binder_id/)
  assert.match(bad(normalizeBatchRequest({ binder_id: '  ', cards: [{ scryfall_id: ID_A }] })).message, /binder_id/)
  assert.match(bad(normalizeBatchRequest({ binder_id: BINDER })).message, /cards/)
  assert.match(bad(normalizeBatchRequest({ binder_id: BINDER, cards: [] })).message, /cards/)
  assert.match(bad(normalizeBatchRequest({ binder_id: BINDER, cards: {} })).message, /cards/)
}

// Binder and card identities are PostgreSQL UUID columns. Reject malformed
// values at the public boundary so they cannot fall through as cast failures or
// opaque database errors.
{
  const binderError = bad(normalizeBatchRequest({
    binder_id: 'not-a-uuid',
    cards: [{ scryfall_id: ID_A }],
  }))
  assert.equal(binderError.status, 400)
  assert.match(binderError.message, /binder_id.*valid UUID/i)

  const cardError = bad(normalizeBatchRequest({
    binder_id: BINDER,
    cards: [{ scryfall_id: 'not-a-uuid' }],
  }))
  assert.equal(cardError.status, 400)
  assert.equal(cardError.index, 0)
  assert.match(cardError.message, /cards\[0\]\.scryfall_id.*valid UUID/i)
}

// ─── Row-level validation errors name the offending row ────────────────────

{
  const cases = [
    [{ scryfall_id: '' }, /scryfall_id/],
    [{ scryfall_id: null }, /scryfall_id/],
    [{ scryfall_id: 42 }, /scryfall_id/],
    [{ scryfall_id: ID_A, foil: 'holo' }, /foil/],
    [{ scryfall_id: ID_A, condition: 'PL' }, /condition/],
    [{ scryfall_id: ID_A, language: '' }, /language/],
    [{ scryfall_id: ID_A, language: 'x'.repeat(17) }, /language/],
    [{ scryfall_id: ID_A, quantity: 0 }, /quantity/],
    [{ scryfall_id: ID_A, quantity: -3 }, /quantity/],
    [{ scryfall_id: ID_A, quantity: 1.5 }, /quantity/],
    [{ scryfall_id: ID_A, quantity: 'lots' }, /quantity/],
    [{ scryfall_id: ID_A, quantity: MAX_QUANTITY + 1 }, /quantity/],
    [null, /cards\[1\]/],
    ['nope', /cards\[1\]/],
  ]

  for (const [card, pattern] of cases) {
    const error = bad(normalizeBatchRequest({
      binder_id: BINDER,
      cards: [{ scryfall_id: ID_B }, card],
    }))
    assert.equal(error.status, 400)
    assert.equal(error.index, 1, `expected row index 1 for ${JSON.stringify(card)}`)
    // The message points at the row the user has to fix, by position.
    assert.match(error.message, /cards\[1\]/)
    assert.match(error.message, pattern)
  }

  // A bad row anywhere rejects the whole request — a batch is all-or-nothing
  // before it ever reaches the database, too.
  const error = bad(normalizeBatchRequest({
    binder_id: BINDER,
    cards: [{ scryfall_id: ID_A }, { scryfall_id: ID_B }, { scryfall_id: ID_A, foil: 'holo' }],
  }))
  assert.equal(error.index, 2)
}

// Whitespace around the identity fields is trimmed, not treated as a distinct row.
{
  const result = ok(normalizeBatchRequest({
    binder_id: ` ${BINDER} `,
    cards: [
      { scryfall_id: ` ${ID_A} `, quantity: 1 },
      { scryfall_id: ID_A, quantity: 2, language: ' en ' },
    ],
  }))
  assert.equal(result.binderId, BINDER)
  assert.deepEqual(result.rows, [
    { scryfall_id: ID_A, quantity: 3, foil: 'normal', condition: 'NM', language: 'en' },
  ])
}

// Quantity accepts the string form a JSON client may send for an integer.
{
  const result = ok(normalizeBatchRequest({
    binder_id: BINDER,
    cards: [{ scryfall_id: ID_A, quantity: '3' }],
  }))
  assert.equal(result.rows[0].quantity, 3)
}

// The exported vocabularies stay in step with the single-card route and the
// library_cards check constraints.
assert.deepEqual(VALID_FOIL, ['normal', 'foil', 'etched'])
assert.deepEqual(VALID_CONDITION, ['M', 'NM', 'LP', 'MP', 'HP', 'DMG'])
assert.equal(MAX_QUANTITY, 9999)

// ─── Route wiring ──────────────────────────────────────────────────────────

{
  const routeSource = readFileSync(new URL('../src/app/api/library/add/batch/route.js', import.meta.url), 'utf8')

  // Identity comes from the session, never the request body.
  assert.match(routeSource, /authClient\.auth\.getUser\(\)/)
  assert.match(routeSource, /p_user_id: user\.id/)
  assert.doesNotMatch(routeSource, /body\.user_id|body\?\.user_id/)

  // Exactly one binder ownership check, scoped to the authenticated user.
  assert.equal(routeSource.match(/from\('binders'\)/g)?.length, 1)
  assert.match(routeSource, /from\('binders'\)[\s\S]{0,160}?\.eq\('user_id', user\.id\)/)

  // One catalog existence check for the whole batch, and one RPC call.
  assert.equal(routeSource.match(/from\('card_index'\)/g)?.length, 1)
  assert.match(routeSource, /\.in\('scryfall_id', .*scryfallIds\)/)
  assert.equal(routeSource.match(/\.rpc\(/g)?.length, 1)
  assert.match(routeSource, /rpc\('import_library_cards'/)

  // The batch is one transactional RPC call, not a loop of them.
  assert.doesNotMatch(routeSource, /for\s*\([^)]*\)\s*\{[\s\S]*?\.rpc\(/)

  // Validation is the shared, tested helper — not re-implemented inline.
  assert.match(routeSource, /normalizeBatchRequest/)
  assert.match(routeSource, /from '@\/lib\/libraryBatchAdd\.mjs'/)

  // Database details stay server-side. Query failures are distinct from honest
  // not-found responses and every 500 body is stable public copy.
  assert.match(routeSource, /if \(binderErr\)[\s\S]*Could not validate binder/)
  assert.match(routeSource, /if \(!binder\)[\s\S]*Binder not found/)
  assert.match(routeSource, /Could not validate scanned cards/)
  assert.match(routeSource, /Could not add scanned cards/)
  assert.doesNotMatch(routeSource, /NextResponse\.json\(\{ error: (?:cardErr|rpcErr)\.message/)
}

// The ordinary single-card add route is untouched and still serves manual adds.
{
  const singleSource = readFileSync(new URL('../src/app/api/library/add/route.js', import.meta.url), 'utf8')
  assert.match(singleSource, /export async function POST/)
  assert.match(singleSource, /rpc\('import_library_cards'/)
  assert.doesNotMatch(singleSource, /normalizeBatchRequest/)
}

console.log('LIBRARY_BATCH_ADD_PASS')
