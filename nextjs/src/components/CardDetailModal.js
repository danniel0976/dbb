'use client'

import { useState, useEffect, useRef } from 'react'
import { getCardById, getImageUrl } from '@/lib/scryfall'
import { useToast } from '@/components/Toast'
import FacebookSaleImage from '@/components/FacebookSaleImage'
import PhotoSection from '@/components/library-detail/PhotoSection'
import ListingSection from '@/components/library-detail/ListingSection'
import {
  OWNER_LISTING_STATUS,
  PRICE_STATUS,
  buildPriceSummary,
  readCkdUsd,
} from '@/components/library-detail/priceSummary'
import { X, Star, Minus, Plus, Trash2, Check, Loader2 } from 'lucide-react'

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

// Header — title + a first-layer Remove action (distinct red icon button,
// separate from Close) alongside Close itself. Remove used to live two taps
// deep behind a "More options" disclosure at the bottom of the Details tab;
// per UAT feedback it needed to be immediately discoverable without burying
// the destructive action, while still requiring an explicit confirm step
// (RemoveConfirmBar below) before anything is deleted.
function ModalHeader({ idPrefix, title, assignCloseBtnRef, onRemoveClick, onClose }) {
  return (
    <div className="dbb-glass-chrome flex shrink-0 items-center justify-between gap-3 px-4 py-3">
      <h2 className="truncate text-dbb-lg font-semibold tracking-heading text-gray-900">{title}</h2>
      {/* flex-row-reverse keeps Close visually in the far corner (Remove to
          its left) while Close stays FIRST in DOM/tab order — this modal
          autofocuses Close on open and the focus trap treats it as the
          panel's first focusable element, so DOM order has to stay stable
          even though Remove is now visually first. */}
      <div className="flex shrink-0 flex-row-reverse items-center gap-1">
        <button
          ref={assignCloseBtnRef}
          onClick={onClose}
          aria-label="Close"
          className="flex h-11 w-11 items-center justify-center rounded-full text-gray-500 transition-colors hover:bg-dbb-accent/10 hover:text-dbb-accent spring-press"
        >
          <X className="h-5 w-5" />
        </button>
        <button
          onClick={onRemoveClick}
          data-testid={`${idPrefix}-remove-btn`}
          aria-label="Remove from library"
          title="Remove from library"
          className="flex h-11 w-11 items-center justify-center rounded-full text-red-500 transition-colors hover:bg-red-500/10 spring-press"
        >
          <Trash2 className="h-5 w-5" />
        </button>
      </div>
    </div>
  )
}

// Confirmation banner shown directly under the header once Remove is
// tapped — first-layer and impossible to miss, but still a deliberate
// second step before the destructive delete actually fires.
function RemoveConfirmBar({ idPrefix, deleting, onConfirm, onCancel }) {
  return (
    <div
      data-testid={`${idPrefix}-remove-confirm`}
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-red-200 bg-red-50 px-4 py-2.5"
    >
      <span className="text-dbb-sm font-medium text-red-600">Remove this card from your library?</span>
      <div className="ml-auto flex items-center gap-2">
        <button
          onClick={onCancel}
          className="rounded-dbb-md px-3 py-1.5 text-dbb-sm text-gray-600 transition-colors hover:bg-black/5"
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          disabled={deleting}
          className="rounded-dbb-md bg-red-600 px-3 py-1.5 text-dbb-sm font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-50"
        >
          {deleting ? 'Removing...' : 'Remove'}
        </button>
      </div>
    </div>
  )
}

// Price summary — the CardKingdom USD baseline and multiplier-adjusted MYR
// amount shown together at the top of the Details tab. An active listing makes
// that amount authoritative; otherwise it is explicitly a preview.
// Rendered in both the desktop and mobile trees, so it carries no `id`
// attributes (see the note on DetailTabBar); state lives in the parent and both
// copies therefore stay in sync.
function PriceSummary({ status, ckdUsd, listingState, now, finish, finishIsUnsaved }) {
  const summary = buildPriceSummary({
    status,
    ckdUsd,
    listingStatus: listingState.status,
    listing: listingState.listing,
    now,
  })

  return (
    <div
      data-testid="library-detail-price-summary"
      role="group"
      aria-label="Card pricing"
      className="rounded-dbb-lg border border-gray-200 bg-gray-50 p-3 space-y-3"
    >
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="text-dbb-xs uppercase tracking-wide text-gray-400">CardKingdom baseline</p>
          {summary.status === PRICE_STATUS.READY ? (
            <p data-testid="library-detail-price-usd" className="text-dbb-sm font-medium text-gray-600">
              {summary.baselineLabel} <span className="text-gray-400">USD</span>
            </p>
          ) : (
            <p data-testid="library-detail-price-usd" className="text-dbb-sm text-gray-500">—</p>
          )}
        </div>
        <div className="min-w-0 text-right">
          <p data-testid="library-detail-price-heading" className="text-dbb-xs uppercase tracking-wide text-gray-400">
            {summary.multiplier == null ? summary.priceLabel : `${summary.priceLabel} · ×${summary.multiplier}`}
          </p>
          {summary.sellStatus === PRICE_STATUS.READY ? (
            <p
              data-testid="library-detail-price-myr"
              className="text-dbb-lg font-semibold tracking-heading text-gray-900"
            >
              {summary.sellLabel}
            </p>
          ) : (
            <p data-testid="library-detail-price-myr" className="text-dbb-lg font-semibold text-gray-400">—</p>
          )}
        </div>
      </div>

      {/* Honest non-ready states — never substitute another price source. */}
      {summary.status === PRICE_STATUS.LOADING && (
        <p data-testid="library-detail-price-note" className="flex items-center gap-1.5 text-dbb-xs text-gray-500">
          <Loader2 className="h-3 w-3 animate-spin" /> Loading CardKingdom price...
        </p>
      )}
      {summary.status === PRICE_STATUS.UNAVAILABLE && (
        <p data-testid="library-detail-price-note" className="text-dbb-xs text-gray-500">
          No CardKingdom price for this printing.
        </p>
      )}
      {summary.status === PRICE_STATUS.ERROR && (
        <p data-testid="library-detail-price-note" className="text-dbb-xs text-amber-600">
          Could not load the CardKingdom price. Try again later.
        </p>
      )}
      {summary.status === PRICE_STATUS.READY && summary.sellStatus === PRICE_STATUS.UNAVAILABLE && (
        <p data-testid="library-detail-price-note" className="text-dbb-xs text-gray-500">
          No positive MYR price is available for this printing.
        </p>
      )}
      {summary.status === PRICE_STATUS.READY && summary.sellStatus === PRICE_STATUS.LOADING && (
        <p data-testid="library-detail-listing-note" className="flex items-center gap-1.5 text-dbb-xs text-gray-500">
          <Loader2 className="h-3 w-3 animate-spin" /> Checking Bazaar listing status...
        </p>
      )}
      {summary.status === PRICE_STATUS.READY && summary.sellStatus === PRICE_STATUS.ERROR && (
        <p data-testid="library-detail-listing-note" className="text-dbb-xs text-amber-600">
          Could not confirm Bazaar listing status. Price preview unavailable.
        </p>
      )}
      {summary.status === PRICE_STATUS.READY && summary.priceLabel === 'Price preview' && (
        <p data-testid="library-detail-price-preview-note" className="text-dbb-xs text-gray-500">
          Preview only — choose a multiplier when listing this card.
        </p>
      )}

      {/* The baseline is looked up for the finish that is actually saved — the
          same one listing and checkout price against — so an unsaved Finish
          edit must not silently look like it has been repriced. */}
      {finishIsUnsaved && (
        <p data-testid="library-detail-price-finish-note" className="text-dbb-xs text-gray-500">
          Priced for the saved finish ({finish}). Save changes to reprice.
        </p>
      )}
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
  const [ownerListingState, setOwnerListingState] = useState({
    status: OWNER_LISTING_STATUS.LOADING,
    listing: null,
  })
  const [listingClock, setListingClock] = useState(() => Date.now())
  const [forcePhotoCamera, setForcePhotoCamera] = useState(false)
  const [pendingPhotoAction, setPendingPhotoAction] = useState(null)
  const [activeTab, setActiveTab] = useState('details')
  const [justSaved, setJustSaved] = useState(false)
  const [ckdUsd, setCkdUsd] = useState(null)
  const [priceStatus, setPriceStatus] = useState(PRICE_STATUS.LOADING)

  const sheetRef = useRef(null)
  const closeBtnRef = useRef(null)
  const triggerCardRef = useRef(null)

  const [quantity, setQuantity] = useState(libraryRow.quantity)
  const [condition, setCondition] = useState(libraryRow.condition)
  const [foil, setFoil] = useState(libraryRow.foil)
  const [starred, setStarred] = useState(libraryRow.starred)

  const handleListingChange = (listing) => {
    if (listing == null) {
      setOwnerListingState({ status: OWNER_LISTING_STATUS.NONE, listing: null })
    } else if (listing?.id) {
      setOwnerListingState({ status: OWNER_LISTING_STATUS.READY, listing })
    } else {
      setOwnerListingState({ status: OWNER_LISTING_STATUS.ERROR, listing: null })
    }
  }

  const handleListingUncertain = () => {
    setOwnerListingState({ status: OWNER_LISTING_STATUS.ERROR, listing: null })
  }

  // Load listing status for PhotoSection and the price summary. HTTP, JSON and
  // malformed-payload failures remain errors; only an explicit null confirms
  // that the owner has no listing for this card.
  useEffect(() => {
    let cancelled = false
    setOwnerListingState({ status: OWNER_LISTING_STATUS.LOADING, listing: null })
    fetch(`/api/listings?library_card_id=${libraryRow.id}`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`Listing request failed: ${r.status}`)))
      .then(data => {
        if (cancelled) return
        if (!Object.prototype.hasOwnProperty.call(data, 'listing')) {
          throw new Error('Listing response did not include listing state')
        }
        handleListingChange(data.listing)
      })
      .catch(() => {
        if (!cancelled) {
          setOwnerListingState({ status: OWNER_LISTING_STATUS.ERROR, listing: null })
        }
      })
    return () => { cancelled = true }
  }, [libraryRow.id])

  // An open modal must stop calling a listing authoritative at expires_at even
  // when nothing else changes. Long delays are chunked below the browser timer
  // ceiling; the final tick advances the pure summary's clock and rerenders the
  // listing controls at the same boundary.
  useEffect(() => {
    setListingClock(Date.now())
    const listing = ownerListingState.listing
    if (ownerListingState.status !== OWNER_LISTING_STATUS.READY ||
        listing?.status !== 'active' || !listing.expires_at) return undefined
    const expiresAt = Date.parse(listing.expires_at)
    if (!Number.isFinite(expiresAt)) return undefined

    let timerId
    const scheduleExpiryBoundary = () => {
      const remaining = expiresAt - Date.now()
      if (remaining <= 0) {
        setListingClock(Date.now())
        return
      }
      timerId = setTimeout(scheduleExpiryBoundary, Math.min(remaining + 25, 2_147_483_647))
    }
    scheduleExpiryBoundary()
    return () => clearTimeout(timerId)
  }, [
    ownerListingState.status,
    ownerListingState.listing?.id,
    ownerListingState.listing?.status,
    ownerListingState.listing?.expires_at,
  ])

  const currentListing = ownerListingState.status === OWNER_LISTING_STATUS.READY
    ? ownerListingState.listing
    : undefined

  const ci = libraryRow.card_index
  const storedImage = ci?.image_uris?.normal || ci?.image_uris?.small || null

  // Saved finish, not the in-progress edit: the listing and checkout paths
  // price the persisted row, so the summary has to look up the same key.
  const pricedFoil = libraryRow.foil || 'normal'

  // CKD USD baseline from the shared pricing cache (same endpoint and cache the
  // listing picker uses). Failure and "no cached price" are distinct states and
  // both are surfaced as-is — no Scryfall or other fallback price.
  useEffect(() => {
    if (!libraryRow.scryfall_id) {
      setPriceStatus(PRICE_STATUS.UNAVAILABLE)
      return
    }
    let cancelled = false
    setPriceStatus(PRICE_STATUS.LOADING)
    fetch('/api/pricing/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ scryfall_id: libraryRow.scryfall_id, foil: pricedFoil }] }),
    })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`Pricing request failed: ${r.status}`)))
      .then(data => {
        if (cancelled) return
        const usd = readCkdUsd(data, libraryRow.scryfall_id, pricedFoil)
        setCkdUsd(usd)
        setPriceStatus(usd == null ? PRICE_STATUS.UNAVAILABLE : PRICE_STATUS.READY)
      })
      .catch(() => {
        if (cancelled) return
        setCkdUsd(null)
        setPriceStatus(PRICE_STATUS.ERROR)
      })
    return () => { cancelled = true }
  }, [libraryRow.scryfall_id, pricedFoil])

  useEffect(() => {
    // Preserve current-main behavior: catalog-backed synthetic/local cards
    // render their stored image without requiring a valid Scryfall ID.
    if (storedImage) {
      setImageUrl(storedImage)
      setLoading(false)
      return
    }

    getCardById(libraryRow.scryfall_id)
      .then(data => {
        setCardData(data)
        setImageUrl(getImageUrl(data))
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [libraryRow.scryfall_id, storedImage])

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
      setSaving(false)
      // A brief in-panel "Saved" state before closing — the global toast
      // alone wasn't a reliable enough confirmation (on mobile it renders
      // behind/over the fixed bottom nav bar), so this gives a guaranteed-
      // visible success signal inside the panel itself before it closes.
      setJustSaved(true)
      setTimeout(handleClose, 550)
    } catch {
      toast('Failed to save changes', 'error')
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

  // Tab "Details": art + price summary + metadata + editable fields + listing
  // controls. The price summary sits directly under the art so the CKD USD
  // baseline and the current sell price (or an explicit unlisted preview) are
  // visible without scrolling or opening the listing picker.
  // ListingSection lives here rather than a separate tab — it's
  // edit-adjacent (list/unlist/relist) and has no natural home of its own.
  // Remove-from-library now lives in the header (ModalHeader/RemoveConfirmBar
  // below), not here.
  const detailsTab = (
    <div className="space-y-5">
      {artBlock}
      <PriceSummary
        status={priceStatus}
        ckdUsd={ckdUsd}
        listingState={ownerListingState}
        now={listingClock}
        finish={pricedFoil}
        finishIsUnsaved={foil !== libraryRow.foil}
      />
      {metadataBlock}
      {editableFields}
      <ListingSection
        libraryRow={libraryRow}
        hasPhoto={hasPhoto}
        listingState={ownerListingState}
        onListingChange={handleListingChange}
        onListingUncertain={handleListingUncertain}
        onRequirePhoto={(retry) => {
          if (retry) setPendingPhotoAction(() => retry)
          setForcePhotoCamera(true)
          setActiveTab('photo')
        }}
      />
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
        disabled={saving || justSaved}
        data-testid="library-detail-save-btn"
        className={`min-h-[44px] flex-1 rounded-dbb-md px-4 text-dbb-sm font-semibold text-white transition-colors disabled:opacity-90 spring-press ${
          justSaved ? 'bg-green-600' : 'bg-dbb-accent hover:bg-dbb-accent-hov'
        }`}
      >
        {justSaved ? (
          <span className="flex items-center justify-center gap-1.5">
            <Check className="h-4 w-4" /> Saved
          </span>
        ) : saving ? 'Saving...' : 'Save changes'}
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
          <ModalHeader
            idPrefix="library-detail-panel"
            title={title}
            assignCloseBtnRef={assignCloseBtnRef}
            onClose={handleClose}
            onRemoveClick={() => setConfirmDelete(true)}
          />
          {confirmDelete && (
            <RemoveConfirmBar
              idPrefix="library-detail-panel"
              deleting={deleting}
              onConfirm={handleDelete}
              onCancel={() => setConfirmDelete(false)}
            />
          )}

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
        <ModalHeader
          idPrefix="library-detail-sheet"
          title={title}
          assignCloseBtnRef={assignCloseBtnRef}
          onClose={handleClose}
          onRemoveClick={() => setConfirmDelete(true)}
        />
        {confirmDelete && (
          <RemoveConfirmBar
            idPrefix="library-detail-sheet"
            deleting={deleting}
            onConfirm={handleDelete}
            onCancel={() => setConfirmDelete(false)}
          />
        )}

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
