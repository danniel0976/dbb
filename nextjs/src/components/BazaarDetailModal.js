'use client'

import { useState, useEffect, useCallback } from 'react'
import { X, Loader2, User } from 'lucide-react'

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

export default function BazaarDetailModal({ listing, onClose, onSelectListing }) {
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

  // Fetch Scryfall card data (cached in sessionStorage)
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

  // Fetch CKD pricing from the batch endpoint
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

  // Fetch all active listings for this card (all sellers)
  useEffect(() => {
    if (!scryfallId) { setSellersLoading(false); return }
    fetch(`/api/listings/card/${scryfallId}`)
      .then(r => r.ok ? r.json() : { listings: [] })
      .then(data => setSellers(data.listings || []))
      .catch(() => setSellers([]))
      .finally(() => setSellersLoading(false))
  }, [scryfallId])

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Escape') onClose()
  }, [onClose])

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

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
    <div
      className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-dbb-primary border border-dbb-accent/30 rounded-xl max-w-3xl w-full max-h-[92vh] overflow-y-auto shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-700 sticky top-0 bg-dbb-primary z-10">
          <h2 className="text-lg font-bold text-white truncate pr-4">{cardName}</h2>
          <button onClick={onClose} className="p-1 hover:text-dbb-accent transition-colors flex-shrink-0">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex flex-col sm:flex-row gap-4 p-4">
          {/* Card image */}
          <div className="sm:w-44 flex-shrink-0">
            {cardLoading ? (
              <div className="aspect-[2/3] skeleton rounded-lg" />
            ) : imageUrl ? (
              <img src={imageUrl} alt={cardName} className="w-full rounded-lg shadow-lg" />
            ) : (
              <div className="aspect-[2/3] bg-dbb-secondary rounded-lg flex items-center justify-center">
                <span className="text-gray-500 text-sm text-center p-2">{cardName}</span>
              </div>
            )}
          </div>

          {/* Right side */}
          <div className="flex-1 min-w-0 space-y-4">
            {/* Card metadata */}
            <div className="space-y-1 text-sm text-gray-400">
              {setName && (
                <div>
                  <span className="text-gray-500">Set:</span>{' '}
                  {setName}
                  {collectorNumber && (
                    <span className="ml-1 text-gray-600">#{collectorNumber}</span>
                  )}
                </div>
              )}
              {rarity && (
                <div>
                  <span className="text-gray-500">Rarity:</span>{' '}
                  <span className={RARITY_COLORS[rarity] || 'text-gray-400'}>
                    {rarity.charAt(0).toUpperCase() + rarity.slice(1)}
                  </span>
                </div>
              )}
              {typeLine && (
                <div><span className="text-gray-500">Type:</span> {typeLine}</div>
              )}
              {oracleText && (
                <div className="mt-2 p-2.5 bg-dbb-secondary rounded text-xs leading-relaxed whitespace-pre-line text-gray-300">
                  {oracleText}
                </div>
              )}
            </div>

            {/* CKD reference price */}
            <div className="p-3 bg-dbb-secondary rounded-lg">
              <p className="text-xs text-gray-500 mb-1">CardKingdom Reference Price</p>
              {priceLoading ? (
                <div className="flex items-center gap-1.5 text-xs text-gray-600">
                  <Loader2 className="w-3 h-3 animate-spin" /> Loading...
                </div>
              ) : ckdPrice != null ? (
                <div className="flex items-baseline gap-2">
                  <span className="text-base font-semibold text-white">${ckdPrice.toFixed(2)}</span>
                  <span className="text-xs text-gray-500">CKD USD</span>
                </div>
              ) : (
                <span className="text-xs text-gray-600">No price data available</span>
              )}
            </div>

            {/* Sellers / listings */}
            <div>
              <h3 className="text-sm font-semibold text-white mb-2">
                {sellersLoading
                  ? 'Loading sellers...'
                  : sellers?.length === 0
                  ? 'No sellers available for this card'
                  : `${sellers.length} seller${sellers.length !== 1 ? 's' : ''}`}
              </h3>

              {sellersLoading ? (
                <div className="flex items-center gap-2 text-xs text-gray-600 py-3">
                  <Loader2 className="w-4 h-4 animate-spin" /> Fetching listings...
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
                        className={`flex items-center justify-between gap-2 p-2.5 rounded-lg border transition-colors ${
                          isSelected
                            ? 'border-dbb-accent bg-dbb-accent/10'
                            : 'border-gray-700 bg-dbb-secondary hover:border-gray-600'
                        }`}
                      >
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          <User className="w-3.5 h-3.5 text-gray-500 flex-shrink-0" />
                          <span className="text-sm text-gray-300 truncate max-w-[120px]">
                            {s.seller_name || 'Seller'}
                          </span>
                          <span className="text-xs border border-gray-600 rounded px-1 py-0.5 text-gray-400 flex-shrink-0">
                            {slc?.condition || 'NM'}
                          </span>
                          {foilBadge && (
                            <span className={`text-[10px] border rounded px-1 py-0.5 flex-shrink-0 ${foilBadge.cls}`}>
                              {foilBadge.label}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <div className="text-right">
                            <div className="text-sm font-semibold text-dbb-accent">
                              {myr != null ? `RM ${myr.toFixed(2)}` : '—'}
                            </div>
                            <div className="text-[10px] text-gray-600">×{s.multiplier}</div>
                          </div>
                          {/* onSelectListing stub — Phase 11 wires this to cart */}
                          <button
                            onClick={() => {
                              setSelectedListingId(s.id)
                              onSelectListing(s)
                            }}
                            className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                              isSelected
                                ? 'bg-dbb-accent text-white'
                                : 'bg-gray-700 hover:bg-dbb-accent text-gray-300 hover:text-white'
                            }`}
                          >
                            {isSelected ? 'Selected' : 'Select'}
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
