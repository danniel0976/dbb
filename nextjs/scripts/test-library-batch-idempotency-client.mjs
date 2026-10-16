import assert from 'node:assert/strict'
import { createScannerBatchLifecycle } from '../src/lib/cardScannerSession.mjs'
// The inventory suite executes the actual modal handlers, including edit blocking,
// explicit identical-payload Retry, replay settlement, and all #23 freeze controls.
import './test-card-scanner-inventory-safety.mjs'
const payload = { binder_id: 'a2000000-0000-4000-8000-000000000001', cards: [{ scryfall_id: 'a3000000-0000-4000-8000-000000000001', quantity: 1 }] }
const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const life = createScannerBatchLifecycle()
const first = life.begin(payload)
assert.match(first.batchId, v4)
assert.equal(life.begin(payload), null)
life.fail(first)
assert.equal(life.canMutate(), false)
assert.equal(life.begin({ ...payload, cards: [] }), null, 'edits cannot replace an unknown attempt')
const retry = life.retry()
assert.equal(retry.batchId, first.batchId)
assert.equal(retry.snapshot, first.snapshot)
assert.equal(life.retry(), null, 'double Retry remains single flight')
assert.equal(life.commit(first), false, 'old continuation cannot settle the retry')
assert.equal(life.commit(retry), true)
const next = life.begin(payload)
assert.notEqual(next.batchId, first.batchId)
life.reject(next)
const rejected = life.begin(payload)
assert.notEqual(rejected.batchId, next.batchId)
life.fail(rejected)
life.invalidate(); life.arm()
const remountRetry = life.retry()
assert.equal(remountRetry.batchId, rejected.batchId, 'StrictMode preserves replay identity')
assert.equal(life.commit(rejected), false)
assert.equal(life.reject(remountRetry), true)
console.log('LIBRARY_BATCH_IDEMPOTENCY_CLIENT_PASS 8 lifecycle groups plus 16 actual-handler groups')
