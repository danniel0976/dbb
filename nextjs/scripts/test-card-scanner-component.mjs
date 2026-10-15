import assert from 'node:assert/strict'
import { scannerComponentHarness, findScannerElement, scannerElementText } from './lib/scannerComponentHarness.mjs'
import * as parser from '../src/lib/cardScanner.mjs'
import * as session from '../src/lib/cardScannerSession.mjs'
import * as view from '../src/lib/cardScannerView.mjs'

const stub = name => Object.assign(() => null, { displayName: name })
const props = { binders: [], onClose() {}, onAdded() { throw new Error('scanner matching cannot write collection state') } }
const before = { document: globalThis.document, fetch: globalThis.fetch }
globalThis.document = { body: { style: {} }, addEventListener() {}, removeEventListener() {} }
const dependencies = {
  '@/lib/cardScanner.mjs': parser,
  '@/lib/cardScannerSession.mjs': session,
  '@/lib/cardScannerView.mjs': view,
  '@/lib/cardScannerVisualBrowser.mjs': { compareScannerCandidatesVisually: async groups => ({ groups, status: 'unavailable' }) },
  './CardScannerPanel': { default: stub('CardScannerPanel'), terminateScannerWorker() {} },
  './ScannerPrintingSelection': { PrintingSelectionPanel: stub('PrintingSelectionPanel'), CandidateCardName: stub('CandidateCardName') },
  './ScannerShelfNotices': { HeldScansBanner: stub('HeldScansBanner'), ScannerExitPrompt: stub('ScannerExitPrompt') },
}
const panel = tree => findScannerElement(tree, element => element.type?.displayName === 'CardScannerPanel')
const picker = tree => findScannerElement(tree, element => element.type?.displayName === 'PrintingSelectionPanel')
const ed = (id, set, number) => ({ scryfall_id: id, set_code: set, collector_number: number, rarity: 'rare', finishes: ['nonfoil'] })
try {
  const harness = scannerComponentHarness('components/AddCardModal.js', dependencies)
  let tree = harness.render(props)
  findScannerElement(tree, e => e.type === 'button' && scannerElementText(e).includes('Scan card')).props.onClick()
  tree = harness.render(props)
  const requests = []
  globalThis.fetch = async url => {
    const query = new URL(url, 'https://offline.invalid')
    assert.equal(query.pathname, '/api/catalog/search', 'scanner must not query/read/write the user collection')
    requests.push(query)
    return { ok: true, json: async () => ({ groups: [{ name: 'Natural Order', editions: [ed('sta-117', 'sta', '117')] }], total: 1, has_more: false }) }
  }
  await panel(tree).props.onEvidence({ nameQuery: '', setCode: 'sta', collectorNumber: '117' })
  tree = harness.render(props)
  assert.equal(requests.length, 1, 'set/serial-only scan must reach catalog retrieval instead of doing nothing')
  assert.equal(requests[0].searchParams.get('set'), 'sta')
  assert.equal(requests[0].searchParams.get('collector_number'), '117', 'printing-only scan must retrieve the exact catalog printing')
  assert.equal(requests[0].searchParams.get('q'), '')
  assert.equal(panel(tree).props.shelf.length, 0, 'printing-only evidence must never enter shelf automatically')
  assert.equal(picker(tree).props.reason, 'printing-only')
  assert.equal(picker(tree).props.children[0].props.edition.scryfall_id, 'sta-117')
  harness.unmount()

  // A weak or incorrect OCR title must not leave unrelated names in the
  // candidate list when the card's set and collector number were read.
  const printingFallback = scannerComponentHarness('components/AddCardModal.js', dependencies)
  tree = printingFallback.render(props)
  findScannerElement(tree, e => e.type === 'button' && scannerElementText(e).includes('Scan card')).props.onClick()
  tree = printingFallback.render(props)
  const fallbackRequests = []
  globalThis.fetch = async url => {
    const query = new URL(url, 'https://offline.invalid')
    fallbackRequests.push(query)
    if (query.searchParams.get('q')) {
      return { ok: true, json: async () => ({ groups: [
        { name: 'Sorin Markov', editions: [ed('wrong-title', 'mom', '7')] },
      ], total: 1, has_more: false }) }
    }
    if (query.searchParams.get('collector_number') !== '169') {
      return { ok: true, json: async () => ({ groups: [], total: 0, has_more: false }) }
    }
    return { ok: true, json: async () => ({ groups: [
      { name: 'Urabrask', editions: [ed('urabrask-mom-169', 'mom', '169')] },
    ], total: 1, has_more: false }) }
  }
  const paddedEvidence = parser.extractScanEvidence('Unrelated OCR title\n0169 R\nMOM EN')
  assert.equal(paddedEvidence.collectorNumber, '169', 'printed leading zero must normalize to the catalog collector number')
  await panel(tree).props.onEvidence(paddedEvidence)
  tree = printingFallback.render(props)
  assert.equal(fallbackRequests.length, 2, 'an uncertain title with exact printing clues must retry as printing-only')
  assert.equal(fallbackRequests[1].searchParams.get('q'), '')
  assert.equal(fallbackRequests[1].searchParams.get('set'), 'mom')
  assert.equal(fallbackRequests[1].searchParams.get('collector_number'), '169')
  assert.equal(picker(tree).props.reason, 'printing-only')
  assert.deepEqual(picker(tree).props.children.map(row => row.props.cardName), ['Urabrask'])
  assert.equal(panel(tree).props.shelf.length, 0, 'printing-only fallback must still require explicit user selection')
  printingFallback.unmount()

  const tiedFallback = scannerComponentHarness('components/AddCardModal.js', dependencies)
  tree = tiedFallback.render(props)
  findScannerElement(tree, e => e.type === 'button' && scannerElementText(e).includes('Scan card')).props.onClick()
  tree = tiedFallback.render(props)
  const tiedRequests = []
  globalThis.fetch = async url => {
    const query = new URL(url, 'https://offline.invalid')
    tiedRequests.push(query)
    if (query.searchParams.get('q')) {
      return { ok: true, json: async () => ({ groups: [
        { name: 'Saruman of Many Colors', editions: [ed('colors-wrong-print', 'ltr', '1')] },
        { name: 'Saruman, the White Hand', editions: [ed('white-wrong-print', 'ltr', '2')] },
      ], total: 2, has_more: false }) }
    }
    return { ok: true, json: async () => ({ groups: [
      { name: 'Urabrask', editions: [ed('urabrask-tied-fallback', 'mom', '169')] },
    ], total: 1, has_more: false }) }
  }
  await panel(tree).props.onEvidence(parser.extractScanEvidence('Saruman\n0169 R\nMOM EN'))
  tree = tiedFallback.render(props)
  assert.equal(tiedRequests.length, 2, 'a title tie with exact printed identifiers must use the safe printing-only fallback')
  assert.equal(picker(tree).props.reason, 'printing-only')
  assert.deepEqual(picker(tree).props.children.map(row => row.props.cardName), ['Urabrask'])
  assert.equal(panel(tree).props.shelf.length, 0)
  tiedFallback.unmount()

  // Exercise the real widened picker, not only routeScannerMatch. A page-4
  // printing resolves the match, but load-more must neither go inert nor add.
  const widened = scannerComponentHarness('components/AddCardModal.js', dependencies)
  let next = widened.render(props)
  findScannerElement(next, e => e.type === 'button' && scannerElementText(e).includes('Scan card')).props.onClick()
  next = widened.render(props)
  const pages = []
  globalThis.fetch = async url => {
    const query = new URL(url, 'https://offline.invalid')
    assert.equal(query.pathname, '/api/catalog/search')
    const page = Number(query.searchParams.get('page'))
    pages.push(page)
    const same = { name: 'Roaming Throne', editions: [ed(`throne-${page}`, page === 4 ? 'lci' : 'xyz', page === 4 ? '258' : String(page))] }
    return { ok: true, json: async () => ({ groups: [same, { name: 'Roaming Unrelated', editions: [ed(`unrelated-${page}`, 'lci', '258')] }], total: 8, has_more: page < 4 }) }
  }
  await panel(next).props.onEvidence({ nameQuery: 'roaming throne', setCode: 'lci', collectorNumber: '0258' })
  next = widened.render(props)
  assert.deepEqual(pages, [1, 2, 3])
  assert.ok(picker(next).props.children.every(row => row.props.cardName === 'Roaming Throne'))
  picker(next).props.onLoadMore()
  await new Promise(resolve => setImmediate(resolve))
  next = widened.render(props)
  assert.deepEqual(pages, [1, 2, 3, 4])
  assert.equal(picker(next).props.reason, 'direct-confirm')
  assert.equal(panel(next).props.shelf.length, 0, 'load-more never auto-adds')
  assert.equal(picker(next).props.children.length, 4, 'all same-name printings from the widened pool stay reachable')
  assert.ok(picker(next).props.children.every(row => row.props.cardName === 'Roaming Throne'))
  assert.ok(picker(next).props.children.some(row => row.props.edition.scryfall_id === 'throne-4'))
  widened.unmount()

  // A distinct-name tie keeps both cards visible and selectable in the real
  // modal callback path, including when pagination adds the alternative.
  const ambiguous = scannerComponentHarness('components/AddCardModal.js', dependencies)
  next = ambiguous.render(props)
  findScannerElement(next, e => e.type === 'button' && scannerElementText(e).includes('Scan card')).props.onClick()
  next = ambiguous.render(props)
  globalThis.fetch = async url => {
    assert.equal(new URL(url, 'https://offline.invalid').pathname, '/api/catalog/search')
    return { ok: true, json: async () => ({ groups: [
      { name: 'Saruman of Many Colors', editions: [ed('colors', 'ltr', '1')] },
      { name: 'Saruman, the White Hand', editions: [ed('white', 'ltr', '2')] },
      { name: 'Unrelated', editions: [ed('unrelated', 'lci', '3')] },
    ], total: 3, has_more: false }) }
  }
  await panel(next).props.onEvidence({ nameQuery: 'saruman' })
  next = ambiguous.render(props)
  assert.equal(picker(next).props.reason, 'card-name-tie')
  const alternatives = picker(next).props.children
  assert.deepEqual(alternatives.map(row => row.props.cardName), ['Saruman of Many Colors', 'Saruman, the White Hand'])
  assert.ok(alternatives.every(row => row.props.showCardName === true))
  alternatives[1].props.onSelect(alternatives[1].props.edition, alternatives[1].props.cardName)
  next = ambiguous.render(props)
  assert.equal(panel(next).props.shelf[0].cardName, 'Saruman, the White Hand')
  assert.equal(panel(next).props.shelf[0].source, 'scanner-confirmed')
  ambiguous.unmount()
} finally { Object.assign(globalThis, before) }
import * as state from '../src/lib/cardScannerState.mjs'
import * as assets from '../src/lib/cardScannerAssets.mjs'
import * as capture from '../src/lib/cardScannerCapture.mjs'

// Real panel effects, synthetic MediaStream/video objects. This proves the
// lifecycle wiring, not Android Firefox's native camera implementation.
{
  const saved = Object.fromEntries(['document', 'window', 'navigator'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const page = new EventTarget()
  page.visibilityState = 'visible'
  const browser = new EventTarget()
  browser.isSecureContext = true
  const streams = []
  const evidenceReads = []
  let located = 0
  let ocrReads = 0
  let workerOptions
  let failNextCameraRequest = false
  let cameraRequests = 0
  const fakeWorker = {
    async reinitialize() {}, async setParameters() {},
    async recognize() { return { data: { text: ++ocrReads % 2 === 1 ? '117 R\nSTA JP' : '自然の秩序' } } },
  }
  page.createElement = () => {
    const canvas = { width: 0, height: 0 }
    canvas.getContext = () => ({ drawImage() {}, putImageData() {}, getImageData() {
      return { width: canvas.width, height: canvas.height, data: new Uint8ClampedArray(canvas.width * canvas.height * 4) }
    } })
    return canvas
  }
  const video = { videoWidth: 720, videoHeight: 1008, readyState: 4, srcObject: null, playCalls: 0, play() { this.playCalls++; return Promise.resolve() } }
  for (const [key, value] of Object.entries({ document: page, window: browser, navigator: {
    mediaDevices: { async getUserMedia() {
      cameraRequests++
      if (failNextCameraRequest) {
        failNextCameraRequest = false
        throw Object.assign(new Error('camera permission denied'), { name: 'NotAllowedError' })
      }
      const track = new EventTarget()
      track.readyState = 'live'
      track.stop = function stop() { this.readyState = 'ended' }
      const stream = { getTracks: () => [track], getVideoTracks: () => [track] }
      streams.push(stream)
      return stream
    } },
  } })) Object.defineProperty(globalThis, key, { configurable: true, value })
  const harness = scannerComponentHarness('components/CardScannerPanel.js', {
    '@/lib/cardScanner.mjs': parser,
    '@/lib/cardScannerCapture.mjs': { ...capture, locateScannerCard(image) { located++; return { x: 20, y: 20, w: image.width - 40, h: image.height - 40 } } },
    'tesseract.js': { async createWorker(language, oem, options) { workerOptions = options; return fakeWorker } },
    '@/lib/cardScannerState.mjs': state,
    '@/lib/cardScannerAssets.mjs': assets,
    '@/lib/cardScannerView.mjs': view,
    '@/lib/cardScannerVisualBrowser.mjs': { visualSignatureFromDrawable: () => null },
  })
  const render = () => harness.render({ onEvidence: evidence => evidenceReads.push(evidence) }, tree => {
    const element = findScannerElement(tree, e => e.type === 'video')
    if (element) element.props.ref.current = video
  })
  const flush = () => new Promise(resolve => setImmediate(resolve))
  try {
    render()
    await flush()
    render()
    assert.equal(streams.length, 1)
    page.visibilityState = 'hidden'
    page.dispatchEvent(new Event('visibilitychange'))
    assert.equal(streams[0].getTracks()[0].readyState, 'ended', 'backgrounding must release/invalidate the suspended camera')
    page.visibilityState = 'visible'
    page.dispatchEvent(new Event('visibilitychange'))
    browser.dispatchEvent(new Event('pageshow'))
    browser.dispatchEvent(new Event('focus'))
    await flush()
    render()
    assert.equal(streams.length, 2, 'returning must reacquire once, even with overlapping resume events')
    assert.equal(video.srcObject, streams[1])
    assert.ok(video.playCalls > 0, 'returning must explicitly play the video, not rely solely on autoplay')
    const requestsBeforeEndedTrack = cameraRequests
    failNextCameraRequest = true
    streams[1].getVideoTracks()[0].readyState = 'ended'
    streams[1].getVideoTracks()[0].dispatchEvent(new Event('ended'))
    await flush()
    render()
    assert.equal(cameraRequests, requestsBeforeEndedTrack + 1, 'ended-track recovery must actually request the camera once')
    assert.equal(streams.length, 2, 'an ended camera track must attempt reacquisition without a page refresh')
    const requestsAfterError = cameraRequests
    page.visibilityState = 'hidden'
    page.dispatchEvent(new Event('visibilitychange'))
    page.visibilityState = 'visible'
    page.dispatchEvent(new Event('visibilitychange'))
    browser.dispatchEvent(new Event('focus'))
    browser.dispatchEvent(new Event('pageshow'))
    await flush()
    assert.equal(cameraRequests, requestsAfterError, 'focus events must not retry a camera request that already failed')
    const retryCamera = findScannerElement(render(), e => e.type === 'button' && scannerElementText(e).includes('Retry camera'))
    assert.ok(retryCamera, 'a temporary camera reacquisition failure must offer an explicit retry')
    retryCamera.props.onClick()
    await flush()
    render()
    assert.equal(streams.length, 3)
    assert.equal(video.srcObject, streams[2])
    const scanTree = render()
    await findScannerElement(scanTree, e => e.type === 'button' && scannerElementText(e).includes('Scan')).props.onClick()
    assert.equal(located, 1, 'capture must locate card bounds before layout-specific OCR')
    assert.equal(evidenceReads.length, 1)
    assert.equal(evidenceReads[0].titleLayout, 'vertical-japanese')
    assert.equal(evidenceReads[0].setCode, 'sta')
    assert.equal(evidenceReads[0].collectorNumber, '117')
    assert.equal(typeof workerOptions.errorHandler, 'function', 'optional language download failures must reject promises, not throw globally in Tesseract')
    const readText = scannerElementText(findScannerElement(render(), e => e.type === 'details'))
    assert.match(readText, /Scan read/)
    assert.match(readText, /自然の秩序/)
    assert.match(readText, /117/)
    let finishInfo
    let startedInfo
    const started = new Promise(resolve => { startedInfo = resolve })
    let stalledReads = 0
    fakeWorker.recognize = async () => {
      if (++stalledReads > 1) return { data: { text: '自然の秩序' } }
      startedInfo()
      return new Promise(resolve => { finishInfo = () => resolve({ data: { text: '117 R\nSTA JP' } }) })
    }
    const pendingRead = findScannerElement(render(), e => e.type === 'button' && scannerElementText(e).includes('Scan')).props.onClick()
    await started
    page.visibilityState = 'hidden'
    page.dispatchEvent(new Event('visibilitychange'))
    page.visibilityState = 'visible'
    page.dispatchEvent(new Event('visibilitychange'))
    await flush()
    render()
    finishInfo()
    await pendingRead
    assert.equal(evidenceReads.length, 1, 'an OCR read abandoned by app switching must not emit late evidence after return')
    const beforeUnmount = streams.length
    harness.unmount()
    page.dispatchEvent(new Event('visibilitychange'))
    browser.dispatchEvent(new Event('pageshow'))
    await flush()
    assert.equal(streams.length, beforeUnmount, 'unmount must remove resume listeners')
    assert.equal(streams.at(-1).getTracks()[0].readyState, 'ended')
  } finally {
    harness.unmount()
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  }
}
console.log('CARD_SCANNER_COMPONENT_PASS')
