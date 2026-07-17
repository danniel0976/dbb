'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { Camera, X, RefreshCw, Loader2, ScanLine, Download, Tag, Image as ImageIcon } from 'lucide-react'

// Reuse the same Tesseract worker approach as OCRCardScanner
let tesseractWorker = null

async function getTesseractWorker() {
  if (!tesseractWorker) {
    const Tesseract = await import('tesseract.js')
    tesseractWorker = await Tesseract.createWorker('eng', 1, {
      logger: () => {},
    })
  }
  return tesseractWorker
}

const MTG_CARD_RATIO = 0.716

// Capture full frame from video
function captureFullFrame(video) {
  const { videoWidth: vw, videoHeight: vh } = video
  let sx = 0, sy = 0, sw = vw, sh = vh
  if (vw / vh > MTG_CARD_RATIO) {
    sw = Math.round(vh * MTG_CARD_RATIO)
    sx = Math.round((vw - sw) / 2)
  } else {
    sh = Math.round(vw / MTG_CARD_RATIO)
    sy = Math.round((vh - sh) / 2)
  }
  const canvas = document.createElement('canvas')
  canvas.width = sw
  canvas.height = sh
  canvas.getContext('2d').drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh)
  return canvas
}

// Capture top third for OCR
function captureTopThird(video) {
  const { videoWidth: vw, videoHeight: vh } = video
  const cropH = Math.round(vh / 3)
  const canvas = document.createElement('canvas')
  canvas.width = vw
  canvas.height = cropH
  const ctx = canvas.getContext('2d')
  ctx.drawImage(video, 0, 0, vw, cropH, 0, 0, vw, cropH)
  // Contrast enhancement
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
  return canvas
}

function extractCardName(rawText) {
  if (!rawText) return ''
  const lines = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 2)
  for (const line of lines.slice(0, 4)) {
    let cleaned = line.replace(/[|\\\/]/g, '').replace(/\s+/g, ' ').trim()
    if (/^\d+$/.test(cleaned)) continue
    if (/^\{.*\}$/.test(cleaned)) continue
    if (cleaned.length >= 3 && cleaned.length <= 40) return cleaned
  }
  return lines.slice(0, 3).join(' ').replace(/\s+/g, ' ').trim()
}

const MULTIPLIERS = [
  { value: 2.5, label: '2.5x' },
  { value: 2.8, label: '2.8x' },
  { value: 3.0, label: '3.0x' },
]

/**
 * ClaimSaleImageGenerator - Scan card, take photo, match, overlay price, download.
 *
 * Flow: scan card -> take photo -> match via OCR+search -> pick multiplier
 *       -> generate image with RM price overlay -> download
 *
 * All images live in browser memory only. No server storage.
 * Images are destroyed when user exits the generator.
 */
export default function ClaimSaleImageGenerator({ onCancel }) {
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const objectUrlsRef = useRef([]) // track all created object URLs for cleanup

  // Phases: idle -> camera -> scanning -> matched -> photo -> pricing -> generated
  const [phase, setPhase] = useState('idle')
  const [errorMsg, setErrorMsg] = useState(null)
  const [ocrProgress, setOcrProgress] = useState(0)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [matchedCard, setMatchedCard] = useState(null) // { edition, cardName }
  const [photoUrl, setPhotoUrl] = useState(null) // captured photo URL
  const [photoBlob, setPhotoBlob] = useState(null)
  const [multiplier, setMultiplier] = useState(2.8)
  const [priceData, setPriceData] = useState(null) // { ckd_usd, myr }
  const [generatedUrl, setGeneratedUrl] = useState(null)
  const [generating, setGenerating] = useState(false)

  // Cleanup all object URLs on unmount
  useEffect(() => {
    return () => {
      objectUrlsRef.current.forEach(url => URL.revokeObjectURL(url))
      stopStream()
    }
  }, [])

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
  }, [])

  const trackUrl = (url) => {
    objectUrlsRef.current.push(url)
    return url
  }

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
      if (videoRef.current) videoRef.current.srcObject = stream
    } catch (err) {
      if (err.name === 'OverconstrainedError' || err.name === 'ConstraintNotSatisfiedError') {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: 'environment' }, width: { ideal: 720 }, height: { ideal: 1280 } },
            audio: false,
          })
          streamRef.current = stream
          if (videoRef.current) videoRef.current.srcObject = stream
          return
        } catch (fallbackErr) {
          setErrorMsg('Could not start camera.')
          setPhase('idle')
          return
        }
      }
      setErrorMsg(err.name === 'NotAllowedError' ? 'Camera permission denied.' : 'Could not start camera.')
      setPhase('idle')
    }
  }, [stopStream])

  // Scan + capture: run OCR on top third, then capture full photo
  const handleScanAndCapture = useCallback(async () => {
    if (!videoRef.current) return
    setPhase('scanning')
    setOcrProgress(0)
    setErrorMsg(null)

    try {
      // Step 1: OCR the top third
      const ocrCanvas = captureTopThird(videoRef.current)
      const worker = await getTesseractWorker()
      worker.setLogger(({ status, progress }) => {
        if (status === 'recognizing text') setOcrProgress(Math.round(progress * 100))
      })
      const { data } = await worker.recognize(ocrCanvas)
      const cardName = extractCardName(data?.text || '')

      if (!cardName || cardName.length < 2) {
        setErrorMsg('Could not read card name. Try recentering and try again.')
        setPhase('camera')
        return
      }

      // Step 2: Capture the full photo
      const photoCanvas = captureFullFrame(videoRef.current)
      const blob = await new Promise(resolve => photoCanvas.toBlob(resolve, 'image/jpeg', 0.9))
      const url = trackUrl(URL.createObjectURL(blob))
      setPhotoUrl(url)
      setPhotoBlob(blob)

      // Stop camera stream - we have the photo
      stopStream()

      // Step 3: Search catalog
      setSearchQuery(cardName)
      await searchCatalog(cardName)
      setPhase('matched')
    } catch (err) {
      console.error('Scan/capture error:', err)
      setErrorMsg('Scan failed. Please try again.')
      setPhase('camera')
    }
  }, [stopStream])

  const searchCatalog = useCallback(async (query) => {
    if (!query || query.length < 2) return
    setSearching(true)
    setSearchResults([])
    try {
      const params = new URLSearchParams()
      params.set('q', query)
      params.set('limit', '20')
      params.set('page', '1')
      params.set('group', '1')
      const res = await fetch(`/api/catalog/search?${params.toString()}`)
      if (!res.ok) throw new Error('Search failed')
      const data = await res.json()
      setSearchResults(data.groups || [])
    } catch (err) {
      setErrorMsg(err.message || 'Search failed')
    } finally {
      setSearching(false)
    }
  }, [])

  const handleManualSearch = (e) => {
    e?.preventDefault?.()
    const term = searchQuery.trim()
    if (term) searchCatalog(term)
  }

  // Select a card edition and fetch pricing
  const handleSelectCard = async (edition, cardName) => {
    setMatchedCard({ edition, cardName })
    setPhase('pricing')
    setErrorMsg(null)

    // Fetch pricing from batch endpoint
    try {
      const res = await fetch('/api/pricing/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [{ scryfall_id: edition.scryfall_id, foil: edition.foil || 'normal' }],
        }),
      })
      if (!res.ok) throw new Error('Pricing lookup failed')
      const data = await res.json()
      const key = `${edition.scryfall_id}:${edition.foil || 'normal'}`
      const prices = data.prices?.[key]
      setPriceData(prices || { ckd_usd: null, myr_2_5: null, myr_2_8: null, myr_3_0: null })
    } catch (err) {
      setPriceData({ ckd_usd: null, myr_2_5: null, myr_2_8: null, myr_3_0: null })
    }
  }

  // Generate the final image with price overlay using canvas
  const handleGenerateImage = useCallback(async () => {
    if (!photoUrl || !matchedCard) return
    setGenerating(true)

    try {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.src = photoUrl
      await new Promise((resolve, reject) => {
        img.onload = resolve
        img.onerror = reject
      })

      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext('2d')
      ctx.drawImage(img, 0, 0)

      // Calculate MYR price
      const ckdUsd = priceData?.ckd_usd
      let myrAmount = null
      if (ckdUsd != null) {
        myrAmount = Math.round(ckdUsd * multiplier * 2) / 2
      }

      // Draw price banner at the bottom
      const bannerHeight = Math.round(canvas.height * 0.12)
      const bannerY = canvas.height - bannerHeight

      // Banner background - gradient red (DBB accent)
      const gradient = ctx.createLinearGradient(0, bannerY, canvas.width, bannerY)
      gradient.addColorStop(0, '#b91c1c')
      gradient.addColorStop(0.5, '#dc2626')
      gradient.addColorStop(1, '#b91c1c')
      ctx.fillStyle = gradient
      ctx.fillRect(0, bannerY, canvas.width, bannerHeight)

      // Card name (left side)
      const fontSize = Math.round(bannerHeight * 0.35)
      ctx.font = `bold ${fontSize}px sans-serif`
      ctx.fillStyle = '#ffffff'
      ctx.textBaseline = 'middle'

      const cardNameText = matchedCard.cardName
      const nameY = bannerY + bannerHeight / 2
      ctx.fillText(cardNameText, Math.round(canvas.width * 0.04), nameY)

      // Price (right side) - large and prominent
      if (myrAmount != null) {
        const priceText = `RM ${myrAmount.toFixed(2)}`
        const priceFontSize = Math.round(bannerHeight * 0.5)
        ctx.font = `bold ${priceFontSize}px sans-serif`
        const textWidth = ctx.measureText(priceText).width
        ctx.fillText(priceText, canvas.width - textWidth - Math.round(canvas.width * 0.04), nameY)
      } else {
        const naText = 'Price N/A'
        const naFontSize = Math.round(bannerHeight * 0.35)
        ctx.font = `${naFontSize}px sans-serif`
        ctx.fillStyle = 'rgba(255,255,255,0.6)'
        const textWidth = ctx.measureText(naText).width
        ctx.fillText(naText, canvas.width - textWidth - Math.round(canvas.width * 0.04), nameY)
      }

      // DBB branding (small, top-left corner)
      const brandFontSize = Math.round(canvas.height * 0.025)
      ctx.font = `${brandFontSize}px sans-serif`
      ctx.fillStyle = 'rgba(255,255,255,0.7)'
      ctx.fillText("Dan's Bizarre Bazaar", Math.round(canvas.width * 0.03), Math.round(canvas.height * 0.04))

      // Convert to blob and create download URL
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.95))
      // Revoke previous generated URL
      if (generatedUrl) {
        const idx = objectUrlsRef.current.indexOf(generatedUrl)
        if (idx >= 0) objectUrlsRef.current.splice(idx, 1)
        URL.revokeObjectURL(generatedUrl)
      }
      const url = trackUrl(URL.createObjectURL(blob))
      setGeneratedUrl(url)
      setPhase('generated')
    } catch (err) {
      console.error('Image generation error:', err)
      setErrorMsg('Failed to generate image. Please try again.')
    } finally {
      setGenerating(false)
    }
  }, [photoUrl, matchedCard, priceData, multiplier, generatedUrl, trackUrl])

  // Download the generated image
  const handleDownload = () => {
    if (!generatedUrl) return
    const a = document.createElement('a')
    a.href = generatedUrl
    const safeName = matchedCard?.cardName?.replace(/[^a-zA-Z0-9]/g, '_') || 'card'
    a.download = `DBB_${safeName}_RM${(priceData?.ckd_usd ? Math.round(priceData.ckd_usd * multiplier * 2) / 2 : 0).toFixed(2)}.jpg`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  // Reset everything for a new card
  const handleReset = () => {
    if (photoUrl) {
      const idx = objectUrlsRef.current.indexOf(photoUrl)
      if (idx >= 0) objectUrlsRef.current.splice(idx, 1)
      URL.revokeObjectURL(photoUrl)
    }
    if (generatedUrl) {
      const idx = objectUrlsRef.current.indexOf(generatedUrl)
      if (idx >= 0) objectUrlsRef.current.splice(idx, 1)
      URL.revokeObjectURL(generatedUrl)
    }
    setPhotoUrl(null)
    setPhotoBlob(null)
    setGeneratedUrl(null)
    setMatchedCard(null)
    setSearchQuery('')
    setSearchResults([])
    setPriceData(null)
    setErrorMsg(null)
    setPhase('camera')
    startCamera()
  }

  // Get current MYR price for display
  const currentMyr = priceData?.ckd_usd != null
    ? Math.round(priceData.ckd_usd * multiplier * 2) / 2
    : null

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Tag className="w-5 h-5 text-dbb-accent" />
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Claim Sale Image Generator</h3>
        </div>
        <button onClick={() => { stopStream(); onCancel() }} className="text-gray-400 hover:text-gray-900 dark:hover:text-white">
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Phase: idle */}
      {phase === 'idle' && (
        <div className="text-center py-8 space-y-4">
          <ImageIcon className="w-12 h-12 text-gray-300 dark:text-gray-600 mx-auto" />
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Scan a card, match it, and generate a claim sale image with the RM price overlay.
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

      {/* Phase: camera */}
      {phase === 'camera' && (
        <div className="space-y-3">
          <div
            className="relative w-full bg-black rounded-lg overflow-hidden mx-auto"
            style={{ maxWidth: '420px', aspectRatio: '63 / 88' }}
          >
            <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
            <div className="absolute inset-0 pointer-events-none z-10">
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
              <div className="absolute left-1/2 -translate-x-1/2 text-white/70 text-[10px] font-medium" style={{ top: '2%' }}>
                Center card and scan
              </div>
            </div>
          </div>
          {errorMsg && <p className="text-xs text-red-400 text-center">{errorMsg}</p>}
          <div className="flex items-center gap-2">
            <button
              onClick={handleScanAndCapture}
              className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-dbb-accent hover:bg-red-600 text-white rounded-lg text-sm font-medium transition-colors"
            >
              <ScanLine className="w-4 h-4" />
              Scan & Capture
            </button>
            <button
              onClick={() => { stopStream(); setPhase('idle') }}
              className="px-3 py-2.5 text-sm text-gray-500 border border-gray-200 dark:border-gray-700 rounded-lg transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Phase: scanning */}
      {phase === 'scanning' && (
        <div className="text-center py-8 space-y-3">
          <Loader2 className="w-8 h-8 text-dbb-accent mx-auto animate-spin" />
          <p className="text-sm text-gray-600 dark:text-gray-400">Scanning card name...</p>
          <div className="w-48 h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden mx-auto">
            <div className="h-full bg-dbb-accent transition-all duration-300" style={{ width: `${ocrProgress}%` }} />
          </div>
          <p className="text-xs text-gray-400">{ocrProgress}%</p>
        </div>
      )}

      {/* Phase: matched - search results */}
      {phase === 'matched' && (
        <div className="space-y-3">
          {/* Show captured photo */}
          {photoUrl && (
            <div className="mx-auto w-full" style={{ maxWidth: '280px', aspectRatio: '63 / 88' }}>
              <img src={photoUrl} alt="Captured card" className="w-full h-full rounded-lg border border-gray-200 dark:border-gray-700 object-cover" />
            </div>
          )}

          {/* Search bar */}
          <form onSubmit={handleManualSearch} className="flex gap-2">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Card name..."
              className="flex-1 px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-dbb-secondary text-gray-900 dark:text-white focus:ring-1 focus:ring-dbb-accent"
              autoFocus
            />
            <button type="submit" disabled={searching} className="px-3 py-2 bg-dbb-accent hover:bg-red-600 disabled:opacity-40 text-white rounded-lg text-sm font-medium transition-colors">
              {searching ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Search'}
            </button>
          </form>

          {errorMsg && <p className="text-xs text-red-400">{errorMsg}</p>}

          {/* Search results */}
          <div className="space-y-2 max-h-[300px] overflow-y-auto">
            {!searching && searchResults.length === 0 && (
              <p className="text-xs text-gray-400 text-center py-4">No matches. Edit the name and search again.</p>
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
                      onClick={() => handleSelectCard(ed, group.name)}
                      className="w-full flex items-center gap-3 px-3 py-2 hover:bg-gray-50 dark:hover:bg-dbb-secondary/50 transition-colors text-left"
                    >
                      {ed.image_uris?.small ? (
                        <img src={ed.image_uris.small} alt="" className="w-10 h-14 rounded object-contain flex-shrink-0" />
                      ) : (
                        <div className="w-10 h-14 bg-gray-100 dark:bg-dbb-secondary rounded flex items-center justify-center flex-shrink-0">
                          <span className="text-gray-400 text-xs">?</span>
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-gray-900 dark:text-white truncate">{ed.set_name} ({ed.set_code?.toUpperCase()})</p>
                        <p className="text-xs text-gray-400">#{ed.collector_number} - {ed.rarity}</p>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <button onClick={handleReset} className="w-full flex items-center justify-center gap-1 py-2 text-sm text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-gray-700 rounded-lg transition-colors">
            <RefreshCw className="w-3.5 h-3.5" /> Rescan
          </button>
        </div>
      )}

      {/* Phase: pricing - select multiplier and generate */}
      {phase === 'pricing' && matchedCard && (
        <div className="space-y-4">
          {/* Photo + matched card info */}
          {photoUrl && (
            <div className="mx-auto w-full" style={{ maxWidth: '280px', aspectRatio: '63 / 88' }}>
              <img src={photoUrl} alt="Captured card" className="w-full h-full rounded-lg border border-gray-200 dark:border-gray-700 object-cover" />
            </div>
          )}
          <div className="text-center">
            <p className="text-sm font-medium text-gray-900 dark:text-white">{matchedCard.cardName}</p>
            <p className="text-xs text-gray-400">{matchedCard.edition.set_name} ({matchedCard.edition.set_code?.toUpperCase()})</p>
          </div>

          {/* Pricing info */}
          <div className="p-3 bg-gray-50 dark:bg-dbb-secondary border border-gray-200 dark:border-gray-700 rounded-lg space-y-2">
            <div className="flex justify-between text-xs">
              <span className="text-gray-500 dark:text-gray-400">CKD USD:</span>
              <span className="font-medium text-gray-900 dark:text-white">
                {priceData?.ckd_usd != null ? `$${priceData.ckd_usd.toFixed(2)}` : 'N/A'}
              </span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-gray-500 dark:text-gray-400">Multiplier:</span>
              <span className="font-medium text-gray-900 dark:text-white">{multiplier}x</span>
            </div>
            <div className="flex justify-between text-sm pt-1 border-t border-gray-200 dark:border-gray-700">
              <span className="font-medium text-gray-900 dark:text-white">RM Price:</span>
              <span className="font-bold text-dbb-accent text-lg">
                {currentMyr != null ? `RM ${currentMyr.toFixed(2)}` : 'N/A'}
              </span>
            </div>
          </div>

          {/* Multiplier selection */}
          <div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">Select multiplier:</p>
            <div className="flex gap-2">
              {MULTIPLIERS.map(m => (
                <button
                  key={m.value}
                  onClick={() => setMultiplier(m.value)}
                  className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                    multiplier === m.value
                      ? 'bg-dbb-accent text-white'
                      : 'bg-gray-100 dark:bg-dbb-secondary text-gray-700 dark:text-gray-300 border border-gray-200 dark:border-gray-700'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          {errorMsg && <p className="text-xs text-red-400">{errorMsg}</p>}

          <div className="flex gap-2">
            <button
              onClick={handleGenerateImage}
              disabled={generating}
              className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-dbb-accent hover:bg-red-600 disabled:opacity-40 text-white rounded-lg text-sm font-medium transition-colors"
            >
              {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <ImageIcon className="w-4 h-4" />}
              {generating ? 'Generating...' : 'Generate Image'}
            </button>
            <button
              onClick={() => { setMatchedCard(null); setPhase('matched') }}
              className="px-3 py-2.5 text-sm text-gray-500 border border-gray-200 dark:border-gray-700 rounded-lg transition-colors"
            >
              Back
            </button>
          </div>
        </div>
      )}

      {/* Phase: generated - show result and download */}
      {phase === 'generated' && generatedUrl && (
        <div className="space-y-4">
          <div className="text-center">
            <p className="text-sm font-medium text-green-500 mb-3">Image generated!</p>
          </div>
          <div className="mx-auto w-full" style={{ maxWidth: '300px', aspectRatio: '63 / 88' }}>
            <img src={generatedUrl} alt="Generated claim sale image" className="w-full h-full rounded-lg border border-gray-200 dark:border-gray-700 object-cover" />
          </div>
          <div className="text-center text-xs text-gray-500 dark:text-gray-400">
            <p>{matchedCard?.cardName} - RM {currentMyr?.toFixed(2) || 'N/A'} ({multiplier}x)</p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleDownload}
              className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm font-medium transition-colors"
            >
              <Download className="w-4 h-4" />
              Download Image
            </button>
            <button
              onClick={() => setPhase('pricing')}
              className="px-3 py-2.5 text-sm text-gray-500 border border-gray-200 dark:border-gray-700 rounded-lg transition-colors"
            >
              Back
            </button>
          </div>
          <button
            onClick={handleReset}
            className="w-full flex items-center justify-center gap-1 py-2 text-sm text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-gray-700 rounded-lg transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" /> New Card
          </button>
        </div>
      )}
    </div>
  )
}