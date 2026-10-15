import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createScannerBatchLifecycle, buildScannerBatchPayload, classifyBatchResponse, parseBatchResponseBody } from '../src/lib/cardScannerSession.mjs'
const payload = { binder_id: 'a2000000-0000-4000-8000-000000000001', cards: [{ scryfall_id: 'a3000000-0000-4000-8000-000000000001', quantity: 1 }] }
const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
let cases = 0
{
  const life = createScannerBatchLifecycle()
  const first = life.begin(payload)
  assert.match(first.batchId || '', v4, 'confirm creates one UUID v4 batchId')
  assert.equal(life.begin(payload), null)
  life.fail(first)
  const retry = life.begin(structuredClone(payload))
  assert.equal(retry.batchId, first.batchId, 'a lost reply must retain the same id')
  life.commit(retry)
  const next = life.begin(payload)
  assert.notEqual(next.batchId, first.batchId, 'success starts a new attempt')
  life.fail(next)
  life.resetAttempt()
  const edited = life.begin(payload)
  assert.notEqual(edited.batchId, next.batchId, 'edit/discard invalidates prior identity even if values are reverted')
  life.fail(edited)
  const changed = life.begin({ ...payload, binder_id: 'a2000000-0000-4000-8000-000000000002' })
  assert.notEqual(changed.batchId, edited.batchId)
  cases += 5
}
// Execute the actual modal submission handler: no React/network runtime needed.
{
  const source = readFileSync(new URL('../src/components/AddCardModal.js', import.meta.url), 'utf8')
  const start = source.indexOf('  const handleScannerBatchAdd = async () => {')
  const end = source.indexOf('  // ─── Add card to library', start)
  assert.ok(start > 0 && end > start)
  const life = createScannerBatchLifecycle()
  const shelf = [{ source: 'scanner-confirmed', scryfallId: payload.cards[0].scryfall_id, quantity: 1, finish: 'nonfoil', selected: true }]
  const calls = []
  const noop = () => {}
  let lost = true
  const names = ['scannerSessionMutable','buildScannerBatchPayload','scannerShelf','scannerBinderId','scannerCondition','setError','scannerBatchLifecycleRef','scannerBatchPendingRef','setPendingExit','setAdding','fetch','classifyBatchResponse','parseBatchResponseBody','setScannerShelf','onAdded','closeNow']
  const values = [() => life.canMutate(),buildScannerBatchPayload,shelf,payload.binder_id,'NM',noop,{ current: life },{ current: false },noop,noop,
    async (_url, options) => { calls.push(JSON.parse(options.body)); if (lost) { lost = false; throw new TypeError('reply lost') }; return { ok: true, json: async () => ({ ok: true, inserted: 1, merged: 0, requested: 1, rows: 1, replayed: true }) } },
    classifyBatchResponse,parseBatchResponseBody,noop,noop,noop]
  const submit = new Function(...names, `${source.slice(start,end)}\nreturn handleScannerBatchAdd`)(...values)
  await submit()
  await submit()
  assert.match(calls[0].batchId || '', v4)
  assert.equal(calls[0].batchId, calls[1].batchId, 'actual retry sends the same id')
  await submit()
  assert.notEqual(calls[2].batchId, calls[1].batchId, 'actual success clears the id')
  cases += 2
}
console.log(`LIBRARY_BATCH_IDEMPOTENCY_CLIENT_PASS ${cases} cases`)
