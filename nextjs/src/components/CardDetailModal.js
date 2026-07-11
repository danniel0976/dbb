'use client'

import { useState, useEffect, useCallback } from 'react'
import { getCardById, getImageUrl } from '@/lib/scryfall'
import { useToast } from '@/components/Toast'
import { X, Star, Minus, Plus, Trash2, Tag, Loader2 } from 'lucide-react'

const MULTIPLIERS = [2.5, 2.8, 3.0]

function ListingSection({ libraryRow }) {
  const { toast } = useToast()
  const [listing, setListing] = useState(undefined) // undefined = loading, null = not listed
  const [showPicker, setShowPicker] = useState(false)
  const [multiplier, setMultiplier] = useState(2.5)
  const [pricePreview, setPricePreview] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  // Load listing status
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
        body: JSON.stringify({ library_card_id: libraryRow.id, multiplier }),
      })
      if (!res.ok) throw new Error('Failed')
      const data = await res.json()
      setListing(data.listings?.[0] || { multiplier })
      setShowPicker(false)
      toast('Card listed on Bazaar', 'success')
    } catch {
      toast('Failed to list card', 'error')
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

  if (listing) {
    const myr = computeMyr(pricePreview, Number(listing.multiplier))
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
      </div>
    )
  }

  return (
    <div className="pt-2 border-t border-gray-700">
      {!showPicker ? (
        <button
          onClick={() => setShowPicker(true)}
          className="flex items-center gap-1.5 text-sm text-dbb-accent hover:text-red-400 transition-colors"
        >
          <Tag className="w-4 h-4" /> List on Bazaar
        </button>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-gray-400 font-medium">Choose multiplier</p>
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
                  {myr != null && (
                    <div className="text-xs text-gray-500 font-normal">RM {myr.toFixed(2)}</div>
                  )}
                  {pricePreview == null && (
                    <div className="text-xs text-gray-600 font-normal">—</div>
                  )}
                </button>
              )
            })}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleList}
              disabled={submitting}
              className="flex-1 py-1.5 text-sm bg-dbb-accent hover:bg-red-600 text-white rounded-lg transition-colors disabled:opacity-50"
            >
              {submitting ? 'Listing...' : 'Confirm Listing'}
            </button>
            <button
              onClick={() => setShowPicker(false)}
              className="px-3 py-1.5 text-sm text-gray-400 hover:text-white transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
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

  const [quantity, setQuantity] = useState(libraryRow.quantity)
  const [condition, setCondition] = useState(libraryRow.condition)
  const [foil, setFoil] = useState(libraryRow.foil)
  const [starred, setStarred] = useState(libraryRow.starred)

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

            {/* Bazaar listing */}
            <ListingSection libraryRow={libraryRow} />

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
