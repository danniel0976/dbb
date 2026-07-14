'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { Camera, X, RefreshCw, Loader2, ScanLine, Check, Plus, AlertCircle, Sparkles } from 'lucide-react'

const CONDITIONS = [
  { value: 'NM', label: 'NM - Near Mint' },
  { value: 'LP', label: 'LP - Lightly Played' },
  { value: 'MP', label: 'MP - Moderately Played' },
  { value: 'HP', label: 'HP - Heavily Played' },
  { value: 'DMG', label: 'DMG - Damaged' },
  { value: 'M', label: 'M - Mint' },
]

// Compute perceptual hash (pHash) from a video frame using canvas API
// Algorithm: resize to 32x32 grayscale -> 8x8 DCT -> threshold at median -> 64-bit hash
function computePHashFromCanvas(sourceCanvas) {
  const ctx = sourceCanvas.getContext('2d')

  // Create a 32x32 grayscale canvas
  const small = document.createElement('canvas')
  small.width = 32
  small.height = 32
  const smallCtx = small.getContext('2d')
  smallCtx.imageSmoothingEnabled = true
  smallCtx.imageSmoothingQuality = 'high'
  smallCtx.drawImage(sourceCanvas, 0, 0, 32, 32)

  // Get grayscale pixel values
  const imageData = smallCtx.getImageData(0, 0, 32, 32)
  const pixels = []
  for (let i = 0; i < imageData.data.length; i += 4) {
    // Grayscale luminance formula
    pixels.push(
      Math.round(0.299 * imageData.data[i] + 0.587 * imageData.data[i + 1] + 0.114 * imageData.data[i + 2])
    )
  }

  // Compute 8x8 DCT (simplified: sample 32x32 with cosine weights)
  const dct8x8 = []
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      let sum = 0
      for (let i = 0; i < 32; i++) {
        for (let j = 0; j < 32; j++) {
          const cu = u === 0 ? Math.sqrt(1 / 32) : Math.sqrt(2 / 32)
          const cv = v === 0 ? Math.sqrt(1 / 32) : Math.sqrt(2 / 32)
          sum += cu * cv * pixels[i * 32 + j] *
            Math.cos(((2 * i + 1) * u * Math.PI) / (2 * 32)) *
            Math.cos(((2 * j + 1) * v * Math.PI) / (2 * 32))
        }
      }
      dct8x8.push(sum)
    }
  }

  // Median of DCT values (excluding DC component at index 0)
  const sorted = [...dct8x8].slice(1).sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]

  // Build 64-bit hash
  let hash = 0n
  for (let i = 0; i < 64; i++) {
    if (dct8x8[i] > median) {
      hash = hash | (1n << BigInt(i))
    }
  }

  return hash.toString()
}

export default function OCRCardScanner({ binders = [], onAdded, onCancel }) {
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const cameraReadyRef = useRef(false)

  const [phase, setPhase] = useState('idle')
  const [errorMsg, setErrorMsg] = useState(null)
  const [matchResult, setMatchResult] = useState(null)
  const [bindersList, setBindersList] = useState(binders)
  const [selectedBinder, setSelectedBinder] = useState(binders[0]?.id || '')
  const [condition, setCondition] = useState('NM')
  const [foil, setFoil] = useState('normal')
  const [quantity, setQuantity] = useState(1)
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState(null)
  const [cameraReady, setCameraReady] = useState(false)
  const [matchDistance, setMatchDistance] = useState(null)

  useEffect(() => {
    if (binders.length === 0) {
      fetch('/api/binders')
        .then(r => r.json())
        .then(data => {
          if (data.binders) {
            setBindersList(data.binders)
            setSelectedBinder(data.binders[0]?.id || '')
          }
        })
        .catch(() => {})
    }
  }, [binders])

  const stopStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop())
      streamRef.current = null
    }
    if (videoRef.current) videoRef.current.srcObject = null
    cameraReadyRef.current = false
    setCameraReady(false)
  }, [])

  const startCamera = useCallback(async () => {
    stopStream()
    setErrorMsg(null)
    setCameraReady(false)
    cameraReadyRef.current = false
    setPhase('camera')

    if (!navigator.mediaDevices?.getUserMedia) {
      setErrorMsg('A camera is required for scanning.')
      setPhase('idle')
      return
    }

    try {
      let stream
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1080 }, height: { ideal: 1920 } },
          audio: false,
        })
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } }, audio: false,
        })
      }

      streamRef.current = stream
      await new Promise(r => requestAnimationFrame(r))

      if (videoRef.current) {
        videoRef.current.srcObject = stream
        try { await videoRef.current.play() } catch {}
        try { await videoRef.current.play() } catch {}

        if (!videoRef.current.videoWidth) {
          await new Promise((resolve) => {
            const onReady = () => {
              videoRef.current?.removeEventListener('loadeddata', onReady)
              resolve()
            }
            videoRef.current?.addEventListener('loadeddata', onReady)
            setTimeout(resolve, 3000)
          })
        }

        cameraReadyRef.current = true
        setCameraReady(true)
      }
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        setErrorMsg('Camera permission denied. Enable camera access in your browser settings.')
      } else if (err.name === 'NotFoundError') {
        setErrorMsg('No camera found. This feature requires a camera.')
      } else {
        setErrorMsg(`Could not start camera: ${err.message || err.name}`)
      }
      setPhase('idle')
    }
  }, [stopStream])

  const restartCamera = useCallback(async () => { await startCamera() }, [startCamera])

  useEffect(() => {
    return () => { stopStream() }
  }, [stopStream])

  // Capture frame, compute pHash client-side, send hash to server for matching
  const handleScan = useCallback(async () => {
    if (!videoRef.current || !cameraReadyRef.current) {
      setErrorMsg('Camera not ready. Tap "Restart Camera" and try again.')
      return
    }

    const { videoWidth: vw, videoHeight: vh } = videoRef.current
    if (!vw || !vh) {
      setErrorMsg('Camera not ready. Tap "Restart Camera" and try again.')
      return
    }

    setPhase('matching')
    setErrorMsg(null)
    setMatchResult(null)
    setMatchDistance(null)

    try {
      // Capture full video frame to canvas
      const canvas = document.createElement('canvas')
      canvas.width = vw
      canvas.height = vh
      canvas.getContext('2d').drawImage(videoRef.current, 0, 0, vw, vh)

      // Compute pHash client-side (no image upload needed - just the hash!)
      const hash = computePHashFromCanvas(canvas)

      // Send hash to server for comparison against card_hashes table
      const res = await fetch('/api/match-card', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hash }),
      })

      const data = await res.json()

      if (!res.ok) throw new Error(data.error || 'Match failed')

      if (data.match) {
        setMatchResult(data.match)
        setMatchDistance(data.match.distance)
        setPhase('results')
      } else {
        setErrorMsg(`No match found${data.best_distance != null ? ` (closest distance: ${data.best_distance})` : ''}. Make sure the card is well-lit and centered.`)
        setPhase('camera')
        if (videoRef.current && videoRef.current.paused && streamRef.current) {
          try { await videoRef.current.play() } catch {}
        }
      }
    } catch (err) {
      setErrorMsg(`Scan failed: ${err.message}`)
      if (streamRef.current && videoRef.current) {
        try {
          if (videoRef.current.paused) await videoRef.current.play()
          setPhase('camera')
        } catch {
          stopStream()
          setPhase('idle')
        }
      } else {
        setPhase('idle')
      }
    }
  }, [stopStream])

  const handleAdd = async () => {
    if (!matchResult) return
    setAdding(true)
    setAddError(null)

    try {
      const res = await fetch('/api/library/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scryfall_id: matchResult.scryfall_id,
          binder_id: selectedBinder,
          quantity, foil, condition,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to add card')
      onAdded?.({ card_name: data.card_name, inserted: data.inserted, merged: data.merged })
      setMatchResult(null)
      setPhase('camera')
      if (videoRef.current && videoRef.current.paused && streamRef.current) {
        try { await videoRef.current.play() } catch {}
      } else if (!streamRef.current) {
        await startCamera()
      }
    } catch (err) {
      setAddError(err.message)
    } finally {
      setAdding(false)
    }
  }

  const handleRescan = useCallback(() => {
    setMatchResult(null)
    setErrorMsg(null)
    setMatchDistance(null)
    if (streamRef.current && videoRef.current) {
      setPhase('camera')
      if (videoRef.current.paused) videoRef.current.play().catch(() => {})
    } else {
      startCamera()
    }
  }, [startCamera])

  // Parse image_uris helper
  function getSmallImageUri(uris) {
    if (!uris) return null
    try {
      if (typeof uris === 'string') return JSON.parse(uris).small
      return uris?.small || null
    } catch { return null }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ScanLine className="w-5 h-5 text-dbb-accent" />
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Card Scanner</h3>
        </div>
        <button onClick={() => { stopStream(); onCancel?.() }} className="text-gray-400 hover:text-gray-900 dark:hover:text-white">
          <X className="w-5 h-5" />
        </button>
      </div>

      {phase === 'idle' && (
        <div className="text-center py-8 space-y-4">
          <Camera className="w-12 h-12 text-gray-300 dark:text-gray-600 mx-auto" />
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Point your camera at a card. The scanner matches it visually - no text recognition needed.
          </p>
          {errorMsg && (
            <p className="text-xs text-red-400 flex items-center justify-center gap-1">
              <AlertCircle className="w-3.5 h-3.5" />{errorMsg}
            </p>
          )}
          <button onClick={startCamera} className="inline-flex items-center gap-2 px-4 py-2 bg-dbb-accent hover:bg-red-600 text-white rounded-lg text-sm font-medium transition-colors">
            <Camera className="w-4 h-4" />Start Camera
          </button>
        </div>
      )}

      {phase === 'camera' && (
        <div className="space-y-3">
          <div className="relative w-full bg-black rounded-lg overflow-hidden mx-auto" style={{ maxWidth: '420px', aspectRatio: '63 / 88' }}>
            <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
            <div className="absolute inset-0 pointer-events-none z-10">
              <div className="absolute left-1/2 top-1/2" style={{
                width: '78%', aspectRatio: '63 / 88', transform: 'translate(-50%, -50%)',
                borderRadius: '12px', boxShadow: '0 0 0 9999px rgba(0,0,0,0.35)',
                border: '2px dashed rgba(255,255,255,0.7)',
              }} />
              <div className="absolute left-1/2 -translate-x-1/2 text-white/70 text-[10px] font-medium" style={{ bottom: '8%' }}>
                Align card within frame
              </div>
            </div>
            {!cameraReady && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/50 z-20">
                <Loader2 className="w-6 h-6 text-white animate-spin" />
              </div>
            )}
          </div>
          {errorMsg && (
            <p className="text-xs text-red-400 text-center flex items-center justify-center gap-1">
              <AlertCircle className="w-3.5 h-3.5" />{errorMsg}
            </p>
          )}
          <div className="flex items-center gap-2">
            <button onClick={handleScan} disabled={!cameraReady}
              className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-dbb-accent hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors">
              <ScanLine className="w-4 h-4" />Scan
            </button>
            <button onClick={restartCamera}
              className="flex items-center gap-1.5 px-3 py-2.5 text-sm text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-gray-700 rounded-lg transition-colors hover:text-gray-900 dark:hover:text-white"
              title="Restart camera">
              <RefreshCw className="w-4 h-4" />Restart
            </button>
            <button onClick={() => { stopStream(); setPhase('idle') }}
              className="px-3 py-2.5 text-sm text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-gray-700 rounded-lg transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {phase === 'matching' && (
        <div className="text-center py-8 space-y-3">
          <div className="relative mx-auto w-16 h-16">
            <Loader2 className="w-16 h-16 text-dbb-accent mx-auto animate-spin" />
            <Sparkles className="w-6 h-6 text-dbb-accent absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
          </div>
          <p className="text-sm text-gray-600 dark:text-gray-400">Matching card...</p>
          <p className="text-xs text-gray-400">Comparing image hash against catalog</p>
        </div>
      )}

      {phase === 'results' && matchResult && (
        <div className="space-y-4">
          <div className="flex items-center gap-3 p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg">
            <Check className="w-5 h-5 text-green-600 dark:text-green-400 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-900 dark:text-white truncate">{matchResult.name}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {matchResult.set_name} ({matchResult.set_code?.toUpperCase()})
                {matchDistance != null && ` - ${matchResult.confidence}% confidence`}
              </p>
            </div>
            {getSmallImageUri(matchResult.image_uris) && (
              <img src={getSmallImageUri(matchResult.image_uris)} alt="" className="w-10 h-14 rounded object-cover flex-shrink-0" />
            )}
          </div>

          <button onClick={handleRescan} className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors">
            <RefreshCw className="w-3.5 h-3.5" />Not the right card? Scan again
          </button>

          <div className="space-y-3 p-3 border border-gray-200 dark:border-gray-700 rounded-lg">
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs text-gray-500 dark:text-gray-400">Binder</label>
              <label className="text-xs text-gray-500 dark:text-gray-400">Condition</label>
              <select value={selectedBinder} onChange={(e) => setSelectedBinder(e.target.value)}
                className="px-2 py-1.5 text-xs rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-dbb-secondary text-gray-900 dark:text-white">
                {bindersList.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
              <select value={condition} onChange={(e) => setCondition(e.target.value)}
                className="px-2 py-1.5 text-xs rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-dbb-secondary text-gray-900 dark:text-white">
                {CONDITIONS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
              <label className="text-xs text-gray-500 dark:text-gray-400">Foil</label>
              <label className="text-xs text-gray-500 dark:text-gray-400">Qty</label>
              <select value={foil} onChange={(e) => setFoil(e.target.value)}
                className="px-2 py-1.5 text-xs rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-dbb-secondary text-gray-900 dark:text-white">
                <option value="normal">Normal</option><option value="foil">Foil</option><option value="etched">Etched</option>
              </select>
              <input type="number" min="1" value={quantity}
                onChange={(e) => setQuantity(Math.max(1, parseInt(e.target.value) || 1))}
                className="px-2 py-1.5 text-xs rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-dbb-secondary text-gray-900 dark:text-white" />
            </div>
            {addError && <p className="text-xs text-red-400">{addError}</p>}
            <div className="flex gap-2">
              <button onClick={handleAdd} disabled={adding}
                className="flex-1 flex items-center justify-center gap-2 py-2 bg-dbb-accent hover:bg-red-600 disabled:opacity-40 text-white rounded-lg text-sm font-medium transition-colors">
                {adding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                {adding ? 'Adding...' : 'Add to Library'}
              </button>
              <button onClick={handleRescan}
                className="flex items-center gap-1 px-3 py-2 text-sm text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-gray-700 rounded-lg transition-colors">
                <ScanLine className="w-3.5 h-3.5" />Scan Next
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}