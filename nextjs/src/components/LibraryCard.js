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

const RARITY_BORDER = {
  common: 'border-rarity-common',
  uncommon: 'border-rarity-uncommon',
  rare: 'border-rarity-rare',
  mythic: 'border-rarity-mythic',
}

export default function LibraryCard({ libraryRow, onStar, onDelete, onOpen }) {
  const [imageUrl, setImageUrl] = useState(null)
  const [imgLoaded, setImgLoaded] = useState(false)
  const [imgError, setImgError] = useState(false)

  const ci = libraryRow.card_index
  const isFoil = libraryRow.foil !== 'normal'
  const rarity = ci?.rarity || 'common'

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

  return (
    <div
      className={`
        group relative bg-dbb-secondary rounded-lg overflow-hidden
        border-2 ${RARITY_BORDER[rarity] || 'border-gray-700'}
        card-hover cursor-pointer flex flex-col
        ${isFoil ? 'foil-card' : ''}
      `}
    >
      {/* Image area */}
      <div
        className="aspect-[2/3] relative bg-dbb-primary"
        onClick={() => onOpen(libraryRow)}
      >
        {!imgLoaded && !imgError && (
          <div className="absolute inset-0 skeleton rounded-t-lg" />
        )}
        {imageUrl && !imgError && (
          <img
            src={imageUrl}
            alt={ci?.name || 'Card'}
            className={`w-full h-full object-cover transition-opacity duration-300 ${imgLoaded ? 'opacity-100' : 'opacity-0'}`}
            onLoad={() => setImgLoaded(true)}
            onError={() => setImgError(true)}
          />
        )}
        {imgError && (
          <div className="absolute inset-0 flex items-center justify-center p-2">
            <span className="text-gray-500 text-xs text-center">{ci?.name || 'Unknown card'}</span>
          </div>
        )}

        {/* Qty badge */}
        {libraryRow.quantity > 1 && (
          <div className="absolute top-1.5 left-1.5 bg-black/80 text-white text-xs font-bold px-1.5 py-0.5 rounded">
            ×{libraryRow.quantity}
          </div>
        )}

        {/* Foil badge */}
        {isFoil && (
          <div className="absolute top-1.5 right-1.5 bg-gradient-to-r from-purple-500 to-pink-500 text-white text-xs font-bold px-1.5 py-0.5 rounded">
            {libraryRow.foil === 'etched' ? 'ETCHED' : 'FOIL'}
          </div>
        )}

        {/* Hover overlay */}
        <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
          <span className="text-white text-xs font-semibold">View Details</span>
        </div>
      </div>

      {/* Card info */}
      <div className="p-2 flex flex-col gap-1">
        <div className="flex items-start justify-between gap-1">
          <h3 className="text-xs font-semibold truncate flex-1 leading-tight" title={ci?.name}>
            {ci?.name || '—'}
          </h3>
          <button
            onClick={(e) => { e.stopPropagation(); onStar(libraryRow) }}
            className={`flex-shrink-0 p-0.5 rounded transition-colors ${
              libraryRow.starred
                ? 'text-yellow-400 hover:text-yellow-300'
                : 'text-gray-600 hover:text-yellow-400'
            }`}
            title={libraryRow.starred ? 'Unstar' : 'Star'}
          >
            <Star className="w-3.5 h-3.5" fill={libraryRow.starred ? 'currentColor' : 'none'} />
          </button>
        </div>

        <div className="flex items-center justify-between gap-1">
          <span className="text-gray-500 text-xs uppercase">{ci?.set_code}</span>
          <span className={`text-xs px-1 py-0.5 rounded font-medium ${CONDITION_COLORS[libraryRow.condition] || 'bg-gray-700 text-gray-300'}`}>
            {libraryRow.condition}
          </span>
        </div>
      </div>
    </div>
  )
}
