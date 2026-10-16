import { scannerRetrievalSeed } from './cardScannerSession.mjs'

const CAMERA_PERMISSION_MESSAGE = 'Camera permission was denied. You can still search by name below.'
const CAMERA_NOT_FOUND_MESSAGE = 'No camera was found on this device. You can still search by name below.'
const CAMERA_GENERIC_MESSAGE = 'The camera could not be started. You can still search by name below.'
const INSECURE_CONTEXT_MESSAGE = 'Camera access needs a secure connection (HTTPS or localhost). Use manual search instead.'
const UNREADABLE_TITLE_MESSAGE = 'The card title could not be read. Try again, or search by name below.'

/**
 * Convert browser camera failures into user-facing recovery guidance.
 * The secure-context branch is checked before the browser error name because
 * an insecure page cannot recover by retrying camera permissions.
 */
export function cameraErrorMessage(error, secureContext = true) {
  if (!secureContext) return INSECURE_CONTEXT_MESSAGE
  if (error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError') {
    return CAMERA_PERMISSION_MESSAGE
  }
  if (error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError') {
    return CAMERA_NOT_FOUND_MESSAGE
  }
  return CAMERA_GENERIC_MESSAGE
}

// A video element only yields a drawable frame from HAVE_CURRENT_DATA upward;
// HAVE_METADATA reports dimensions while the first frame is still decoding.
const HAVE_CURRENT_DATA = 2

/**
 * Whether the viewfinder can actually be scanned. Attaching a stream is not
 * enough: capturing before the element has decoded frame data and reported
 * dimensions yields a blank canvas, which OCR reads as an unreadable title.
 */
export function isScannerReady(video) {
  if (!video) return false
  const width = Number(video.videoWidth)
  const height = Number(video.videoHeight)
  if (!Number.isFinite(width) || !Number.isFinite(height)) return false
  if (width <= 0 || height <= 0) return false
  return Number(video.readyState) >= HAVE_CURRENT_DATA
}

/** Whether a MediaStream still has a track that can deliver video. */
export function isStreamLive(stream) {
  const tracks = stream?.getTracks?.()
  if (!Array.isArray(tracks)) return false
  return tracks.some(track => track?.readyState === 'live')
}

/**
 * What resuming the scanner has to do with the camera.
 *
 * Repeated scanning returns to the panel once per card, so a still-live stream
 * is reused: another getUserMedia would re-prompt on some browsers and always
 * pays the warm-up again. Re-acquiring is only for a stream that is gone.
 */
export function resolveCameraResume({ stream, attachedStream } = {}) {
  if (!isStreamLive(stream)) return 'acquire'
  return attachedStream === stream ? 'keep' : 'reattach'
}

/**
 * Status to fall back to when a read is abandoned mid-flight. Never 'reading':
 * nothing remains to finish it, so that would leave the overlay up and the scan
 * button disabled for good.
 */
export function statusAfterCancelledRead(stream) {
  return isStreamLive(stream) ? 'live' : 'init'
}

/**
 * Decide whether OCR produced a usable name seed or should return to live view.
 * This keeps the panel's mocked/read-error behavior deterministic without
 * coupling tests to React, browser media devices, or Tesseract.
 */
export function resolveScanOutcome(evidence) {
  if (scannerRetrievalSeed(evidence)) {
    return { kind: 'evidence', evidence }
  }
  return { kind: 'retry', message: UNREADABLE_TITLE_MESSAGE }
}

/**
 * Keep a successful OCR read non-scannable until the parent finishes catalog
 * matching and printing routing. Cancellation is checked only after that owned
 * promise settles, so an unmounted panel never re-enables itself.
 */
let captureGeneration = 0

export async function settleScanEvidence({ evidence, onEvidence, isCancelled } = {}) {
  // Each completed camera read owns one non-image generation. Resuming or
  // paging catalog results never creates another capture.
  await onEvidence({ ...evidence, captureToken: ++captureGeneration })
  return isCancelled?.() ? 'cancelled' : 'live'
}

