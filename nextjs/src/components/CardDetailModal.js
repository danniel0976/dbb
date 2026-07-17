'use client'

import { useState, useEffect, useRef } from 'react'
import { getCardById, getImageUrl } from '@/lib/scryfall'
import { useToast } from '@/components/Toast'
import CameraCapture from '@/components/CameraCapture'
import FacebookSaleImage from '@/components/FacebookSaleImage'
import { X, Star, Minus, Plus, Trash2, Tag, Loader2, Camera, RotateCcw, Maximize2, Package } from 'lucide-react'

const MULTIPLIERS = [2.5, 2.8, 3.0]
const DURATION_OPTIONS = [
  { hours: 1, label: '1h' },
  { hours: 3, label: '3h' },
  { hours: 6, label: '6h' },
  { hours: 12, label: '12h' },
  { hours: 24, label: '24h' },
]

function relativeTime(isoString, future = false) {
  if (!isoString) return null
  const diffMs = new Date(isoString).getTime() - Date.now()
  const abs = Math.abs(diffMs)
  const mins = Math.floor(abs / 60000)
  const hours = Math.floor(abs / 3600000)
  const days = Math.floor(abs / 86400000)
  let label
  if (abs < 60000) label = 'just now'
  else if (mins < 60) label = `${mins}m`
  else if (hours < 24) label = `${hours}h ${mins % 60}m`
  else label = `${days}d`
  return future ? (diffMs > 0 ? `in ${label}` : 'expired') : `${label} ago`
}

// PhotoSection — shows current card photo + camera capture for owner.
// Uses small variant (640px) for inline display; full-size available via lightbox.
function PhotoSection({ libraryRow, listing, onPhotoChange, forceCamera, onCameraOpened, onCaptureComplete, onCaptureCancel }) {
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
      <div className="pt-2 border-t border-black/5 dark:border-white/10">
        <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-600">
          <Loader2 className="w-3 h-3 animate-spin" /> Loading photo...
        </div>
      </div>
    )
  }

  return (
    <div className="pt-2 border-t border-black/5 dark:border-white/10 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-gray-600 dark:text-gray-400">Card photo</p>
        {photoUrl && !showCamera && (
          <button
            onClick={() => setShowCamera(true)}
            className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors"
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
            className="w-full max-h-40 object-contain rounded-dbb-md bg-gray-100 dark:bg-dbb-secondary"
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
          <p className="text-xs text-gray-500 dark:text-gray-600">No photo yet — required before listing.</p>
          <button
            onClick={() => setShowCamera(true)}
            className="flex items-center justify-center gap-2 w-full py-2 border border-dashed border-gray-300 dark:border-gray-600 hover:border-dbb-accent text-gray-400 hover:text-dbb-accent rounded-lg text-xs transition-colors"
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

function ClaimSaleForm({ libraryRow, onCancel, onRequirePhoto }) {
  const { toast } = useToast()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [setCode, setSetCode] = useState(libraryRow?.card_index?.set_code || '')
  const [durationHours, setDurationHours] = useState(24)
  const [deliveryOption, setDeliveryOption] = useState('pickup')
  const [csQuantity, setCsQuantity] = useState(1)
  const [submitting, setSubmitting] = useState(false)

  const ownedQty = libraryRow?.quantity || 1

  const handleCreate = async () => {
    if (!title.trim()) {
      toast('Title is required', 'error')
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch('/api/claim-sales', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || undefined,
          set_code: setCode.trim() || undefined,
          duration_hours: durationHours,
          delivery_option: deliveryOption,
          card_ids: [libraryRow.id],
          quantities: { [libraryRow.id]: csQuantity },
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        if (res.status === 422 && err.missing_photos?.includes(libraryRow.id)) {
          onRequirePhoto?.(handleCreate)
          return
        }
        throw new Error(err.error || 'Failed')
      }
      toast('Claim sale created on Bazaar', 'success')
      onCancel()
    } catch (e) {
      toast(e.message || 'Failed to create claim sale', 'error')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="pt-2 border-t border-black/5 dark:border-white/10 space-y-3">
      <p className="text-xs text-gray-600 dark:text-gray-400 font-medium flex items-center gap-1">
        <Package className="w-3 h-3" /> Claim Sale
      </p>

      <div>
        <input
          type="text"
          placeholder="Claim sale title (e.g. Modern staples sale)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-gray-700 rounded px-3 py-1.5 text-sm focus:border-dbb-accent focus:outline-none placeholder-gray-400 dark:placeholder-gray-600"
        />
      </div>

      <div>
        <textarea
          placeholder="Description (optional)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          className="w-full bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-gray-700 rounded px-3 py-1.5 text-sm focus:border-dbb-accent focus:outline-none placeholder-gray-400 dark:placeholder-gray-600 resize-none"
        />
      </div>

      <div>
        <input
          type="text"
          placeholder="Set code (optional, e.g. MKM)"
          value={setCode}
          onChange={(e) => setSetCode(e.target.value)}
          className="w-full bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-gray-700 rounded px-3 py-1.5 text-sm focus:border-dbb-accent focus:outline-none placeholder-gray-400 dark:placeholder-gray-600"
        />
      </div>

      <div>
        <p className="text-xs text-gray-600 mb-1.5">Duration (max 24h)</p>
        <div className="flex gap-1.5">
          {DURATION_OPTIONS.map(({ hours, label }) => (
            <button
              key={hours}
              onClick={() => setDurationHours(hours)}
              className={`flex-1 py-1.5 rounded border text-xs font-medium transition-colors ${
                durationHours === hours
                  ? 'border-dbb-accent bg-dbb-accent/10 text-dbb-accent'
                  : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-500 hover:border-gray-400 dark:hover:border-gray-500'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <p className="text-xs text-gray-600 mb-1.5">Delivery option</p>
        <div className="flex gap-2">
            {[
              { value: 'pickup', label: 'TCG store pickup' },
            ].map(opt => (
            <button
              key={opt.value}
              onClick={() => setDeliveryOption(opt.value)}
              className={`flex-1 py-1.5 rounded border text-xs font-medium transition-colors ${
                deliveryOption === opt.value
                  ? 'border-dbb-accent bg-dbb-accent/10 text-dbb-accent'
                  : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-500 hover:border-gray-400 dark:hover:border-gray-500'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Quantity picker for claim sale */}
      {ownedQty > 1 && (
        <div>
          <p className="text-xs text-gray-600 mb-1.5">Quantity (max {ownedQty})</p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setCsQuantity(q => Math.max(1, q - 1))}
              className="p-1 rounded bg-gray-100 dark:bg-dbb-secondary hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
            >
              <Minus className="w-4 h-4" />
            </button>
            <input
              type="number"
              min="1"
              max={ownedQty}
              value={csQuantity}
              onChange={(e) => {
                const v = parseInt(e.target.value) || 1
                setCsQuantity(Math.max(1, Math.min(ownedQty, v)))
              }}
              className="w-16 text-center bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-sm focus:border-dbb-accent focus:outline-none"
            />
            <button
              onClick={() => setCsQuantity(q => Math.min(ownedQty, q + 1))}
              className="p-1 rounded bg-gray-100 dark:bg-dbb-secondary hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
            >
              <Plus className="w-4 h-4" />
            </button>
            <span className="text-xs text-gray-500 ml-1">of {ownedQty} owned</span>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={handleCreate}
          disabled={submitting}
          className="flex-1 py-1.5 text-sm bg-dbb-accent hover:bg-red-600 text-white rounded-lg transition-colors disabled:opacity-50"
        >
          {submitting ? 'Creating...' : 'Create Claim Sale'}
        </button>
        <button
          onClick={onCancel}
          className="px-3 py-1.5 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

function ListingSection({ libraryRow, hasPhoto, onRequirePhoto }) {
  const { toast } = useToast()
  const [listing, setListing] = useState(undefined) // undefined = loading, null = not listed
  const [showPicker, setShowPicker] = useState(false)
  const [showListPrompt, setShowListPrompt] = useState(false) // singles vs claim sale
  const [showClaimSale, setShowClaimSale] = useState(false)
  const [isRelist, setIsRelist] = useState(false)
  const [multiplier, setMultiplier] = useState(2.5)
  const [durationHours, setDurationHours] = useState(24)
  const [listQuantity, setListQuantity] = useState(1) // listing quantity (1..owned)
  const [pricePreview, setPricePreview] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [photoRequired, setPhotoRequired] = useState(false)
  const [merchantProfileRequired, setMerchantProfileRequired] = useState(false)

  const ownedQty = libraryRow.quantity || 1

  // Load listing status (including expired ones owned by this user)
  useEffect(() => {
    fetch(`/api/listings?library_card_id=${libraryRow.id}`)
      .then(r => r.ok ? r.json() : { listing: null })
      .then(data => setListing(data.listing || null))
      .catch(() => setListing(null))
  }, [libraryRow.id])

  // Reset listing quantity to 1 when opening a new listing picker
  useEffect(() => {
    if (showPicker) setListQuantity(1)
  }, [showPicker])

  // Fetch price preview when either the new-listing or relist picker is open.
  // Relisting uses isRelist without setting showPicker, so checking only
  // showPicker left every multiplier button without a price.
  useEffect(() => {
    if ((!showPicker && !isRelist) || !libraryRow.scryfall_id) return
    const foil = libraryRow.foil || 'normal'
    fetch('/api/pricing/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ scryfall_id: libraryRow.scryfall_id, foil }] }),
    })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        const key = `${libraryRow.scryfall_id}:${foil}`
        setPricePreview(data?.prices?.[key]?.ckd_usd ?? null)
      })
      .catch(() => {})
  }, [showPicker, isRelist, libraryRow.scryfall_id, libraryRow.foil])

  const computeMyr = (ckdUsd, mult) => {
    if (ckdUsd == null) return null
    return Math.round(ckdUsd * mult * 2) / 2
  }

  const handleList = async () => {
    setSubmitting(true)
    try {
      const res = await fetch('/api/listings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ library_card_id: libraryRow.id, multiplier, duration_hours: durationHours, quantity: listQuantity }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        if (res.status === 422 && err.missing_photos?.includes(libraryRow.id)) {
          onRequirePhoto?.(handleList)
          return
        }
        if (err.code === 'MERCHANT_PROFILE_REQUIRED' || err.code === 'MERCHANT_PROFILE_UNAVAILABLE') {
          setMerchantProfileRequired(true)
          return
        }
        throw new Error(err.error || 'Failed')
      }
      const data = await res.json()
      setListing(data.listings?.[0] || { multiplier, status: 'active' })
      setShowPicker(false)
      toast('Card listed on Bazaar', 'success')
    } catch (e) {
      toast(e.message || 'Failed to list card', 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const handleRelist = async () => {
    if (!listing?.id) return
    setSubmitting(true)
    try {
      const res = await fetch(`/api/listings/${listing.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ multiplier, duration_hours: durationHours }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        if (err.code === 'MERCHANT_PROFILE_REQUIRED' || err.code === 'MERCHANT_PROFILE_UNAVAILABLE') {
          setMerchantProfileRequired(true)
          return
        }
        throw new Error(err.error || 'Failed to relist card')
      }
      const data = await res.json()
      setListing(data.listing || { ...listing, status: 'active', multiplier })
      setShowPicker(false)
      setIsRelist(false)
      toast('Card relisted on Bazaar', 'success')
    } catch (error) {
      toast(error.message || 'Failed to relist card', 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const handleUnlist = async () => {
    if (!listing?.id) return
    setSubmitting(true)
    try {
      const res = await fetch(`/api/listings/${listing.id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed')
      setListing(null)
      toast('Card unlisted', 'success')
    } catch {
      toast('Failed to unlist card', 'error')
    } finally {
      setSubmitting(false)
    }
  }

  if (listing === undefined) {
    return (
      <div className="flex items-center gap-2 text-xs text-gray-600 pt-2 border-t border-black/5 dark:border-white/10">
        <Loader2 className="w-3 h-3 animate-spin" /> Checking bazaar status...
      </div>
    )
  }

  const isExpired = listing && (
    listing.status === 'expired' ||
    (listing.expires_at && new Date(listing.expires_at) <= new Date())
  )

  // Not listed yet — show a "List on Bazaar" button (not the picker right away)
  if (!listing && !showPicker && !showClaimSale && !showListPrompt) {
    return (
      <div className="pt-2 border-t border-black/5 dark:border-white/10">
        <button
          onClick={() => {
            if (!hasPhoto) {
              setPhotoRequired(true)
              onRequirePhoto?.()
            } else { setShowListPrompt(true) }
          }}
          className="flex items-center justify-center gap-2 w-full py-1.5 border border-gray-200 dark:border-gray-700 hover:border-dbb-accent text-gray-500 dark:text-gray-400 hover:text-dbb-accent rounded-lg text-xs font-medium transition-colors"
        >
          <Tag className="w-3 h-3" />
          List on Bazaar
        </button>
        {photoRequired && !hasPhoto && (
          <p className="text-xs text-amber-400 mt-1.5">
            Opening the assisted camera so you can add the required condition photo.
          </p>
        )}
      </div>
    )
  }

  // Show listing type prompt: singles or claim sale
  if (showListPrompt && !showPicker && !showClaimSale) {
    return (
      <div className="pt-2 border-t border-black/5 dark:border-white/10 space-y-3">
        <p className="text-xs text-gray-600 dark:text-gray-400 font-medium">Sell as singles or put up for claim sale?</p>
        <div className="flex gap-2">
          <button
            onClick={() => { setShowListPrompt(false); setShowPicker(true) }}
            className="flex-1 py-2 border border-gray-200 dark:border-gray-700 hover:border-dbb-accent text-gray-600 dark:text-gray-300 hover:text-dbb-accent rounded-lg text-xs font-medium transition-colors flex items-center justify-center gap-1.5"
          >
            <Tag className="w-3 h-3" /> Singles
          </button>
          <button
            onClick={() => { setShowListPrompt(false); setShowClaimSale(true) }}
            className="flex-1 py-2 border border-gray-200 dark:border-gray-700 hover:border-dbb-accent text-gray-600 dark:text-gray-300 hover:text-dbb-accent rounded-lg text-xs font-medium transition-colors flex items-center justify-center gap-1.5"
          >
            <Package className="w-3 h-3" /> Claim Sale
          </button>
        </div>
        <button
          onClick={() => setShowListPrompt(false)}
          className="text-xs text-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors"
        >
          Cancel
        </button>
      </div>
    )
  }

  // Show claim sale form
  if (showClaimSale) {
    return (
      <ClaimSaleForm
        libraryRow={libraryRow}
        onCancel={() => setShowClaimSale(false)}
        onRequirePhoto={onRequirePhoto}
      />
    )
  }

  // Show picker for new listing or relist
  if (!listing || (showPicker && !isExpired) || (isRelist && isExpired)) {
    const isRelisting = isExpired && isRelist

    // Photo gate — shouldn't happen (button above checks), but block at render level too
    if (!hasPhoto) {
      return (
        <div className="pt-2 border-t border-black/5 dark:border-white/10 space-y-2">
          <p className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1.5">
            A card photo is required before listing. Please take a photo above.
          </p>
          <button
            onClick={() => { setShowPicker(false); setIsRelist(false); setPhotoRequired(false) }}
            className="text-xs text-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors"
          >
            Cancel
          </button>
        </div>
      )
    }

    if (merchantProfileRequired) {
      return (
        <div className="pt-2 border-t border-black/5 dark:border-white/10 space-y-2">
          <p className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1.5">
            Complete your seller payment information in Profile before listing or relisting.
          </p>
          <div className="flex items-center gap-3">
            <a href="/profile" className="text-xs font-medium text-dbb-accent hover:underline">
              Complete seller profile
            </a>
            <button
              onClick={() => { setMerchantProfileRequired(false); setShowPicker(false); setIsRelist(false) }}
              className="text-xs text-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )
    }

    return (
      <div className="pt-2 border-t border-black/5 dark:border-white/10">
        <div className="space-y-3">
          <p className="text-xs text-gray-600 dark:text-gray-400 font-medium">
            {isRelisting ? 'Relist on Bazaar' : 'List on Bazaar'}
          </p>

          {/* Multiplier picker */}
          <div>
            <p className="text-xs text-gray-600 mb-1.5">Multiplier</p>
            <div className="flex gap-2">
              {MULTIPLIERS.map(m => {
                const myr = computeMyr(pricePreview, m)
                return (
                  <button
                    key={m}
                    onClick={() => setMultiplier(m)}
                    className={`flex-1 py-2 rounded-lg border text-sm font-medium transition-colors ${
                      multiplier === m
                        ? 'border-dbb-accent bg-dbb-accent/10 text-dbb-accent'
                        : 'border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-dbb-accent/50'
                    }`}
                  >
                    <div>×{m}</div>
                    {myr != null ? (
                      <div className="text-xs text-gray-500 font-normal">RM {myr.toFixed(2)}</div>
                    ) : (
                      <div className="text-xs text-gray-600 font-normal">—</div>
                    )}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Quantity picker (1..owned) */}
          {ownedQty > 1 && (
            <div>
              <p className="text-xs text-gray-600 mb-1.5">Quantity (max {ownedQty})</p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setListQuantity(q => Math.max(1, q - 1))}
                  className="p-1 rounded bg-gray-100 dark:bg-dbb-secondary hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                >
                  <Minus className="w-4 h-4" />
                </button>
                <input
                  type="number"
                  min="1"
                  max={ownedQty}
                  value={listQuantity}
                  onChange={(e) => {
                    const v = parseInt(e.target.value) || 1
                    setListQuantity(Math.max(1, Math.min(ownedQty, v)))
                  }}
                  className="w-16 text-center bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-sm focus:border-dbb-accent focus:outline-none"
                />
                <button
                  onClick={() => setListQuantity(q => Math.min(ownedQty, q + 1))}
                  className="p-1 rounded bg-gray-100 dark:bg-dbb-secondary hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                >
                  <Plus className="w-4 h-4" />
                </button>
                <span className="text-xs text-gray-500 ml-1">of {ownedQty} owned</span>
              </div>
            </div>
          )}

          {/* Duration picker */}
          <div>
            <p className="text-xs text-gray-600 mb-1.5">Duration (max 24h)</p>
            <div className="flex gap-1.5">
              {DURATION_OPTIONS.map(({ hours, label }) => (
                <button
                  key={hours}
                  onClick={() => setDurationHours(hours)}
                  className={`flex-1 py-1.5 rounded border text-xs font-medium transition-colors ${
                    durationHours === hours
                      ? 'border-dbb-accent bg-dbb-accent/10 text-dbb-accent'
                      : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-500 hover:border-gray-400 dark:hover:border-gray-500'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={isRelisting ? handleRelist : handleList}
              disabled={submitting}
              className="flex-1 py-1.5 text-sm bg-dbb-accent hover:bg-red-600 text-white rounded-lg transition-colors disabled:opacity-50"
            >
              {submitting ? 'Listing...' : (isRelisting ? 'Relist' : 'Confirm Listing')}
            </button>
            <button
              onClick={() => { setShowPicker(false); setIsRelist(false) }}
              className="px-3 py-1.5 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Expired listing state
  const expiredQty = listing.quantity || 1
  if (isExpired) {
    return (
      <div className="pt-2 border-t border-black/5 dark:border-white/10">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1 text-xs font-medium text-orange-400 bg-orange-500/10 border border-orange-500/30 rounded px-2 py-0.5">
            <Tag className="w-3 h-3" /> Listing Expired
          </span>
          <button
            onClick={() => { setIsRelist(true); setMultiplier(Number(listing.multiplier) || 2.5); setListQuantity(expiredQty) }}
            className="btn btn-outline btn-sm"
          >
            Relist
          </button>
        </div>
        {expiredQty > 1 && (
          <p className="text-xs text-gray-500 mt-1">{expiredQty} copies</p>
        )}
      </div>
    )
  }

  // Active listing state
  const listedAgo = listing.created_at ? relativeTime(listing.created_at, false) : null
  const expiresIn = listing.expires_at ? relativeTime(listing.expires_at, true) : null
  const listedQty = listing.quantity || 1

  return (
    <div className="pt-2 border-t border-black/5 dark:border-white/10">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1 text-xs font-medium text-green-400 bg-green-500/10 border border-green-500/30 rounded px-2 py-0.5">
            <Tag className="w-3 h-3" /> Listed on Bazaar
          </span>
          <span className="text-xs text-gray-500">×{listing.multiplier}{listedQty > 1 ? ` · ${listedQty} copies` : ''}</span>
        </div>
        <button
          onClick={handleUnlist}
          disabled={submitting}
          className="flex items-center gap-1 text-xs text-red-400 hover:text-red-300 transition-colors disabled:opacity-50"
        >
          {submitting ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
          Unlist
        </button>
      </div>
      {(listedAgo || expiresIn) && (
        <p className="text-[10px] text-gray-600 mt-1">
          {listedAgo && `listed ${listedAgo}`}
          {listedAgo && expiresIn && ' · '}
          {expiresIn && `expires ${expiresIn}`}
        </p>
      )}
    </div>
  )
}

const CONDITIONS = ['M', 'NM', 'LP', 'MP', 'HP', 'DMG']
const FOILS = ['normal', 'foil', 'etched']

export default function CardDetailModal({ libraryRow, onClose, onSave, onDelete }) {
  const { toast } = useToast()
  const [cardData, setCardData] = useState(null)
  const [imageUrl, setImageUrl] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [hasPhoto, setHasPhoto] = useState(false)
  const [currentListing, setCurrentListing] = useState(undefined)
  const [forcePhotoCamera, setForcePhotoCamera] = useState(false)
  const [pendingPhotoAction, setPendingPhotoAction] = useState(null)
  const [showMore, setShowMore] = useState(false) // gates the destructive "Remove" affordance one level deeper

  const sheetRef = useRef(null)
  const closeBtnRef = useRef(null)

  const [quantity, setQuantity] = useState(libraryRow.quantity)
  const [condition, setCondition] = useState(libraryRow.condition)
  const [foil, setFoil] = useState(libraryRow.foil)
  const [starred, setStarred] = useState(libraryRow.starred)

  // Load listing status for PhotoSection (needed to block retake while listed)
  useEffect(() => {
    fetch(`/api/listings?library_card_id=${libraryRow.id}`)
      .then(r => r.ok ? r.json() : { listing: null })
      .then(data => setCurrentListing(data.listing || null))
      .catch(() => setCurrentListing(null))
  }, [libraryRow.id])

  const ci = libraryRow.card_index

  useEffect(() => {
    getCardById(libraryRow.scryfall_id)
      .then(data => {
        setCardData(data)
        setImageUrl(getImageUrl(data))
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [libraryRow.scryfall_id])

  // Behavioral primitives: Escape-to-close, focus trap, and scroll lock while
  // open (matches the established FilterSheet pattern from Pass 4 tooling).
  useEffect(() => {
    closeBtnRef.current?.focus()

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      const focusables = sheetRef.current?.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
      if (!focusables || focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = prevOverflow
    }
  }, [onClose])

  async function handleSave() {
    setSaving(true)
    try {
      const res = await fetch(`/api/library/${libraryRow.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quantity, condition, foil, starred }),
      })
      if (!res.ok) throw new Error('Save failed')
      const { card } = await res.json()
      toast('Card updated', 'success')
      onSave({ ...libraryRow, ...card, card_index: ci })
      onClose()
    } catch {
      toast('Failed to save changes', 'error')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    setDeleting(true)
    try {
      const res = await fetch(`/api/library/${libraryRow.id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Delete failed')
      toast('Card removed from library', 'success')
      onDelete(libraryRow.id)
      onClose()
    } catch {
      toast('Failed to delete card', 'error')
    } finally {
      setDeleting(false)
      setConfirmDelete(false)
    }
  }

  const title = ci?.name || cardData?.name || 'Card Details'

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
      role="presentation"
    >
      {/* Mobile: full-height bottom sheet. Desktop: centered two-region panel.
          Solid content body; glass-style chrome lives only on the header/footer
          edges (never two stacked translucent layers). */}
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative flex h-[92vh] w-full flex-col overflow-hidden rounded-t-dbb-xl bg-white shadow-2xl dark:bg-dbb-primary sm:h-auto sm:max-h-[90vh] sm:max-w-3xl sm:rounded-dbb-xl"
      >
        {/* Header — glass chrome edge */}
        <div className="dbb-glass-chrome flex shrink-0 items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <h2 className="truncate text-dbb-lg font-semibold tracking-heading text-gray-900 dark:text-white">
            {title}
          </h2>
          <button
            ref={closeBtnRef}
            onClick={onClose}
            aria-label="Close"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-gray-500 transition-colors hover:bg-black/5 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-white/10 dark:hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Scrollable solid body */}
        <div className="flex-1 overflow-y-auto overscroll-contain">
          <div className="flex flex-col gap-5 p-4 sm:flex-row sm:gap-6 sm:p-6">
            {/* Artwork region — native MTG aspect ratio, never cropped */}
            <div className="mx-auto w-40 shrink-0 sm:mx-0 sm:w-56">
              {loading ? (
                <div className="aspect-[5/7] skeleton rounded-dbb-md" />
              ) : imageUrl ? (
                <img
                  src={imageUrl}
                  alt={ci?.name || 'Card'}
                  className="h-auto w-full rounded-dbb-md object-contain shadow-dbb-md"
                />
              ) : (
                <div className="flex aspect-[5/7] items-center justify-center rounded-dbb-md bg-gray-100 dark:bg-dbb-secondary">
                  <span className="p-2 text-center text-dbb-sm text-gray-500">{ci?.name}</span>
                </div>
              )}
            </div>

            {/* Progressive action panel */}
            <div className="flex min-w-0 flex-1 flex-col gap-5">
              {/* Card metadata */}
              <div className="space-y-1 text-dbb-sm text-gray-600 dark:text-gray-300">
                {(ci?.set_name || cardData?.set_name) && (
                  <div><span className="text-gray-400 dark:text-gray-500">Set</span> · {ci?.set_name || cardData?.set_name}</div>
                )}
                {(ci?.rarity || cardData?.rarity) && (
                  <div><span className="text-gray-400 dark:text-gray-500">Rarity</span> · {ci?.rarity || cardData?.rarity}</div>
                )}
                {(ci?.type_line || cardData?.type_line) && (
                  <div><span className="text-gray-400 dark:text-gray-500">Type</span> · {ci?.type_line || cardData?.type_line}</div>
                )}
                {cardData?.oracle_text && (
                  <div className="mt-2 whitespace-pre-line rounded-dbb-md bg-gray-50 p-3 text-dbb-xs leading-relaxed text-gray-600 dark:bg-dbb-secondary dark:text-gray-300">
                    {cardData.oracle_text}
                  </div>
                )}
              </div>

              {/* Editable fields */}
              <div className="space-y-3">
                {/* Quantity — 44px touch targets */}
                <div className="flex items-center gap-3">
                  <label className="w-24 text-dbb-sm text-gray-600 dark:text-gray-400">Quantity</label>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setQuantity(q => Math.max(1, q - 1))}
                      aria-label="Decrease quantity"
                      className="flex h-11 w-11 items-center justify-center rounded-dbb-md bg-gray-100 transition-colors hover:bg-gray-200 dark:bg-dbb-secondary dark:hover:bg-gray-700"
                    >
                      <Minus className="h-4 w-4" />
                    </button>
                    <input
                      type="number"
                      min="1"
                      max="9999"
                      value={quantity}
                      onChange={(e) => setQuantity(Math.max(1, Math.min(9999, parseInt(e.target.value) || 1)))}
                      className="h-11 w-16 rounded-dbb-md bg-white text-center text-dbb-sm focus:outline-none focus:ring-2 focus:ring-dbb-accent/40 dark:bg-dbb-secondary"
                    />
                    <button
                      onClick={() => setQuantity(q => Math.min(9999, q + 1))}
                      aria-label="Increase quantity"
                      className="flex h-11 w-11 items-center justify-center rounded-dbb-md bg-gray-100 transition-colors hover:bg-gray-200 dark:bg-dbb-secondary dark:hover:bg-gray-700"
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                {/* Condition */}
                <div className="flex items-center gap-3">
                  <label className="w-24 text-dbb-sm text-gray-600 dark:text-gray-400">Condition</label>
                  <select
                    value={condition}
                    onChange={(e) => setCondition(e.target.value)}
                    className="h-11 rounded-dbb-md bg-gray-100 px-3 text-dbb-sm focus:outline-none focus:ring-2 focus:ring-dbb-accent/40 dark:bg-dbb-secondary"
                  >
                    {CONDITIONS.map(c => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>

                {/* Foil */}
                <div className="flex items-center gap-3">
                  <label className="w-24 text-dbb-sm text-gray-600 dark:text-gray-400">Finish</label>
                  <select
                    value={foil}
                    onChange={(e) => setFoil(e.target.value)}
                    className="h-11 rounded-dbb-md bg-gray-100 px-3 text-dbb-sm focus:outline-none focus:ring-2 focus:ring-dbb-accent/40 dark:bg-dbb-secondary"
                  >
                    {FOILS.map(f => (
                      <option key={f} value={f}>{f.charAt(0).toUpperCase() + f.slice(1)}</option>
                    ))}
                  </select>
                </div>

                {/* Star */}
                <div className="flex items-center gap-3">
                  <label className="w-24 text-dbb-sm text-gray-600 dark:text-gray-400">Starred</label>
                  <button
                    onClick={() => setStarred(s => !s)}
                    aria-pressed={starred}
                    className={`flex h-11 items-center gap-2 rounded-dbb-md px-4 text-dbb-sm font-medium transition-colors ${
                      starred
                        ? 'bg-yellow-500/10 text-yellow-500'
                        : 'bg-gray-100 text-gray-500 hover:text-yellow-500 dark:bg-dbb-secondary'
                    }`}
                  >
                    <Star className="h-4 w-4" fill={starred ? 'currentColor' : 'none'} />
                    {starred ? 'Starred' : 'Star this card'}
                  </button>
                </div>
              </div>

              {/* Card photo */}
              <PhotoSection
                libraryRow={libraryRow}
                listing={currentListing}
                onPhotoChange={setHasPhoto}
                forceCamera={forcePhotoCamera}
                onCameraOpened={() => setForcePhotoCamera(false)}
                onCaptureComplete={() => {
                  if (pendingPhotoAction) {
                    const retry = pendingPhotoAction
                    setPendingPhotoAction(null)
                    retry()
                  }
                }}
                onCaptureCancel={() => setPendingPhotoAction(null)}
              />

              <FacebookSaleImage
                libraryRow={libraryRow}
                hasPhoto={hasPhoto}
                hasUnsavedDetails={condition !== libraryRow.condition || foil !== libraryRow.foil}
              />

              {/* Bazaar listing */}
              <ListingSection
                libraryRow={libraryRow}
                hasPhoto={hasPhoto}
                onRequirePhoto={(retry) => {
                  if (retry) setPendingPhotoAction(() => retry)
                  setForcePhotoCamera(true)
                }}
              />

              {/* Secondary / destructive actions live one level deeper */}
              <div className="pt-1">
                {!showMore ? (
                  <button
                    onClick={() => setShowMore(true)}
                    className="text-dbb-sm text-gray-500 transition-colors hover:text-gray-900 dark:hover:text-white"
                  >
                    More options
                  </button>
                ) : (
                  <div className="rounded-dbb-md bg-gray-50 p-3 dark:bg-dbb-secondary">
                    {!confirmDelete ? (
                      <button
                        onClick={() => setConfirmDelete(true)}
                        className="flex items-center gap-2 text-dbb-sm text-red-500 transition-colors hover:text-red-400"
                      >
                        <Trash2 className="h-4 w-4" />
                        Remove from library
                      </button>
                    ) : (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-dbb-sm text-red-500">Remove from library?</span>
                        <button
                          onClick={handleDelete}
                          disabled={deleting}
                          className="rounded-dbb-md bg-red-600 px-3 py-1.5 text-dbb-sm text-white transition-colors hover:bg-red-500 disabled:opacity-50"
                        >
                          {deleting ? 'Removing...' : 'Confirm'}
                        </button>
                        <button
                          onClick={() => setConfirmDelete(false)}
                          className="px-2 py-1.5 text-dbb-sm text-gray-500 transition-colors hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Sticky footer — primary actions, glass chrome top edge */}
        <div
          className="dbb-glass-chrome dbb-glass-chrome--edge-top flex shrink-0 items-center gap-3 px-4 py-3 sm:px-6"
          style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
        >
          <button
            onClick={onClose}
            className="min-h-[44px] px-4 text-dbb-sm text-gray-500 transition-colors hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="min-h-[44px] flex-1 rounded-dbb-md bg-dbb-accent px-4 text-dbb-sm font-semibold text-white transition-colors hover:bg-dbb-accent-hov disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  )
}
