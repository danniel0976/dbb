'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { Camera, X, RefreshCw, Loader2 } from 'lucide-react'

const MAX_PX = 1280
const JPEG_QUALITY = 0.85

// Resize video frame to max 1280px on the longest side and return a JPEG blob
function captureFrame(video) {
  const { videoWidth: vw, videoHeight: vh } = video
  const scale = Math.min(1, MAX_PX / Math.max(vw, vh))
  const w = Math.round(vw * scale)
  const h = Math.round(vh * scale)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  canvas.getContext('2d').drawImage(video, 0, 0, w, h)
  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY))
}

/**
 * CameraCapture — camera-only photo capture component.
 *
 * Props:
 *   libraryCardId  string    — the library_card to attach the photo to
 *   onUploaded     fn(url)   — called with the new signed URL after successful upload
 *   onCancel       fn()      — called when user dismisses without capturing
 *
 * Desktop note: `facingMode: environment` is requested (ideal) so a rear camera
 * is preferred when available; on desktops with a single webcam it falls back to
 * that camera automatically. Chrome, Firefox, and Safari are all supported.
 *
 * If no camera is available at all, a "camera required" message is shown.
 */
export default function CameraCapture({ libraryCardId, onUploaded, onCancel }) {
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
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
      }
      setStatus('live')
    } catch (err) {
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
  }, [stopStream])

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
      const form = new FormData()
      form.append('library_card_id', libraryCardId)
      form.append('photo', capturedBlob, 'card.jpg')
      const res = await fetch('/api/photos', { method: 'POST', body: form })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Upload failed')
      onUploaded(data.url)
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
      {/* Error state */}
      {status === 'error' && (
        <div className="rounded-lg bg-gray-800 border border-gray-700 p-4 text-center">
          <Camera className="w-8 h-8 text-gray-600 mx-auto mb-2" />
          <p className="text-sm text-gray-400">{errorMsg}</p>
          <button
            onClick={onCancel}
            className="mt-3 text-xs text-gray-500 hover:text-white transition-colors"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Live viewfinder */}
      {(status === 'init' || status === 'live') && (
        <div className="space-y-2">
          <div className="relative bg-black rounded-lg overflow-hidden aspect-video">
            {status === 'init' && (
              <div className="absolute inset-0 flex items-center justify-center">
                <Loader2 className="w-6 h-6 text-gray-600 animate-spin" />
              </div>
            )}
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="w-full h-full object-cover"
            />
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
              className="px-3 py-2.5 text-sm text-gray-400 hover:text-white border border-gray-700 rounded-lg transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Captured preview */}
      {(status === 'captured' || status === 'uploading') && previewUrl && (
        <div className="space-y-2">
          <img
            src={previewUrl}
            alt="Card photo preview"
            className="w-full rounded-lg border border-gray-700 object-cover"
            style={{ maxHeight: '200px', objectFit: 'cover' }}
          />
          {errorMsg && (
            <p className="text-xs text-red-400">{errorMsg}</p>
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
              className="flex items-center gap-1 px-3 py-2 text-sm text-gray-400 hover:text-white border border-gray-700 rounded-lg transition-colors disabled:opacity-40"
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
