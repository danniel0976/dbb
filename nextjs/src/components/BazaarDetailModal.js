'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { X, Loader2, User, Camera, Calendar, Maximize2 } from 'lucide-react'

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

// ConditionProof — lazy-loaded lightbox showing the seller's real-life card photo.
function ConditionProof({ listingId, onClose }) {
  const [photoUrl, setPhotoUrl] = useState(null)
  const [loading, setLoading] = useState(true)
  const [enlarged, setEnlarged] = useState(false)

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
      <div className="bg-white dark:bg-dbb-primary rounded-dbb-xl max-w-md w-full shadow-2xl overflow-hidden">
        {/* Glass chrome header */}
        <div className="dbb-glass-chrome flex items-center justify-between px-4 py-3">
          <h3 className="text-dbb-sm font-semibold text-gray-900 dark:text-white flex items-center gap-1.5">
            <Camera className="h-4 w-4 text-dbb-accent" /> Condition proof
          </h3>
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex h-11 w-11 items-center justify-center rounded-full text-gray-500 transition-colors hover:bg-black/5 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-white/10 dark:hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        {/* Solid body */}
        <div className="p-4">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-dbb-sm text-gray-500 dark:text-gray-600">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading photo...
            </div>
          ) : photoUrl ? (
            <div className="relative">
              <img
                src={photoUrl}
                alt="Card condition proof"
                className="w-full rounded-dbb-md object-contain"
              />
              <button
                onClick={() => setEnlarged(true)}
                className="absolute bottom-2 right-2 flex h-11 w-11 items-center justify-center rounded-dbb-md bg-black/60 text-white transition-colors hover:bg-black/80"
                title="View full size"
              >
                <Maximize2 className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2 py-6 text-dbb-xs text-gray-500 justify-center">
              <Camera className="h-4 w-4" /> No condition photo available
            </div>
          )}
          <p className="mt-2 text-center text-dbb-xs text-gray-500 dark:text-gray-600">
            Seller's real-life card photo — condition evidence for this listing.
          </p>
        </div>
      </div>

      {/* Full-size lightbox */}
      {enlarged && photoUrl && (
        <div
          className="fixed inset-0 z-[80] bg-black/95 flex items-center justify-center p-4"
          onClick={() => setEnlarged(false)}
        >
          <button
            className="absolute top-4 right-4 flex h-11 w-11 items-center justify-center text-white transition-colors hover:text-dbb-accent"
            onClick={() => setEnlarged(false)}
          >
            <X className="h-6 w-6" />
          </button>
          <img
            src={photoUrl.split('?')[0]}
            alt="Card condition proof — full size"
            className="max-w-full max-h-full object-contain rounded-dbb-md"
          />
        </div>
      )}
    </div>
  )
}

function SellerPopup({ listingId, onClose, userId }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [isFollowing, setIsFollowing] = useState(false)
  const [followLoading, setFollowLoading] = useState(false)

  useEffect(() => {
    fetch(`/api/listings/${listingId}/seller`)
      .then(r => r.ok ? r.json() : null)
      .then(d => setData(d?.seller || null))
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [listingId])

  useEffect(() => {
    if (!userId || !data?.id) return
    fetch(`/api/follows?check_user=${data.id}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.following) setIsFollowing(true) })
      .catch(() => {})
  }, [userId, data?.id])

  const handleFollowUser = async () => {
    if (!userId || !data?.id || followLoading) return
    setFollowLoading(true)
    try {
      if (isFollowing) {
        const res = await fetch(`/api/follows?followee_id=${data.id}`, { method: 'DELETE' })
        if (res.ok) setIsFollowing(false)
      } else {
        const res = await fetch('/api/follows', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ followee_id: data.id }),
        })
        if (res.ok) setIsFollowing(true)
      }
    } catch {
      // silent
    } finally {
      setFollowLoading(false)
    }
  }

  const formatDate = (iso) => {
    if (!iso) return null
    return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long' })
  }

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-white dark:bg-dbb-primary rounded-dbb-xl max-w-sm w-full shadow-2xl overflow-hidden">
        {/* Glass chrome header */}
        <div className="dbb-glass-chrome flex items-center justify-between px-4 py-3">
          <h3 className="text-dbb-sm font-semibold text-gray-900 dark:text-white">Seller info</h3>
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex h-11 w-11 items-center justify-center rounded-full text-gray-500 transition-colors hover:bg-black/5 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-white/10 dark:hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        {/* Solid body */}
        <div className="space-y-3 p-4">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-6 text-dbb-sm text-gray-500 dark:text-gray-600">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading...
            </div>
          ) : !data ? (
            <p className="py-4 text-center text-dbb-sm text-gray-500">Seller info unavailable.</p>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-dbb-accent/20">
                  <User className="h-5 w-5 text-dbb-accent" />
                </div>
                <div>
                  <p className="text-dbb-sm font-semibold text-gray-900 dark:text-white">{data.display_name}</p>
                  {data.member_since && (
                    <p className="flex items-center gap-1 text-dbb-xs text-gray-500">
                      <Calendar className="h-3 w-3" />
                      Member since {formatDate(data.member_since)}
                    </p>
                  )}
                </div>
              </div>
              {userId && data.id !== userId && (
                <button
                  onClick={handleFollowUser}
                  disabled={followLoading}
                  className={`flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-dbb-md text-dbb-sm font-medium transition-colors ${
                    isFollowing
                      ? 'bg-dbb-accent/10 text-dbb-accent border border-dbb-accent/30'
                      : 'bg-dbb-accent text-white hover:bg-dbb-accent-hov'
                  }`}
                >
                  {followLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : isFollowing ? (
                    <>Following</>
                  ) : (
                    <>Follow seller</>
                  )}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// Mobile drag sheet with CSS-first physics + rAF spring fallback
function MobileDragSheet({ open, onClose, children, sheetRef, dragState, setDragState }) {
  const touchStartY = useRef(0)
  const currentY = useRef(0)
  const sheetHeight = useRef(0)
  const dismissThreshold = useRef(0)
  const rafId = useRef(null)
  const isDragging = useRef(false)

  // CSS-only approach: use touch-action + overscroll-behavior for native rubber-banding
  // Spring animation only for snap-back/dismiss transitions
  const springAnimate = (from, to, onComplete) => {
    const duration = 300
    const startTime = performance.now()
    const spring = (t) => {
      // Simple ease-out-cubic spring
      return 1 - Math.pow(1 - t, 3)
    }
    
    const animate = (now) => {
      const elapsed = now - startTime
      const progress = Math.min(elapsed / duration, 1)
      const eased = spring(progress)
      const current = from + (to - from) * eased
      
      if (sheetRef.current) {
        sheetRef.current.style.transform = `translateY(${current}px)`
      }
      
      if (progress < 1) {
        rafId.current = requestAnimationFrame(animate)
      } else {
        onComplete?.()
      }
    }
    
    rafId.current = requestAnimationFrame(animate)
  }

  const handleTouchStart = (e) => {
    if (!open) return
    isDragging.current = true
    touchStartY.current = e.touches[0].clientY
    const rect = sheetRef.current?.getBoundingClientRect()
    sheetHeight.current = rect?.height || 0
    dismissThreshold.current = sheetHeight.current * 0.3 // 30% drag to dismiss
    
    if (rafId.current) {
      cancelAnimationFrame(rafId.current)
      rafId.current = null
    }
    
    // Disable transition during drag for immediate response
    if (sheetRef.current) {
      sheetRef.current.style.transition = 'none'
    }
  }

  const handleTouchMove = (e) => {
    if (!isDragging.current || !sheetRef.current) return
    
    const deltaY = e.touches[0].clientY - touchStartY.current
    
    // Only allow downward drag (dismiss direction)
    if (deltaY > 0) {
      e.preventDefault() // Prevent page scroll while dragging sheet
      
      // Apply rubber-banding resistance near bounds (CSS overscroll-behavior handles visual)
      const resistance = deltaY < 100 ? 1 : 1 + Math.log10(deltaY / 100)
      const clampedDelta = Math.min(deltaY / resistance, sheetHeight.current * 0.8)
      
      currentY.current = clampedDelta
      sheetRef.current.style.transform = `translateY(${clampedDelta}px)`
    }
  }

  const handleTouchEnd = () => {
    if (!isDragging.current) return
    isDragging.current = false
    
    const shouldDismiss = currentY.current >= dismissThreshold.current
    const fromY = currentY.current
    const toY = shouldDismiss ? sheetHeight.current : 0
    
    // Re-enable transition for smooth snap
    if (sheetRef.current) {
      sheetRef.current.style.transition = 'transform 0.3s cubic-bezier(0.2, 0.8, 0.2, 1)'
    }
    
    if (shouldDismiss) {
      // Animate to full dismiss, then close
      springAnimate(fromY, toY, () => {
        onClose()
        // Reset transform after close
        if (sheetRef.current) {
          sheetRef.current.style.transform = ''
        }
      })
    } else {
      // Snap back to open position
      springAnimate(fromY, toY, () => {
        if (sheetRef.current) {
          sheetRef.current.style.transform = ''
        }
      })
    }
    
    currentY.current = 0
  }

  // Cleanup raf on unmount
  useEffect(() => {
    return () => {
      if (rafId.current) cancelAnimationFrame(rafId.current)
    }
  }, [])

  return (
    <div
      ref={sheetRef}
      role="dialog"
      aria-modal="true"
      aria-label="Card details"
      className="absolute left-0 right-0 bottom-0 max-h-[92vh] w-full flex flex-col bg-white shadow-2xl rounded-t-dbb-xl overflow-hidden dark:bg-dbb-primary touch-none"
      style={{ 
        overscrollBehavior: 'contain',
        touchAction: 'pan-x' // Allow horizontal touch, block vertical for drag handling
      }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* Drag handle for visual affordance */}
      <div className="flex shrink-0 items-center justify-center py-3 bg-transparent">
        <div className="w-10 h-1.5 rounded-full bg-gray-300 dark:bg-gray-600" />
      </div>
      {children}
    </div>
  )
}

export default function BazaarDetailModal({ listing, onClose, onSelectListing, userId }) {
  const lc = listing.library_cards
  const ci = lc?.card_index
  const scryfallId = lc?.scryfall_id

  const [cardData, setCardData] = useState(null)
  const [imageUrl, setImageUrl] = useState(null)
  const [cardLoading, setCardLoading] = useState(true)
  const [ckdPrice, setCkdPrice] = useState(null)
  const [priceLoading, setPriceLoading] = useState(true)
  const [sellers, setSellers] = useState(null)
  const [sellersLoading, setSellersLoading] = useState(true)
  const [selectedListingId, setSelectedListingId] = useState(null)
  const [sellerPopupId, setSellerPopupId] = useState(null)
  const [proofListingId, setProofListingId] = useState(null)

  const sheetRef = useRef(null)
  const closeBtnRef = useRef(null)
  const triggerCardRef = useRef(null) // Track the card that opened this modal
  const [dragState, setDragState] = useState({ isOpen: false, translateY: 0 })

  // Capture the currently focused element (the card that triggered this) for focus restoration
  useEffect(() => {
    triggerCardRef.current = document.activeElement
    closeBtnRef.current?.focus()
  }, [])

  // Fetch Scryfall card data
  useEffect(() => {
    if (!scryfallId) { setCardLoading(false); return }
    const cacheKey = `sf_card_${scryfallId}`
    const cached = sessionStorage.getItem(cacheKey)
    if (cached) {
      try {
        const data = JSON.parse(cached)
        setCardData(data)
        setImageUrl(data.image_uris?.normal || data.card_faces?.[0]?.image_uris?.normal)
      } catch {}
      setCardLoading(false)
      return
    }
    fetch(`https://api.scryfall.com/cards/${scryfallId}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data) {
          sessionStorage.setItem(cacheKey, JSON.stringify(data))
          setCardData(data)
          setImageUrl(data.image_uris?.normal || data.card_faces?.[0]?.image_uris?.normal)
        }
      })
      .catch(() => {})
      .finally(() => setCardLoading(false))
  }, [scryfallId])

  // Fetch CKD pricing
  useEffect(() => {
    if (!scryfallId) { setPriceLoading(false); return }
    const foilType = lc?.foil || 'normal'
    fetch('/api/pricing/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ scryfall_id: scryfallId, foil: foilType }] }),
    })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        const key = `${scryfallId}:${foilType}`
        setCkdPrice(data?.prices?.[key]?.ckd_usd ?? null)
      })
      .catch(() => {})
      .finally(() => setPriceLoading(false))
  }, [scryfallId, lc?.foil])

  // Fetch all active listings for this card
  useEffect(() => {
    if (!scryfallId) { setSellersLoading(false); return }
    fetch(`/api/listings/card/${scryfallId}`)
      .then(r => r.ok ? r.json() : { listings: [] })
      .then(data => setSellers(data.listings || []))
      .catch(() => setSellers([]))
      .finally(() => setSellersLoading(false))
  }, [scryfallId])

  // Focus trap + scroll lock (desktop only; mobile sheet handles its own scroll)
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        handleClose()
        return
      }
      if (e.key !== 'Tab') return
      
      // Only apply focus trap on desktop (mobile sheet is dismissed on Escape)
      if (window.innerWidth >= 1024) {
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
    }

    document.addEventListener('keydown', onKeyDown)
    
    // Desktop only: lock body scroll
    if (window.innerWidth >= 1024) {
      const prevOverflow = document.body.style.overflow
      document.body.style.overflow = 'hidden'
      return () => {
        document.removeEventListener('keydown', onKeyDown)
        document.body.style.overflow = prevOverflow
      }
    }
    
    return () => {
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  const handleClose = () => {
    // Restore focus to the card that opened this modal
    if (triggerCardRef.current && triggerCardRef.current.focus) {
      triggerCardRef.current.focus()
    }
    onClose()
  }

  const computeMyr = (ckdUsd, multiplier) => {
    if (ckdUsd == null) return null
    return Math.round(ckdUsd * Number(multiplier) * 2) / 2
  }

  const cardName = ci?.name || cardData?.name || 'Card'
  const setName = ci?.set_name || cardData?.set_name || ci?.set_code?.toUpperCase()
  const collectorNumber = ci?.collector_number || cardData?.collector_number
  const rarity = ci?.rarity || cardData?.rarity
  const typeLine = ci?.type_line || cardData?.type_line
  const oracleText = cardData?.oracle_text || cardData?.card_faces?.[0]?.oracle_text

  // Shared content component for both desktop inspector and mobile sheet
  const DetailContent = () => (
    <>
      {/* Header — glass chrome */}
      <div className="dbb-glass-chrome flex shrink-0 items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <h2 className="truncate text-dbb-lg font-semibold tracking-heading text-gray-900 dark:text-white">{cardName}</h2>
        <button
          ref={closeBtnRef}
          onClick={handleClose}
          aria-label="Close"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-gray-500 transition-colors hover:bg-black/5 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-white/10 dark:hover:text-white"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* Scrollable solid body */}
      <div className="flex-1 overflow-y-auto overscroll-contain">
        <div className="flex flex-col gap-5 p-4 sm:flex-row sm:gap-6 sm:p-6">
          {/* Card image — native MTG aspect ratio, never cropped */}
          <div className="mx-auto w-40 shrink-0 sm:mx-0 sm:w-44">
            {cardLoading ? (
              <div className="aspect-[5/7] skeleton rounded-dbb-md" />
            ) : imageUrl ? (
              <img
                src={imageUrl}
                alt={cardName}
                className="h-auto w-full rounded-dbb-md object-contain shadow-dbb-md"
              />
            ) : (
              <div className="flex aspect-[5/7] items-center justify-center rounded-dbb-md bg-gray-100 dark:bg-dbb-secondary">
                <span className="p-2 text-center text-dbb-sm text-gray-500">{cardName}</span>
              </div>
            )}
          </div>

          {/* Right side — progressive info panel */}
          <div className="flex min-w-0 flex-1 flex-col gap-4">
            {/* Card metadata */}
            <div className="space-y-1 text-dbb-sm text-gray-600 dark:text-gray-300">
              {setName && (
                <div>
                  <span className="text-gray-400 dark:text-gray-500">Set</span> · {setName}
                  {collectorNumber && <span className="ml-1 text-gray-500">#{collectorNumber}</span>}
                </div>
              )}
              {rarity && (
                <div>
                  <span className="text-gray-400 dark:text-gray-500">Rarity</span> ·{' '}
                  <span className={RARITY_COLORS[rarity] || 'text-gray-400'}>
                    {rarity.charAt(0).toUpperCase() + rarity.slice(1)}
                  </span>
                </div>
              )}
              {typeLine && (
                <div><span className="text-gray-400 dark:text-gray-500">Type</span> · {typeLine}</div>
              )}
              {oracleText && (
                <div className="mt-2 whitespace-pre-line rounded-dbb-md bg-gray-50 p-3 text-dbb-xs leading-relaxed text-gray-600 dark:bg-dbb-secondary dark:text-gray-300">
                  {oracleText}
                </div>
              )}
            </div>

            {/* CKD reference price — always visible */}
            <div className="rounded-dbb-md bg-gray-50 p-3 dark:bg-dbb-secondary">
              <p className="mb-1 text-dbb-xs text-gray-600 dark:text-gray-500">CardKingdom Reference Price</p>
              {priceLoading ? (
                <div className="flex items-center gap-1.5 text-dbb-xs text-gray-500 dark:text-gray-600">
                  <Loader2 className="h-3 w-3 animate-spin" /> Loading...
                </div>
              ) : ckdPrice != null ? (
                <div className="flex items-baseline gap-2">
                  <span className="text-base font-semibold text-gray-900 dark:text-white">${ckdPrice.toFixed(2)}</span>
                  <span className="text-dbb-xs text-gray-500">CKD USD</span>
                </div>
              ) : (
                <span className="text-dbb-xs text-gray-500 dark:text-gray-600">No price data available</span>
              )}
            </div>

            {/* Sellers / listings */}
            <div>
              <h3 className="mb-2 text-dbb-sm font-semibold text-gray-900 dark:text-white">
                {sellersLoading
                  ? 'Loading sellers...'
                  : sellers?.length === 0
                  ? 'No sellers available for this card'
                  : `${sellers.length} seller${sellers.length !== 1 ? 's' : ''}`}
              </h3>

              {sellersLoading ? (
                <div className="flex items-center gap-2 py-3 text-dbb-xs text-gray-500 dark:text-gray-600">
                  <Loader2 className="h-4 w-4 animate-spin" /> Fetching listings...
                </div>
              ) : sellers && sellers.length > 0 ? (
                <div className="space-y-2">
                  {sellers.map(s => {
                    const slc = s.library_cards
                    const myr = computeMyr(ckdPrice, s.multiplier)
                    const foilBadge = slc?.foil && FOIL_BADGES[slc.foil]
                    const isSelected = selectedListingId === s.id
                    return (
                      <div
                        key={s.id}
                        className={`rounded-dbb-md border p-3 transition-colors ${
                          isSelected
                            ? 'border-dbb-accent bg-dbb-accent/10'
                            : 'border-gray-200 bg-white dark:border-gray-700 dark:bg-dbb-secondary hover:border-gray-300 dark:hover:border-gray-600'
                        }`}
                      >
                        <div className="flex flex-col gap-2">
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex min-w-0 flex-1 items-center gap-2">
                              <User className="h-3.5 w-3.5 flex-shrink-0 text-gray-500" />
                              <button
                                onClick={() => setSellerPopupId(s.id)}
                                className="max-w-[120px] truncate text-left text-dbb-sm text-gray-600 transition-colors hover:text-dbb-accent dark:text-gray-300"
                                title="View seller profile"
                              >
                                {s.seller_name || 'Seller'}
                              </button>
                              <span className="flex-shrink-0 rounded border border-gray-300 px-1 py-0.5 text-dbb-xs text-gray-500 dark:border-gray-600 dark:text-gray-400">
                                {slc?.condition || 'NM'}
                              </span>
                              {foilBadge && (
                                <span className={`flex-shrink-0 rounded border px-1 py-0.5 text-dbb-xs ${foilBadge.cls}`}>
                                  {foilBadge.label}
                                </span>
                              )}
                              {s.quantity > 1 && (
                                <span className="flex-shrink-0 text-dbb-xs text-gray-500 dark:text-gray-400">
                                  {s.quantity}×
                                </span>
                              )}
                            </div>
                            <div className="text-right">
                              <div className="text-dbb-sm font-semibold text-dbb-accent">
                                {myr != null ? `RM ${myr.toFixed(2)}` : '—'}
                              </div>
                              <div className="text-dbb-xs text-gray-500 dark:text-gray-600">×{s.multiplier}</div>
                            </div>
                          </div>
                          <div className="flex items-center justify-between gap-2 pt-1">
                            <button
                              onClick={() => setProofListingId(s.id)}
                              className="flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-dbb-md border border-gray-200 px-3 text-dbb-sm text-gray-600 transition-colors hover:border-dbb-accent hover:text-dbb-accent dark:border-gray-700 dark:text-gray-300"
                            >
                              <Camera className="h-3.5 w-3.5" /> View card condition
                            </button>
                            <button
                              onClick={() => {
                                setSelectedListingId(s.id)
                                onSelectListing(s)
                              }}
                              className={`flex min-h-[44px] flex-shrink-0 items-center justify-center px-4 text-dbb-sm font-medium transition-colors ${
                                isSelected
                                  ? 'bg-dbb-accent text-white'
                                  : 'bg-gray-100 text-gray-600 hover:bg-dbb-accent hover:text-white dark:bg-dbb-secondary dark:text-gray-300'
                              }`}
                            >
                              {isSelected ? (
                                <span className="flex items-center gap-1.5">✓ Selected</span>
                              ) : (
                                'Select'
                              )}
                            </button>
                          </div>
                        </div>
                        {(s.created_at || s.expires_at) && (
                          <p className="mt-1 pl-0.5 text-dbb-xs text-gray-500 dark:text-gray-600">
                            {s.created_at && `listed ${relativeTime(s.created_at, false)}`}
                            {s.created_at && s.expires_at && ' · '}
                            {s.expires_at && `expires ${relativeTime(s.expires_at, true)}`}
                          </p>
                        )}
                      </div>
                    )
                  })}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {/* Sticky footer — glass chrome top edge */}
      <div
        className="dbb-glass-chrome dbb-glass-chrome--edge-top flex shrink-0 items-center justify-end gap-3 px-4 py-3 sm:px-6"
        style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
      >
        <button
          onClick={handleClose}
          className="min-h-[44px] px-4 text-dbb-sm text-gray-500 transition-colors hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
        >
          Close
        </button>
      </div>
    </>
  )

  return (
    <>
      {/* Desktop: right-side non-blocking inspector panel (≥1024px) */}
      <div className="hidden lg:block">
        <div
          className="fixed top-0 right-0 h-full w-[480px] max-w-[90vw] z-50 bg-white dark:bg-dbb-primary shadow-2xl"
          style={{ 
            transform: 'translateX(0)',
            transition: 'transform 0.3s cubic-bezier(0.2, 0.8, 0.2, 1)'
          }}
        >
          <div className="h-full flex flex-col">
            <DetailContent />
          </div>
        </div>
        {/* Backdrop for desktop (click to close, but doesn't block view behind) */}
        <div
          className="fixed inset-0 z-40 bg-black/30 lg:block"
          onClick={handleClose}
          aria-hidden="true"
        />
      </div>

      {/* Mobile: drag-physics bottom sheet (≤1023px) */}
      <div className="lg:hidden fixed inset-0 z-50 bg-black/60" onClick={handleClose}>
        <MobileDragSheet
          open={true}
          onClose={handleClose}
          sheetRef={sheetRef}
          dragState={dragState}
          setDragState={setDragState}
        >
          <DetailContent />
        </MobileDragSheet>
      </div>

      {sellerPopupId && (
        <SellerPopup
          listingId={sellerPopupId}
          onClose={() => setSellerPopupId(null)}
          userId={userId}
        />
      )}
      {proofListingId && (
        <ConditionProof
          listingId={proofListingId}
          onClose={() => setProofListingId(null)}
        />
      )}
    </>
  )
}
