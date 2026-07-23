'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { X, Loader2, User, Camera, Calendar } from 'lucide-react'

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

// ConditionProof — lightbox showing the seller's real-life card photo.
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
        {/* Glass chrome header */}
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
        {/* Solid body */}
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
              <p className="text-dbb-sm font-medium text-gray-900">
                No condition photo available
              </p>
              <p className="text-center text-dbb-xs text-gray-500 max-w-[260px]">
                This listing doesn't have a condition photo. The seller hasn't uploaded one yet.
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
      <div className="bg-white rounded-dbb-xl max-w-sm w-full shadow-2xl overflow-hidden">
        {/* Glass chrome header */}
        <div className="dbb-glass-chrome flex items-center justify-between px-4 py-3">
          <h3 className="text-dbb-sm font-semibold text-gray-900">Seller info</h3>
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex h-11 w-11 items-center justify-center rounded-full text-gray-500 transition-colors hover:bg-black/5 hover:text-gray-900"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        {/* Solid body */}
        <div className="space-y-3 p-4">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-6 text-dbb-sm text-gray-500">
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
                  <p className="text-dbb-sm font-semibold text-gray-900">{data.display_name}</p>
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

  const closeBtnRef = useRef(null)
  const triggerCardRef = useRef(null)

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

  // Escape key handler + scroll lock
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        handleClose()
        return
      }
    }

    document.addEventListener('keydown', onKeyDown)
    
    // Lock body scroll
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = prevOverflow
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

  return (
    <>
      {/* Desktop: right-side non-blocking inspector panel (≥1024px) */}
      <div className="hidden lg:block fixed inset-0 z-40">
        {/* Backdrop - click to close */}
        <div
          className="absolute inset-0 bg-black/50"
          onClick={handleClose}
          aria-hidden="true"
        />

        {/* Inspector panel */}
        <div data-testid="bazaar-detail-panel" className="absolute top-0 right-0 h-full w-[480px] max-w-[90vw] bg-white border-l border-gray-200 shadow-[-12px_0_40px_-8px_rgba(0,0,0,0.35)] flex flex-col">
          {/* Header — glass chrome */}
          <div className="dbb-glass-chrome flex shrink-0 items-center justify-between gap-3 px-4 py-3">
            <h2 className="truncate text-dbb-lg font-semibold tracking-heading text-gray-900">{cardName}</h2>
            <button
              ref={closeBtnRef}
              onClick={handleClose}
              aria-label="Close"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-gray-500 transition-colors hover:bg-dbb-accent/10 hover:text-dbb-accent spring-press"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Scrollable single-column content */}
          <div className="flex-1 overflow-y-auto">
            <div className="space-y-5 p-4">
              {/* Card image — height-capped so name/price/sellers stay visible
                  below without scrolling on a typical ~900px viewport */}
              <div className="w-full flex justify-center">
                {cardLoading ? (
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

              {/* Card name (repeated for single-column flow) */}
              <div>
                <h3 className="text-dbb-xl font-semibold text-gray-900">{cardName}</h3>
              </div>

              {/* Price — prominent, red accent */}
              <div className="rounded-dbb-md bg-gray-50 p-4">
                <p className="mb-1 text-dbb-xs text-gray-600">CardKingdom Reference Price</p>
                {priceLoading ? (
                  <div className="flex items-center gap-1.5 text-dbb-xs text-gray-500">
                    <Loader2 className="h-3 w-3 animate-spin" /> Loading...
                  </div>
                ) : ckdPrice != null ? (
                  <div className="flex items-baseline gap-2">
                    <span className="text-2xl font-bold text-dbb-accent">${ckdPrice.toFixed(2)}</span>
                    <span className="text-dbb-xs text-gray-500">CKD USD</span>
                  </div>
                ) : (
                  <span className="text-dbb-xs text-gray-500">No price data available</span>
                )}
              </div>

              {/* Card metadata */}
              <div className="space-y-2 text-dbb-sm text-gray-600">
                {setName && (
                  <div>
                    <span className="text-gray-400">Set</span> · {setName}
                    {collectorNumber && <span className="ml-1 text-gray-500">#{collectorNumber}</span>}
                  </div>
                )}
                {rarity && (
                  <div>
                    <span className="text-gray-400">Rarity</span> ·{' '}
                    <span className={RARITY_COLORS[rarity] || 'text-gray-400'}>
                      {rarity.charAt(0).toUpperCase() + rarity.slice(1)}
                    </span>
                  </div>
                )}
                {typeLine && (
                  <div><span className="text-gray-400">Type</span> · {typeLine}</div>
                )}
                {oracleText && (
                  <div className="mt-2 whitespace-pre-line rounded-dbb-md bg-gray-50 p-3 text-dbb-xs leading-relaxed text-gray-600">
                    {oracleText}
                  </div>
                )}
              </div>

              {/* Sellers / listings — stacked vertically */}
              <div>
                <h3 className="mb-3 text-dbb-sm font-semibold text-gray-900">
                  {sellersLoading
                    ? 'Loading sellers...'
                    : sellers?.length === 0
                    ? 'No sellers available for this card'
                    : `${sellers.length} seller${sellers.length !== 1 ? 's' : ''}`}
                </h3>

                {sellersLoading ? (
                  <div className="flex items-center gap-2 py-3 text-dbb-xs text-gray-500">
                    <Loader2 className="h-4 w-4 animate-spin" /> Fetching listings...
                  </div>
                ) : sellers && sellers.length > 0 ? (
                  <div className="space-y-3">
                    {sellers.map(s => {
                      const slc = s.library_cards
                      const myr = computeMyr(ckdPrice, s.multiplier)
                      const foilBadge = slc?.foil && FOIL_BADGES[slc.foil]
                      const isSelected = selectedListingId === s.id
                      return (
                        <div
                          key={s.id}
                          className={`rounded-dbb-md border p-4 transition-colors ${
                            isSelected
                              ? 'border-dbb-accent bg-dbb-accent/10'
                              : 'border-gray-200 bg-white hover:border-gray-300'
                          }`}
                        >
                          {/* Row 1: Seller name + metadata */}
                          <div className="flex items-center flex-wrap gap-2 mb-3">
                            <User className="h-3.5 w-3.5 flex-shrink-0 text-gray-500" />
                            <button
                              onClick={() => setSellerPopupId(s.id)}
                              className="truncate text-left text-dbb-sm text-gray-600 transition-colors hover:text-dbb-accent"
                              title="View seller profile"
                            >
                              {s.seller_name || 'Seller'}
                            </button>
                            <span className="flex-shrink-0 rounded border border-gray-300 px-1.5 py-0.5 text-dbb-xs text-gray-500">
                              {slc?.condition || 'NM'}
                            </span>
                            {foilBadge && (
                              <span className={`flex-shrink-0 rounded border px-1.5 py-0.5 text-dbb-xs ${foilBadge.cls}`}>
                                {foilBadge.label}
                              </span>
                            )}
                            {s.quantity > 1 && (
                              <span className="flex-shrink-0 text-dbb-xs text-gray-500">
                                {s.quantity}×
                              </span>
                            )}
                          </div>
                          
                          {/* Row 2: Price + Select button */}
                          <div className="flex items-center justify-between gap-3 pt-2 border-t border-gray-100">
                            <div className="text-right">
                              <div className="text-dbb-lg font-bold text-dbb-accent">
                                {myr != null ? `RM ${myr.toFixed(2)}` : '—'}
                              </div>
                              <div className="text-dbb-xs text-gray-500">×{s.multiplier}</div>
                            </div>
                            <button
                              onClick={() => {
                                setSelectedListingId(s.id)
                                onSelectListing(s)
                              }}
                              className={`flex min-h-[44px] flex-shrink-0 items-center justify-center px-6 text-dbb-sm font-medium transition-colors spring-press ${
                                isSelected
                                  ? 'bg-dbb-accent text-white'
                                  : 'bg-dbb-accent/10 text-dbb-accent border border-dbb-accent/30 hover:bg-dbb-accent hover:text-white'
                              }`}
                            >
                              {isSelected ? (
                                <span className="flex items-center gap-1.5">✓ Selected</span>
                              ) : (
                                'Select'
                              )}
                            </button>
                          </div>

                          {/* Row 3: Condition proof button (full width) */}
                          <button
                            onClick={() => setProofListingId(s.id)}
                            className="flex min-h-[44px] w-full mt-3 items-center justify-center gap-1.5 rounded-dbb-md border border-gray-200 px-3 text-dbb-sm text-gray-600 transition-colors hover:border-dbb-accent hover:text-dbb-accent spring-press"
                          >
                            <Camera className="h-3.5 w-3.5" /> View card condition
                          </button>
                          
                          {(s.created_at || s.expires_at) && (
                            <p className="mt-2 text-dbb-xs text-gray-500">
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

          {/* Sticky footer — glass chrome top edge */}
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

      {/* Mobile: full-screen overlay (≤1023px) */}
      <div data-testid="bazaar-detail-sheet" className="lg:hidden fixed inset-0 z-50 bg-white overflow-y-auto">
        {/* Header — glass chrome */}
        <div className="sticky top-0 dbb-glass-chrome flex items-center justify-between gap-3 px-4 py-3">
          <h2 className="truncate text-dbb-lg font-semibold tracking-heading text-gray-900">{cardName}</h2>
          <button
            ref={closeBtnRef}
            onClick={handleClose}
            aria-label="Close"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-gray-500 transition-colors hover:bg-dbb-accent/10 hover:text-dbb-accent spring-press"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Scrollable single-column content */}
        <div className="space-y-5 p-4 pb-8">
          {/* Card image — height-capped, consistent with the desktop panel */}
          <div className="w-full flex justify-center">
            {cardLoading ? (
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

          {/* Card name */}
          <div>
            <h3 className="text-dbb-xl font-semibold text-gray-900">{cardName}</h3>
          </div>

          {/* Price */}
          <div className="rounded-dbb-md bg-gray-50 p-4">
            <p className="mb-1 text-dbb-xs text-gray-600">CardKingdom Reference Price</p>
            {priceLoading ? (
              <div className="flex items-center gap-1.5 text-dbb-xs text-gray-500">
                <Loader2 className="h-3 w-3 animate-spin" /> Loading...
              </div>
            ) : ckdPrice != null ? (
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-bold text-dbb-accent">${ckdPrice.toFixed(2)}</span>
                <span className="text-dbb-xs text-gray-500">CKD USD</span>
              </div>
            ) : (
              <span className="text-dbb-xs text-gray-500">No price data available</span>
            )}
          </div>

          {/* Card metadata */}
          <div className="space-y-2 text-dbb-sm text-gray-600">
            {setName && (
              <div>
                <span className="text-gray-400">Set</span> · {setName}
                {collectorNumber && <span className="ml-1 text-gray-500">#{collectorNumber}</span>}
              </div>
            )}
            {rarity && (
              <div>
                <span className="text-gray-400">Rarity</span> ·{' '}
                <span className={RARITY_COLORS[rarity] || 'text-gray-400'}>
                  {rarity.charAt(0).toUpperCase() + rarity.slice(1)}
                </span>
              </div>
            )}
            {typeLine && (
              <div><span className="text-gray-400">Type</span> · {typeLine}</div>
            )}
            {oracleText && (
              <div className="mt-2 whitespace-pre-line rounded-dbb-md bg-gray-50 p-3 text-dbb-xs leading-relaxed text-gray-600">
                {oracleText}
              </div>
            )}
          </div>

          {/* Sellers */}
          <div>
            <h3 className="mb-3 text-dbb-sm font-semibold text-gray-900">
              {sellersLoading
                ? 'Loading sellers...'
                : sellers?.length === 0
                ? 'No sellers available for this card'
                : `${sellers.length} seller${sellers.length !== 1 ? 's' : ''}`}
            </h3>

            {sellersLoading ? (
              <div className="flex items-center gap-2 py-3 text-dbb-xs text-gray-500">
                <Loader2 className="h-4 w-4 animate-spin" /> Fetching listings...
              </div>
            ) : sellers && sellers.length > 0 ? (
              <div className="space-y-3">
                {sellers.map(s => {
                  const slc = s.library_cards
                  const myr = computeMyr(ckdPrice, s.multiplier)
                  const foilBadge = slc?.foil && FOIL_BADGES[slc.foil]
                  const isSelected = selectedListingId === s.id
                  return (
                    <div
                      key={s.id}
                      className={`rounded-dbb-md border p-4 transition-colors ${
                        isSelected
                          ? 'border-dbb-accent bg-dbb-accent/10'
                          : 'border-gray-200 bg-white'
                      }`}
                    >
                      {/* Row 1: Seller name + metadata */}
                      <div className="flex items-center flex-wrap gap-2 mb-3">
                        <User className="h-3.5 w-3.5 flex-shrink-0 text-gray-500" />
                        <button
                          onClick={() => setSellerPopupId(s.id)}
                          className="truncate text-left text-dbb-sm text-gray-600 transition-colors hover:text-dbb-accent"
                          title="View seller profile"
                        >
                          {s.seller_name || 'Seller'}
                        </button>
                        <span className="flex-shrink-0 rounded border border-gray-300 px-1.5 py-0.5 text-dbb-xs text-gray-500">
                          {slc?.condition || 'NM'}
                        </span>
                        {foilBadge && (
                          <span className={`flex-shrink-0 rounded border px-1.5 py-0.5 text-dbb-xs ${foilBadge.cls}`}>
                            {foilBadge.label}
                          </span>
                        )}
                        {s.quantity > 1 && (
                          <span className="flex-shrink-0 text-dbb-xs text-gray-500">
                            {s.quantity}×
                          </span>
                        )}
                      </div>
                      
                      {/* Row 2: Price + Select button */}
                      <div className="flex items-center justify-between gap-3 pt-2 border-t border-gray-100">
                        <div className="text-right">
                          <div className="text-dbb-lg font-bold text-dbb-accent">
                            {myr != null ? `RM ${myr.toFixed(2)}` : '—'}
                          </div>
                          <div className="text-dbb-xs text-gray-500">×{s.multiplier}</div>
                        </div>
                        <button
                          onClick={() => {
                            setSelectedListingId(s.id)
                            onSelectListing(s)
                          }}
                          className={`flex min-h-[44px] flex-shrink-0 items-center justify-center px-6 text-dbb-sm font-medium transition-colors spring-press ${
                            isSelected
                              ? 'bg-dbb-accent text-white'
                              : 'bg-dbb-accent/10 text-dbb-accent border border-dbb-accent/30 hover:bg-dbb-accent hover:text-white'
                          }`}
                        >
                          {isSelected ? (
                            <span className="flex items-center gap-1.5">✓ Selected</span>
                          ) : (
                            'Select'
                          )}
                        </button>
                      </div>
                      
                      {/* Row 3: Condition proof button */}
                      <button
                        onClick={() => setProofListingId(s.id)}
                        className="flex min-h-[44px] w-full mt-3 items-center justify-center gap-1.5 rounded-dbb-md border border-gray-200 px-3 text-dbb-sm text-gray-600 transition-colors hover:border-dbb-accent hover:text-dbb-accent spring-press"
                      >
                        <Camera className="h-3.5 w-3.5" /> View card condition
                      </button>
                      
                      {(s.created_at || s.expires_at) && (
                        <p className="mt-2 text-dbb-xs text-gray-500">
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
