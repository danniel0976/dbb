'use client'

import { useState, useEffect } from 'react'
import { Camera } from 'lucide-react'

const FOIL_BADGE = {
  foil: { label: 'Foil', cls: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30' },
  etched: { label: 'Etched', cls: 'bg-purple-500/20 text-purple-400 border-purple-500/30' },
}

const RARITY_COLORS = {
  mythic: 'text-rarity-mythic',
  rare: 'text-rarity-rare',
  uncommon: 'text-rarity-uncommon',
  common: 'text-gray-500 dark:text-gray-400',
}

export default function ClaimSaleCard({ listing, onClick }) {
  const lc = listing.library_cards
  const ci = lc?.card_index
  const [imageUrl, setImageUrl] = useState(null)
  const [imgLoaded, setImgLoaded] = useState(false)
  const [myrPrice, setMyrPrice] = useState(null)
  const [priceLoading, setPriceLoading] = useState(true)
  const [hasPhoto, setHasPhoto] = useState(false)

  // Fetch card image from Scryfall
  useEffect(() => {
    if (!lc?.scryfall_id) return
    const cacheKey = `sf_img_${lc.scryfall_id}`
    const cached = sessionStorage.getItem(cacheKey)
    if (cached) { setImageUrl(cached); return }

    fetch(`https://api.scryfall.com/cards/${lc.scryfall_id}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data) return
        const url = data.image_uris?.normal || data.card_faces?.[0]?.image_uris?.normal
        if (url) {
          sessionStorage.setItem(cacheKey, url)
          setImageUrl(url)
        }
      })
      .catch(() => {})
  }, [lc?.scryfall_id])

  // Fetch CKD price to compute MYR listing price
  useEffect(() => {
    if (!lc?.scryfall_id) { setPriceLoading(false); return }

    const foilType = lc.foil || 'normal'
    fetch('/api/pricing/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ scryfall_id: lc.scryfall_id, foil: foilType }] }),
    })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        const key = `${lc.scryfall_id}:${foilType}`
        const entry = data?.prices?.[key]
        const multiplier = Number(listing.multiplier)
        let myr = null
        if (entry?.ckd_usd != null) {
          myr = Math.round(entry.ckd_usd * multiplier * 2) / 2
        }
        setMyrPrice(myr)
      })
      .catch(() => {})
      .finally(() => setPriceLoading(false))
  }, [lc?.scryfall_id, lc?.foil, listing.multiplier])

  // Check if this card has a condition photo
  useEffect(() => {
    if (!lc?.id) return
    fetch(`/api/photos/${lc.id}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { setHasPhoto(!!data?.hasPhoto) })
      .catch(() => {})
  }, [lc?.id])

  const foilBadge = lc?.foil && FOIL_BADGE[lc.foil]
  const rarityColor = RARITY_COLORS[ci?.rarity] || 'text-gray-500 dark:text-gray-400'

  return (
    <div
      className="group relative bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-dbb-tertiary/40 rounded-dbb overflow-hidden card-hover cursor-pointer"
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClick?.() }}
    >
      {/* Card image */}
      <div className="relative aspect-[2/3] bg-gray-100 dark:bg-dbb-primary">
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
        {foilBadge && (
          <span className={`absolute top-1.5 right-1.5 text-[10px] font-medium border rounded px-1.5 py-0.5 ${foilBadge.cls}`}>
            {foilBadge.label}
          </span>
        )}
        {/* Condition photo indicator */}
        {hasPhoto && (
          <span className="absolute top-1.5 left-1.5 flex items-center gap-0.5 text-[10px] font-medium bg-black/60 text-white border border-white/20 rounded px-1.5 py-0.5">
            <Camera size={10} />
            Photo
          </span>
        )}
      </div>

      {/* Info */}
      <div className="p-2.5 space-y-1.5">
        <p className="text-dbb-sm font-medium text-gray-900 dark:text-white leading-tight line-clamp-2">
          {ci?.name || '—'}
        </p>

        <div className="flex items-center gap-1.5 text-[10px]">
          <span className={rarityColor}>{ci?.rarity || ''}</span>
          {ci?.set_code && (
            <span className="text-gray-500 dark:text-gray-600">· {ci.set_code.toUpperCase()}</span>
          )}
        </div>

        <div className="flex items-center gap-1 text-[10px] text-gray-500">
          <span className="border border-gray-200 dark:border-dbb-tertiary/50 rounded px-1 py-0.5">{lc?.condition || 'NM'}</span>
          {ci?.collector_number && (
            <span className="text-gray-500 dark:text-gray-600">#{ci.collector_number}</span>
          )}
        </div>

        {/* Price — computed from multiplier */}
        <div className="pt-1 border-t border-gray-200 dark:border-dbb-tertiary/30">
          {priceLoading ? (
            <div className="h-4 skeleton rounded w-16" />
          ) : myrPrice != null ? (
            <p className="text-dbb-sm font-semibold price-green">
              RM {myrPrice.toFixed(2)}
              <span className="ml-1.5 text-[10px] text-gray-500 font-normal">
                ×{listing.multiplier}
              </span>
            </p>
          ) : (
            <p className="text-dbb-xs text-gray-500 dark:text-gray-600">Price unavailable</p>
          )}
        </div>
      </div>
    </div>
  )
}