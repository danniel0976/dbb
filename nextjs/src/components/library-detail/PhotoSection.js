'use client'

import { useState, useEffect } from 'react'
import { useToast } from '@/components/Toast'
import CameraCapture from '@/components/CameraCapture'
import { X, Loader2, Camera, RotateCcw, Maximize2 } from 'lucide-react'

// PhotoSection — shows current card photo + camera capture for owner.
// Uses small variant (640px) for inline display; full-size available via lightbox.
export default function PhotoSection({ libraryRow, listing, onPhotoChange, forceCamera, onCameraOpened, onCaptureComplete, onCaptureCancel }) {
  const { toast } = useToast()
  const [photoUrl, setPhotoUrl] = useState(undefined) // undefined=loading, null=none, string=url
  const [showCamera, setShowCamera] = useState(false)
  const [showLightbox, setShowLightbox] = useState(false)
  const [fullSizeUrl, setFullSizeUrl] = useState(null)

  useEffect(() => {
    fetch(`/api/photos/${libraryRow.id}?size=small`)
      .then(r => r.status === 404 ? null : r.ok ? r.json() : null)
      .then(data => {
        const url = data?.url || null
        setPhotoUrl(url)
        onPhotoChange?.(!!url)
      })
      .catch(() => { setPhotoUrl(null); onPhotoChange?.(false) })
  }, [libraryRow.id])

  const handleUploaded = (url) => {
    setPhotoUrl(url)
    setShowCamera(false)
    toast('Photo saved', 'success')
    onPhotoChange?.(true)
    onCaptureComplete?.()
  }

  useEffect(() => {
    if (forceCamera && photoUrl !== undefined && !photoUrl) {
      setShowCamera(true)
      onCameraOpened?.()
    }
  }, [forceCamera, photoUrl, onCameraOpened])

  const handleOpenLightbox = () => {
    setShowLightbox(true)
    if (!fullSizeUrl) {
      fetch(`/api/photos/${libraryRow.id}`)
        .then(r => r.ok ? r.json() : null)
        .then(data => setFullSizeUrl(data?.url || '__none__'))
        .catch(() => setFullSizeUrl('__none__'))
    }
  }

  if (photoUrl === undefined) {
    return (
      <div className="pt-2 border-t border-black/5">
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Loader2 className="w-3 h-3 animate-spin" /> Loading photo...
        </div>
      </div>
    )
  }

  return (
    <div className="pt-2 border-t border-black/5 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-gray-600">Card photo</p>
        {photoUrl && !showCamera && (
          <button
            onClick={() => setShowCamera(true)}
            className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-900 transition-colors"
          >
            <RotateCcw className="w-3 h-3" /> Retake
          </button>
        )}
      </div>

      {showCamera ? (
        <CameraCapture
          libraryCardId={libraryRow.id}
          onUploaded={handleUploaded}
          onCancel={() => {
            setShowCamera(false)
            onCaptureCancel?.()
          }}
        />
      ) : photoUrl ? (
        <div className="relative">
          <img
            src={photoUrl}
            alt="Card photo"
            className="w-full max-h-40 object-contain rounded-dbb-md bg-gray-100"
          />
          <button
            onClick={handleOpenLightbox}
            className="absolute bottom-1.5 right-1.5 p-1 bg-black/60 rounded text-white hover:bg-black/80 transition-colors text-[10px] flex items-center gap-1"
          >
            <Maximize2 className="w-3 h-3" /> Full size
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-gray-500">No photo yet — required before listing.</p>
          <button
            onClick={() => setShowCamera(true)}
            className="flex items-center justify-center gap-2 w-full py-2 border border-dashed border-gray-300 hover:border-dbb-accent text-gray-400 hover:text-dbb-accent rounded-lg text-xs transition-colors"
          >
            <Camera className="w-4 h-4" />
            Take Photo
          </button>
        </div>
      )}

      {showLightbox && (
        <div
          className="fixed inset-0 z-[80] bg-black/95 flex items-center justify-center p-4"
          onClick={() => { setShowLightbox(false); setFullSizeUrl(null) }}
        >
          <button
            className="absolute top-4 right-4 p-2 text-white hover:text-dbb-accent transition-colors"
            onClick={() => { setShowLightbox(false); setFullSizeUrl(null) }}
          >
            <X className="w-6 h-6" />
          </button>
          {!fullSizeUrl ? (
            <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
          ) : fullSizeUrl === '__none__' ? (
            <span className="text-gray-500">Photo unavailable</span>
          ) : (
            <img
              src={fullSizeUrl}
              alt="Card photo — full size"
              className="max-w-full max-h-full object-contain rounded-lg"
            />
          )}
        </div>
      )}
    </div>
  )
}
