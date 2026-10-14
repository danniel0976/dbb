// Execute the actual non-JSX callbacks without React, dependencies or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { rankScannerResults } from '../src/lib/cardScanner.mjs'
import { routeScannerMatch, scannerRetrievalSeed, shouldSweepAnotherScanPage } from '../src/lib/cardScannerSession.mjs'
import { scannerSelectionReason } from '../src/lib/cardScannerView.mjs'

const source = readFileSync(new URL('../src/components/AddCardModal.js', import.meta.url), 'utf8')

function between(text, start, end) {
  const from = text.indexOf(start)
  assert(from >= 0 && text.indexOf(start, from + start.length) === -1, `Cannot uniquely locate ${start}`)
  const to = text.indexOf(end, from + start.length)
  assert(to > from && text.indexOf(end) === to && text.indexOf(end, to + end.length) === -1,
    `Cannot uniquely locate end ${end} after ${start}`)
  return text.slice(from + start.length, to).trim()
}

function hookCallback(text, name, next) {
  const body = between(text, `const ${name} = useCallback(`, next)
  // Use the callback's closing brace, not any particular hook dependency list.
  const end = body.lastIndexOf('\n  },')
  assert(end >= 0 && /\)\s*$/.test(body.slice(end + '\n  },'.length)),
    `Cannot locate closing callback brace for ${name}`)
  return body.slice(0, end + '\n  }'.length)
}

const search = hookCallback(source, 'doSearch', '// ─── Input handler')
const buildUrl = hookCallback(source, 'buildSearchUrl', '// ─── Submit search')
const merge = between(source, 'function mergeSearchGroups', 'export default function AddCardModal')
const initial = between(source, 'const INITIAL_FILTERS = ', 'function hasActiveFilters')
const clear = between(source, 'const handleClear = ', 'const handleScanEvidence')
const cleanupSection = between(source, '// ─── Cleanup on unmount', 'const sheetRef')
const cleanupStart = cleanupSection.indexOf('useEffect(')
const cleanupEnd = cleanupSection.lastIndexOf('\n  },')
assert(cleanupStart >= 0 && cleanupEnd > cleanupStart, 'Cannot locate unmount effect callback')
const cleanup = cleanupSection.slice(cleanupStart + 'useEffect('.length, cleanupEnd + '\n  }'.length)

// Extraction drift must be loud, not a fallback to a hand-written algorithm.
assert.throws(() => hookCallback('', 'doSearch', '// ─── Input handler'), /Cannot uniquely locate/)
assert.throws(() => hookCallback(source.replace('const doSearch =', 'const renamed ='), 'doSearch', '// ─── Input handler'), /Cannot uniquely locate/)

assert.throws(() => hookCallback(source + 'const doSearch = useCallback(', 'doSearch', '// ─── Input handler'), /Cannot uniquely locate/)
assert.throws(() => hookCallback(source.replace('// ─── Input handler', '// renamed'), 'doSearch', '// ─── Input handler'), /Cannot uniquely locate end/)
assert.throws(() => hookCallback(source + '// ─── Input handler', 'doSearch', '// ─── Input handler'), /Cannot uniquely locate end/)
assert.throws(() => hookCallback('const doSearch = useCallback(async () => {\n// ─── Input handler', 'doSearch', '// ─── Input handler'), /closing callback brace/)

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function harness(parts = {}) {
  const state = { ScannerShelf: [{ scryfallId: 'held', quantity: 1 }] }
  const writes = []
  const requests = []
  const visuals = []
  const violations = []
  const context = {
    AbortController, URLSearchParams,
    rankScannerResults, routeScannerMatch, scannerRetrievalSeed, shouldSweepAnotherScanPage, scannerSelectionReason,
    compareScannerCandidatesVisually: (groups, signature) => {
      if (!parts.deferVisual) return Promise.resolve({ groups, status: 'unavailable' })
      const pending = deferred()
      visuals.push({ ...pending, groups, signature })
      return pending.promise
    },
    acceptScannerCandidate: (candidate, origin) => {
      state.ScannerShelf.push({ candidate, origin })
      writes.push('ScannerShelf')
      assert.fail('Unexpected direct acceptance in concurrency fixture')
    },
    DEFAULT_LIMIT: 20,
    abortRef: { current: null },
    searchGenRef: { current: 0 },
    groups: [],
    inputRef: { current: null },
    scannerSessionMutable: () => true,
    leaveScannerMode: () => {},
    scannerBatchLifecycleRef: { current: { arm() {}, invalidate() {} } },
    terminateScannerWorker: () => {},
    // No real fetch is exposed to this isolated VM. Unexpected URLs fail closed.
    fetch(url, options) {
      const invalid = []
      if (typeof url !== 'string' || !url.startsWith('/api/catalog/search?')) invalid.push('Unexpected fetch URL')
      if (!(options?.signal instanceof AbortSignal)) invalid.push('Missing AbortSignal')
      if (invalid.length) {
        violations.push(...invalid)
        return Promise.reject(new Error('Fetch double rejected invalid request'))
      }
      const pending = deferred()
      requests.push({ url, signal: options.signal, resolve: pending.resolve, reject: pending.reject })
      // Deliberately ignore abort here to simulate late success/errors from a
      // transport that has already started processing its response.
      return pending.promise
    },
  }
  for (const name of ['Groups', 'Total', 'HasMore', 'Page', 'Loading', 'LoadingMore', 'Error',
    'Q', 'CommittedQ', 'Filters', 'AppliedFilters', 'SelectedEdition', 'ScanEvidence',
    'ScannerDecision', 'ScannerVisualStatus']) {
    context[`set${name}`] = value => {
      state[name] = typeof value === 'function' ? value(state[name]) : value
      writes.push(name)
    }
  }
  const callbacks = runInNewContext(`
    const INITIAL_FILTERS = ${initial}
    const mergeSearchGroups = function mergeSearchGroups${merge}
    const buildSearchUrl = ${parts.buildUrl ?? buildUrl}
    const doSearch = ${parts.search ?? search}
    const handleClear = ${parts.clear ?? clear}
    const unmount = (${parts.cleanup ?? cleanup})()
    ;({ doSearch, handleClear, unmount, INITIAL_FILTERS })
  `, context, { timeout: 1000 })
  const start = (query, append = false, evidence = null) => callbacks.doSearch(
    query, callbacks.INITIAL_FILTERS, append ? 2 : 1, append, evidence
  )
  return { ...callbacks, start, state, writes, requests, visuals, context,
    assertValidFetches: () => assert.deepEqual(violations, [], 'Fetch double violations must escape callback catch') }
}

function respond(request, name) {
  request.resolve({ ok: true, json: async () => ({
    groups: [{ name, editions: [{ scryfall_id: name }] }], total: 1, has_more: false,
  }) })
}

const modes = [null, { nameQuery: 'unreadable', setCode: null, collectorNumber: null, rarity: null }]

async function verifyConcurrency(parts = {}) {
  const harnesses = []
  const makeHarness = () => {
    const h = harness(parts)
    harnesses.push(h)
    return h
  }

// A newer request aborts the old one; a late success cannot overwrite its result.
for (const evidence of modes) {
  const h = makeHarness()
  const older = h.start('old', false, evidence)
  const generation = h.context.searchGenRef.current
  const newer = h.start('new', false, evidence)
  assert.equal(new URLSearchParams(h.requests[1].url.split('?')[1]).get('scan'), evidence ? '1' : null)
  assert.equal(h.context.searchGenRef.current, generation + 1)
  assert.equal(h.requests[0].signal.aborted, true)
  assert.equal(h.requests[1].signal.aborted, false)
  respond(h.requests[1], 'Newer')
  await newer
  const snapshot = JSON.stringify(h.state)
  const writes = h.writes.length
  respond(h.requests[0], 'Older')
  await older
  assert.equal(h.state.Groups[0].name, 'Newer')
  assert.equal(JSON.stringify(h.state), snapshot)
  assert.equal(h.writes.length, writes, 'stale success/finally must not write state')
}

// Stale rejection/finally cannot clear either loading flag or the newer controller.
for (const evidence of modes) for (const append of [false, true]) {
  const h = makeHarness()
  const older = h.start('old', false, evidence)
  const newer = h.start('new', append, evidence)
  const controller = h.context.abortRef.current
  const snapshot = JSON.stringify(h.state)
  const writes = h.writes.length
  h.requests[0].reject(new Error('late old error'))
  await older
  assert.equal(JSON.stringify(h.state), snapshot)
  assert.equal(h.writes.length, writes)
  assert.equal(h.state.Loading, !append)
  assert.equal(h.state.LoadingMore, append)
  assert.equal(h.context.abortRef.current, controller)
  respond(h.requests[1], 'Newer')
  await newer
  assert.equal(h.state.Error, null)
  assert.equal(h.state.Loading, false)
  assert.equal(h.state.LoadingMore, false)
  assert.equal(h.context.abortRef.current, null)
}

// Execute real clear and real effect cleanup, not invented generation changes.
for (const evidence of modes) for (const action of ['handleClear', 'unmount']) {
  for (const outcome of ['success', 'error']) {
    const h = makeHarness()
    const pending = h.start('pending', false, evidence)
    const generation = h.context.searchGenRef.current
    h[action]()
    assert.equal(h.requests[0].signal.aborted, true)
    assert.equal(h.context.searchGenRef.current, generation + 1)
    const snapshot = JSON.stringify(h.state)
    const writes = h.writes.length
    if (outcome === 'success') respond(h.requests[0], 'Late')
    else h.requests[0].reject(new Error('late after invalidation'))
    await pending
    assert.equal(JSON.stringify(h.state), snapshot, `${action}: late ${outcome} changed state`)
    assert.equal(h.writes.length, writes, `${action}: stale finally wrote state`)
  }
}

  for (const h of harnesses) h.assertValidFetches()
}

async function reached(predicate, label) {
  for (let turn = 0; turn < 30 && !predicate(); turn++) await Promise.resolve()
  assert(predicate(), `Did not reach deferred ${label}`)
}

const printingEvidence = { nameQuery: 'unreadable', setCode: 'mom', collectorNumber: '169', rarity: null }
const printingData = {
  groups: [{ name: 'Lightning Bolt', editions: [{ scryfall_id: 'printing', set_code: 'mom', collector_number: '169' }] }],
  total: 1, has_more: false,
}

async function verifyDeferredAwaits(parts = {}) {
  for (const stage of ['fetch-json', 'printing-fetch', 'printing-json', 'visual']) {
    for (const action of ['newer', 'handleClear', 'unmount']) for (const outcome of ['success', 'error']) {
      const h = harness({ ...parts, deferVisual: stage === 'visual' })
      const evidence = stage.startsWith('printing') ? printingEvidence : modes[1]
      const older = h.start('unreadable', false, evidence)
      let release
      if (stage === 'fetch-json') {
        const json = deferred()
        let entered = false
        h.requests[0].resolve({ ok: true, json: () => { entered = true; return json.promise } })
        await reached(() => entered, stage)
        release = () => outcome === 'success' ? json.resolve(printingData) : json.reject(new Error('late json'))
      } else if (stage.startsWith('printing')) {
        h.requests[0].resolve({ ok: true, json: async () => ({ groups: [], total: 0, has_more: false }) })
        await reached(() => h.requests.length === 2, stage)
        const lookup = h.requests[1]
        const params = new URLSearchParams(lookup.url.split('?')[1])
        assert.equal(params.get('q'), '')
        assert.equal(params.get('set'), 'mom')
        assert.equal(params.get('collector_number'), '169')
        assert.equal(params.get('scan'), '1')
        assert.equal(lookup.signal, h.requests[0].signal)
        if (stage === 'printing-fetch') {
          release = () => outcome === 'success'
            ? lookup.resolve({ ok: true, json: async () => printingData })
            : lookup.reject(new Error('late printing fetch'))
        } else {
          const json = deferred()
          let entered = false
          lookup.resolve({ ok: true, json: () => { entered = true; return json.promise } })
          await reached(() => entered, stage)
          release = () => outcome === 'success' ? json.resolve(printingData) : json.reject(new Error('late printing json'))
        }
      } else {
        respond(h.requests[0], 'Old visual candidate')
        await reached(() => h.visuals.length === 1, stage)
        assert.equal(h.state.ScannerVisualStatus.status, 'checking')
        assert.equal(h.visuals[0].groups[0].name, 'Old visual candidate')
        release = () => outcome === 'success'
          ? h.visuals[0].resolve({ groups: h.visuals[0].groups, status: 'compared' })
          : h.visuals[0].reject(new Error('late visual error'))
      }
      const generation = h.context.searchGenRef.current
      let newer
      if (action === 'newer') newer = h.start('new')
      else h[action]()
      assert.equal(h.context.searchGenRef.current, generation + 1)
      assert.equal(h.requests[0].signal.aborted, true)
      const controller = h.context.abortRef.current
      const snapshot = JSON.stringify(h.state)
      const writes = h.writes.length
      release()
      await older
      assert.equal(JSON.stringify(h.state), snapshot, `${stage}/${action}/${outcome}: obsolete continuation changed state`)
      assert.equal(h.writes.length, writes, `${stage}: obsolete continuation wrote state`)
      assert.equal(h.context.abortRef.current, controller, `${stage}: obsolete continuation changed abort ownership`)
      if (newer) {
        respond(h.requests.at(-1), 'Newer')
        await newer
        assert.equal(h.state.Groups[0].name, 'Newer')
        assert.equal(h.context.abortRef.current, null)
      }
      h.assertValidFetches()
    }
  }
}

// Mutate extracted strings in memory only: no production files or scratch writes.
function replaceOnce(text, before, after) {
  assert.equal(text.split(before).length, 2, `Mutation must uniquely find ${before}`)
  return text.replace(before, after)
}

await verifyConcurrency()
await verifyDeferredAwaits()
// Current printing fallback still completes as confirmation-only, never auto-add.
{
  const h = harness()
  const pending = h.start('unreadable', false, printingEvidence)
  h.requests[0].resolve({ ok: true, json: async () => ({ groups: [], total: 0, has_more: false }) })
  await reached(() => h.requests.length === 2, 'current printing lookup')
  h.requests[1].resolve({ ok: true, json: async () => printingData })
  await pending
  assert.equal(h.state.ScannerDecision.kind, 'uncertain')
  assert.equal(h.state.ScannerDecision.reason, 'printing-only')
  assert.equal(h.state.ScannerDecision.candidates[0].edition.scryfall_id, 'printing')
  assert.equal(h.state.Groups[0].scanMatches.name, 'none')
  assert.equal(h.state.ScanEvidence.nameQuery, '')
  assert.equal(h.state.ScannerShelf.length, 1)
  assert.equal(h.state.Error, null)
  assert.equal(h.state.Loading, false)
  assert.equal(h.context.abortRef.current, null)
  h.assertValidFetches()
}
const staleGuard = 'if (gen !== searchGenRef.current) return'
const mutations = [
  ['fetch guard', { search: replaceOnce(search, `${staleGuard}\n\n        pool`, '// removed fetch guard\n\n        pool') }, verifyConcurrency],
  ['catch guard', { search: replaceOnce(search, `${staleGuard}  // stale — ignore`, '// removed catch guard') }, verifyConcurrency],
  ['finally guard', { search: replaceOnce(search, 'if (gen === searchGenRef.current) {', 'if (true) {') }, verifyConcurrency],
  ['clear bump', { clear: replaceOnce(clear, 'searchGenRef.current++', 'void 0') }, verifyConcurrency],
  ['unmount bump', { cleanup: replaceOnce(cleanup, 'searchGenRef.current++', 'void 0') }, verifyConcurrency],
  ['printing await guard', { search: replaceOnce(search, `${staleGuard}\n          pool`, '// removed printing guard\n          pool') }, verifyDeferredAwaits],
  ['visual await guard', { search: replaceOnce(search, `${staleGuard}\n          ranked = visual.groups`, '// removed visual guard\n          ranked = visual.groups') }, verifyDeferredAwaits],
]
for (const [name, parts, verify] of mutations) {
  await assert.rejects(() => verify(parts), error => error instanceof assert.AssertionError, `${name} mutation must fail assertions`)
  console.log(`MUTATION_REJECTED: ${name}`)
}

// Bad URL/signal errors are caught by doSearch, but cannot hide from the harness.
for (const parts of [
  { buildUrl: '() => "https://invalid.test/"' },
  { search: replaceOnce(search, 'fetch(url, { signal: controller.signal })\n        if (!res.ok)', 'fetch(url, {})\n        if (!res.ok)') },
]) {
  const h = harness(parts)
  await h.start('invalid')
  assert.equal(h.state.Error, 'Fetch double rejected invalid request')
  assert.equal(h.requests.length, 0)
  assert.throws(h.assertValidFetches, /Fetch double violations/)
}
console.log('CARD_SCANNER_SEARCH_CONCURRENCY_PASS (actual callbacks; manual/scanner/append, deferred printing/visual, clear/unmount, mutation rejection; no network)')
