import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compileFunction } from 'node:vm'

// Execute the panel's actual worker ownership functions, not a copied model.
// Only the engine import is substituted; React, canvas and assets never load.
const source = readFileSync(new URL('../src/components/CardScannerPanel.js', import.meta.url), 'utf8')
const start = source.indexOf('let workerPromise = null')
const end = source.indexOf('// Capture the portrait crop', start)
assert.ok(start >= 0 && end > start, 'worker lifecycle source boundaries must exist')
const ownedSource = source.slice(start, end)
assert.match(ownedSource, /async function getScannerWorker\(\)/)
assert.match(ownedSource, /export async function terminateScannerWorker\(\)/)
assert.equal(ownedSource.match(/import\('tesseract\.js'\)/g)?.length, 1, 'engine import must be substituted exactly once')
const createLifecycle = compileFunction(
  ownedSource.replace("import('tesseract.js')", 'importEngine()')
    .replace('export async function terminateScannerWorker', 'async function terminateScannerWorker')
    + '\nreturn { getScannerWorker, terminateScannerWorker }',
  ['importEngine', 'SCANNER_ASSETS']
)

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function harness() {
  const creations = []
  let imports = 0
  const lifecycle = createLifecycle(() => {
    imports += 1
    return Promise.resolve({
      createWorker(language, mode, options) {
        assert.equal(language, 'eng')
        assert.equal(mode, 1)
        assert.equal(typeof options.logger, 'function')
        assert.equal(typeof options.errorHandler, 'function')
        assert.equal(options.workerPath, 'memory-only-test')
        const creation = deferred()
        creations.push(creation)
        return creation.promise
      },
    })
  }, { options: { workerPath: 'memory-only-test' } })
  return { ...lifecycle, creations, get imports() { return imports } }
}

function worker({ rejectTermination = false } = {}) {
  return {
    terminations: 0,
    async terminate() {
      this.terminations += 1
      if (rejectTermination) throw new Error('termination rejected')
    },
  }
}

// A stale rejection must not clear either a pending or a ready newer creation.
for (const readyFirst of [false, true]) {
  const h = harness()
  const oldRead = h.getScannerWorker()
  const oldFailure = new Error('old creation rejected')
  const rejected = assert.rejects(oldRead, error => error === oldFailure)
  await Promise.resolve()
  const close = h.terminateScannerWorker()
  const newRead = h.getScannerWorker()
  await Promise.resolve()
  assert.equal(h.creations.length, 2)
  const current = worker()
  if (readyFirst) {
    h.creations[1].resolve(current)
    assert.equal(await newRead, current)
  }
  h.creations[0].reject(oldFailure)
  await rejected
  await close
  const nextRead = h.getScannerWorker()
  assert.equal(h.imports, 2, 'late old rejection must not create a third worker on the next read')
  if (!readyFirst) h.creations[1].resolve(current)
  assert.equal(await newRead, current)
  assert.equal(await nextRead, current)
  assert.equal(current.terminations, 0, 'old close must not terminate the reopened worker')
  await h.terminateScannerWorker()
  assert.equal(current.terminations, 1)
}

// Close takes ownership of a late success exactly once, including failed teardown.
for (const rejectTermination of [false, true]) {
  const h = harness()
  const abandonedRead = h.getScannerWorker()
  await Promise.resolve()
  const closing = h.terminateScannerWorker()
  await h.terminateScannerWorker()
  const abandoned = worker({ rejectTermination })
  h.creations[0].resolve(abandoned)
  assert.equal(await abandonedRead, abandoned)
  await closing
  await h.terminateScannerWorker()
  assert.equal(abandoned.terminations, 1, 'repeated close must not retry abandoned termination')
  assert.equal(h.imports, 1, 'close must not create workers')
}

// StrictMode-like close/reopen/close: late workers stay with their own close.
{
  const h = harness()
  const firstRead = h.getScannerWorker()
  await Promise.resolve()
  const firstClose = h.terminateScannerWorker()
  const secondRead = h.getScannerWorker()
  await Promise.resolve()
  const secondClose = h.terminateScannerWorker()
  const thirdRead = h.getScannerWorker()
  const sharedRead = h.getScannerWorker()
  await Promise.resolve()
  assert.equal(h.creations.length, 3, 'concurrent reads must share the current creation')
  const workers = [worker(), worker({ rejectTermination: true }), worker()]
  h.creations[2].resolve(workers[2])
  assert.equal(await thirdRead, workers[2])
  assert.equal(await sharedRead, workers[2])
  h.creations[1].resolve(workers[1])
  await secondRead
  await secondClose
  h.creations[0].resolve(workers[0])
  await firstRead
  await firstClose
  assert.deepEqual(workers.map(w => w.terminations), [1, 1, 0])
  assert.equal(await h.getScannerWorker(), workers[2])
  assert.equal(h.imports, 3, 'late success must not erase the current owner')
  await h.terminateScannerWorker()
  await h.terminateScannerWorker()
  assert.deepEqual(workers.map(w => w.terminations), [1, 1, 1])
}

// Current creation failure clears only itself; an explicit read can retry.
{
  const h = harness()
  const failedRead = h.getScannerWorker()
  const rejected = assert.rejects(failedRead, /current creation rejected/)
  await Promise.resolve()
  h.creations[0].reject(new Error('current creation rejected'))
  await rejected
  assert.equal(h.imports, 1, 'failure must not retry automatically')
  const retry = h.getScannerWorker()
  await Promise.resolve()
  const current = worker()
  h.creations[1].resolve(current)
  assert.equal(await retry, current)
  assert.equal(await h.getScannerWorker(), current)
  assert.equal(h.imports, 2)
  await h.terminateScannerWorker()
  assert.equal(current.terminations, 1)
}

// Import failures use the same ownership path and permit a later retry.
{
  let imports = 0
  const current = worker()
  const h = createLifecycle(() => {
    imports += 1
    return imports === 1
      ? Promise.reject(new Error('engine import rejected'))
      : Promise.resolve({ createWorker: () => current })
  }, { options: {} })
  await assert.rejects(h.getScannerWorker(), /engine import rejected/)
  assert.equal(imports, 1)
  assert.equal(await h.getScannerWorker(), current)
  assert.equal(imports, 2)
  await h.terminateScannerWorker()
  assert.equal(current.terminations, 1)
}

// These doubles do not verify playback/startup timeouts or real-device recovery.
console.log('CARD_SCANNER_WORKER_LIFECYCLE_PASS')
