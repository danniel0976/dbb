'use client'

import Image from 'next/image'
import { priceUtils } from '../lib/supabase'

const raritySymbols = {
  common: 'C',
  uncommon: 'U',
  rare: 'R',
  mythic: 'M',
}

const rarityBorderColors = {
  common: 'border-rarity-common',
  uncommon: 'border-rarity-uncommon',
  rare: 'border-rarity-rare',
  mythic: 'border-rarity-mythic',
}

export default function CardGrid({ cards, onCardClick }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-4 xl:grid-cols-5 gap-4">
      {cards.map((card) => (
        <CardItem 
          key={card.id} 
          card={card} 
          onClick={() => onCardClick(card)}
        />
      ))}
    </div>
  )
}

function CardItem({ card, onClick }) {
  const imageUrl = card.image_crop_url || card.image_png_url
  
  return (
    <div
      onClick={onClick}
      className={`
        group relative bg-dbb-secondary rounded-lg overflow-hidden
        border-2 ${rarityBorderColors[card.rarity]}
        card-hover cursor-pointer
      `}
    >
      {/* Card Image */}
      <div className="aspect-[2/3] relative bg-dbb-primary">
        {imageUrl ? (
          <Image
            src={imageUrl}
            alt={card.card_name}
            fill
            className="object-contain"
            sizes="(max-width: 640px) 50vw, (max-width: 768px) 33vw, (max-width: 1024px) 25vw, 20vw"
          />
        ) : (
          <div className="w-full h-full bg-dbb-primary flex items-center justify-center">
            <span className="text-gray-600 text-xs text-center p-2">
              No Image
            </span>
          </div>
        )}
        
        {/* Foil Badge */}
        {card.is_foil && (
          <div className="absolute top-2 right-2 bg-gradient-to-r from-yellow-400 to-orange-500 text-black text-xs font-bold px-2 py-1 rounded-full shadow-lg">
            ✨ FOIL
          </div>
        )}
        
        {/* Overlay on hover */}
        <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex items-center justify-center">
          <span className="text-white font-semibold text-sm">View Details</span>
        </div>
      </div>

      {/* Card Info */}
      <div className="p-3 space-y-2">
        {/* Name */}
        <h3 className="font-semibold text-sm truncate" title={card.card_name}>
          {card.card_name}
        </h3>

        {/* Set and Collector Number */}
        <div className="flex items-center justify-between text-xs text-gray-400">
          <span>{card.set_code}</span>
          <span className="flex items-center gap-1">
            <span className={getRarityColor(card.rarity)}>
              {raritySymbols[card.rarity]}
            </span>
            <span>{card.collector_number.padStart(4, '0')}</span>
          </span>
        </div>

        {/* Price */}
        <div className="pt-2 border-t border-gray-700">
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-400">CKD</span>
            <span className="text-xs text-gray-400">
              {priceUtils.formatUSD(card.ckd_usd_price)}
            </span>
          </div>
          <div className="text-dbb-accent font-bold text-sm mt-1">
            {priceUtils.formatMYR(card.myr_price_2_8)}
            <span className="text-xs text-gray-500 ml-1">@2.8×</span>
          </div>
        </div>
      </div>
    </div>
  )
}

function getRarityColor(rarity) {
  switch (rarity) {
    case 'mythic':
      return 'text-rarity-mythic'
    case 'rare':
      return 'text-rarity-rare'
    case 'uncommon':
      return 'text-rarity-uncommon'
    default:
      return 'text-rarity-common'
  }
}
