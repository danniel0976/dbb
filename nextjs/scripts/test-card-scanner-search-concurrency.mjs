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
  assert(to > from, `Cannot locate end ${end} after ${start}`)
  return text.slice(from + start.length, to).trim()
}

function hookCallback(text, name, next) {
  const body = between(text, `const ${name} = useCallback(`, next)
  // Use the callback's closing brace, not any particular hook dependency list.
  const end = body.lastIndexOf('\n  },')
  assert(end >= 0, `Cannot locate closing callback brace for ${name}`)
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

function harness() {
  const state = {}
  const writes = []
  const requests = []
  const context = {
    AbortController, URLSearchParams,
    rankScannerResults, routeScannerMatch, scannerRetrievalSeed, shouldSweepAnotherScanPage, scannerSelectionReason,
    compareScannerCandidatesVisually: async groups => ({ groups, status: 'unavailable' }),
    acceptScannerCandidate: () => assert.fail('Unexpected direct acceptance in concurrency fixture'),
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
      assert.equal(typeof url, 'string')
      assert(url.startsWith('/api/catalog/search?'), `Unexpected fetch: ${url}`)
      assert(options.signal instanceof AbortSignal)
      let resolve, reject
      const pending = new Promise((yes, no) => { resolve = yes; reject = no })
      requests.push({ url, signal: options.signal, resolve, reject })
      // Deliberately ignore abort here to simulate late success/errors from a
      // transport that has already started processing its response.
      return pending
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
    const buildSearchUrl = ${buildUrl}
    const doSearch = ${search}
    const handleClear = ${clear}
    const unmount = (${cleanup})()
    ;({ doSearch, handleClear, unmount, INITIAL_FILTERS })
  `, context, { timeout: 1000 })
  const start = (query, append = false, evidence = null) => callbacks.doSearch(
    query, callbacks.INITIAL_FILTERS, append ? 2 : 1, append, evidence
  )
  return { ...callbacks, start, state, writes, requests, context }
}

function respond(request, name) {
  request.resolve({ ok: true, json: async () => ({
    groups: [{ name, editions: [{ scryfall_id: name }] }], total: 1, has_more: false,
  }) })
}

const modes = [null, { nameQuery: 'unreadable', setCode: null, collectorNumber: null, rarity: null }]

// A newer request aborts the old one; a late success cannot overwrite its result.
for (const evidence of modes) {
  const h = harness()
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
  const h = harness()
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
    const h = harness()
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

console.log('CARD_SCANNER_SEARCH_CONCURRENCY_PASS (actual callbacks; manual/scanner/append search, clear and unmount; no network)')
