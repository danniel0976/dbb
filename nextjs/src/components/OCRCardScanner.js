'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { Camera, X, RefreshCw, Loader2, ScanLine, Check, Plus, AlertCircle } from 'lucide-react'

// Dynamic import of Tesseract.js (WASM-based, ~2-4MB, client-side only)
let tesseractWorker = null
let workerCreating = null

async function getTesseractWorker() {
  if (tesseractWorker) return tesseractWorker
  if (workerCreating) return workerCreating
  workerCreating = (async () => {
    try {
      const Tesseract = await import('tesseract.js')
      tesseractWorker = await Tesseract.createWorker('eng', 1, {
        logger: () => {},
      })
      workerCreating = null
      return tesseractWorker
    } catch (err) {
      tesseractWorker = null
      workerCreating = null
      throw err
    }
  })()
  return workerCreating
}

async function terminateTesseractWorker() {
  if (tesseractWorker) {
    try { await tesseractWorker.terminate() } catch {}
    tesseractWorker = null
  }
  workerCreating = null
}

// Capture top portion of video frame and preprocess for OCR:
// 1. Crop top ~35% where card name sits
// 2. Upscale 2x for better text recognition
// 3. Convert to grayscale
// 4. Apply Otsu's adaptive threshold (binarize)
// Returns a canvas ready for Tesseract
function captureAndPreprocess(video) {
  const { videoWidth: vw, videoHeight: vh } = video
  if (!vw || !vh) return null

  // Crop top 35% - card name region on MTG cards
  const cropH = Math.round(vh * 0.35)
  const scale = 2 // upscale for better OCR on small text

  const canvas = document.createElement('canvas')
  canvas.width = vw * scale
  canvas.height = cropH * scale
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'

  // Draw the cropped region upscaled
  ctx.drawImage(video, 0, 0, vw, cropH, 0, 0, vw * scale, cropH * scale)

  // Get pixel data for preprocessing
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const pixels = imageData.data

  // Step 1: Convert to grayscale
  const gray = new Uint8ClampedArray(canvas.width * canvas.height)
  for (let i = 0, j = 0; i < pixels.length; i += 4, j++) {
    gray[j] = Math.round(0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2])
  }

  // Step 2: Compute histogram for Otsu's threshold
  const histogram = new Array(256).fill(0)
  for (let i = 0; i < gray.length; i++) histogram[gray[i]]++
  const total = gray.length

  // Otsu's method: find threshold that maximizes between-class variance
  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * histogram[i]
  let sumB = 0, wB = 0, maxVar = 0, threshold = 127
  for (let i = 0; i < 256; i++) {
    wB += histogram[i]
    if (wB === 0) continue
    const wF = total - wB
    if (wF === 0) break
    sumB += i * histogram[i]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const betweenVar = wB * wF * (mB - mF) * (mB - mF)
    if (betweenVar > maxVar) {
      maxVar = betweenVar
      threshold = i
    }
  }

  // Step 3: Binarize using the computed threshold
  for (let i = 0, j = 0; i < pixels.length; i += 4, j++) {
    const val = gray[j] > threshold ? 255 : 0
    pixels[i] = val
    pixels[i + 1] = val
    pixels[i + 2] = val
    pixels[i + 3] = 255
  }

  ctx.putImageData(imageData, 0, 0)
  return canvas
}

// Extract likely card name from OCR text
function extractCardName(rawText) {
  if (!rawText) return ''
  const lines = rawText
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 1)

  // Try each of the first few lines as a card name candidate
  for (const line of lines.slice(0, 5)) {
    let cleaned = line
      .replace(/[|\\\/_~]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    // Skip lines that look like mana cost, numbers, or type lines
    if (/^\d+$/.test(cleaned)) continue
    if (/^\{.*\}$/.test(cleaned)) continue
    if (/^(Legendary|Creature|Instant|Sorcery|Artifact|Enchantment|Land|Planeswalker|Battle)/i.test(cleaned)) continue
    // Card names are typically 2-30 chars, mostly letters
    if (cleaned.length >= 2 && cleaned.length <= 40 && /[a-zA-Z]{2,}/.test(cleaned)) {
      return cleaned
    }
  }

  // Fallback: join first 2-3 short lines
  return lines.slice(0, 3).join(' ').replace(/\s+/g, ' ').trim()
}

const CONDITIONS = [
  { value: 'NM', label: 'NM - Near Mint' },
  { value: 'LP', label: 'LP - Lightly Played' },
  { value: 'MP', label: 'MP - Moderately Played' },
  { value: 'HP', label: 'HP - Heavily Played' },
  { value: 'DMG', label: 'DMG - Damaged' },
  { value: 'M', label: 'M - Mint' },
]

export default function OCRCardScanner({ binders = [], onAdded, onCancel }) {
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const cameraReadyRef = useRef(false)

  const [phase, setPhase] = useState('idle') // idle -> camera -> scanning -> results
  const [errorMsg, setErrorMsg] = useState(null)
  const [ocrProgress, setOcrProgress] = useState(0)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [selectedEdition, setSelectedEdition] = useState(null)
  const [bindersList, setBindersList] = useState(binders)
  const [selectedBinder, setSelectedBinder] = useState(binders[0]?.id || '')
  const [condition, setCondition] = useState('NM')
  const [foil, setFoil] = useState('normal')
  const [quantity, setQuantity] = useState(1)
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState(null)
  const [cameraReady, setCameraReady] = useState(false)

  // Fetch binders if not provided
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
    if (videoRef.current) {
      videoRef.current.srcObject = null
    }
    cameraReadyRef.current = false
    setCameraReady(false)
  }, [])

  const startCamera = useCallback(async () => {
    // Full stop before restart - this is the key fix for the grey/blank issue
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
      // Request camera with progressive fallback
      let stream
      try {
        // First try: environment camera with decent resolution
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1080 },
            height: { ideal: 1920 },
          },
          audio: false,
        })
      } catch (firstErr) {
        // Second try: just environment camera, any resolution
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        })
      }

      streamRef.current = stream

      // Small delay to let the old stream fully release
      await new Promise(r => requestAnimationFrame(r))

      if (videoRef.current) {
        videoRef.current.srcObject = stream
        // Critical for mobile: explicit play() after setting srcObject
        try {
          await videoRef.current.play()
        } catch {
          // Some browsers need a user gesture - try again on next interaction
          try { await videoRef.current.play() } catch {}
        }

        // Wait for video to actually have dimensions (loadeddata event)
        if (!videoRef.current.videoWidth) {
          await new Promise((resolve) => {
            const onReady = () => {
              videoRef.current?.removeEventListener('loadeddata', onReady)
              resolve()
            }
            videoRef.current?.addEventListener('loadeddata', onReady)
            // Timeout fallback - don't hang forever
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

  // Restart camera - dedicated function for retry/rescan
  const restartCamera = useCallback(async () => {
    await startCamera()
  }, [startCamera])

  useEffect(() => {
    return () => {
      stopStream()
      terminateTesseractWorker()
    }
  }, [stopStream])

  // Run OCR on the top portion of the video frame
  const handleScan = useCallback(async () => {
    if (!videoRef.current) return

    // Check camera is actually ready with a live frame
    if (!cameraReadyRef.current || !videoRef.current.videoWidth || !videoRef.current.videoHeight) {
      setErrorMsg('Camera not ready. Tap "Restart Camera" and try again.')
      return
    }

    setPhase('scanning')
    setOcrProgress(0)
    setErrorMsg(null)

    try {
      const canvas = captureAndPreprocess(videoRef.current)
      if (!canvas) {
        setErrorMsg('Could not capture camera frame. Try again.')
        setPhase('camera')
        return
      }

      const worker = await getTesseractWorker()

      if (worker.setLogger) {
        worker.setLogger(({ status, progress }) => {
          if (status === 'recognizing text') {
            setOcrProgress(Math.round(progress * 100))
          }
        })
      }

      const { data } = await worker.recognize(canvas)
      const rawText = data?.text || ''
      const cardName = extractCardName(rawText)

      if (!cardName || cardName.length < 2) {
        setErrorMsg('Could not read the card name. Make sure the card name is in the highlighted area and try again.')
        // Return to camera but keep the stream alive - just go back to viewfinder
        setPhase('camera')
        // Ensure video is still playing (may have been paused)
        if (videoRef.current && videoRef.current.paused && streamRef.current) {
          try { await videoRef.current.play() } catch {}
        }
        return
      }

      setSearchQuery(cardName)
      setPhase('results')
      await searchCatalog(cardName)
    } catch (err) {
      // Reset worker on failure so next scan creates a fresh one
      await terminateTesseractWorker()
      setErrorMsg('Scan failed. Tap "Restart Camera" and try again.')
      // Camera stream might still be alive - try to resume it
      if (streamRef.current && videoRef.current) {
        try {
          if (videoRef.current.paused) await videoRef.current.play()
          setPhase('camera')
        } catch {
          // Stream is dead - go back to idle with restart option
          stopStream()
          setPhase('idle')
        }
      } else {
        setPhase('idle')
      }
    }
  }, [])

  // Search the catalog API
  const searchCatalog = useCallback(async (query) => {
    if (!query || query.length < 2) return
    setSearching(true)
    setSearchResults([])
    setErrorMsg(null)

    try {
      const params = new URLSearchParams()
      params.set('q', query)
      params.set('limit', '20')
      params.set('page', '1')
      params.set('group', '1')

      const res = await fetch(`/api/catalog/search?${params.toString()}`)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Search failed')
      }
      const data = await res.json()
      setSearchResults(data.groups || [])

      // If no results, try a fuzzier search (first word only)
      if (data.groups?.length === 0) {
        const firstWord = query.split(/\s+/)[0]
        if (firstWord.length >= 3 && firstWord !== query) {
          const params2 = new URLSearchParams({ q: firstWord, limit: '10', page: '1', group: '1' })
          const res2 = await fetch(`/api/catalog/search?${params2.toString()}`)
          if (res2.ok) {
            const data2 = await res2.json()
            setSearchResults(data2.groups || [])
          }
        }
      }
    } catch (err) {
      setErrorMsg(err.message || 'Search failed.')
    } finally {
      setSearching(false)
    }
  }, [])

  // Select an edition and prepare to add
  const handleSelectEdition = (edition, cardName) => {
    setSelectedEdition({ edition, cardName })
    setAddError(null)
  }

  // Add card to library
  const handleAdd = async () => {
    if (!selectedEdition) return
    setAdding(true)
    setAddError(null)

    try {
      const res = await fetch('/api/library/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scryfall_id: selectedEdition.edition.scryfall_id,
          binder_id: selectedBinder,
          quantity,
          foil,
          condition,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to add card')
      onAdded?.({ card_name: data.card_name, inserted: data.inserted, merged: data.merged })
      // Reset for next scan
      setSelectedEdition(null)
      setSearchResults([])
      setSearchQuery('')
      setPhase('camera')
      // Camera should still be running - just resume if paused
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

  // Rescan - go back to camera viewfinder
  const handleRescan = useCallback(() => {
    setSelectedEdition(null)
    setSearchResults([])
    setSearchQuery('')
    setErrorMsg(null)

    if (streamRef.current && videoRef.current) {
      // Stream is still alive - just go back to camera phase and resume
      setPhase('camera')
      if (videoRef.current.paused) {
        videoRef.current.play().catch(() => {})
      }
    } else {
      // Stream died - restart it
      startCamera()
    }
  }, [startCamera])

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ScanLine className="w-5 h-5 text-dbb-accent" />
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">OCR Card Scanner</h3>
        </div>
        <button onClick={() => { stopStream(); onCancel?.() }} className="text-gray-400 hover:text-gray-900 dark:hover:text-white">
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Phase: idle - initial prompt or error with restart */}
      {phase === 'idle' && (
        <div className="text-center py-8 space-y-4">
          <Camera className="w-12 h-12 text-gray-300 dark:text-gray-600 mx-auto" />
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Point your camera at a card. The scanner reads the card name and finds it in the catalog.
          </p>
          {errorMsg && (
            <p className="text-xs text-red-400 flex items-center justify-center gap-1">
              <AlertCircle className="w-3.5 h-3.5" />
              {errorMsg}
            </p>
          )}
          <button
            onClick={startCamera}
            className="inline-flex items-center gap-2 px-4 py-2 bg-dbb-accent hover:bg-red-600 text-white rounded-lg text-sm font-medium transition-colors"
          >
            <Camera className="w-4 h-4" />
            Start Camera
          </button>
        </div>
      )}

      {/* Phase: camera - live viewfinder */}
      {phase === 'camera' && (
        <div className="space-y-3">
          <div
            className="relative w-full bg-black rounded-lg overflow-hidden mx-auto"
            style={{ maxWidth: '420px', aspectRatio: '63 / 88' }}
          >
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="w-full h-full object-cover"
            />
            {/* Overlay guides */}
            <div className="absolute inset-0 pointer-events-none z-10">
              {/* Top region highlight for OCR */}
              <div
                className="absolute left-0 right-0 top-0"
                style={{
                  height: '35%',
                  borderBottom: '2px dashed rgba(219, 38, 38, 0.6)',
                  background: 'rgba(219, 38, 38, 0.05)',
                }}
              />
              <div className="absolute left-1/2 -translate-x-1/2 text-white/70 text-[10px] font-medium" style={{ top: '2%' }}>
                Align card name here
              </div>
              {/* Card frame guide */}
              <div
                className="absolute left-1/2 top-1/2"
                style={{
                  width: '78%',
                  aspectRatio: '63 / 88',
                  transform: 'translate(-50%, -50%)',
                  borderRadius: '12px',
                  boxShadow: '0 0 0 9999px rgba(0,0,0,0.35)',
                  border: '2px dashed rgba(255,255,255,0.7)',
                }}
              />
            </div>
            {/* Camera not ready indicator */}
            {!cameraReady && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/50 z-20">
                <Loader2 className="w-6 h-6 text-white animate-spin" />
              </div>
            )}
          </div>

          {errorMsg && (
            <p className="text-xs text-red-400 text-center flex items-center justify-center gap-1">
              <AlertCircle className="w-3.5 h-3.5" />
              {errorMsg}
            </p>
          )}

          <div className="flex items-center gap-2">
            <button
              onClick={handleScan}
              disabled={!cameraReady}
              className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-dbb-accent hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors"
            >
              <ScanLine className="w-4 h-4" />
              Scan
            </button>
            <button
              onClick={restartCamera}
              className="flex items-center gap-1.5 px-3 py-2.5 text-sm text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-gray-700 rounded-lg transition-colors hover:text-gray-900 dark:hover:text-white"
              title="Restart camera"
            >
              <RefreshCw className="w-4 h-4" />
              Restart
            </button>
            <button
              onClick={() => { stopStream(); setPhase('idle') }}
              className="px-3 py-2.5 text-sm text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-gray-700 rounded-lg transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Phase: scanning - OCR in progress */}
      {phase === 'scanning' && (
        <div className="text-center py-8 space-y-3">
          <Loader2 className="w-8 h-8 text-dbb-accent mx-auto animate-spin" />
          <p className="text-sm text-gray-600 dark:text-gray-400">Reading card name...</p>
          <div className="w-48 h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden mx-auto">
            <div
              className="h-full bg-dbb-accent transition-all duration-300"
              style={{ width: `${ocrProgress}%` }}
            />
          </div>
          <p className="text-xs text-gray-400">{ocrProgress}%</p>
        </div>
      )}

      {/* Phase: results - search matches */}
      {phase === 'results' && (
        <div className="space-y-4">
          {/* Detected name + rescan */}
          <div className="flex items-center gap-2 p-2 bg-gray-50 dark:bg-dbb-secondary/50 rounded-lg">
            <Search className="w-4 h-4 text-gray-400 flex-shrink-0" />
            <span className="text-sm text-gray-900 dark:text-white truncate flex-1">{searchQuery}</span>
            <button
              onClick={handleRescan}
              className="flex items-center gap-1 px-2 py-1 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Rescan
            </button>
          </div>

          {errorMsg && <p className="text-xs text-red-400">{errorMsg}</p>}

          {/* Search results */}
          {!selectedEdition && (
            <div className="space-y-2 max-h-[400px] overflow-y-auto">
              {searching && (
                <div className="text-center py-4">
                  <Loader2 className="w-5 h-5 text-gray-400 mx-auto animate-spin" />
                </div>
              )}
              {!searching && searchResults.length === 0 && (
                <div className="text-center py-6 space-y-2">
                  <p className="text-xs text-gray-400">No matches found.</p>
                  <button
                    onClick={handleRescan}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-dbb-accent border border-dbb-accent/30 rounded-lg hover:bg-dbb-accent/5 transition-colors"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Scan again
                  </button>
                </div>
              )}
              {searchResults.map((group) => (
                <div key={group.name} className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
                  <div className="px-3 py-2 bg-gray-50 dark:bg-dbb-secondary text-sm font-medium text-gray-900 dark:text-white">
                    {group.name}
                    <span className="ml-2 text-xs text-gray-400">{group.editions.length} printing(s)</span>
                  </div>
                  <div className="divide-y divide-gray-100 dark:divide-gray-800">
                    {group.editions.map((ed) => (
                      <button
                        key={ed.scryfall_id}
                        onClick={() => handleSelectEdition(ed, group.name)}
                        className="w-full flex items-center gap-3 px-3 py-2 hover:bg-gray-50 dark:hover:bg-dbb-secondary/50 transition-colors text-left"
                      >
                        {ed.image_uris?.small ? (
                          <img src={ed.image_uris.small} alt="" className="w-10 h-14 rounded object-cover flex-shrink-0" />
                        ) : (
                          <div className="w-10 h-14 bg-gray-100 dark:bg-dbb-secondary rounded flex items-center justify-center flex-shrink-0">
                            <span className="text-gray-400 text-xs">?</span>
                          </div>
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-gray-900 dark:text-white truncate">
                            {ed.set_name} ({ed.set_code?.toUpperCase()})
                          </p>
                          <p className="text-xs text-gray-400">
                            #{ed.collector_number} - {ed.rarity}
                            {ed.foil_available && ' - Foil'}
                          </p>
                        </div>
                        <Check className="w-4 h-4 text-gray-300 dark:text-gray-600" />
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Edition selected - add form */}
          {selectedEdition && (
            <div className="space-y-3 p-3 border border-gray-200 dark:border-gray-700 rounded-lg">
              <div className="flex items-center gap-3">
                {selectedEdition.edition.image_uris?.small ? (
                  <img src={selectedEdition.edition.image_uris.small} alt="" className="w-12 h-16 rounded object-cover" />
                ) : (
                  <div className="w-12 h-16 bg-gray-100 dark:bg-dbb-secondary rounded" />
                )}
                <div className="flex-1">
                  <p className="text-sm font-medium text-gray-900 dark:text-white">{selectedEdition.cardName}</p>
                  <p className="text-xs text-gray-400">{selectedEdition.edition.set_name} ({selectedEdition.edition.set_code?.toUpperCase()})</p>
                </div>
                <button onClick={() => setSelectedEdition(null)} className="text-gray-400 hover:text-white">
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <label className="text-xs text-gray-500 dark:text-gray-400">Binder</label>
                <label className="text-xs text-gray-500 dark:text-gray-400">Condition</label>
                <select
                  value={selectedBinder}
                  onChange={(e) => setSelectedBinder(e.target.value)}
                  className="px-2 py-1.5 text-xs rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-dbb-secondary text-gray-900 dark:text-white"
                >
                  {bindersList.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
                <select
                  value={condition}
                  onChange={(e) => setCondition(e.target.value)}
                  className="px-2 py-1.5 text-xs rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-dbb-secondary text-gray-900 dark:text-white"
                >
                  {CONDITIONS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
                <label className="text-xs text-gray-500 dark:text-gray-400">Foil</label>
                <label className="text-xs text-gray-500 dark:text-gray-400">Qty</label>
                <select
                  value={foil}
                  onChange={(e) => setFoil(e.target.value)}
                  className="px-2 py-1.5 text-xs rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-dbb-secondary text-gray-900 dark:text-white"
                >
                  <option value="normal">Normal</option>
                  <option value="foil">Foil</option>
                  <option value="etched">Etched</option>
                </select>
                <input
                  type="number"
                  min="1"
                  value={quantity}
                  onChange={(e) => setQuantity(Math.max(1, parseInt(e.target.value) || 1))}
                  className="px-2 py-1.5 text-xs rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-dbb-secondary text-gray-900 dark:text-white"
                />
              </div>

              {addError && <p className="text-xs text-red-400">{addError}</p>}

              <div className="flex gap-2">
                <button
                  onClick={handleAdd}
                  disabled={adding}
                  className="flex-1 flex items-center justify-center gap-2 py-2 bg-dbb-accent hover:bg-red-600 disabled:opacity-40 text-white rounded-lg text-sm font-medium transition-colors"
                >
                  {adding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                  {adding ? 'Adding...' : 'Add to Library'}
                </button>
                <button
                  onClick={handleRescan}
                  className="flex items-center gap-1 px-3 py-2 text-sm text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-gray-700 rounded-lg transition-colors"
                >
                  <ScanLine className="w-3.5 h-3.5" />
                  Scan Next
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}