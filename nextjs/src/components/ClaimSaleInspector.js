'use client'

import { useState, useEffect, useRef } from 'react'
import { X, Camera, Image as ImageIcon, Check, Loader2, ShoppingCart, Info } from 'lucide-react'
import Link from 'next/link'
import { notifyCartChanged } from '@/lib/cartBadge.mjs'
import { AVAILABILITY } from '@/lib/claimSaleAvailability.mjs'

const FOIL_BADGES = {
  foil: { label: 'Foil', cls: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30' },
  etched: { label: 'Etched', cls: 'bg-purple-500/20 text-purple-400 border-purple-500/30' },
}

const RARITY_COLORS = {
  mythic: 'text-rarity-mythic',
  rare: 'text-rarity-rare',
  uncommon: 'text-rarity-uncommon',
  common: 'text-gray-400',
}

function ConditionProof({ listingId, onClose }) {
  const [photoUrl, setPhotoUrl] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch(`/api/listings/${listingId}/condition-proof`)
      .then(r => r.ok ? r.json() : null)
      .then(data => setPhotoUrl(data?.photo_url || null))
      .catch(() => setPhotoUrl(null))
      .finally(() => setLoading(false))
  }, [listingId])

  return (
    <div
      className="fixed inset-0 z-[70] bg-black/80 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-white rounded-dbb-xl max-w-md w-full shadow-2xl overflow-hidden">
        <div className="dbb-glass-chrome flex items-center justify-between px-4 py-3">
          <h3 className="text-dbb-sm font-semibold text-gray-900 flex items-center gap-1.5">
            <Camera className="h-4 w-4 text-dbb-accent" /> Condition proof
          </h3>
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex h-11 w-11 items-center justify-center rounded-full text-gray-500 transition-colors hover:bg-black/5 hover:text-gray-900"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-4">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-dbb-sm text-gray-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading photo...
            </div>
          ) : photoUrl ? (
            <img
              src={photoUrl}
              alt="Card condition proof"
              className="w-full rounded-dbb-md object-contain"
            />
          ) : (
            <div className="flex flex-col items-center gap-3 py-8">
              <Camera className="h-8 w-8 text-gray-400" />
              <p className="text-dbb-sm font-medium text-gray-900">No condition photo available</p>
              <p className="text-center text-dbb-xs text-gray-500 max-w-[260px]">
                The seller hasn't uploaded a condition photo for this card.
              </p>
            </div>
          )}
          {!loading && (
            <p className="mt-3 text-center text-dbb-xs text-gray-500">
              Seller's real-life card photo — condition evidence for this listing.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

// Read-only inspector panel for a single claim sale card listing.
// Desktop: right-side slide-in panel. Mobile: full-screen sheet.
// isOwner controls whether the thumbnail action is shown.
export default function ClaimSaleInspector({
  listing,
  priceData,
  priceError,
  onClose,
  isOwner,
  availability,
  sellerName,
  claimSaleTitle,
  featuredListingId,
  onSetFeatured,
  savingFeatured,
}) {
  const [imageUrl, setImageUrl] = useState(null)
  const [imgLoading, setImgLoading] = useState(true)
  const [proofOpen, setProofOpen] = useState(false)
  const [requestedQuantity, setRequestedQuantity] = useState(1)
  const [cartState, setCartState] = useState('idle')
  const wrapRef = useRef(null)
  const closeBtnRef = useRef(null)
  const triggerRef = useRef(null)

  const lc = listing.library_cards
  const ci = lc?.card_index
  const storedImage = ci?.image_uris?.normal || ci?.image_uris?.small || null

  // Resolve card image
  useEffect(() => {
    if (storedImage) {
      setImageUrl(storedImage)
      setImgLoading(false)
      return
    }
    if (!lc?.scryfall_id) { setImgLoading(false); return }
    const cacheKey = `sf_img_${lc.scryfall_id}`
    const cached = sessionStorage.getItem(cacheKey)
    if (cached) { setImageUrl(cached); setImgLoading(false); return }
    fetch(`https://api.scryfall.com/cards/${lc.scryfall_id}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data) return
        const url = data.image_uris?.normal || data.card_faces?.[0]?.image_uris?.normal
        if (url) { sessionStorage.setItem(cacheKey, url); setImageUrl(url) }
      })
      .catch(() => {})
      .finally(() => setImgLoading(false))
  }, [lc?.scryfall_id, storedImage])

  // Focus management + scroll lock
  useEffect(() => {
    triggerRef.current = document.activeElement
    closeBtnRef.current?.focus()
  }, [])

  const assignCloseRef = (el) => {
    if (el && el.offsetParent !== null) closeBtnRef.current = el
  }

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); handleClose(); return }
      if (e.key !== 'Tab') return
      const all = wrapRef.current?.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
      const focusables = all ? Array.from(all).filter(el => el.offsetParent !== null) : []
      if (!focusables.length) return
      const first = focusables[0]; const last = focusables[focusables.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKeyDown)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = prevOverflow
    }
  }, [])

  function handleClose() {
    if (triggerRef.current?.focus) triggerRef.current.focus()
    onClose()
  }

  const cardName = ci?.name || '—'
  const isFeatured = featuredListingId === listing.id
  const foilBadge = lc?.foil && FOIL_BADGES[lc.foil]

  const multiplier = Number(listing.multiplier)
  const priceLoading = priceData === undefined
  const myrPrice = priceData?.ckd_usd != null
    ? Math.round(priceData.ckd_usd * multiplier * 2) / 2
    : null

  // Offered quantity is the listing's offered amount, not the seller's total
  // library inventory. The page query selects listings.quantity explicitly.
  const offeredQty = listing.quantity

  // `availability` is resolved by the parent from listing + claim sale state.
  // Whenever it is not purchasable the buyer gets a named reason instead of a
  // silently missing Add to cart button; the server-side stock check is still
  // the authority and can reject a request that got this far.
  const purchasable = !!availability?.purchasable
  const priceBlocked = purchasable && !priceLoading && myrPrice == null

  async function addToCart() {
    if (!Number.isInteger(requestedQuantity) || requestedQuantity < 1 || requestedQuantity > offeredQty) return
    setCartState('loading')
    try {
      const response = await fetch('/api/cart', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ listing_id: listing.id, quantity: requestedQuantity }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not add to cart')
      setCartState(data.already_in_cart ? 'already' : 'added')
      notifyCartChanged()
    } catch (error) {
      setCartState(error.message || 'error')
    }
  }

  const artBlock = (
    <div className="w-full flex justify-center">
      {imgLoading ? (
        <div className="aspect-[5/7] max-h-[32vh] w-auto skeleton rounded-dbb-lg" />
      ) : imageUrl ? (
        <img
          src={imageUrl}
          alt={cardName}
          className="max-h-[32vh] w-auto rounded-dbb-lg object-contain shadow-dbb-md"
        />
      ) : (
        <div className="flex aspect-[5/7] max-h-[32vh] w-auto items-center justify-center rounded-dbb-lg bg-gray-100">
          <span className="p-2 text-center text-dbb-sm text-gray-500">{cardName}</span>
        </div>
      )}
    </div>
  )

  const bundleContext = (
    <div className="rounded-dbb-md bg-gray-50 px-3 py-2 text-dbb-xs text-gray-600 space-y-0.5">
      {sellerName && (
        <p><span className="text-gray-400">Seller</span> · {sellerName}</p>
      )}
      {claimSaleTitle && (
        <p><span className="text-gray-400">Bundle</span> · {claimSaleTitle}</p>
      )}
    </div>
  )

  const metaBlock = (
    <div className="space-y-1.5 text-dbb-sm text-gray-600">
      {/* Condition + finish row */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="border border-gray-200 dark:border-dbb-tertiary/50 rounded px-1.5 py-0.5 text-dbb-xs text-gray-600">
          {lc?.condition || 'Condition unavailable'}
        </span>
        {foilBadge && (
          <span className={`rounded border px-1.5 py-0.5 text-dbb-xs ${foilBadge.cls}`}>
            {foilBadge.label}
          </span>
        )}
        {(!lc?.foil || lc.foil === 'normal') && (
          <span className="text-dbb-xs text-gray-400">Normal finish</span>
        )}
      </div>

      {/* Set + collector# */}
      {(ci?.set_name || ci?.set_code) && (
        <div>
          <span className="text-gray-400">Set</span> · {ci.set_name || ci.set_code?.toUpperCase()}
          {ci?.collector_number && <span className="ml-1 text-gray-500">#{ci.collector_number}</span>}
        </div>
      )}
      {ci?.rarity && (
        <div>
          <span className="text-gray-400">Rarity</span> ·{' '}
          <span className={RARITY_COLORS[ci.rarity] || 'text-gray-500'}>
            {ci.rarity.charAt(0).toUpperCase() + ci.rarity.slice(1)}
          </span>
        </div>
      )}
      {ci?.type_line && (
        <div><span className="text-gray-400">Type</span> · {ci.type_line}</div>
      )}
    </div>
  )

  const listingBlock = (
      <div className="rounded-dbb-md bg-gray-50 p-3 space-y-2">
      {offeredQty != null && (
        <div className="flex items-center justify-between text-dbb-sm">
          <span className="text-gray-500">Offered qty</span>
          <span
            data-testid="claim-sale-offered-qty"
            className={`font-medium ${offeredQty > 0 ? 'text-gray-800' : 'text-gray-500'}`}
          >
            {offeredQty > 0 ? offeredQty : '0 — none available'}
          </span>
        </div>
      )}
      <div className="flex items-center justify-between">
        <span className="text-dbb-xs text-gray-500">Unit price</span>
        {priceError ? (
          <span className="text-dbb-xs text-amber-500">Pricing unavailable</span>
        ) : priceLoading ? (
          <div className="flex items-center gap-1 text-dbb-xs text-gray-400">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading...
          </div>
        ) : myrPrice != null ? (
          <div className="flex items-baseline gap-1.5">
            <span className="text-dbb-lg font-bold price-green">RM {myrPrice.toFixed(2)}</span>
            <span className="text-dbb-xs text-gray-400">×{listing.multiplier}</span>
          </div>
        ) : (
          <span className="text-dbb-xs text-gray-400">Price unavailable</span>
        )}
      </div>
      {!purchasable && availability?.title && availability.code !== AVAILABILITY.OWNER && (
        <div
          data-testid="claim-sale-unavailable"
          data-availability={availability.code}
          role="status"
          className="flex gap-2 rounded-dbb-md border border-gray-200 bg-white p-3"
        >
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" aria-hidden="true" />
          <div className="space-y-0.5">
            <p className="text-dbb-sm font-medium text-gray-800">{availability.title}</p>
            <p className="text-dbb-xs text-gray-500">{availability.detail}</p>
            {availability.code === AVAILABILITY.SIGNED_OUT && (
              <Link href="/login" className="inline-block pt-1 text-dbb-xs font-medium text-dbb-accent underline">
                Sign in
              </Link>
            )}
          </div>
        </div>
      )}
      {priceBlocked && (
        <div
          data-testid="claim-sale-unavailable"
          data-availability="price_unavailable"
          role="status"
          className="flex gap-2 rounded-dbb-md border border-gray-200 bg-white p-3"
        >
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" aria-hidden="true" />
          <div className="space-y-0.5">
            <p className="text-dbb-sm font-medium text-gray-800">Price unavailable</p>
            <p className="text-dbb-xs text-gray-500">
              We could not price this card right now, so it cannot be added to a cart yet. Try again shortly.
            </p>
          </div>
        </div>
      )}
      {purchasable && myrPrice != null && (
        <div className="rounded-dbb-md border border-dbb-accent/30 bg-dbb-accent/5 p-3 space-y-2">
          <div className="flex items-center justify-between text-dbb-sm">
            <span className="text-gray-500">Quantity</span>
            <div className="flex items-center gap-2">
              <button onClick={() => setRequestedQuantity(q => Math.max(1, q - 1))} className="h-8 w-8 rounded border border-gray-300">−</button>
              <span className="min-w-5 text-center font-medium">{requestedQuantity}</span>
              <button onClick={() => setRequestedQuantity(q => Math.min(offeredQty, q + 1))} className="h-8 w-8 rounded border border-gray-300">+</button>
            </div>
          </div>
          <p className="text-right text-dbb-xs text-gray-500">Line total RM {(myrPrice * requestedQuantity).toFixed(2)}</p>
          {cartState === 'already' ? (
            <Link href="/cart" className="flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-dbb-md bg-dbb-accent px-3 text-dbb-sm font-medium text-white">
              <ShoppingCart className="h-4 w-4" /> In cart — edit quantity
            </Link>
          ) : (
            <button
              onClick={addToCart}
              disabled={cartState === 'loading'}
              className="flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-dbb-md bg-dbb-accent px-3 text-dbb-sm font-medium text-white disabled:opacity-50"
            >
              {cartState === 'loading' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShoppingCart className="h-4 w-4" />}
              {cartState === 'added' ? 'Added to cart' : cartState !== 'idle' && cartState !== 'loading' ? cartState : 'Add to cart'}
            </button>
          )}
        </div>
      )}
    </div>
  )

  const actionBlock = (
    <div className="space-y-2">
      {/* Condition proof — always available */}
      <button
        onClick={() => setProofOpen(true)}
        className="flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-dbb-md border border-gray-200 px-3 text-dbb-sm text-gray-600 transition-colors hover:border-dbb-accent hover:text-dbb-accent spring-press"
      >
        <Camera className="h-3.5 w-3.5" /> View card condition
      </button>

      {/* Thumbnail action — owner only */}
      {isOwner && (
        <button
          onClick={() => onSetFeatured(listing.id)}
          disabled={savingFeatured}
          className={`flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-dbb-md border px-3 text-dbb-sm font-medium transition-colors spring-press ${
            isFeatured
              ? 'border-dbb-accent bg-dbb-accent/10 text-dbb-accent hover:bg-dbb-accent/20'
              : 'border-gray-200 text-gray-600 hover:border-dbb-accent hover:text-dbb-accent'
          }`}
        >
          {savingFeatured ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : isFeatured ? (
            <><Check className="h-3.5 w-3.5" /> Remove thumbnail</>
          ) : (
            <><ImageIcon className="h-3.5 w-3.5" /> Set as browse thumbnail</>
          )}
        </button>
      )}
    </div>
  )

  const bodyContent = (
    <div className="space-y-4 p-4">
      {artBlock}
      <div>
        <h3 className="text-dbb-xl font-semibold text-gray-900">{cardName}</h3>
      </div>
      {bundleContext}
      {metaBlock}
      {listingBlock}
      {actionBlock}
    </div>
  )

  return (
    <div ref={wrapRef}>
      {/* Desktop: right-side inspector panel (≥1024px) */}
      <div className="hidden lg:block fixed inset-0 z-40">
        <div
          className="absolute inset-0 bg-black/50"
          onClick={handleClose}
          aria-hidden="true"
        />
        <div
          data-testid="claim-sale-inspector-panel"
          role="dialog"
          aria-modal="true"
          aria-label={cardName}
          className="absolute top-0 right-0 h-full w-[440px] max-w-[90vw] bg-white border-l border-gray-200 shadow-[-12px_0_40px_-8px_rgba(0,0,0,0.35)] flex flex-col"
        >
          <div className="dbb-glass-chrome flex shrink-0 items-center justify-between gap-3 px-4 py-3">
            <h2 className="truncate text-dbb-lg font-semibold tracking-heading text-gray-900">{cardName}</h2>
            <button
              ref={assignCloseRef}
              onClick={handleClose}
              aria-label="Close inspector"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-gray-500 transition-colors hover:bg-dbb-accent/10 hover:text-dbb-accent spring-press"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto overscroll-contain">
            {bodyContent}
          </div>
          <div
            className="dbb-glass-chrome flex shrink-0 items-center justify-end gap-3 px-4 py-3"
            style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
          >
            <button
              onClick={handleClose}
              className="min-h-[44px] rounded-dbb-md px-4 text-dbb-sm text-gray-600 transition-colors hover:bg-dbb-accent/10 hover:text-dbb-accent spring-press"
            >
              Close
            </button>
          </div>
        </div>
      </div>

      {/* Mobile: full-screen sheet (≤1023px) */}
      <div
        data-testid="claim-sale-inspector-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={cardName}
        className="lg:hidden fixed inset-0 z-50 flex flex-col bg-white overflow-y-auto"
      >
        <div className="sticky top-0 dbb-glass-chrome flex items-center justify-between gap-3 px-4 py-3">
          <h2 className="truncate text-dbb-lg font-semibold tracking-heading text-gray-900">{cardName}</h2>
          <button
            ref={assignCloseRef}
            onClick={handleClose}
            aria-label="Close inspector"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-gray-500 transition-colors hover:bg-dbb-accent/10 hover:text-dbb-accent spring-press"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1">
          <div className="pb-8">
            {bodyContent}
          </div>
        </div>
      </div>

      {proofOpen && (
        <ConditionProof
          listingId={listing.id}
          onClose={() => setProofOpen(false)}
        />
      )}
    </div>
  )
}
