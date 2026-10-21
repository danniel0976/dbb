import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as session from '../src/lib/cardScannerSession.mjs'
import * as state from '../src/lib/cardScannerState.mjs'
import { rankScannerResults } from '../src/lib/cardScanner.mjs'
import { scannerSelectionReason } from '../src/lib/cardScannerView.mjs'

const source = readFileSync(new URL('../src/components/AddCardModal.js', import.meta.url), 'utf8')
// Extract exact, non-JSX declarations, not a reconstructed implementation.
function extract(name, optional = false, input = source) {
  const marker = `  const ${name} = `
  const start = input.indexOf(marker)
  if (optional && start === -1) return ''
  assert.ok(start >= 0, `missing handler: ${name}`)
  assert.equal(input.indexOf(marker, start + marker.length), -1, `duplicate handler: ${name}`)
  const tail = input.slice(start + marker.length)
  const boundary = tail.search(/\n  (?:const |useEffect\(|return \()/)
  assert.ok(boundary >= 0, `missing boundary: ${name}`)
  const region = input.slice(start, start + marker.length + boundary)
  const close = region.lastIndexOf('\n  }')
  assert.ok(close >= 0, `missing handler closure: ${name}`)
  const suffix = region.slice(close).match(/^\n  }(?:, \[[\s\S]*?\]\))?/)[0]
  const declaration = region.slice(0, close) + suffix
  assert.doesNotMatch(declaration, /<[A-Za-z]/, `${name} must remain non-JSX`)
  assert.doesNotThrow(() => new Function(declaration), `invalid handler: ${name}`)
  return declaration
}
const extractionFixture = `  const sample = useCallback(() => {
    if (true) {
      return 'nested'
    }
  }, [someDependency.map(value => value)])
  const next = true`
assert.match(extract('sample', false, extractionFixture), /someDependency.map/)
for (const malformed of [
  extractionFixture.replace('const sample', 'const missing'),
  extractionFixture + '\n  const sample = () => {}',
  extractionFixture.replace('\n  const next = true', ''),
  extractionFixture.replace('\n  }, [', '\n  , ['),
  extractionFixture.replace("return 'nested'", 'return <div />'),
]) assert.throws(() => extract('sample', false, malformed), assert.AssertionError)
const names = ['resumeScanner', 'leaveScannerMode', 'acceptScannerCandidate', 'handleScanEvidence',
  'handleSelectEdition', 'handleLoadMore', 'handleClear', 'handleManualFallback', 'closeNow',
  'handleClose', 'confirmScannerDiscard', 'openScanner', 'editScannerShelf', 'removeScannerShelf',
  'changeScannerBinder', 'changeScannerCondition', 'handleScannerBatchAdd']
const declarations = extract('setScannerShelf', true) + '\n' + names.map(name => extract(name)).join('\n') + '\n' + extract('acknowledgeScannerLibraryCheck', true)
const factory = new Function('env', `with (env) { ${declarations}; return { ${names.join(',')}, acknowledgeScannerLibraryCheck: typeof acknowledgeScannerLibraryCheck === 'undefined' ? null : acknowledgeScannerLibraryCheck }; }`)
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const candidate = (id = 'a', finishes = ['nonfoil', 'foil']) => ({
  cardName: 'Lightning Bolt', edition: { scryfall_id: id, finishes,
    image_uris: { small: 'https://example.invalid/catalog.jpg' }, rawText: 'secret OCR',
    visualSignature: { pixels: [1] }, frame: 'data:image/png;base64,AAA' },
})
const row = (id = 'a', finish = 'nonfoil', selected = true) => ({
  ...session.addScannerShelfItem([], { ...candidate(id), source: 'scanner-direct' })[0],
  shelfId: `${id}:${finish}`, finish, selected,
})
function harness(rows = [row(), row('a', 'foil', false), row('b', 'nonfoil', false)], response, callback) {
  const env = { ...session, useCallback: fn => fn, INITIAL_FILTERS: { set: '', colors: [] }, SCAN_LIMIT: 40,
    DEFAULT_LIMIT: 20, hasActiveFilters: filters => Boolean(filters.set),
    scannerShelf: rows, scannerShelfRef: { current: rows }, scannerBinderId: 'binder', scannerCondition: 'NM',
    scannerBatchLifecycleRef: { current: session.createScannerBatchLifecycle() },
    scannerCaptureLifecycleRef: { current: session.createScannerCaptureLifecycle?.() },
    scannerBatchPendingRef: { current: false }, abortRef: { current: null }, searchGenRef: { current: 0 },
    inputRef: { current: null }, showScanner: true, scanEvidence: { nameQuery: 'Lightning Bolt' },
    scannerDecision: null, printingList: null, printingEditId: null, shelfUndo: null, lastScannerSetRef: {current:''}, scanningLanguage:'en', scannerSetLock:'', scannerResumeToken: 0, loadingMore: false, hasMore: true, committedQ: '',
    appliedFilters: {}, page: 1, error: null, adding: false, scannerRecovery: false,
    posts: [], searches: [], closed: 0, added: 0, violations: [],
    terminateScannerWorker: () => {}, console: { error: () => {} },
  }
  env.scannerSessionMutable = () => env.scannerBatchLifecycleRef.current.canMutate()
  for (const key of ['ScanEvidence', 'ScannerDecision', 'ScannerVisualStatus', 'Groups', 'Total', 'HasMore',
    'CommittedQ', 'Q', 'HeldScans', 'ShowScanner', 'ScannerResumeToken', 'Filters', 'AppliedFilters',
    'Error', 'Loading', 'LoadingMore', 'PendingExit', 'ScannerBinderId', 'ScannerCondition', 'Adding',
    'SelectedEdition', 'Page', 'ScannerRecovery', 'ShelfUndo', 'PrintingList', 'PrintingEditId']) {
    const prop = key[0].toLowerCase() + key.slice(1)
    env[`set${key}`] = value => { env[prop] = typeof value === 'function' ? value(env[prop]) : value }
  }
  env.setScannerShelfState = value => {
    env.scannerShelf = value
  }
  // Base has React's setter; candidate executes its exact synchronous ref setter above.
  env.setScannerShelf = value => {
    env.scannerShelf = typeof value === 'function' ? value(env.scannerShelfRef.current) : value
    env.scannerShelfRef.current = env.scannerShelf
  }
  env.doSearch = (...args) => { env.searches.push(args) }
  env.onClose = () => { env.closed++ }
  env.onAdded = data => { env.added++; callback?.(data) }
  // Record violations OUTSIDE fetch rejection handling: assertions cannot be swallowed by production catches.
  env.fetch = (url, options) => {
    if (url !== '/api/library/add/batch' || options?.method !== 'POST') env.violations.push([url, options])
    env.posts.push(JSON.parse(options.body))
    return response()
  }
  return { env, handlers: factory(env) }
}
function mount(h) {
  const start = source.indexOf('// ─── Cleanup on unmount')
  assert.notEqual(start, -1, 'modal lifecycle effect anchor missing')
  const effect = source.slice(start).match(/useEffect\(\(\) => \{[\s\S]*?\n  \}, \[\]\)/)?.[0]
  assert.ok(effect, 'exact modal lifecycle effect extraction failed')
  let cleanup
  h.env.useEffect = setup => { cleanup = setup() }
  new Function('env', `with (env) { ${effect}; }`)(h.env)
  return cleanup
}
const receipt = (requested = 1) => ({ ok: true, inserted: requested, merged: 0, requested, rows: requested })
const success = () => Promise.resolve({ ok: true, json: async () => receipt() })
let failures = 0
async function test(name, run) {
  try { await run(); console.log(`PASS ${name}`) }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`) }
}
function frozen(h) {
  const { env, handlers } = h
  const before = JSON.stringify(env.scannerShelf)
  handlers.editScannerShelf('a:nonfoil', { quantity: 9, selected: false, finish: 'foil' })
  handlers.removeScannerShelf('a:nonfoil')
  handlers.changeScannerBinder('other')
  handlers.changeScannerCondition('HP')
  handlers.handleScanEvidence({ nameQuery: 'Other' })
  handlers.acceptScannerCandidate(candidate('new'), 'scanner-direct', env.scanEvidence?.captureToken)
  handlers.handleSelectEdition(candidate().edition, 'Other')
  handlers.resumeScanner(); handlers.openScanner(); handlers.handleManualFallback(); handlers.handleClear()
  handlers.handleLoadMore(); handlers.handleClose()
  assert.equal(JSON.stringify(env.scannerShelf), before)
  assert.equal(env.scannerBinderId, 'binder'); assert.equal(env.scannerCondition, 'NM')
  assert.equal(env.searches.length, 0); assert.equal(env.closed, 0)
  assert.equal(env.scannerBatchLifecycleRef.current.canMutate(), false)
}
for (const [name, response] of [
  ['commit then lost connection', () => Promise.reject(new Error('connection lost after commit'))],
  ['ambiguous gateway failure', () => Promise.resolve({ ok: false, status: 502, json: async () => ({ error: 'gateway' }) })],
  ['truncated 2xx acknowledgement', () => Promise.resolve({ ok: true, json: async () => { throw new Error('truncated') } })],
  ['unreadable 2xx acknowledgement', () => Promise.resolve({ ok: true, json: async () => ({}) })],
]) {
  await test(name, async () => {
    let serverWrites = 0
    const h = harness(undefined, () => { serverWrites++; return response() })
    await h.handlers.handleScannerBatchAdd()
    await h.handlers.handleScannerBatchAdd()
    assert.equal(serverWrites, 1, 'simulated inventory commit must not be duplicated after a lost acknowledgement')
    assert.equal(h.env.posts.length, 1, 'uncertain submitted rows must never be blindly retried')
    assert.equal(h.env.scannerShelf.length, 3, 'submitted snapshot AND unchecked rows must remain')
    assert.match(h.env.error, /inventory may already have changed/i)
    frozen(h)
    assert.deepEqual(h.env.violations, [])
  })
}
await test('slow body owns request through parsing and selected-only settlement', async () => {
  const body = deferred()
  const h = harness(undefined, () => Promise.resolve({ ok: true, json: () => body.promise }))
  const first = h.handlers.handleScannerBatchAdd()
  await Promise.resolve(); await Promise.resolve()
  const duplicate = h.handlers.handleScannerBatchAdd()
  try {
    assert.equal(h.env.posts.length, 1, 'slow body cannot unlock duplicate activation')
    frozen(h)
  } finally {
    body.resolve(receipt()); await first; await duplicate
  }
  assert.deepEqual(h.env.scannerShelf.map(item => item.shelfId), ['a:foil', 'b:nonfoil'])
  assert.equal(h.env.closed, 0, 'unchecked rows must keep modal and shelf available')
  assert.equal(h.env.adding, false)
  assert.equal(h.env.scannerBatchLifecycleRef.current.canMutate(), true)
  await h.handlers.handleScannerBatchAdd()
  assert.equal(h.env.posts.length, 1, 'settled identities cannot be resent by stale activation')
  assert.deepEqual(h.env.violations, [])
})
await test('callback throw cannot lose unchecked rows or retry successful rows', async () => {
  const h = harness(undefined, success, () => { throw new Error('callback') })
  await h.handlers.handleScannerBatchAdd(); await h.handlers.handleScannerBatchAdd()
  assert.equal(h.env.posts.length, 1)
  assert.deepEqual(h.env.scannerShelf.map(item => item.shelfId), ['a:foil', 'b:nonfoil'])
  assert.equal(h.env.closed, 0); assert.equal(h.env.adding, false)
  assert.deepEqual(h.env.violations, [])
})
await test('explicit manual library acknowledgement quarantines submitted identities', async () => {
  const h = harness(undefined, () => Promise.reject(new Error('lost')))
  await h.handlers.handleScannerBatchAdd()
  assert.equal(typeof h.handlers.acknowledgeScannerLibraryCheck, 'function', 'explicit library-check handler required')
  h.handlers.acknowledgeScannerLibraryCheck(false)
  assert.equal(h.env.scannerBatchLifecycleRef.current.canMutate(), false)
  h.handlers.acknowledgeScannerLibraryCheck(true)
  assert.deepEqual(h.env.scannerShelf.map(item => item.shelfId), ['a:foil', 'b:nonfoil'])
  assert.match(h.env.error, /manually/i)
  await h.handlers.handleScannerBatchAdd()
  assert.equal(h.env.posts.length, 1)
  h.handlers.editScannerShelf('a:foil', { selected: true })
  h.env.fetch = (url, options) => {
    if (url !== '/api/library/add/batch' || options.method !== 'POST') h.env.violations.push(url)
    const payload = JSON.parse(options.body); h.env.posts.push(payload)
    return success()
  }
  await h.handlers.handleScannerBatchAdd()
  assert.deepEqual(h.env.posts[1].cards.map(item => [item.scryfall_id, item.foil]), [['a', 'foil']])
  assert.deepEqual(h.env.violations, [])
})
await test('discard is explicit and local only, pending discard blocked', async () => {
  const response = deferred()
  const h = harness(undefined, () => response.promise)
  const first = h.handlers.handleScannerBatchAdd()
  h.handlers.confirmScannerDiscard()
  assert.equal(h.env.closed, 0); assert.equal(h.env.scannerShelf.length, 3)
  response.reject(new Error('lost')); await first
  h.handlers.handleClose(); assert.equal(h.env.closed, 0)
  h.handlers.confirmScannerDiscard()
  assert.equal(h.env.closed, 1); assert.equal(h.env.scannerShelf.length, 0)
  assert.equal(h.env.posts.length, 1); assert.deepEqual(h.env.violations, [])
})
await test('late continuation inert; StrictMode rearm retains submitted freeze', async () => {
  for (const reject of [false, true]) {
    const response = deferred()
    const h = harness(undefined, () => response.promise)
    const cleanup = mount(h)
    const first = h.handlers.handleScannerBatchAdd()
    cleanup()
    mount(h)
    const before = JSON.stringify([h.env.scannerShelf, h.env.error, h.env.adding])
    assert.equal(h.env.scannerBatchLifecycleRef.current.canMutate(), false, 'StrictMode cannot forget a submitted request')
    assert.equal(h.env.scannerRecovery, true, 'StrictMode recovery must remain reachable')
    assert.equal(h.env.scannerBatchPendingRef.current, false)
    assert.equal(h.env.adding, false)
    if (reject) response.reject(new Error('late'))
    else response.resolve({ ok: true, json: async () => receipt() })
    await first
    assert.equal(JSON.stringify([h.env.scannerShelf, h.env.error, h.env.adding]), before)
    assert.equal(h.env.added, 0); assert.equal(h.env.closed, 0)
    await h.handlers.handleScannerBatchAdd(); assert.equal(h.env.posts.length, 1)
    assert.deepEqual(h.env.violations, [])
  }
  const idle = session.createScannerBatchLifecycle()
  idle.invalidate(); idle.arm(); assert.equal(idle.canMutate(), true)
})
await test('capture direct/chooser double activation, stale token, new capture, manual isolation', async () => {
  const h = harness([], success)
  let evidence
  await state.settleScanEvidence({ evidence: { nameQuery: 'Lightning Bolt', rawText: 'OCR', visualSignature: { pixels: [1] } },
    onEvidence: value => { evidence = value; return h.handlers.handleScanEvidence(value) }, isCancelled: () => false })
  // Keep the pre-render chooser closure's evidence alive for a second queued click.
  h.env.scanEvidence = evidence
  h.handlers.acceptScannerCandidate(candidate(), 'scanner-direct', evidence.captureToken)
  h.env.scanEvidence = evidence
  h.handlers.handleSelectEdition(candidate().edition, candidate().cardName)
  h.handlers.acceptScannerCandidate(candidate(), 'scanner-direct', evidence.captureToken)
  assert.equal(h.env.scannerShelf[0].quantity, 1, 'one capture must increment at most once across both paths')
  h.handlers.resumeScanner(); h.env.scanEvidence = evidence; h.handlers.handleLoadMore()
  h.handlers.handleScanEvidence(evidence)
  h.handlers.handleSelectEdition(candidate().edition, candidate().cardName)
  assert.equal(h.env.scannerShelf[0].quantity, 1, 'resume/load-more cannot rearm consumed evidence')
  await state.settleScanEvidence({ evidence: { nameQuery: 'Lightning Bolt' }, onEvidence: value => {
    evidence = value; h.handlers.handleScanEvidence(value)
  }, isCancelled: () => false })
  h.handlers.handleSelectEdition(candidate().edition, candidate().cardName)
  h.handlers.handleSelectEdition(candidate().edition, candidate().cardName)
  assert.equal(h.env.scannerShelf[0].quantity, 2, 'a deliberate new capture may increment once more')
  h.env.showScanner = false; h.env.scanEvidence = null
  h.handlers.handleSelectEdition(candidate('manual').edition, 'Manual')
  h.handlers.acceptScannerCandidate(candidate('manual'), 'manual', evidence.captureToken)
  assert.equal(h.env.scannerShelf.length, 1)
  assert.deepEqual(h.env.violations, [])
})
await test('real catalog direct routing consumes the same token as the chooser', async () => {
  const h = harness([], success)
  const merge = source.match(/function mergeSearchGroups\([\s\S]*?\n\}/g)
  assert.equal(merge?.length, 1, 'mergeSearchGroups extraction must be exact')
  Object.assign(h.env, { groups: [], rankScannerResults, scannerSelectionReason,
    acceptScannerCandidate: h.handlers.acceptScannerCandidate,
    compareScannerCandidatesVisually: async groups => ({ groups, status: 'unavailable' }),
  })
  h.env.doSearch = new Function('env', `with (env) { ${merge[0]}; ${extract('buildSearchUrl')}; ${extract('doSearch')}; return doSearch; }`)(h.env)
  const urls = []
  h.env.fetch = async (url, options) => {
    urls.push([url, options])
    return { ok: true, json: async () => ({ groups: [{ name: 'Lightning Bolt', editions: [{
      ...candidate().edition, set_code: 'mh2', collector_number: '123', rarity: 'uncommon',
    }] }], total: 1, has_more: false }) }
  }
  let evidence
  await state.settleScanEvidence({ evidence: { nameQuery: 'Lightning Bolt', setCode: 'mh2', collectorNumber: '123' },
    onEvidence: value => { evidence = value; return h.handlers.handleScanEvidence(value) }, isCancelled: () => false })
  assert.equal(urls.length, 1, 'direct match retains the primary one-page route')
  const url = new URL(urls[0][0], 'https://example.invalid')
  assert.equal(url.pathname, '/api/catalog/search')
  assert.equal(url.searchParams.get('scan'), '1')
  assert.equal(url.searchParams.get('limit'), '40')
  assert.equal(url.searchParams.get('page'), '1')
  assert.equal(url.searchParams.get('q'), 'Lightning Bolt')
  assert.equal(urls[0][1].method, undefined, 'catalog double must only receive read-only GET')
  assert.equal(h.env.scannerShelf[0]?.quantity, 1, 'real direct handler must pass the capture token')
  h.env.scanEvidence = evidence
  h.handlers.handleSelectEdition(candidate().edition, candidate().cardName)
  assert.equal(h.env.scannerShelf[0].quantity, 1, 'queued chooser cannot consume the real direct capture again')
})
await test('stale render and callback reentry cannot resend settled identities', async () => {
  let h
  let callbackOwned = false
  h = harness(undefined, success, () => {
    callbackOwned = !h.env.scannerBatchLifecycleRef.current.canMutate()
    h.handlers.handleScannerBatchAdd()
  })
  const oldShelf = h.env.scannerShelf
  h.env.setScannerShelfState = value => { h.env.pendingShelf = value }
  await h.handlers.handleScannerBatchAdd()
  assert.equal(callbackOwned, true, 'ownership must remain held during onAdded')
  assert.equal(h.env.scannerShelf, oldShelf, 'React render is deliberately deferred')
  await h.handlers.handleScannerBatchAdd()
  assert.equal(h.env.posts.length, 1, 'exact synchronous shelf setter must protect before rerender')
  assert.deepEqual(h.env.pendingShelf.map(item => item.shelfId), ['a:foil', 'b:nonfoil'])
  assert.deepEqual(h.env.violations, [])
})
await test('shelf allowlist excludes capture/OCR and unsafe image URLs', async () => {
  const safe = session.addScannerShelfItem([], { ...candidate(), source: 'scanner-direct',
    rawText: 'OCR', pixels: [1], visualSignature: [1], captureToken: 1 })[0]
  for (const key of ['rawText', 'pixels', 'frame', 'visualSignature', 'captureToken']) assert.equal(Object.hasOwn(safe, key), false)
  const unsafe = candidate()
  unsafe.edition.image_uris = { small: 'data:image/png;base64,AAA', normal: 'blob:private', large: 'https://example.invalid/catalog.jpg' }
  const result = session.addScannerShelfItem([], { ...unsafe, source: 'scanner-confirmed' })
  assert.doesNotMatch(JSON.stringify(result), /data:|blob:|private|secret OCR/)
  assert.equal(result[0].imageUris.large, 'https://example.invalid/catalog.jpg')
})
await test('beforeunload protects pending shelf and recovery, removes listener on cleanup', async () => {
  const start = source.indexOf('  // ─── Protect unsaved scanner rows')
  assert.notEqual(start, -1, 'beforeunload effect required')
  const end = source.indexOf('  // ─── Cleanup on unmount', start)
  assert.ok(end > start)
  for (const [rows, recovery, blocked] of [[[], false, false], [[row()], false, true], [[], true, true]]) {
    const listeners = new Map()
    let cleanup
    const env = { ...session, scannerShelf: rows, scannerRecovery: recovery,
      scannerShelfRef: { current: rows }, useEffect: fn => { cleanup = fn() },
      window: { addEventListener: (name, fn) => listeners.set(name, fn),
        removeEventListener: (name, fn) => { assert.equal(listeners.get(name), fn); listeners.delete(name) } } }
    new Function('env', `with (env) { ${source.slice(start, end)} }`)(env)
    let prevented = false
    const event = { preventDefault: () => { prevented = true } }
    listeners.get('beforeunload')(event)
    assert.equal(prevented, blocked)
    assert.equal(event.returnValue, blocked ? '' : undefined)
    cleanup(); assert.equal(listeners.size, 0)
  }
})
await test('lost reply blocks edits; explicit Retry reuses identical payload and accepts replay once', async () => {
  for (const firstResponse of [() => Promise.reject(new Error('lost')),
    () => Promise.resolve({ ok: false, status: 503, json: async () => ({}) }),
    () => Promise.resolve({ ok: true, status: 200, json: async () => { throw new Error('truncated') } }),
    () => Promise.resolve({ ok: true, status: 200, json: async () => ({}) })]) {
    let first = true
    let received
    const h = harness([row()], () => {
      if (first) { first = false; return firstResponse() }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ...receipt(), replayed: true }) })
    }, data => { received = data })
    await h.handlers.handleScannerBatchAdd()
    frozen(h)
    await h.handlers.handleScannerBatchAdd()
    assert.equal(h.env.posts.length, 1, 'normal confirm cannot retry unknown write')
    await h.handlers.handleScannerBatchAdd(true)
    assert.equal(h.env.posts.length, 2)
    assert.match(h.env.posts[0].batchId || '', /^[0-9a-f-]{36}$/)
    assert.deepEqual(h.env.posts[1], h.env.posts[0], 'retry must preserve every payload byte')
    assert.equal(received.replayed, true)
    assert.equal(h.env.scannerShelf.length, 0)
    assert.equal(h.env.added, 1)
    assert.equal(h.env.scannerRecovery, false)
    await h.handlers.handleScannerBatchAdd(true)
    assert.equal(h.env.posts.length, 2)
  }
})
await test('definite 4xx unfreezes and rotates identity; unknown discard and acknowledgement retire identity', async () => {
  const h = harness([row()], () => Promise.resolve({ ok: false, status: 409, json: async () => ({ error: 'Batch ID reused' }) }))
  await h.handlers.handleScannerBatchAdd()
  assert.equal(h.env.scannerBatchLifecycleRef.current.canMutate(), true)
  assert.equal(h.env.scannerRecovery, false)
  await h.handlers.handleScannerBatchAdd()
  assert.notEqual(h.env.posts[0].batchId, h.env.posts[1].batchId)
  for (const action of ['discard', 'acknowledge']) {
    const u = harness([row()], () => Promise.reject(new Error('lost')))
    await u.handlers.handleScannerBatchAdd()
    const id = u.env.posts[0].batchId
    if (action === 'discard') u.handlers.confirmScannerDiscard()
    else u.handlers.acknowledgeScannerLibraryCheck(true)
    const life = u.env.scannerBatchLifecycleRef.current
    assert.equal(life.unknownSnapshot(), null)
    life.arm() // explicit discard closes/unmounts; a fresh mount may begin again.
    const next = life.begin({ binder_id: 'binder', cards: [{ scryfall_id: 'a', quantity: 1 }] })
    assert.notEqual(next.batchId, id)
  }
})
if (failures) process.exitCode = 1
else console.log('CARD_SCANNER_INVENTORY_SAFETY_PASS')
