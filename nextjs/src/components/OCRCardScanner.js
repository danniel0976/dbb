'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { Camera, X, RefreshCw, Loader2, Search, ScanLine, Check, Plus } from 'lucide-react'

// Dynamic import of Tesseract.js (WASM-based, ~2-4MB, client-side only)
let tesseractWorker = null

async function getTesseractWorker() {
  if (tesseractWorker) return tesseractWorker
  try {
    const Tesseract = await import('tesseract.js')
    tesseractWorker = await Tesseract.createWorker('eng', 1, {
      logger: () => {},
    })
    return tesseractWorker
  } catch (err) {
    // Reset so next attempt can retry instead of caching a failure
    tesseractWorker = null
    throw err
  }
}

async function terminateTesseractWorker() {
  if (tesseractWorker) {
    try { await tesseractWorker.terminate() } catch {}
    tesseractWorker = null
  }
}

// Capture a frame from the video element at the given crop region
function captureRegion(video, region) {
  const { videoWidth: vw, videoHeight: vh } = video
  const canvas = document.createElement('canvas')

  if (region === 'top') {
    // Top third of the frame - where the card name is on MTG cards
    const cropH = Math.round(vh / 3)
    canvas.width = vw
    canvas.height = cropH
    const ctx = canvas.getContext('2d')
    // Boost contrast for better OCR
    ctx.drawImage(video, 0, 0, vw, cropH, 0, 0, vw, cropH)
    // Apply simple contrast enhancement
    const imageData = ctx.getImageData(0, 0, vw, cropH)
    const data = imageData.data
    const contrast = 1.5
    const intercept = 128 * (1 - contrast)
    for (let i = 0; i < data.length; i += 4) {
      data[i] = Math.max(0, Math.min(255, data[i] * contrast + intercept))
      data[i + 1] = Math.max(0, Math.min(255, data[i + 1] * contrast + intercept))
      data[i + 2] = Math.max(0, Math.min(255, data[i + 2] * contrast + intercept))
    }
    ctx.putImageData(imageData, 0, 0)
  } else {
    // Full frame
    canvas.width = vw
    canvas.height = vh
    canvas.getContext('2d').drawImage(video, 0, 0, vw, vh)
  }
  return canvas
}

// Extract likely card name from OCR text
// MTG card names are typically on the first line(s) of the top third
function extractCardName(rawText) {
  if (!rawText) return ''
  const lines = rawText
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 2) // skip very short lines

  // Take the first few meaningful lines and join
  // Card names can be 1-3 words typically on the first 1-2 lines
  const candidateLines = lines.slice(0, 4)

  // Try each line as a potential card name, longest meaningful one first
  for (const line of candidateLines) {
    // Remove common OCR artifacts
    let cleaned = line
      .replace(/[|\\\/]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    // Skip lines that look like mana cost or type line
    if (/^\d+$/.test(cleaned)) continue
    if (/^\{.*\}$/.test(cleaned)) continue
    if (cleaned.length >= 3 && cleaned.length <= 40) {
      return cleaned
    }
  }

  // Fallback: join first 2-3 short lines
  return candidateLines.slice(0, 3).join(' ').replace(/\s+/g, ' ').trim()
}

// Conditions for add-card form
const CONDITIONS = [
  { value: 'NM', label: 'NM - Near Mint' },
  { value: 'LP', label: 'LP - Lightly Played' },
  { value: 'MP', label: 'MP - Moderately Played' },
  { value: 'HP', label: 'HP - Heavily Played' },
  { value: 'DMG', label: 'DMG - Damaged' },
  { value: 'M', label: 'M - Mint' },
]

const MTG_CARD_RATIO = 0.716

/**
 * OCRCardScanner - Camera capture + Tesseract.js OCR for card name recognition.
 *
 * Flow: open camera -> capture frame -> OCR top third -> extract card name
 *       -> auto-fill search -> show matches -> user confirms printing -> add to library
 *
 * All OCR runs client-side via Tesseract.js WASM. No server processing.
 */
export default function OCRCardScanner({ binders = [], onAdded, onCancel }) {
  const videoRef = useRef(null)
  const streamRef = useRef(null)

  // States: idle -> camera -> scanning -> results -> adding
  const [phase, setPhase] = useState('idle')
  const [errorMsg, setErrorMsg] = useState(null)
  const [ocrProgress, setOcrProgress] = useState(0)
  const [ocrText, setOcrText] = useState('')
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
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
  }, [])

  const startCamera = useCallback(async () => {
    stopStream()
    setErrorMsg(null)
    setPhase('camera')

    if (!navigator.mediaDevices?.getUserMedia) {
      setErrorMsg('A camera is required for scanning.')
      setPhase('idle')
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          aspectRatio: { ideal: MTG_CARD_RATIO },
          width: { ideal: 720 },
          height: { ideal: 1008 },
        },
        audio: false,
      })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        // Mobile browsers require explicit play() after setting srcObject
        try { await videoRef.current.play() } catch {}
      }
    } catch (err) {
      // Fallback without aspect ratio
      if (err.name === 'OverconstrainedError' || err.name === 'ConstraintNotSatisfiedError') {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
          streamRef.current = stream
          if (videoRef.current) {
            videoRef.current.srcObject = stream
            try { await videoRef.current.play() } catch {}
          }
          return
        } catch (fallbackErr) {
          setErrorMsg('Could not start camera. Please check permissions.')
          setPhase('idle')
          return
        }
      }
      setErrorMsg(err.name === 'NotAllowedError' ? 'Camera permission denied.' : 'Could not start camera.')
      setPhase('idle')
    }
  }, [stopStream])

  useEffect(() => {
    return () => {
      stopStream()
      terminateTesseractWorker()
    }
  }, [stopStream])

  // Run OCR on the top third of the video frame
  const handleScan = useCallback(async () => {
    if (!videoRef.current) return
    setPhase('scanning')
    setOcrProgress(0)
    setErrorMsg(null)

    try {
      // Verify video is actually playing (has dimensions)
      if (!videoRef.current.videoWidth || !videoRef.current.videoHeight) {
        setErrorMsg('Camera not ready. Please wait for the viewfinder to load.')
        setPhase('camera')
        return
      }

      const canvas = captureRegion(videoRef.current, 'top')
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
      setOcrText(rawText)

      const cardName = extractCardName(rawText)

      if (!cardName || cardName.length < 2) {
        const hint = rawText.trim() ? ` OCR saw: "${rawText.trim().slice(0, 60)}".` : ''
        setErrorMsg(`Could not read a card name.${hint} Try recentering or type manually.`)
        setPhase('camera')
        return
      }

      setSearchQuery(cardName)
      setPhase('results')

      // Auto-search the catalog
      await searchCatalog(cardName)
    } catch (err) {
      console.error('OCR error:', err)
      setErrorMsg('OCR failed. Please try again or type the card name manually.')
      setPhase('camera')
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
    } catch (err) {
      setErrorMsg(err.message || 'Search failed. Try typing the name manually.')
    } finally {
      setSearching(false)
    }
  }, [])

  // Manual search from the search field
  const handleManualSearch = (e) => {
    e?.preventDefault?.()
    const term = searchQuery.trim()
    if (term) searchCatalog(term)
  }

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
      setOcrText('')
      setPhase('camera')
      startCamera()
    } catch (err) {
      setAddError(err.message)
    } finally {
      setAdding(false)
    }
  }

  // Retake / rescan
  const handleRescan = () => {
    setSelectedEdition(null)
    setSearchResults([])
    setSearchQuery('')
    setOcrText('')
    setErrorMsg(null)
    setPhase('camera')
    startCamera()
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ScanLine className="w-5 h-5 text-dbb-accent" />
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">OCR Card Scanner</h3>
        </div>
        <button onClick={onCancel} className="text-gray-400 hover:text-gray-900 dark:hover:text-white">
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Phase: idle - initial prompt */}
      {phase === 'idle' && (
        <div className="text-center py-8 space-y-4">
          <Camera className="w-12 h-12 text-gray-300 dark:text-gray-600 mx-auto" />
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Point your camera at a card and scan the name to search the catalog.
          </p>
          {errorMsg && <p className="text-xs text-red-400">{errorMsg}</p>}
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
            {phase === 'camera' && (
              <div className="absolute inset-0 pointer-events-none z-10">
                {/* Top-third highlight for OCR region */}
                <div
                  className="absolute left-0 right-0 top-0"
                  style={{
                    height: '33%',
                    borderBottom: '2px dashed rgba(219, 38, 38, 0.6)',
                    background: 'rgba(219, 38, 38, 0.05)',
                  }}
                />
                <div className="absolute left-1/2 -translate-x-1/2 text-white/70 text-[10px] font-medium" style={{ top: '2%' }}>
                  Card name here
                </div>
                {/* Full card frame guide */}
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
            )}
          </div>
          {errorMsg && <p className="text-xs text-red-400 text-center">{errorMsg}</p>}
          <div className="flex items-center gap-2">
            <button
              onClick={handleScan}
              className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-dbb-accent hover:bg-red-600 text-white rounded-lg text-sm font-medium transition-colors"
            >
              <ScanLine className="w-4 h-4" />
              Scan Card Name
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

      {/* Phase: results - search and selection */}
      {phase === 'results' && (
        <div className="space-y-4">
          {/* Search bar */}
          <form onSubmit={handleManualSearch} className="flex gap-2">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Card name from OCR..."
              className="flex-1 px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-dbb-secondary text-gray-900 dark:text-white focus:ring-1 focus:ring-dbb-accent"
              autoFocus
            />
            <button
              type="submit"
              disabled={searching}
              className="px-3 py-2 bg-dbb-accent hover:bg-red-600 disabled:opacity-40 text-white rounded-lg text-sm font-medium transition-colors"
            >
              {searching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
            </button>
            <button
              type="button"
              onClick={handleRescan}
              className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-gray-700 rounded-lg transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </form>

          {errorMsg && <p className="text-xs text-red-400">{errorMsg}</p>}

          {/* Search results - grouped by name */}
          {!selectedEdition && (
            <div className="space-y-2 max-h-[400px] overflow-y-auto">
              {searching && (
                <div className="text-center py-4">
                  <Loader2 className="w-5 h-5 text-gray-400 mx-auto animate-spin" />
                </div>
              )}
              {!searching && searchResults.length === 0 && (
                <p className="text-xs text-gray-400 text-center py-4">
                  No matches found. Try editing the name and searching again.
                </p>
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