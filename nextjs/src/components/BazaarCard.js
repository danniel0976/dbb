'use client'

import { useState, useEffect } from 'react'

const FOIL_BADGE = {
  foil: { label: 'F', cls: 'bg-yellow-400/90 text-black' },
  etched: { label: 'E', cls: 'bg-purple-400/90 text-black' },
}

// Small corner dot only — rarity no longer gets a competing full text row.
const RARITY_DOT = {
  mythic: 'bg-rarity-mythic',
  rare: 'bg-rarity-rare',
  uncommon: 'bg-rarity-uncommon',
  common: 'bg-gray-400 dark:bg-gray-500',
}

export default function BazaarCard({ listing, onClick, priceData, variant = 'results' }) {
  const lc = listing.library_cards
  const ci = lc?.card_index
  const storedImage = ci?.image_uris?.small || ci?.image_uris?.normal || null
  const [imageUrl, setImageUrl] = useState(storedImage)
  const [imgLoaded, setImgLoaded] = useState(false)

  // Catalog images avoid one external Scryfall request per tile. Retain the
  // fallback for old catalog rows that predate stored image URIs.
  useEffect(() => {
    if (storedImage) {
      setImageUrl(storedImage)
      return
    }
    if (!lc?.scryfall_id) return
    const cacheKey = `sf_img_${lc.scryfall_id}`
    const cached = sessionStorage.getItem(cacheKey)
    if (cached) { setImageUrl(cached); return }

    fetch(`https://api.scryfall.com/cards/${lc.scryfall_id}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data) return
        const url = data.image_uris?.small
          || data.card_faces?.[0]?.image_uris?.small
          || data.image_uris?.normal
          || data.card_faces?.[0]?.image_uris?.normal
        if (url) {
          sessionStorage.setItem(cacheKey, url)
          setImageUrl(url)
        }
      })
      .catch(() => {})
  }, [lc?.scryfall_id, storedImage])

  const multiplier = Number(listing.multiplier)
  const myrPrice = priceData?.ckd_usd != null
    ? Math.round(priceData.ckd_usd * multiplier * 2) / 2
    : null
  const priceLoading = priceData === undefined

  const foilBadge = lc?.foil && FOIL_BADGE[lc.foil]
  const rarityDot = RARITY_DOT[ci?.rarity] || RARITY_DOT.common

  return (
    <div
      className={`group relative overflow-hidden rounded-dbb-lg border border-black/[0.05] bg-white shadow-dbb-sm transition duration-200 hover:-translate-y-0.5 hover:shadow-dbb-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-dbb-accent dark:border-white/[0.07] dark:bg-dbb-secondary ${variant === 'showcase' ? 'bazaar-card--showcase' : 'bazaar-card--results'}`}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClick?.() }}
    >
      {/* Artwork — ~74% of tile height, native card aspect ratio preserved
          (never cropped/stretched: object-contain preserves the full card). */}
      <div className="relative aspect-[5/7] bg-gray-100 dark:bg-dbb-primary rounded-t-dbb-lg overflow-hidden">
        {!imgLoaded && !imageUrl && (
          <div className="w-full h-full card-skeleton" />
        )}
        {imageUrl && (
          <img
            src={imageUrl}
            alt={ci?.name || 'Card'}
            className={`w-full h-full object-contain transition-opacity duration-300 ${imgLoaded ? 'opacity-100' : 'opacity-0'}`}
            onLoad={() => setImgLoaded(true)}
            loading="lazy"
          />
        )}

        {/* Rarity indicator — subtle corner dot, not a text row */}
        <span
          className={`absolute top-2 left-2 w-2.5 h-2.5 rounded-full ring-1 ring-white/70 dark:ring-black/40 ${rarityDot}`}
          aria-label={ci?.rarity || undefined}
        />

        {/* Foil/etched — small image-overlay badge, not a separate text row */}
        {foilBadge && (
          <span
            className={`absolute top-2 right-2 w-5 h-5 flex items-center justify-center rounded-full text-[10px] font-bold shadow-dbb-sm ${foilBadge.cls}`}
            aria-label={foilBadge.label === 'F' ? 'Foil' : 'Etched'}
          >
            {foilBadge.label}
          </span>
        )}
      </div>

      {/* Info — 16px inset */}
      <div className="p-4 space-y-1.5">
        <p className="text-sm font-medium text-gray-900 dark:text-white leading-tight line-clamp-2">
          {ci?.name || '—'}
        </p>

        {/* Price — visually dominant, always visible */}
        {priceLoading ? (
          <div className="h-5 skeleton rounded w-20" />
        ) : myrPrice != null ? (
          <p className="text-dbb-base font-semibold text-dbb-price leading-tight">
            RM {myrPrice.toFixed(2)}
          </p>
        ) : (
          <p className="text-xs text-gray-500 dark:text-gray-600">Price unavailable</p>
        )}

        {/* One quiet metadata line: set · condition · seller count */}
        <p className="text-[11px] text-gray-500 dark:text-gray-500 truncate">
          {ci?.set_code ? ci.set_code.toUpperCase() : ''}
          {ci?.set_code && ' · '}
          {lc?.condition || 'NM'}
          {' · '}
          {listing.seller_count || 1} {(listing.seller_count || 1) === 1 ? 'seller' : 'sellers'}
        </p>
      </div>
    </div>
  )
}
