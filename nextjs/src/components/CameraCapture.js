'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { Camera, X, RefreshCw, Loader2 } from 'lucide-react'

const MAX_PX = 1280
const JPEG_QUALITY = 0.85

// MTG card ratio: 63mm × 88mm → width/height = 0.716
const MTG_CARD_RATIO = 0.716

// Capture the same portrait crop shown by the object-cover viewfinder. Camera
// sensors may still report landscape dimensions while a phone is held upright;
// getUserMedia constraints are preferences, not an orientation guarantee.
function captureFrame(video) {
  const { videoWidth: vw, videoHeight: vh } = video
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
  const w = Math.round(sw * scale)
  const h = Math.round(sh * scale)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  canvas.getContext('2d').drawImage(video, sx, sy, sw, sh, 0, 0, w, h)
  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY))
}

/**
 * CameraCapture — camera-only photo capture component (vertical/portrait orientation).
 *
 * Features:
 *   - Vertical camera orientation (portrait mode) with MTG card ratio framing guide
 *   - Rounded-edge rectangle overlay matching MTG card proportions (63×88mm ≈ 0.716)
 *   - Semi-transparent overlay with cutout for the card area
 *   - Dashed border guide that's visually subtle (encourages centering without blocking view)
 *   - Captures the full frame (condition assessment needs surrounding context)
 *
 * Props:
 *   libraryCardId  string    — the library_card to attach the photo to
 *   onUploaded     fn(url)   — called with the new signed URL after successful upload
 *   onCancel       fn()      — called when user dismisses without capturing
 *   cardName       string    — optional: card name to display during batch capture
 *
 * Desktop note: `facingMode: environment` is requested (ideal) so a rear camera
 * is preferred when available; on desktops with a single webcam it falls back to
 * that camera automatically. Chrome, Firefox, and Safari are all supported.
 *
 * If no camera is available at all, a "camera required" message is shown.
 */
export default function CameraCapture({ libraryCardId, onUploaded, onCancel, cardName }) {
  const videoRef = useRef(null)
  const streamRef = useRef(null)

  const [status, setStatus] = useState('init')   // init | live | captured | uploading | error
  const [errorMsg, setErrorMsg] = useState(null)
  const [capturedBlob, setCapturedBlob] = useState(null)
  const [previewUrl, setPreviewUrl] = useState(null)
  const [uploading, setUploading] = useState(false)

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
  }, [])

  const startCamera = useCallback(async () => {
    stopStream()
    setStatus('init')
    setErrorMsg(null)

    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus('error')
      setErrorMsg('A camera is required to photograph your card.')
      return
    }

    try {
      // Request vertical (portrait) orientation with MTG card aspect ratio
      // aspectRatio ideal 0.716 → portrait orientation matching MTG card proportions
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          aspectRatio: { ideal: MTG_CARD_RATIO },
          width: { ideal: 720 },
          height: { ideal: 1008 },  // 720 / 0.716 ≈ 1006, round to clean number
        },
        audio: false,
      })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
      }
      setStatus('live')
    } catch (err) {
      // Fallback: try without aspectRatio constraint (some browsers/cameras don't support it)
      if (err.name === 'OverconstrainedError' || err.name === 'ConstraintNotSatisfiedError') {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: { ideal: 'environment' },
              width: { ideal: 720 },
              height: { ideal: 1280 },
            },
            audio: false,
          })
          streamRef.current = stream
          if (videoRef.current) {
            videoRef.current.srcObject = stream
          }
          setStatus('live')
          return
        } catch (fallbackErr) {
          handleCameraError(fallbackErr)
          return
        }
      }
      handleCameraError(err)
    }
  }, [stopStream])

  function handleCameraError(err) {
    if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
      setStatus('error')
      setErrorMsg('A camera is required to photograph your card.')
    } else if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      setStatus('error')
      setErrorMsg('Camera permission was denied. Please allow camera access and try again.')
    } else {
      setStatus('error')
      setErrorMsg('Could not start the camera. A camera is required to photograph your card.')
    }
  }

  useEffect(() => {
    startCamera()
    return () => stopStream()
  }, [startCamera, stopStream])

  const handleShutter = useCallback(async () => {
    if (!videoRef.current || status !== 'live') return
    const blob = await captureFrame(videoRef.current)
    if (!blob) return
    const url = URL.createObjectURL(blob)
    setCapturedBlob(blob)
    setPreviewUrl(url)
    stopStream()
    setStatus('captured')
  }, [status, stopStream])

  const handleRetake = useCallback(() => {
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setCapturedBlob(null)
    setPreviewUrl(null)
    startCamera()
  }, [previewUrl, startCamera])

  const handleUpload = useCallback(async () => {
    if (!capturedBlob || uploading) return
    setUploading(true)
    setStatus('uploading')
    try {
      // Phase 18: Direct-to-Supabase upload via signed upload URL.
      // The file NEVER touches our server — it goes client → Supabase Storage.
      // Step 1: Get a signed upload URL from our API (validates ownership + path)
      const urlRes = await fetch('/api/photos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ library_card_id: libraryCardId }),
      })
      const urlData = await urlRes.json().catch(() => ({}))
      if (!urlRes.ok) throw new Error(urlData.error || 'Could not get upload URL')

      // Step 2: Upload directly to Supabase Storage via PUT with upsert header
      const uploadRes = await fetch(urlData.upload_url, {
        method: 'PUT',
        headers: {
          'Content-Type': 'image/jpeg',
          'x-upsert': 'true',
        },
        body: capturedBlob,
      })
      if (!uploadRes.ok) throw new Error('Direct upload to storage failed')

      // Step 3: Confirm the upload with our server (verifies + creates DB row + returns signed URL)
      const confirmRes = await fetch('/api/photos/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          library_card_id: libraryCardId,
          storage_path: urlData.storage_path,
        }),
      })
      const confirmData = await confirmRes.json().catch(() => ({}))
      if (!confirmRes.ok) throw new Error(confirmData.error || 'Upload confirmation failed')
      onUploaded(confirmData.url)
    } catch (e) {
      setErrorMsg(e.message || 'Upload failed. Please try again.')
      setStatus('captured')
    } finally {
      setUploading(false)
    }
  }, [capturedBlob, uploading, libraryCardId, onUploaded])

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl)
  }, [previewUrl])

  return (
    <div className="space-y-3">
      {/* Card name label (for batch capture context) */}
      {cardName && (
        <div className="text-center">
          <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{cardName}</p>
        </div>
      )}

      {/* Error state */}
      {status === 'error' && (
        <div className="rounded-lg bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 p-4 text-center">
          <Camera className="w-8 h-8 text-gray-400 dark:text-gray-600 mx-auto mb-2" />
          <p className="text-sm text-gray-500 dark:text-gray-400">{errorMsg}</p>
          <button
            onClick={onCancel}
            className="mt-3 text-xs text-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Live viewfinder — vertical/portrait orientation with MTG card framing guide */}
      {(status === 'init' || status === 'live') && (
        <div className="space-y-2">
          <div
            data-testid="portrait-camera-viewport"
            className="relative w-full bg-black rounded-lg overflow-hidden mx-auto"
            style={{ maxWidth: '420px', aspectRatio: '63 / 88' }}
          >
            {status === 'init' && (
              <div className="absolute inset-0 flex items-center justify-center z-20">
                <Loader2 className="w-6 h-6 text-gray-400 dark:text-gray-600 animate-spin" />
              </div>
            )}
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="w-full h-full object-cover"
            />

            {/* MTG card framing guide overlay */}
            {status === 'live' && (
              <div className="absolute inset-0 pointer-events-none z-10">
                {/* A single shadowed rectangle creates a genuinely clear center.
                    There must not be a second full-screen tint behind it. */}
                <div
                  data-testid="mtg-framing-guide"
                  className="absolute left-1/2 top-1/2"
                  style={{
                    width: '78%',
                    aspectRatio: '63 / 88',
                    transform: 'translate(-50%, -50%)',
                    borderRadius: '16px',
                    boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.48), 0 0 22px 3px rgba(219, 38, 38, 0.28)',
                    border: '3px dashed rgba(255, 255, 255, 0.9)',
                    background: 'transparent',
                  }}
                />

                {/* "Center your card here" hint at top of guide */}
                <div
                  className="absolute left-1/2 -translate-x-1/2 text-white/70 text-[10px] font-medium tracking-wide"
                  style={{ top: '3%' }}
                >
                  Center your card in the frame
                </div>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleShutter}
              disabled={status !== 'live'}
              className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-dbb-accent hover:bg-red-600 disabled:opacity-40 text-white rounded-lg text-sm font-medium transition-colors"
            >
              <Camera className="w-4 h-4" />
              Take Photo
            </button>
            <button
              onClick={onCancel}
              className="px-3 py-2.5 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white border border-gray-200 dark:border-gray-700 rounded-lg transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Captured preview */}
      {(status === 'captured' || status === 'uploading') && previewUrl && (
        <div className="space-y-2">
          <div className="mx-auto w-full" style={{ maxWidth: '420px', aspectRatio: '63 / 88' }}>
            <img
              src={previewUrl}
              alt="Card photo preview"
              className="w-full h-full rounded-lg border border-gray-200 dark:border-gray-700 object-cover"
            />
          </div>
          {errorMsg && (
            <p className="text-xs text-red-400 text-center">{errorMsg}</p>
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={handleUpload}
              disabled={uploading}
              className="flex-1 flex items-center justify-center gap-2 py-2 bg-dbb-accent hover:bg-red-600 disabled:opacity-40 text-white rounded-lg text-sm font-medium transition-colors"
            >
              {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {uploading ? 'Uploading...' : 'Use This Photo'}
            </button>
            <button
              onClick={handleRetake}
              disabled={uploading}
              className="flex items-center gap-1 px-3 py-2 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white border border-gray-200 dark:border-gray-700 rounded-lg transition-colors disabled:opacity-40"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Retake
            </button>
            <button
              onClick={onCancel}
              disabled={uploading}
              className="px-3 py-2 text-sm text-gray-500 hover:text-white transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
