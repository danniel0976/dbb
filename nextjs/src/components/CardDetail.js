'use client'

import { useState } from 'react'
import Image from 'next/image'
import { X, Copy, Check, Sparkles } from 'lucide-react'
import { priceUtils, generateCaption } from '../lib/supabase'

const rarityLabels = {
  common: 'Common',
  uncommon: 'Uncommon',
  rare: 'Rare',
  mythic: 'Mythic Rare',
}

const rarityColors = {
  common: 'bg-rarity-common',
  uncommon: 'bg-rarity-uncommon',
  rare: 'bg-rarity-rare',
  mythic: 'bg-rarity-mythic',
}

const colorMap = {
  W: { name: 'White', class: 'bg-white text-black border-gray-300' },
  U: { name: 'Blue', class: 'bg-blue-500 text-white border-blue-600' },
  B: { name: 'Black', class: 'bg-gray-800 text-white border-gray-900' },
  R: { name: 'Red', class: 'bg-red-500 text-white border-red-600' },
  G: { name: 'Green', class: 'bg-green-500 text-white border-green-600' },
}

export default function CardDetail({ card, onClose, onCopyCaption }) {
  const [multiplier, setMultiplier] = useState(2.8)
  const [copied, setCopied] = useState(false)

  const hasCKPrice = card.ckd_usd_price !== null && card.ckd_usd_price !== undefined
  const foilType = card.foil_type || (card.is_foil ? 'foil' : 'nonfoil')
  const isEtched = foilType === 'etched'

  // Selling prices: CKD USD × multiplier (ckd_usd_price already reflects the correct finish price)
  const prices = hasCKPrice ? {
    2.5: card.myr_price_2_5,
    2.8: card.myr_price_2_8,
    3.0: card.myr_price_3_0,
  } : null

  const selectedPrice = prices ? prices[multiplier] : null

  // Reference foil/etched prices for comparison (non-foil cards only)
  const hasCKFoilPrice = card.ckd_foil_price !== null && card.ckd_foil_price !== undefined
  const hasCKEtchedPrice = card.ckd_etched_price !== null && card.ckd_etched_price !== undefined
  const foilPrices = !card.is_foil && hasCKFoilPrice ? {
    2.5: Math.round(card.ckd_foil_price * 2.5 * 2) / 2,
    2.8: Math.round(card.ckd_foil_price * 2.8 * 2) / 2,
    3.0: Math.round(card.ckd_foil_price * 3.0 * 2) / 2,
  } : null
  const etchedPrices = !card.is_foil && hasCKEtchedPrice ? {
    2.5: Math.round(card.ckd_etched_price * 2.5 * 2) / 2,
    2.8: Math.round(card.ckd_etched_price * 2.8 * 2) / 2,
    3.0: Math.round(card.ckd_etched_price * 3.0 * 2) / 2,
  } : null

  const handleCopy = async () => {
    await onCopyCaption(card, multiplier)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/80 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative bg-dbb-secondary rounded-xl shadow-2xl max-w-4xl w-full max-h-[90vh] overflow-y-auto">
        {/* Close Button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-2 hover:bg-dbb-primary rounded-lg transition-colors z-10"
        >
          <X className="w-6 h-6" />
        </button>

        <div className="grid md:grid-cols-2 gap-6 p-6">
          {/* Left: Card Image */}
          <div className="space-y-4">
            <div className="relative aspect-[2/3] rounded-lg overflow-hidden border-2 border-dbb-accent/30 bg-dbb-primary">
              {card.image_png_url ? (
                <Image
                  src={card.image_png_url}
                  alt={card.card_name}
                  fill
                  className="object-contain"
                  sizes="(max-width: 768px) 100vw, 50vw"
                  priority
                />
              ) : (
                <div className="w-full h-full bg-dbb-primary flex items-center justify-center">
                  <span className="text-gray-600">No Image Available</span>
                </div>
              )}
              
              {card.is_foil && (
                <div className="absolute top-3 right-3 bg-gradient-to-r from-yellow-400 to-orange-500 text-black text-sm font-bold px-3 py-1.5 rounded-full shadow-lg flex items-center gap-1">
                  <Sparkles className="w-4 h-4" />
                  {isEtched ? 'ETCHED' : foilType === 'surge_foil' ? 'SURGE' : 'FOIL'}
                </div>
              )}
            </div>
          </div>

          {/* Right: Card Details */}
          <div className="space-y-6">
            {/* Header */}
            <div>
              <h2 className="text-2xl font-bold mb-2">{card.card_name}</h2>
              
              <div className="flex items-center gap-3 flex-wrap">
                {/* Rarity Badge */}
                <span className={`px-3 py-1 rounded-full text-xs font-bold text-black ${rarityColors[card.rarity]}`}>
                  {rarityLabels[card.rarity]}
                </span>
                
                {/* Collector Number */}
                <span className="text-sm text-gray-400">
                  #{card.collector_number?.padStart(4, '0') ?? '????'}
                </span>
                
                {/* Set Code */}
                <span className="text-sm text-gray-400 bg-dbb-primary px-2 py-1 rounded">
                  {card.set_code}
                </span>
              </div>

              {/* Colors */}
              {card.colors && card.colors.length > 0 && (
                <div className="flex items-center gap-2 mt-3">
                  <span className="text-xs text-gray-400">Colors:</span>
                  <div className="flex gap-1">
                    {card.colors.map((color) => (
                      <span
                        key={color}
                        className={`w-6 h-6 rounded-full ${colorMap[color]?.class || 'bg-gray-600'} 
                          border flex items-center justify-center text-xs font-bold`}
                        title={colorMap[color]?.name}
                      >
                        {color}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Card Type */}
            {card.card_type && (
              <div>
                <h3 className="text-sm font-semibold text-gray-400 mb-1">Type</h3>
                <p className="text-sm">{card.card_type}</p>
              </div>
            )}

            {/* Pricing */}
            <div className="bg-dbb-primary rounded-lg p-4 space-y-4">
              {hasCKPrice ? (
                <>
                  {/* Hero Price */}
                  <div className="text-center py-2">
                    <div className="text-3xl font-bold text-dbb-accent">
                      {priceUtils.formatMYR(selectedPrice)}
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                      Selling price @ {multiplier}× multiplier
                    </div>
                  </div>

                  {/* Multiplier Selector */}
                  <div className="grid grid-cols-3 gap-2">
                    {[2.5, 2.8, 3.0].map((mult) => (
                      <button
                        key={mult}
                        onClick={() => setMultiplier(mult)}
                        className={`
                          p-2 rounded-lg text-center transition-all
                          ${multiplier === mult 
                            ? 'bg-dbb-accent text-white' 
                            : 'bg-dbb-secondary hover:bg-dbb-primary border border-gray-700'}
                        `}
                      >
                        <div className="text-xs opacity-75">{mult}×</div>
                        <div className="font-bold text-sm">
                          RM {prices[mult]?.toFixed(2) || 'N/A'}
                        </div>
                      </button>
                    ))}
                  </div>

                  {/* Foil/Etched reference prices (for non-foil cards only) */}
                  {foilPrices && (
                    <div>
                      <div className="text-xs text-gray-500 mb-1">✨ Foil price (FYI)</div>
                      <div className="grid grid-cols-3 gap-2">
                        {[2.5, 2.8, 3.0].map((mult) => (
                          <div key={mult} className="p-2 rounded-lg text-center bg-yellow-900/20 border border-yellow-600/30">
                            <div className="text-xs opacity-75 text-yellow-400">{mult}×</div>
                            <div className="font-bold text-sm text-yellow-400">
                              RM {foilPrices[mult]?.toFixed(2) || 'N/A'}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {etchedPrices && (
                    <div>
                      <div className="text-xs text-gray-500 mb-1">⬡ Etched price (FYI)</div>
                      <div className="grid grid-cols-3 gap-2">
                        {[2.5, 2.8, 3.0].map((mult) => (
                          <div key={mult} className="p-2 rounded-lg text-center bg-purple-900/20 border border-purple-600/30">
                            <div className="text-xs opacity-75 text-purple-400">{mult}×</div>
                            <div className="font-bold text-sm text-purple-400">
                              RM {etchedPrices[mult]?.toFixed(2) || 'N/A'}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Price Info */}
                  <div className="pt-3 border-t border-gray-700 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-gray-400">
                        CKD USD {isEtched ? '(Etched)' : card.is_foil && foilType !== 'nonfoil' ? '(Foil)' : ''}
                      </span>
                      <span className="font-semibold">{priceUtils.formatUSD(card.ckd_usd_price)}</span>
                    </div>
                    {!card.is_foil && hasCKFoilPrice && (
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-gray-400">CKD USD (Foil)</span>
                        <span className="font-semibold text-yellow-400">{priceUtils.formatUSD(card.ckd_foil_price)}</span>
                      </div>
                    )}
                    {!card.is_foil && hasCKEtchedPrice && (
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-gray-400">CKD USD (Etched)</span>
                        <span className="font-semibold text-purple-400">{priceUtils.formatUSD(card.ckd_etched_price)}</span>
                      </div>
                    )}
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-gray-400">Source</span>
                      <span className="text-sm">CardKingdom</span>
                    </div>
                  </div>

                </>
              ) : (
                <div className="text-center py-4">
                  <p className="text-gray-400 text-lg font-semibold">N/A</p>
                  <p className="text-xs text-gray-500 mt-1">No CardKingdom price available</p>
                </div>
              )}
            </div>

            {/* Copy as Caption */}
            <button
              onClick={handleCopy}
              className={`
                w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg font-semibold transition-all
                ${copied 
                  ? 'bg-green-600 text-white' 
                  : 'bg-dbb-accent hover:bg-red-600 text-white'}
              `}
            >
              {copied ? <><Check className="w-4 h-4" /> Copied!</> : <><Copy className="w-4 h-4" /> Copy as Caption</>}
            </button>
            <p className="text-xs text-gray-500 text-center -mt-3">
              Copies formatted caption for Facebook posts
            </p>

            {/* CardKingdom Purchase Link — routes to correct finish-specific product */}
            {(() => {
              const ckUrl = isEtched
                ? (card.ck_etched_product_url || card.ck_product_url)
                : card.is_foil
                  ? (card.ck_foil_product_url || card.ck_product_url)
                  : card.ck_product_url
              return ckUrl ? (
                <a
                  href={ckUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block w-full text-center py-2.5 px-4 rounded-lg bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 text-white font-semibold transition-all hover:shadow-lg hover:shadow-purple-500/25"
                >
                  🛒 View on CardKingdom
                </a>
              ) : (
                <a
                  href={`https://www.cardkingdom.com/mtg-singles/${card.card_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block w-full text-center py-2.5 px-4 rounded-lg bg-gradient-to-r from-purple-600/50 to-blue-600/50 hover:from-purple-600/70 hover:to-blue-600/70 text-white font-semibold transition-all hover:shadow-lg hover:shadow-purple-500/25 opacity-70"
                  title="Best-guess link — may not match exact printing"
                >
                  🛒 Search on CardKingdom
                </a>
              )
            })()}

            {/* Additional Info */}
            <div className="text-xs text-gray-500 space-y-1 pt-4 border-t border-gray-700">
              <div>Condition: {card.condition || 'NM'}</div>
              {hasCKPrice && card.pricing_source && (
                <>
                  <div>Price Source: {card.pricing_source}</div>
                  {card.pricing_last_updated && (
                    <div>Prices Updated: {new Date(card.pricing_last_updated).toLocaleString('en-MY')}</div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}