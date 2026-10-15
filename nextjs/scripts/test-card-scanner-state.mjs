import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as scannerState from '../src/lib/cardScannerState.mjs'
import {
  cameraErrorMessage,
  isScannerReady,
  isStreamLive,
  resolveCameraResume,
  resolveScanOutcome,
  statusAfterCancelledRead,
} from '../src/lib/cardScannerState.mjs'

assert.equal(
  cameraErrorMessage({ name: 'NotAllowedError' }, true),
  'Camera permission was denied. You can still search by name below.'
)
assert.equal(
  cameraErrorMessage({ name: 'NotFoundError' }, true),
  'No camera was found on this device. You can still search by name below.'
)
assert.equal(
  cameraErrorMessage({ name: 'OverconstrainedError' }, true),
  'The camera could not be started. You can still search by name below.'
)
assert.equal(
  cameraErrorMessage({ name: 'NotAllowedError' }, false),
  'Camera access needs a secure connection (HTTPS or localhost). Use manual search instead.'
)
assert.equal(
  cameraErrorMessage(null, true),
  'The camera could not be started. You can still search by name below.'
)

assert.deepEqual(resolveScanOutcome({ nameQuery: 'lightning bolt' }), {
  kind: 'evidence',
  evidence: { nameQuery: 'lightning bolt' },
})
assert.deepEqual(resolveScanOutcome({ nameQuery: '  Lightning Bolt  ' }), {
  kind: 'evidence',
  evidence: { nameQuery: '  Lightning Bolt  ' },
})
assert.deepEqual(resolveScanOutcome({ nameQuery: '' }), {
  kind: 'retry',
  message: 'The card title could not be read. Try again, or search by name below.',
})
assert.deepEqual(resolveScanOutcome(null), {
  kind: 'retry',
  message: 'The card title could not be read. Try again, or search by name below.',
})

// A usable OCR read stays in the non-scannable routing phase until the parent
// has finished catalog matching, visual comparison, and printing routing.
{
  const settleScanEvidence = scannerState.settleScanEvidence
  assert.equal(typeof settleScanEvidence, 'function', 'scan evidence settlement helper must exist')

  let releaseRouting
  let settled = false
  const routing = new Promise(resolve => { releaseRouting = resolve })
  const pending = settleScanEvidence({
    evidence: { nameQuery: 'lightning bolt' },
    onEvidence: () => routing,
    isCancelled: () => false,
  }).then(result => {
    settled = true
    return result
  })

  await Promise.resolve()
  assert.equal(settled, false, 'panel must remain non-scannable while catalog routing is pending')
  releaseRouting()
  assert.equal(await pending, 'live')

  let cancelled = false
  let releaseCancelledRouting
  const cancelledRouting = new Promise(resolve => { releaseCancelledRouting = resolve })
  const cancelledPending = settleScanEvidence({
    evidence: { nameQuery: 'counterspell' },
    onEvidence: () => cancelledRouting,
    isCancelled: () => cancelled,
  })
  cancelled = true
  releaseCancelledRouting()
  assert.equal(await cancelledPending, 'cancelled')
}

// ─── Camera readiness ─────────────────────────────────────────────────────

// Scannable means the element can actually yield a frame. A stream that is
// attached but has no decoded dimensions yet would capture a blank canvas, so
// readiness requires both video metadata and non-zero dimensions.
{
  const video = (overrides = {}) => ({
    readyState: 4,
    videoWidth: 720,
    videoHeight: 1008,
    ...overrides,
  })

  assert.equal(isScannerReady(video()), true)
  assert.equal(isScannerReady(video({ readyState: 2 })), true)
  // HAVE_NOTHING / HAVE_METADATA: no frame data to draw from yet.
  assert.equal(isScannerReady(video({ readyState: 0 })), false)
  assert.equal(isScannerReady(video({ readyState: 1 })), false)
  // Dimensions are the other half: some devices report data before sizing.
  assert.equal(isScannerReady(video({ videoWidth: 0 })), false)
  assert.equal(isScannerReady(video({ videoHeight: 0 })), false)
  assert.equal(isScannerReady(video({ videoWidth: undefined, videoHeight: undefined })), false)
  assert.equal(isScannerReady(video({ videoWidth: NaN })), false)
  assert.equal(isScannerReady(null), false)
  assert.equal(isScannerReady(undefined), false)
}

// ─── Repeated-scan camera lifecycle ───────────────────────────────────────

const track = (readyState = 'live') => ({ readyState })
const mediaStream = tracks => ({ getTracks: () => tracks })

{
  const live = mediaStream([track()])
  assert.equal(isStreamLive(live), true)
  assert.equal(isStreamLive(mediaStream([track('ended')])), false)
  assert.equal(isStreamLive(mediaStream([track('ended'), track()])), true)
  assert.equal(isStreamLive(mediaStream([])), false)
  assert.equal(isStreamLive(null), false)
  assert.equal(isStreamLive({}), false)
}

// An accepted scan returns the user to the panel for the next card. While the
// stream is still live that must cost no new getUserMedia call: reuse it, or at
// most re-point the video element at the stream already running.
{
  const live = mediaStream([track()])
  assert.equal(resolveCameraResume({ stream: live, attachedStream: live }), 'keep')
  assert.equal(resolveCameraResume({ stream: live, attachedStream: null }), 'reattach')
  assert.equal(resolveCameraResume({ stream: live, attachedStream: mediaStream([track()]) }), 'reattach')

  // Only a dead/absent stream may re-prompt the camera.
  assert.equal(resolveCameraResume({ stream: mediaStream([track('ended')]), attachedStream: null }), 'acquire')
  assert.equal(resolveCameraResume({ stream: mediaStream([]), attachedStream: null }), 'acquire')
  assert.equal(resolveCameraResume({ stream: null, attachedStream: null }), 'acquire')
  assert.equal(resolveCameraResume(), 'acquire')
}

// ─── Cancellation ─────────────────────────────────────────────────────────

// A read abandoned mid-flight (manual fallback, teardown, resume) must hand the
// panel back a usable status. 'reading' would strand the overlay and leave the
// scan button disabled with nothing left to finish it.
{
  const live = mediaStream([track()])
  assert.equal(statusAfterCancelledRead(live), 'live')
  assert.equal(statusAfterCancelledRead(mediaStream([track('ended')])), 'init')
  assert.equal(statusAfterCancelledRead(null), 'init')
  for (const stream of [live, mediaStream([track('ended')]), null, undefined]) {
    assert.notEqual(statusAfterCancelledRead(stream), 'reading')
  }
}

// ─── Panel wiring ─────────────────────────────────────────────────────────

{
  const panelSource = readFileSync(new URL('../src/components/CardScannerPanel.js', import.meta.url), 'utf8')

  // Readiness is gated on the element's own load events, never on stream
  // attachment alone, and the scan path re-checks before grabbing a frame.
  assert.match(panelSource, /onLoadedMetadata=\{handleVideoReady\}/)
  assert.match(panelSource, /onLoadedData=\{handleVideoReady\}/)
  assert.match(panelSource, /onCanPlay=\{handleVideoReady\}/)
  assert.match(panelSource, /if \(status !== 'live' \|\| !isScannerReady\(videoRef\.current\)\) return/)

  // Teardown belongs to unmount only: an effect that also runs on resume would
  // stop the stream it is meant to reuse.
  assert.match(panelSource, /useEffect\(\(\) => \(\) => \{\s*cancelledRef\.current = true\s*stopStream\(\)\s*\}, \[stopStream\]\)/)
  assert.match(panelSource, /resolveCameraResume\(\{\s*stream: streamRef\.current,/)

  // An accepted scan hands evidence up with the camera still running, but the
  // scan button stays disabled until the parent's returned routing promise has
  // settled. Resume renders must not promote a still-routing read to live.
  const readPath = panelSource.slice(
    panelSource.indexOf('const handleScan'),
    panelSource.indexOf('const handleManual')
  )
  assert.ok(readPath.length > 0)
  assert.doesNotMatch(readPath, /stopStream\(\)/)
  assert.match(readPath, /const nextStatus = await settleScanEvidence\(\{[\s\S]*onEvidence,[\s\S]*evidence: outcome\.evidence,[\s\S]*isCancelled: isReadCancelled/)
  assert.match(readPath, /if \(nextStatus === 'cancelled'\) return\s*setStatus\(nextStatus\)/)
  assert.doesNotMatch(readPath, /setStatus\('live'\)\s*onEvidence\(/)
  // Every pre-routing cancelled return resets status rather than leaving
  // 'reading' up while the panel is still mounted.
  assert.equal(readPath.match(/if \(isReadCancelled\(\)\) return abandonRead\(\)/g)?.length, 3)
  assert.match(readPath, /readEpoch !== readEpochRef\.current/)
  assert.match(readPath, /readScannerFrame\(\{[\s\S]*isCancelled: isReadCancelled/)
  assert.doesNotMatch(readPath, /if \(cancelledRef\.current\) return\s*$/m)

  const resumePath = panelSource.slice(
    panelSource.indexOf('// Mount and resume:'),
    panelSource.indexOf('const handleScan')
  )
  assert.match(resumePath, /setStatus\(current => \([\s\S]*current === 'reading'[\s\S]*current/)

  const modalSource = readFileSync(new URL('../src/components/AddCardModal.js', import.meta.url), 'utf8')
  const evidenceHandler = modalSource.slice(
    modalSource.indexOf('const handleScanEvidence'),
    modalSource.indexOf('const handleManualFallback')
  )
  assert.match(evidenceHandler, /return doSearch\(term, nextFilters, 1, false, evidence, SCAN_LIMIT\)/)

  // Manual fallback still releases the camera: that exit leaves the scanner.
  const manualPath = panelSource.slice(panelSource.indexOf('const handleManual'))
  assert.match(manualPath, /stopStream\(\)/)
}

// Set+serial can recover an unreadable/non-English title, but remains assisted.
assert.equal(resolveScanOutcome({ nameQuery: '', setCode: 'sta', collectorNumber: '117' }).kind, 'evidence')
assert.equal(resolveScanOutcome({ nameQuery: '', setCode: 'sta' }).kind, 'retry')

console.log('CARD_SCANNER_STATE_PASS')
