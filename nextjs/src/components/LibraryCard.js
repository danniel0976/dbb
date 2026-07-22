'use client'

import { useState, useEffect } from 'react'
import { getCardById, getImageUrl } from '@/lib/scryfall'
import { Star } from 'lucide-react'

const CONDITION_COLORS = {
  M: 'bg-emerald-700 text-white',
  NM: 'bg-emerald-600 text-white',
  LP: 'bg-yellow-600 text-white',
  MP: 'bg-orange-600 text-white',
  HP: 'bg-red-700 text-white',
  DMG: 'bg-red-900 text-white',
}

export default function LibraryCard({ libraryRow, onStar, onDelete, onOpen, dimmed, priceData }) {
  const [imageUrl, setImageUrl] = useState(null)
  const [imgLoaded, setImgLoaded] = useState(false)
  const [imgError, setImgError] = useState(false)

  const ci = libraryRow.card_index
  const isFoil = libraryRow.foil !== 'normal'
  useEffect(() => {
    let cancelled = false
    getCardById(libraryRow.scryfall_id)
      .then(data => {
        if (!cancelled) setImageUrl(getImageUrl(data))
      })
      .catch(() => {
        if (!cancelled) setImgError(true)
      })
    return () => { cancelled = true }
  }, [libraryRow.scryfall_id])

  const myrPrice = priceData?.myr_3_0 ?? null

  const handleOpenKeyDown = (event) => {
    if ((event.key === 'Enter' || event.key === ' ') && onOpen) {
      event.preventDefault()
      onOpen(libraryRow)
    }
  }

  return (
    <article
      className={['group relative flex flex-col overflow-hidden rounded-dbb-lg bg-white shadow-dbb-sm spring-press transition-shadow duration-200', isFoil && 'foil-card', dimmed && 'opacity-50'].filter(Boolean).join(' ')}
    >
      {/* Image area */}
      <div
        role="button"
        tabIndex={0}
        aria-label={`View details for ${ci?.name || 'card'}`}
        onKeyDown={handleOpenKeyDown}
        className="relative aspect-[5/7] cursor-pointer bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dbb-accent"
        onClick={() => onOpen(libraryRow)}
      >
        {!imgLoaded && !imgError && (
          <div className="absolute inset-0 card-skeleton" />
        )}
        {imageUrl && !imgError && (
          <img
            src={imageUrl}
            alt={ci?.name || 'Card'}
            className={`h-full w-full object-contain transition-opacity duration-300 ${imgLoaded ? 'opacity-100' : 'opacity-0'}`}
            onLoad={() => setImgLoaded(true)}
            onError={() => setImgError(true)}
            loading="lazy"
          />
        )}
        {imgError && (
          <div className="absolute inset-0 flex items-center justify-center p-2">
            <span className="text-gray-400 text-xs text-center">{ci?.name || 'Unknown card'}</span>
          </div>
        )}

        {/* Qty badge */}
        {libraryRow.quantity > 1 && (
          <div className="absolute left-2 top-2 rounded-full bg-black/75 px-2 py-1 text-[11px] font-semibold text-white">
            ×{libraryRow.quantity}
          </div>
        )}

        {/* Foil/etched — small badge, bottom-left (mirrors the qty badge's
            top-left placement) so it never competes with Star's top-right
            corner. The .foil-card spectrum border on the article is the
            primary foil signal; this badge only disambiguates foil vs
            etched at a glance. */}
        {isFoil && (
          <div
            className={`absolute left-2 bottom-2 flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold shadow-dbb-sm ${
              libraryRow.foil === 'etched' ? 'bg-purple-400/90 text-black' : 'bg-yellow-400/90 text-black'
            }`}
            aria-label={libraryRow.foil === 'etched' ? 'Etched' : 'Foil'}
          >
            {libraryRow.foil === 'etched' ? 'E' : 'F'}
          </div>
        )}

        {/* Star remains visible without relying on hover or a detail view. */}
        {onStar && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onStar(libraryRow) }}
            className={['absolute right-2 top-2 flex h-11 w-11 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white', libraryRow.starred ? 'text-yellow-300' : 'text-white/80 hover:text-yellow-200'].join(' ')}
            title={libraryRow.starred ? 'Unstar' : 'Star'}
            aria-label={libraryRow.starred ? `Unstar ${ci?.name || 'card'}` : `Star ${ci?.name || 'card'}`}
            aria-pressed={libraryRow.starred}
          >
            <Star className="h-[19px] w-[19px]" fill={libraryRow.starred ? 'currentColor' : 'none'} />
          </button>
        )}
      </div>

      {/* Card info */}
      <div className="flex flex-col gap-1.5 p-3">
        <div className="min-w-0">
          <h3 className="truncate text-dbb-sm font-semibold leading-tight text-gray-900" title={ci?.name}>
            {ci?.name || '—'}
          </h3>
        </div>

        <div className="flex min-w-0 items-center gap-1.5 text-xs text-gray-500">
          <span className="truncate uppercase tracking-wide">{ci?.set_code || '—'}</span>
          <span aria-hidden="true" className="text-gray-300">·</span>
          <span className="truncate font-medium text-gray-600">
            {libraryRow.condition || '—'}
          </span>
        </div>

        {/* Price remains visible on the card face, including before pricing resolves. */}
        <div className="pt-0.5">
          <span className="text-dbb-sm font-semibold text-dbb-price">
            RM {myrPrice != null ? myrPrice.toFixed(2) : '—'}
          </span>
        </div>
      </div>
    </article>
  )
}
