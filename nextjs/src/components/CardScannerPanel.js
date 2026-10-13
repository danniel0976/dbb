'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { Camera, Loader2, ScanLine, Search, Trash2 } from 'lucide-react'
import { locateScannerCard, readScannerFrame } from '@/lib/cardScannerCapture.mjs'
import { resolveScannerAssetSources, scannerPrivacyNotice } from '@/lib/cardScannerAssets.mjs'
import { visualSignatureFromDrawable } from '@/lib/cardScannerVisualBrowser.mjs'
import {
  rarityToneClass,
  scannerVisualStatusCopy,
  shelfRarityLabel,
  shelfThumbnailSource,
} from '@/lib/cardScannerView.mjs'
import {
  cameraErrorMessage,
  isScannerReady,
  resolveCameraResume,
  resolveScanOutcome,
  settleScanEvidence,
  statusAfterCancelledRead,
} from '@/lib/cardScannerState.mjs'

// MTG card ratio: 63mm × 88mm → width/height = 0.716 (matches CameraCapture).
const MTG_CARD_RATIO = 0.716
const MAX_PX = 1280


// Where the OCR engine's worker/core/language assets load from. Unset vars mean
// tesseract.js keeps its jsdelivr defaults; see cardScannerAssets.mjs for why
// self-hosting all three is not shipped from this repository.
const SCANNER_ASSETS = resolveScannerAssetSources({
  workerPath: process.env.NEXT_PUBLIC_TESSERACT_WORKER_PATH,
  corePath: process.env.NEXT_PUBLIC_TESSERACT_CORE_PATH,
  langPath: process.env.NEXT_PUBLIC_TESSERACT_LANG_PATH,
})

// One bounded Tesseract worker per browser session, created only when a scan
// actually starts so the library stays out of the initial bundle.
let workerPromise = null

async function getScannerWorker() {
  if (!workerPromise) {
    workerPromise = import('tesseract.js')
      .then(Tesseract => Tesseract.createWorker('eng', 1, {
        logger: () => {},
        // Tesseract still rejects the owning job promise. Suppress its default
        // global throw so an unavailable optional language can fail soft.
        errorHandler: () => {},
        ...SCANNER_ASSETS.options,
      }))
      .catch(err => {
        workerPromise = null
        throw err
      })
  }
  return workerPromise
}

/** Release the shared worker. Called when the add-card modal fully closes. */
export async function terminateScannerWorker() {
  const pending = workerPromise
  workerPromise = null
  if (!pending) return
  try {
    const worker = await pending
    await worker?.terminate?.()
  } catch {
    // A worker that never started needs no teardown.
  }
}

// Capture the portrait crop the viewfinder shows, capped at MAX_PX.
// Stays in browser memory — nothing here is ever uploaded.
function captureCardCanvas(video) {
  const { videoWidth: vw, videoHeight: vh } = video
  if (!vw || !vh) return null
  let sx = 0
  let sy = 0
  let sw = vw
  let sh = vh
  if (vw / vh > MTG_CARD_RATIO) {
    sw = Math.round(vh * MTG_CARD_RATIO)
    sx = Math.round((vw - sw) / 2)
  } else {
    sh = Math.round(vw / MTG_CARD_RATIO)
    sy = Math.round((vh - sh) / 2)
  }
  const scale = Math.min(1, MAX_PX / Math.max(sw, sh))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(sw * scale)
  canvas.height = Math.round(sh * scale)
  canvas.getContext('2d').drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
  // Locate a smaller/offset portrait card at bounded resolution. Ambiguous
  // boundaries fail soft to the same viewfinder crop; no perspective claim.
  const sample = document.createElement('canvas')
  sample.width = 240
  sample.height = Math.round(240 / MTG_CARD_RATIO)
  const context = sample.getContext('2d', { willReadFrequently: true })
  context.drawImage(canvas, 0, 0, sample.width, sample.height)
  const bounds = locateScannerCard(context.getImageData(0, 0, sample.width, sample.height))
  if (bounds) {
    const cropped = document.createElement('canvas')
    const scaleX = canvas.width / sample.width
    const scaleY = canvas.height / sample.height
    cropped.width = Math.round(bounds.w * scaleX)
    cropped.height = Math.round(bounds.h * scaleY)
    cropped.getContext('2d').drawImage(canvas, bounds.x * scaleX, bounds.y * scaleY,
      bounds.w * scaleX, bounds.h * scaleY, 0, 0, cropped.width, cropped.height)
    return cropped
  }
  return canvas
}

// Lightweight browser-canvas cleanup (BRD: start here, OpenCV only if measured):
// upscale the strip, desaturate, and stretch contrast around mid-grey.
function prepareStrip(source, rect) {
  const sx = Math.round(source.width * rect.x)
  const sy = Math.round(source.height * rect.y)
  const sw = Math.max(1, Math.round(source.width * rect.w))
  const sh = Math.max(1, Math.round(source.height * rect.h))
  const zoom = 2
  const canvas = document.createElement('canvas')
  canvas.width = sw * zoom
  canvas.height = sh * zoom
  const ctx = canvas.getContext('2d')
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)

  const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const px = image.data
  for (let i = 0; i < px.length; i += 4) {
    const grey = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]
    const stretched = Math.max(0, Math.min(255, (grey - 128) * 1.6 + 128))
    px[i] = stretched
    px[i + 1] = stretched
    px[i + 2] = stretched
  }
  ctx.putImageData(image, 0, 0)
  return canvas
}

/**
 * CardScannerPanel — browser-local capture + OCR for the add-card flow.
 *
 * Props:
 *   onEvidence  fn(evidence)   — a usable read; the modal seeds its own search
 *   onManual    fn(prefillText)— user (or a failure) falls back to manual search
 *   shelf       scanner-originated temporary items; never persisted here
 *
 * The panel never calls /api/library/add, never selects a printing, and never
 * uploads the captured frame. Manual search stays reachable in every state.
 */
export default function CardScannerPanel({
  onEvidence,
  onManual,
  shelf = [],
  onEditShelfItem,
  onRemoveShelfItem,
  binders = [],
  binderId = '',
  onBinderChange,
  condition = 'NM',
  conditions = [],
  onConditionChange,
  onConfirmBatch,
  confirming = false,
  resumeToken = 0,
  visualStatus = null,
  children,
}) {
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const cancelledRef = useRef(false)
  const cameraEpochRef = useRef(0)
  const cameraPendingRef = useRef(null)
  const cameraFailedRef = useRef(false)
  const readEpochRef = useRef(0)

  const [status, setStatus] = useState('init') // init | live | reading | error
  const [message, setMessage] = useState(null)
  const [lastText, setLastText] = useState('')
  const [lastRead, setLastRead] = useState(null)
  const selectedQuantity = shelf
    .filter(item => item.selected === true)
    .reduce((sum, item) => sum + item.quantity, 0)
  const visualMessage = scannerVisualStatusCopy(visualStatus)

  const stopStream = useCallback(() => {
    cameraEpochRef.current += 1
    cameraPendingRef.current = null
    const stream = streamRef.current
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    stream?.getTracks().forEach(track => track.stop())
  }, [])

  const startCamera = useCallback(async () => {
    if (cancelledRef.current || document.visibilityState === 'hidden' || cameraPendingRef.current || cameraFailedRef.current) return
    cameraFailedRef.current = false
    stopStream()
    const request = { epoch: cameraEpochRef.current }
    cameraPendingRef.current = request
    const current = () => !cancelledRef.current && request.epoch === cameraEpochRef.current && document.visibilityState !== 'hidden'
    setStatus('init')
    setMessage(null)

    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus('error')
      setMessage(cameraErrorMessage({ name: 'NotFoundError' }, window.isSecureContext))
      cameraPendingRef.current = null
      return
    }

    const attach = stream => {
      if (!current()) {
        stream.getTracks().forEach(track => track.stop())
        return
      }
      streamRef.current = stream
      const recoverEndedTrack = () => {
        if (streamRef.current !== stream || cancelledRef.current || document.visibilityState === 'hidden') return
        readEpochRef.current += 1
        startCamera()
      }
      stream.getVideoTracks?.().forEach(track => {
        track.addEventListener?.('ended', recoverEndedTrack, { once: true })
      })
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        videoRef.current.play()?.catch(() => {})
      }
      // 'live' means scannable, so it waits for decoded frame data; the video
      // element's load events promote it through handleVideoReady.
      setStatus(isScannerReady(videoRef.current) ? 'live' : 'init')
    }

    try {
      attach(await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          aspectRatio: { ideal: MTG_CARD_RATIO },
          width: { ideal: 720 },
          height: { ideal: 1008 },
        },
        audio: false,
      }))
    } catch (err) {
      if (!current()) return
      // Some cameras reject the aspect-ratio constraint; retry without it.
      if (err?.name === 'OverconstrainedError' || err?.name === 'ConstraintNotSatisfiedError') {
        try {
          attach(await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: 'environment' }, width: { ideal: 720 }, height: { ideal: 1280 } },
            audio: false,
          }))
          return
        } catch (fallbackErr) {
          if (current()) handleCameraError(fallbackErr)
          return
        }
      }
      handleCameraError(err)
    } finally {
      if (cameraPendingRef.current === request) cameraPendingRef.current = null
    }
  }, [stopStream])

  function handleCameraError(err) {
    cameraFailedRef.current = true
    setStatus('error')
    setMessage(cameraErrorMessage(err, window.isSecureContext))
  }

  const handleVideoReady = useCallback(() => {
    if (cancelledRef.current) return
    if (!isScannerReady(videoRef.current)) return
    setStatus(current => (current === 'init' ? 'live' : current))
  }, [])

  // Releasing the camera belongs to unmount alone. An effect that also re-ran on
  // resume would stop the very stream the next scan is supposed to reuse.
  useEffect(() => () => {
    cancelledRef.current = true
    stopStream()
  }, [stopStream])

  // Mount and resume: reuse a stream that is still live, so an accepted scan
  // never costs another camera prompt/warm-up before the next card.
  useEffect(() => {
    cancelledRef.current = false
    const resume = resolveCameraResume({
      stream: streamRef.current,
      attachedStream: videoRef.current?.srcObject ?? null,
    })
    if (resume === 'acquire') {
      startCamera()
      return
    }
    if (resume === 'reattach' && videoRef.current) {
      videoRef.current.srcObject = streamRef.current
    }
    setStatus(current => (
      current === 'reading'
        ? current
        : isScannerReady(videoRef.current) ? 'live' : 'init'
    ))
  }, [startCamera, resumeToken])

  // Mobile browsers may keep a 'live' track whose video is suspended after an
  // app switch. Release it in the background and reacquire on return; normal
  // per-card resumes above still reuse the stream. Overlapping foreground
  // events share startCamera's single in-flight acquisition.
  useEffect(() => {
    const suspend = () => {
      readEpochRef.current += 1
      stopStream()
      if (!cameraFailedRef.current) setStatus('init')
    }
    const resume = () => {
      if (cancelledRef.current || document.visibilityState === 'hidden') return
      const action = resolveCameraResume({ stream: streamRef.current, attachedStream: videoRef.current?.srcObject })
      if (action === 'acquire') { startCamera(); return }
      if (videoRef.current) {
        if (action === 'reattach') videoRef.current.srcObject = streamRef.current
        videoRef.current.play()?.catch(() => {})
      }
    }
    const visibility = () => document.visibilityState === 'hidden' ? suspend() : resume()
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('pagehide', suspend)
    window.addEventListener('pageshow', resume)
    window.addEventListener('focus', resume)
    return () => {
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('pagehide', suspend)
      window.removeEventListener('pageshow', resume)
      window.removeEventListener('focus', resume)
    }
  }, [startCamera, stopStream])

  const handleScan = useCallback(async () => {
    if (status !== 'live' || !isScannerReady(videoRef.current)) return
    const readEpoch = ++readEpochRef.current
    const isReadCancelled = () => cancelledRef.current || readEpoch !== readEpochRef.current
    setStatus('reading')
    setMessage(null)
    // A read abandoned mid-flight hands the panel back a usable status instead
    // of stranding the 'reading' overlay over a disabled scan button.
    const abandonRead = () => {
      if (!isReadCancelled()) setStatus(statusAfterCancelledRead(streamRef.current))
    }
    try {
      const frame = captureCardCanvas(videoRef.current)
      if (!frame) throw new Error('frame')
      // Only the compact perceptual signature leaves this component. The frame
      // and its pixels remain in browser memory and are never added to a request.
      const visualSignature = visualSignatureFromDrawable(frame)

      const worker = await getScannerWorker()
      if (isReadCancelled()) return abandonRead()

      const read = await readScannerFrame({ frame, worker, prepare: prepareStrip, isCancelled: isReadCancelled })
      if (isReadCancelled()) return abandonRead()
      if (!read) return abandonRead()
      const evidence = { ...read, visualSignature }
      setLastText(evidence.nameQuery || '')
      setLastRead(evidence)

      const outcome = resolveScanOutcome(evidence)
      if (outcome.kind !== 'evidence') {
        // Never present a confident-looking result when the read is unusable.
        setStatus('live')
        setMessage(outcome.message)
        return
      }

      // The camera keeps running: the shelf flow comes back here for the next
      // card, and re-acquiring would re-prompt and re-warm for nothing. Keep the
      // panel in 'reading' until catalog and printing routing has settled.
      const nextStatus = await settleScanEvidence({
        onEvidence,
        evidence: outcome.evidence,
        isCancelled: isReadCancelled,
      })
      if (nextStatus === 'cancelled') return
      setStatus(nextStatus)
    } catch {
      if (isReadCancelled()) return abandonRead()
      setStatus('live')
      setMessage('Scanning failed on this device. Search by name below instead.')
    }
  }, [status, onEvidence])

  const handleManual = useCallback(() => {
    cancelledRef.current = true
    stopStream()
    onManual(lastText)
  }, [stopStream, onManual, lastText])

  return (
    <div className="space-y-2 rounded-dbb-md border border-gray-200 p-3 dark:border-gray-700/50">
      <div className="flex items-start gap-2 text-dbb-xs text-gray-500 dark:text-gray-400">
        <ScanLine className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>{scannerPrivacyNotice(SCANNER_ASSETS)}</span>
      </div>

      {status !== 'error' && (
        <>
          <div className="relative mx-auto w-full max-w-[260px] overflow-hidden rounded-dbb-md bg-black" style={{ aspectRatio: '0.716' }}>
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              onLoadedMetadata={handleVideoReady}
              onLoadedData={handleVideoReady}
              onCanPlay={handleVideoReady}
              className="h-full w-full object-cover"
            />
            <div className="pointer-events-none absolute inset-[2%] rounded border border-dashed border-white/70" />
            {status === 'reading' && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-dbb-xs text-white">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Reading card…
              </div>
            )}
          </div>
          <p className="text-center text-[11px] text-gray-500 dark:text-gray-400">
            Fill the frame, hold steady, and tilt away from glare before scanning.
          </p>
        </>
      )}

      {message && <p className="text-dbb-xs text-amber-600 dark:text-amber-400">{message}</p>}
      {lastRead && (
        <details className="text-[11px] text-gray-500 dark:text-gray-400">
          <summary className="cursor-pointer">Scan read (on this device only)</summary>
          <p>Name: {lastRead.nameQuery || 'unreadable'} · Set: {lastRead.setCode || 'unreadable'} · Number: {lastRead.collectorNumber || 'unreadable'}</p>
          <pre className="whitespace-pre-wrap break-words">{lastRead.rawText}</pre>
          {lastRead.languageUnavailable && <p>Japanese OCR files were unavailable; using printed set and number for confirmation.</p>}
        </details>
      )}
      {visualMessage && (
        <p role="status" className="text-dbb-xs text-gray-500 dark:text-gray-400">
          {visualMessage}
        </p>
      )}

      <div className="flex gap-2">
        {status === 'error' && (
          <button
            type="button"
            onClick={() => {
              cameraFailedRef.current = false
              startCamera()
            }}
            disabled={confirming}
            className="flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-dbb-md bg-dbb-accent text-dbb-sm font-semibold text-white transition-colors hover:bg-dbb-accent-hov disabled:opacity-50"
          >
            <Camera className="h-4 w-4" />
            Retry camera
          </button>
        )}
        <button
          type="button"
          onClick={handleScan}
          disabled={status !== 'live' || confirming}
          className="flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-dbb-md bg-dbb-accent text-dbb-sm font-semibold text-white transition-colors hover:bg-dbb-accent-hov disabled:opacity-50"
        >
          {status === 'reading' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
          {status === 'init' ? 'Starting camera…' : 'Scan card'}
        </button>
        <button
          type="button"
          onClick={handleManual}
          disabled={confirming}
          className="flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-dbb-md border border-gray-200 text-dbb-sm text-gray-600 transition-colors hover:border-dbb-accent hover:text-dbb-accent dark:border-gray-700 dark:text-gray-400 disabled:opacity-50"
        >
          <Search className="h-4 w-4" />
          Use manual search
        </button>
      </div>

      {children}

      <div className="space-y-2 rounded-dbb-md bg-gray-50 p-2 dark:bg-dbb-secondary/50">
        <div className="flex items-center justify-between">
          <p className="text-dbb-xs font-semibold text-gray-700 dark:text-gray-200">
            Scan shelf ({shelf.filter(item => item.selected === true).length}/{shelf.length} selected)
          </p>
          <span className="text-[11px] text-gray-400">
            {confirming ? 'Saving submitted shelf' : 'Temporary until confirmed'}
          </span>
        </div>

        {shelf.length === 0 ? (
          <p className="text-dbb-xs text-gray-500 dark:text-gray-400">
            Confirmed scans will collect here before one batch add.
          </p>
        ) : (
          <div className="space-y-2">
            {shelf.map(item => {
              // The shelf already carries the catalog row's image and rarity;
              // showing them is what makes a row checkable against the card in
              // hand before one batch write.
              const thumbnail = shelfThumbnailSource(item)
              const rarity = shelfRarityLabel(item)
              return (
              <div key={item.shelfId} className={`rounded-dbb-md border border-gray-200 bg-white p-2 dark:border-gray-700 dark:bg-dbb-primary ${item.selected ? '' : 'opacity-60'}`}>
                <div className="flex items-start gap-2">
                  <label className="flex min-h-9 shrink-0 items-center gap-1 text-[11px] text-gray-500 dark:text-gray-400">
                    <input
                      type="checkbox"
                      checked={item.selected}
                      onChange={event => onEditShelfItem?.(item.shelfId, { selected: event.target.checked })}
                      disabled={confirming}
                      aria-label={`Select ${item.cardName} for batch confirmation`}
                      className="rounded border-gray-300 text-dbb-accent focus:ring-dbb-accent dark:border-gray-700"
                    />
                  </label>
                  {thumbnail ? (
                    <img
                      src={thumbnail}
                      alt={item.cardName}
                      loading="lazy"
                      className="h-14 w-10 shrink-0 rounded object-contain"
                    />
                  ) : (
                    <div
                      aria-hidden="true"
                      className="flex h-14 w-10 shrink-0 items-center justify-center rounded border border-gray-200 bg-gray-100 text-[11px] text-gray-400 dark:border-gray-700 dark:bg-dbb-secondary dark:text-gray-600"
                    >
                      ?
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-dbb-xs font-medium text-gray-900 dark:text-white">{item.cardName}</p>
                    <p className="truncate text-[11px] text-gray-500 dark:text-gray-400">
                      {item.setName} · {item.setCode?.toUpperCase()} #{item.collectorNumber}
                    </p>
                    {rarity && (
                      <span className={`text-[11px] ${rarityToneClass(item.rarity)}`}>{rarity}</span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => onRemoveShelfItem?.(item.shelfId)}
                    disabled={confirming}
                    aria-label={`Remove ${item.cardName} from scan shelf`}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-dbb-md text-gray-400 hover:bg-red-500/10 hover:text-red-500 disabled:opacity-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <label className="text-[11px] text-gray-500 dark:text-gray-400">
                    Quantity
                    <input
                      type="number"
                      min="1"
                      max="9999"
                      value={item.quantity}
                      onChange={event => onEditShelfItem?.(item.shelfId, { quantity: event.target.value })}
                      disabled={confirming}
                      className="mt-1 h-9 w-full rounded-dbb-md border border-gray-200 bg-white px-2 text-dbb-xs dark:border-gray-700 dark:bg-dbb-secondary disabled:opacity-50"
                    />
                  </label>
                  <label className="text-[11px] text-gray-500 dark:text-gray-400">
                    Finish
                    <select
                      value={item.finish}
                      onChange={event => onEditShelfItem?.(item.shelfId, { finish: event.target.value })}
                      disabled={confirming}
                      className="mt-1 h-9 w-full rounded-dbb-md border border-gray-200 bg-white px-2 text-dbb-xs dark:border-gray-700 dark:bg-dbb-secondary disabled:opacity-50"
                    >
                      {item.finishes.map(finish => (
                        <option key={finish} value={finish}>{finish === 'nonfoil' ? 'Non-foil' : finish[0].toUpperCase() + finish.slice(1)}</option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>
              )
            })}

            <div className="grid grid-cols-2 gap-2">
              <label className="text-[11px] text-gray-500 dark:text-gray-400">
                Binder
                <select
                  value={binderId}
                  onChange={event => onBinderChange?.(event.target.value)}
                  disabled={confirming}
                  className="mt-1 h-9 w-full rounded-dbb-md border border-gray-200 bg-white px-2 text-dbb-xs dark:border-gray-700 dark:bg-dbb-secondary disabled:opacity-50"
                >
                  {binders.map(binder => (
                    <option key={binder.id} value={binder.id}>{binder.name}{binder.is_default ? ' (default)' : ''}</option>
                  ))}
                </select>
              </label>
              <label className="text-[11px] text-gray-500 dark:text-gray-400">
                Condition
                <select
                  value={condition}
                  onChange={event => onConditionChange?.(event.target.value)}
                  disabled={confirming}
                  className="mt-1 h-9 w-full rounded-dbb-md border border-gray-200 bg-white px-2 text-dbb-xs dark:border-gray-700 dark:bg-dbb-secondary disabled:opacity-50"
                >
                  {conditions.map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
            </div>

            <button
              type="button"
              onClick={onConfirmBatch}
              disabled={confirming || !binderId || selectedQuantity === 0}
              className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-dbb-md bg-dbb-accent text-dbb-sm font-semibold text-white hover:bg-dbb-accent-hov disabled:opacity-50"
            >
              {confirming && <Loader2 className="h-4 w-4 animate-spin" />}
              Confirm {selectedQuantity} scanned card{selectedQuantity === 1 ? '' : 's'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
