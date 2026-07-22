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

const DETAIL_TABS = [
  { id: 'details', label: 'Details', testId: 'library-detail-tab-details' },
  { id: 'photo', label: 'Condition Photo', testId: 'library-detail-tab-photo' },
  { id: 'fbsale', label: 'Facebook Sale', testId: 'library-detail-tab-fbsale' },
]

// idPrefix namespaces the ids per breakpoint tree — CardDetailModal renders
// both the desktop panel and mobile sheet simultaneously (only one visible
// per CSS breakpoint, an established pattern in this file), so a bare id
// would collide as a duplicate DOM id between the two trees.
function DetailTabBar({ activeTab, onChange, idPrefix }) {
  return (
    <div role="tablist" aria-label="Card detail sections" className="flex shrink-0 items-center gap-1 p-1 h-11 rounded-full bg-gray-100 mx-4 mt-3">
      {DETAIL_TABS.map(tab => (
        <button
          key={tab.id}
          role="tab"
          id={`${idPrefix}-tabbtn-${tab.id}`}
          data-testid={tab.testId}
          aria-selected={activeTab === tab.id}
          aria-controls={`${idPrefix}-tabpanel-${tab.id}`}
          onClick={() => onChange(tab.id)}
          className={`flex-1 h-full rounded-full text-dbb-xs font-medium transition-colors spring-press ${
            activeTab === tab.id ? 'bg-white text-gray-900 shadow-dbb-sm' : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}

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
  const [activeTab, setActiveTab] = useState('details')

  const sheetRef = useRef(null)
  const closeBtnRef = useRef(null)
  const triggerCardRef = useRef(null)

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

  // Capture the triggering card so focus can return to it on close, and
  // autofocus whichever close button is actually visible (desktop panel vs
  // mobile sheet render simultaneously, toggled by CSS breakpoint).
  const assignCloseBtnRef = (el) => {
    if (el && el.offsetParent !== null) closeBtnRef.current = el
  }

  useEffect(() => {
    triggerCardRef.current = document.activeElement
    closeBtnRef.current?.focus()
  }, [])

  function handleClose() {
    if (triggerCardRef.current && triggerCardRef.current.focus) {
      triggerCardRef.current.focus()
    }
    onClose()
  }

  // Behavioral primitives: Escape-to-close, focus trap, and scroll lock while
  // open (matches the established FilterSheet pattern from Pass 4 tooling).
  // The focus trap is scoped to the wrapper containing both the desktop
  // panel and mobile sheet trees; only the currently visible tree's
  // elements (offsetParent !== null) participate, since both trees exist
  // in the DOM at once and only one is shown per breakpoint.
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        handleClose()
        return
      }
      if (e.key !== 'Tab') return
      const all = sheetRef.current?.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
      const focusables = all ? Array.from(all).filter(el => el.offsetParent !== null) : []
      if (focusables.length === 0) return
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
  }, [])

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
      handleClose()
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
      handleClose()
    } catch {
      toast('Failed to delete card', 'error')
    } finally {
      setDeleting(false)
      setConfirmDelete(false)
    }
  }

  const title = ci?.name || cardData?.name || 'Card Details'

  const metadataBlock = (
    <div className="space-y-1 text-dbb-sm text-gray-600">
      {(ci?.set_name || cardData?.set_name) && (
        <div><span className="text-gray-400">Set</span> · {ci?.set_name || cardData?.set_name}</div>
      )}
      {(ci?.rarity || cardData?.rarity) && (
        <div><span className="text-gray-400">Rarity</span> · {ci?.rarity || cardData?.rarity}</div>
      )}
      {(ci?.type_line || cardData?.type_line) && (
        <div><span className="text-gray-400">Type</span> · {ci?.type_line || cardData?.type_line}</div>
      )}
      {cardData?.oracle_text && (
        <div className="mt-2 whitespace-pre-line rounded-dbb-md bg-gray-50 p-3 text-dbb-xs leading-relaxed text-gray-600">
          {cardData.oracle_text}
        </div>
      )}
    </div>
  )

  const editableFields = (
    <div className="space-y-3">
      {/* Quantity — 44px touch targets */}
      <div className="flex items-center gap-3">
        <label className="w-24 text-dbb-sm text-gray-600">Quantity</label>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setQuantity(q => Math.max(1, q - 1))}
            aria-label="Decrease quantity"
            className="flex h-11 w-11 items-center justify-center rounded-dbb-md bg-gray-100 transition-colors hover:bg-gray-200"
          >
            <Minus className="h-4 w-4" />
          </button>
          <input
            type="number"
            min="1"
            max="9999"
            value={quantity}
            onChange={(e) => setQuantity(Math.max(1, Math.min(9999, parseInt(e.target.value) || 1)))}
            className="h-11 w-16 rounded-dbb-md bg-white text-center text-dbb-sm focus:outline-none focus:ring-2 focus:ring-dbb-accent/40"
          />
          <button
            onClick={() => setQuantity(q => Math.min(9999, q + 1))}
            aria-label="Increase quantity"
            className="flex h-11 w-11 items-center justify-center rounded-dbb-md bg-gray-100 transition-colors hover:bg-gray-200"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Condition */}
      <div className="flex items-center gap-3">
        <label className="w-24 text-dbb-sm text-gray-600">Condition</label>
        <select
          value={condition}
          onChange={(e) => setCondition(e.target.value)}
          className="h-11 rounded-dbb-md bg-gray-100 px-3 text-dbb-sm focus:outline-none focus:ring-2 focus:ring-dbb-accent/40"
        >
          {CONDITIONS.map(c => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </div>

      {/* Foil */}
      <div className="flex items-center gap-3">
        <label className="w-24 text-dbb-sm text-gray-600">Finish</label>
        <select
          value={foil}
          onChange={(e) => setFoil(e.target.value)}
          className="h-11 rounded-dbb-md bg-gray-100 px-3 text-dbb-sm focus:outline-none focus:ring-2 focus:ring-dbb-accent/40"
        >
          {FOILS.map(f => (
            <option key={f} value={f}>{f.charAt(0).toUpperCase() + f.slice(1)}</option>
          ))}
        </select>
      </div>

      {/* Star */}
      <div className="flex items-center gap-3">
        <label className="w-24 text-dbb-sm text-gray-600">Starred</label>
        <button
          onClick={() => setStarred(s => !s)}
          aria-pressed={starred}
          className={`flex h-11 items-center gap-2 rounded-dbb-md px-4 text-dbb-sm font-medium transition-colors ${
            starred
              ? 'bg-yellow-500/10 text-yellow-500'
              : 'bg-gray-100 text-gray-500 hover:text-yellow-500'
          }`}
        >
          <Star className="h-4 w-4" fill={starred ? 'currentColor' : 'none'} />
          {starred ? 'Starred' : 'Star this card'}
        </button>
      </div>
    </div>
  )

  const moreOptions = (
    <div className="pt-1">
      {!showMore ? (
        <button
          onClick={() => setShowMore(true)}
          className="text-dbb-sm text-gray-500 transition-colors hover:text-gray-900"
        >
          More options
        </button>
      ) : (
        <div className="rounded-dbb-md bg-gray-50 p-3">
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
                className="px-2 py-1.5 text-dbb-sm text-gray-500 transition-colors hover:text-gray-900"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )

  const artBlock = (
    <div className="w-full flex justify-center">
      {loading ? (
        <div className="aspect-[5/7] max-h-[32vh] w-auto skeleton rounded-dbb-lg" />
      ) : imageUrl ? (
        <img
          src={imageUrl}
          alt={ci?.name || 'Card'}
          className="max-h-[32vh] w-auto rounded-dbb-lg object-contain shadow-dbb-md"
        />
      ) : (
        <div className="flex aspect-[5/7] max-h-[32vh] w-auto items-center justify-center rounded-dbb-lg bg-gray-100">
          <span className="p-2 text-center text-dbb-sm text-gray-500">{ci?.name}</span>
        </div>
      )}
    </div>
  )

  // Tab "Details": art + metadata + editable fields + listing controls + more
  // options. ListingSection lives here rather than a separate tab — it's
  // edit-adjacent (list/unlist/relist) and has no natural home of its own.
  const detailsTab = (
    <div className="space-y-5">
      {artBlock}
      {metadataBlock}
      {editableFields}
      <ListingSection
        libraryRow={libraryRow}
        hasPhoto={hasPhoto}
        onRequirePhoto={(retry) => {
          if (retry) setPendingPhotoAction(() => retry)
          setForcePhotoCamera(true)
          setActiveTab('photo')
        }}
      />
      {moreOptions}
    </div>
  )

  // Tab "Condition Photo"
  const photoTab = (
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
  )

  // Tab "Facebook Sale"
  const fbSaleTab = (
    <FacebookSaleImage
      libraryRow={libraryRow}
      hasPhoto={hasPhoto}
      hasUnsavedDetails={condition !== libraryRow.condition || foil !== libraryRow.foil}
    />
  )

  // All 3 panels stay mounted (just visibility-toggled) rather than
  // unmounting on tab switch — PhotoSection owns `hasPhoto` via
  // onPhotoChange, and ListingSection (in the Details tab) needs that value
  // correct from the moment the modal opens, not only after the user has
  // visited the Photo tab at least once.
  // idPrefix namespaces ids per breakpoint tree — see the note on DetailTabBar.
  const renderTabContent = (idPrefix) => (
    <>
      <div
        role="tabpanel"
        id={`${idPrefix}-tabpanel-details`}
        data-testid="library-detail-tabpanel-details"
        aria-labelledby={`${idPrefix}-tabbtn-details`}
        className={activeTab === 'details' ? '' : 'hidden'}
      >
        {detailsTab}
      </div>
      <div
        role="tabpanel"
        id={`${idPrefix}-tabpanel-photo`}
        data-testid="library-detail-tabpanel-photo"
        aria-labelledby={`${idPrefix}-tabbtn-photo`}
        className={activeTab === 'photo' ? '' : 'hidden'}
      >
        {photoTab}
      </div>
      <div
        role="tabpanel"
        id={`${idPrefix}-tabpanel-fbsale`}
        data-testid="library-detail-tabpanel-fbsale"
        aria-labelledby={`${idPrefix}-tabbtn-fbsale`}
        className={activeTab === 'fbsale' ? '' : 'hidden'}
      >
        {fbSaleTab}
      </div>
    </>
  )

  const footer = (
    <>
      <button
        onClick={handleClose}
        className="min-h-[44px] rounded-dbb-md px-4 text-dbb-sm text-gray-600 transition-colors hover:bg-dbb-accent/10 hover:text-dbb-accent spring-press"
      >
        Cancel
      </button>
      <button
        onClick={handleSave}
        disabled={saving}
        className="min-h-[44px] flex-1 rounded-dbb-md bg-dbb-accent px-4 text-dbb-sm font-semibold text-white transition-colors hover:bg-dbb-accent-hov disabled:opacity-50 spring-press"
      >
        {saving ? 'Saving...' : 'Save changes'}
      </button>
    </>
  )

  return (
    <div ref={sheetRef}>
      {/* Desktop: right-side non-blocking inspector panel (≥1024px) */}
      <div className="hidden lg:block fixed inset-0 z-40">
        {/* Backdrop - click to close */}
        <div
          className="absolute inset-0 bg-black/50"
          onClick={handleClose}
          aria-hidden="true"
        />

        {/* Inspector panel */}
        <div
          data-testid="library-detail-panel"
          role="dialog"
          aria-modal="true"
          aria-label={title}
          className="absolute top-0 right-0 h-full w-[480px] max-w-[90vw] bg-white border-l border-gray-200 shadow-[-12px_0_40px_-8px_rgba(0,0,0,0.35)] flex flex-col"
        >
          {/* Header — glass chrome */}
          <div className="dbb-glass-chrome flex shrink-0 items-center justify-between gap-3 px-4 py-3">
            <h2 className="truncate text-dbb-lg font-semibold tracking-heading text-gray-900">{title}</h2>
            <button
              ref={assignCloseBtnRef}
              onClick={handleClose}
              aria-label="Close"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-gray-500 transition-colors hover:bg-dbb-accent/10 hover:text-dbb-accent spring-press"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <DetailTabBar activeTab={activeTab} onChange={setActiveTab} idPrefix="library-detail-panel" />

          {/* Scrollable tabbed content */}
          <div className="flex-1 overflow-y-auto overscroll-contain">
            <div className="p-4">
              {renderTabContent('library-detail-panel')}
            </div>
          </div>

          {/* Sticky footer — glass chrome top edge */}
          <div
            className="dbb-glass-chrome flex shrink-0 items-center gap-3 px-4 py-3"
            style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
          >
            {footer}
          </div>
        </div>
      </div>

      {/* Mobile: full-screen overlay (≤1023px) */}
      <div
        data-testid="library-detail-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="lg:hidden fixed inset-0 z-50 flex flex-col bg-white"
      >
        {/* Header — glass chrome */}
        <div className="dbb-glass-chrome flex shrink-0 items-center justify-between gap-3 px-4 py-3">
          <h2 className="truncate text-dbb-lg font-semibold tracking-heading text-gray-900">{title}</h2>
          <button
            ref={assignCloseBtnRef}
            onClick={handleClose}
            aria-label="Close"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-gray-500 transition-colors hover:bg-dbb-accent/10 hover:text-dbb-accent spring-press"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <DetailTabBar activeTab={activeTab} onChange={setActiveTab} idPrefix="library-detail-sheet" />

        {/* Scrollable tabbed content */}
        <div className="flex-1 overflow-y-auto overscroll-contain">
          <div className="p-4">
            {renderTabContent('library-detail-sheet')}
          </div>
        </div>

        {/* Sticky footer — glass chrome top edge */}
        <div
          className="dbb-glass-chrome flex shrink-0 items-center gap-3 px-4 py-3"
          style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
        >
          {footer}
        </div>
      </div>
    </div>
  )
}
