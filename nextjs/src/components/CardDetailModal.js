'use client'

import { useState, useEffect, useRef } from 'react'
import { getCardById, getImageUrl } from '@/lib/scryfall'
import { useToast } from '@/components/Toast'
import FacebookSaleImage from '@/components/FacebookSaleImage'
import PhotoSection from '@/components/library-detail/PhotoSection'
import ListingSection from '@/components/library-detail/ListingSection'
import { X, Star, Minus, Plus, Trash2 } from 'lucide-react'

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
