import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { normalizeBatchRequest } from '../src/lib/libraryBatchAdd.mjs'

const USER = 'a1000000-0000-4000-8000-000000000001'
const BINDER = 'a2000000-0000-4000-8000-000000000001'
const CARD = 'a3000000-0000-4000-8000-000000000001'
const BATCH = 'a4000000-0000-4000-8000-000000000001'
const source = readFileSync(new URL('../src/app/api/library/add/batch/route.js', import.meta.url), 'utf8')
const executable = source.replace(/^import .*$/gm, '').replace('export async function POST', 'async function POST')
const run = new Function('NextResponse', 'createAuthClient', 'createServiceClient', 'normalizeBatchRequest', `${executable}\nreturn POST`)
let cases = 0
async function invoke(body, { rpcError, authenticated = true } = {}) {
  const calls = []
  const db = {
    from(table) {
      calls.push(['read', table])
      const query = {
        select() { return query }, eq() { return query },
        async maybeSingle() { return { data: { id: BINDER } } },
        async in() { return { data: [{ scryfall_id: CARD }] } },
      }
      return query // No insert/update/delete method: the RPC is the only write path.
    },
    async rpc(name, params) {
      calls.push(['rpc', name, params])
      return { data: [{ inserted: 0, merged: 1, replayed: true }], error: rpcError }
    },
  }
  const POST = run({ json: (data, options = {}) => ({ status: options.status || 200, data }) },
    async () => ({ auth: { getUser: async () => ({ data: { user: authenticated ? { id: USER } : null } }) } }),
    () => db, normalizeBatchRequest)
  return { response: await POST({ json: async () => body }), calls }
}
const valid = { batchId: BATCH, binder_id: BINDER, cards: [{ scryfall_id: CARD, quantity: 3 }] }
{
  const { response, calls } = await invoke(valid)
  assert.deepEqual(calls.filter(c => c[0] === 'rpc'), [['rpc', 'import_library_cards_once', {
    p_user_id: USER, p_binder_id: BINDER, p_batch_id: BATCH,
    p_rows: [{ scryfall_id: CARD, quantity: 3, foil: 'normal', condition: 'NM', language: 'en' }],
  }]])
  assert.deepEqual(response, { status: 200, data: { ok: true, inserted: 0, merged: 1, requested: 1, rows: 1, replayed: true } })
  cases++
}
for (const batchId of [undefined, null, '', 'not-a-uuid', BATCH.replace('-4000-', '-1000-'), ` ${BATCH} `]) {
  const { response, calls } = await invoke({ ...valid, batchId })
  assert.equal(response.status, 400)
  assert.match(response.data.error, /batchId.*UUID v4/)
  assert.equal(calls.length, 0, 'invalid id must not reach the service client')
  cases++
}
{
  const { response, calls } = await invoke(valid, { authenticated: false })
  assert.equal(response.status, 401)
  assert.equal(calls.length, 0)
  cases++
}
{
  const old = console.error
  console.error = () => {}
  try {
    const { response } = await invoke(valid, { rpcError: { message: 'private database detail', code: 'XX000' } })
    assert.deepEqual(response, { status: 500, data: { error: 'Could not add scanned cards' } })
    cases++
  } finally { console.error = old }
}
console.log(`LIBRARY_BATCH_IDEMPOTENCY_ROUTE_PASS ${cases} cases`)
