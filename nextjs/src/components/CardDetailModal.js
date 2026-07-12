'use client'

import { useState, useEffect, useCallback } from 'react'
import { getCardById, getImageUrl } from '@/lib/scryfall'
import { useToast } from '@/components/Toast'
import CameraCapture from '@/components/CameraCapture'
import { X, Star, Minus, Plus, Trash2, Tag, Loader2, Camera, RotateCcw } from 'lucide-react'

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

// PhotoSection — shows current card photo + camera capture for owner
function PhotoSection({ libraryRow, listing, onPhotoChange }) {
  const { toast } = useToast()
  const [photoUrl, setPhotoUrl] = useState(undefined) // undefined=loading, null=none, string=url
  const [showCamera, setShowCamera] = useState(false)

  const isActiveListing = listing && listing.status === 'active' &&
    (!listing.expires_at || new Date(listing.expires_at) > new Date())

  useEffect(() => {
    fetch(`/api/photos/${libraryRow.id}`)
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
  }

  if (photoUrl === undefined) {
    return (
      <div className="pt-2 border-t border-gray-700">
        <div className="flex items-center gap-2 text-xs text-gray-600">
          <Loader2 className="w-3 h-3 animate-spin" /> Loading photo...
        </div>
      </div>
    )
  }

  return (
    <div className="pt-2 border-t border-gray-700 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-gray-400">Card photo</p>
        {photoUrl && !isActiveListing && !showCamera && (
          <button
            onClick={() => setShowCamera(true)}
            className="flex items-center gap-1 text-xs text-gray-500 hover:text-white transition-colors"
          >
            <RotateCcw className="w-3 h-3" /> Retake
          </button>
        )}
        {photoUrl && isActiveListing && (
          <span className="text-xs text-gray-600">Unlist to retake</span>
        )}
      </div>

      {showCamera ? (
        <CameraCapture
          libraryCardId={libraryRow.id}
          onUploaded={handleUploaded}
          onCancel={() => setShowCamera(false)}
        />
      ) : photoUrl ? (
        <img
          src={photoUrl}
          alt="Card photo"
          className="w-full max-h-40 object-cover rounded-lg border border-gray-700"
        />
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-gray-600">No photo yet — required before listing.</p>
          <button
            onClick={() => setShowCamera(true)}
            className="flex items-center justify-center gap-2 w-full py-2 border border-dashed border-gray-600 hover:border-dbb-accent text-gray-400 hover:text-dbb-accent rounded-lg text-xs transition-colors"
          >
            <Camera className="w-4 h-4" />
            Take Photo
          </button>
        </div>
      )}
    </div>
  )
}

function ListingSection({ libraryRow, hasPhoto }) {
  const { toast } = useToast()
  const [listing, setListing] = useState(undefined) // undefined = loading, null = not listed
  const [showPicker, setShowPicker] = useState(false)
  const [isRelist, setIsRelist] = useState(false)
  const [multiplier, setMultiplier] = useState(2.5)
  const [durationHours, setDurationHours] = useState(24)
  const [pricePreview, setPricePreview] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [photoRequired, setPhotoRequired] = useState(false)

  // Load listing status (including expired ones owned by this user)
  useEffect(() => {
    fetch(`/api/listings?library_card_id=${libraryRow.id}`)
      .then(r => r.ok ? r.json() : { listing: null })
      .then(data => setListing(data.listing || null))
      .catch(() => setListing(null))
  }, [libraryRow.id])

  // Fetch price preview when picker is open
  useEffect(() => {
    if (!showPicker || !libraryRow.scryfall_id) return
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
  }, [showPicker, libraryRow.scryfall_id, libraryRow.foil])

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
        body: JSON.stringify({ library_card_id: libraryRow.id, multiplier, duration_hours: durationHours }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
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
      if (!res.ok) throw new Error('Failed')
      const data = await res.json()
      setListing(data.listing || { ...listing, status: 'active', multiplier })
      setShowPicker(false)
      setIsRelist(false)
      toast('Card relisted on Bazaar', 'success')
    } catch {
      toast('Failed to relist card', 'error')
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
      <div className="flex items-center gap-2 text-xs text-gray-600 pt-2 border-t border-gray-700">
        <Loader2 className="w-3 h-3 animate-spin" /> Checking bazaar status...
      </div>
    )
  }

  const isExpired = listing && (
    listing.status === 'expired' ||
    (listing.expires_at && new Date(listing.expires_at) <= new Date())
  )

  // Not listed yet — show a "List on Bazaar" button (not the picker right away)
  if (!listing && !showPicker) {
    return (
      <div className="pt-2 border-t border-gray-700">
        <button
          onClick={() => {
            if (!hasPhoto) { setPhotoRequired(true) } else { setShowPicker(true) }
          }}
          className="flex items-center justify-center gap-2 w-full py-1.5 border border-gray-700 hover:border-dbb-accent text-gray-400 hover:text-dbb-accent rounded-lg text-xs font-medium transition-colors"
        >
          <Tag className="w-3 h-3" />
          List on Bazaar
        </button>
        {photoRequired && !hasPhoto && (
          <p className="text-xs text-amber-400 mt-1.5">
            A card photo is required before listing. Take a photo above first.
          </p>
        )}
      </div>
    )
  }

  // Show picker for new listing or relist
  if (!listing || (showPicker && !isExpired) || (isRelist && isExpired)) {
    const isRelisting = isExpired && isRelist

    // Photo gate — shouldn't happen (button above checks), but block at render level too
    if (!hasPhoto) {
      return (
        <div className="pt-2 border-t border-gray-700 space-y-2">
          <p className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1.5">
            A card photo is required before listing. Please take a photo above.
          </p>
          <button
            onClick={() => { setShowPicker(false); setIsRelist(false); setPhotoRequired(false) }}
            className="text-xs text-gray-500 hover:text-white transition-colors"
          >
            Cancel
          </button>
        </div>
      )
    }

    return (
      <div className="pt-2 border-t border-gray-700">
        <div className="space-y-3">
          <p className="text-xs text-gray-400 font-medium">
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
                        : 'border-gray-700 text-gray-400 hover:border-dbb-accent/50'
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
                      : 'border-gray-700 text-gray-500 hover:border-gray-500'
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
              className="px-3 py-1.5 text-sm text-gray-400 hover:text-white transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Expired listing state
  if (isExpired) {
    return (
      <div className="pt-2 border-t border-gray-700">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1 text-xs font-medium text-orange-400 bg-orange-500/10 border border-orange-500/30 rounded px-2 py-0.5">
            <Tag className="w-3 h-3" /> Listing Expired
          </span>
          <button
            onClick={() => { setIsRelist(true); setMultiplier(Number(listing.multiplier) || 2.5) }}
            className="text-xs text-dbb-accent hover:text-red-400 transition-colors"
          >
            Relist
          </button>
        </div>
      </div>
    )
  }

  // Active listing state
  const listedAgo = listing.created_at ? relativeTime(listing.created_at, false) : null
  const expiresIn = listing.expires_at ? relativeTime(listing.expires_at, true) : null

  return (
    <div className="pt-2 border-t border-gray-700">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1 text-xs font-medium text-green-400 bg-green-500/10 border border-green-500/30 rounded px-2 py-0.5">
            <Tag className="w-3 h-3" /> Listed on Bazaar
          </span>
          <span className="text-xs text-gray-500">×{listing.multiplier}</span>
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

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Escape') onClose()
  }, [onClose])

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

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

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-dbb-primary border border-dbb-accent/30 rounded-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <h2 className="text-lg font-bold text-white truncate pr-4">
            {ci?.name || cardData?.name || 'Card Details'}
          </h2>
          <button onClick={onClose} className="p-1 hover:text-dbb-accent transition-colors flex-shrink-0">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex flex-col sm:flex-row gap-4 p-4">
          {/* Image */}
          <div className="sm:w-48 flex-shrink-0">
            {loading ? (
              <div className="aspect-[2/3] skeleton rounded-lg" />
            ) : imageUrl ? (
              <img
                src={imageUrl}
                alt={ci?.name || 'Card'}
                className="w-full rounded-lg shadow-lg"
              />
            ) : (
              <div className="aspect-[2/3] bg-dbb-secondary rounded-lg flex items-center justify-center">
                <span className="text-gray-500 text-sm text-center p-2">{ci?.name}</span>
              </div>
            )}
          </div>

          {/* Details + edit */}
          <div className="flex-1 flex flex-col gap-4">
            {/* Card metadata */}
            <div className="text-sm text-gray-400 space-y-1">
              {(ci?.set_name || cardData?.set_name) && (
                <div><span className="text-gray-500">Set:</span> {ci?.set_name || cardData?.set_name}</div>
              )}
              {(ci?.rarity || cardData?.rarity) && (
                <div><span className="text-gray-500">Rarity:</span> {ci?.rarity || cardData?.rarity}</div>
              )}
              {(ci?.type_line || cardData?.type_line) && (
                <div><span className="text-gray-500">Type:</span> {ci?.type_line || cardData?.type_line}</div>
              )}
              {cardData?.oracle_text && (
                <div className="mt-2 p-2 bg-dbb-secondary rounded text-xs leading-relaxed whitespace-pre-line">
                  {cardData.oracle_text}
                </div>
              )}
            </div>

            {/* Editable fields */}
            <div className="space-y-3">
              {/* Quantity */}
              <div className="flex items-center gap-3">
                <label className="text-sm text-gray-400 w-24">Quantity</label>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setQuantity(q => Math.max(1, q - 1))}
                    className="p-1 rounded bg-dbb-secondary hover:bg-gray-700 transition-colors"
                  >
                    <Minus className="w-4 h-4" />
                  </button>
                  <input
                    type="number"
                    min="1"
                    max="9999"
                    value={quantity}
                    onChange={(e) => setQuantity(Math.max(1, Math.min(9999, parseInt(e.target.value) || 1)))}
                    className="w-16 text-center bg-dbb-secondary border border-gray-700 rounded px-2 py-1 text-sm focus:border-dbb-accent focus:outline-none"
                  />
                  <button
                    onClick={() => setQuantity(q => Math.min(9999, q + 1))}
                    className="p-1 rounded bg-dbb-secondary hover:bg-gray-700 transition-colors"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Condition */}
              <div className="flex items-center gap-3">
                <label className="text-sm text-gray-400 w-24">Condition</label>
                <select
                  value={condition}
                  onChange={(e) => setCondition(e.target.value)}
                  className="bg-dbb-secondary border border-gray-700 rounded px-3 py-1.5 text-sm focus:border-dbb-accent focus:outline-none"
                >
                  {CONDITIONS.map(c => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>

              {/* Foil */}
              <div className="flex items-center gap-3">
                <label className="text-sm text-gray-400 w-24">Finish</label>
                <select
                  value={foil}
                  onChange={(e) => setFoil(e.target.value)}
                  className="bg-dbb-secondary border border-gray-700 rounded px-3 py-1.5 text-sm focus:border-dbb-accent focus:outline-none"
                >
                  {FOILS.map(f => (
                    <option key={f} value={f}>{f.charAt(0).toUpperCase() + f.slice(1)}</option>
                  ))}
                </select>
              </div>

              {/* Star */}
              <div className="flex items-center gap-3">
                <label className="text-sm text-gray-400 w-24">Starred</label>
                <button
                  onClick={() => setStarred(s => !s)}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded border transition-colors ${
                    starred
                      ? 'border-yellow-500 bg-yellow-500/10 text-yellow-400'
                      : 'border-gray-700 text-gray-500 hover:border-yellow-500/50'
                  }`}
                >
                  <Star className="w-4 h-4" fill={starred ? 'currentColor' : 'none'} />
                  {starred ? 'Starred' : 'Star this card'}
                </button>
              </div>
            </div>

            {/* Card photo */}
            <PhotoSection
              libraryRow={libraryRow}
              listing={currentListing}
              onPhotoChange={setHasPhoto}
            />

            {/* Bazaar listing */}
            <ListingSection libraryRow={libraryRow} hasPhoto={hasPhoto} />

            {/* Actions */}
            <div className="flex items-center justify-between pt-2 border-t border-gray-700">
              {!confirmDelete ? (
                <button
                  onClick={() => setConfirmDelete(true)}
                  className="flex items-center gap-2 text-sm text-red-400 hover:text-red-300 transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                  Remove
                </button>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-red-400">Remove from library?</span>
                  <button
                    onClick={handleDelete}
                    disabled={deleting}
                    className="text-sm bg-red-700 hover:bg-red-600 px-3 py-1 rounded transition-colors disabled:opacity-50"
                  >
                    {deleting ? 'Removing...' : 'Confirm'}
                  </button>
                  <button
                    onClick={() => setConfirmDelete(false)}
                    className="text-sm text-gray-400 hover:text-white transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              )}

              <div className="flex items-center gap-2">
                <button
                  onClick={onClose}
                  className="px-4 py-1.5 text-sm text-gray-400 hover:text-white transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="px-4 py-1.5 text-sm bg-dbb-accent hover:bg-red-600 text-white rounded transition-colors disabled:opacity-50"
                >
                  {saving ? 'Saving...' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
