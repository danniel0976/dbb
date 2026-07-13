'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { X, Search, Loader2, Plus, ChevronRight } from 'lucide-react'

const CONDITIONS = [
  { value: 'NM', label: 'NM – Near Mint' },
  { value: 'LP', label: 'LP – Lightly Played' },
  { value: 'MP', label: 'MP – Moderately Played' },
  { value: 'HP', label: 'HP – Heavily Played' },
  { value: 'DMG', label: 'DMG – Damaged' },
  { value: 'M', label: 'M – Mint' },
]

const RARITY_COLORS = {
  mythic: 'text-rarity-mythic',
  rare: 'text-rarity-rare',
  uncommon: 'text-rarity-uncommon',
  common: 'text-gray-400',
}

function CardImage({ card }) {
  const [src, setSrc] = useState(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    // Use stored image_uri if available, otherwise fetch from Scryfall
    if (card.image_uris?.small) {
      setSrc(card.image_uris.small)
      return
    }
    // Fallback: fetch card JSON from Scryfall to get image URI
    fetch(`https://api.scryfall.com/cards/${card.scryfall_id}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data) return
        const uri = data.image_uris?.small ?? data.card_faces?.[0]?.image_uris?.small ?? null
        if (uri) setSrc(uri)
      })
      .catch(() => {})
  }, [card.scryfall_id, card.image_uris])

  if (!src) {
    return (
      <div className="w-14 h-20 bg-gray-100 dark:bg-dbb-secondary border border-gray-200 dark:border-gray-700 rounded flex items-center justify-center flex-shrink-0">
        <span className="text-gray-400 dark:text-gray-600 text-xs">?</span>
      </div>
    )
  }
  return (
    <img
      src={src}
      alt={card.name}
      onLoad={() => setLoaded(true)}
      className={`w-14 h-20 object-cover rounded flex-shrink-0 transition-opacity duration-200 ${loaded ? 'opacity-100' : 'opacity-0'}`}
    />
  )
}

function AddForm({ card, binders, onAdd, onBack, adding }) {
  const [binderId, setBinderId] = useState(binders.find(b => b.is_default)?.id || binders[0]?.id || '')
  const [foil, setFoil] = useState('normal')
  const [condition, setCondition] = useState('NM')
  const [quantity, setQuantity] = useState(1)

  // Available foil finishes from catalog data
  const finishes = card.finishes || ['nonfoil', 'foil']
  const hasFoil = finishes.includes('foil')
  const hasEtched = finishes.includes('etched')

  return (
    <div className="space-y-4">
      {/* Card summary */}
      <div className="flex gap-3 p-3 bg-gray-50 dark:bg-dbb-secondary/50 rounded-lg border border-gray-200 dark:border-gray-700/50">
        <CardImage card={card} />
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-white truncate">{card.name}</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">{card.set_name} · {card.set_code?.toUpperCase()} #{card.collector_number}</p>
          {card.rarity && (
            <span className={`text-xs capitalize ${RARITY_COLORS[card.rarity] || 'text-gray-400'}`}>
              {card.rarity}
            </span>
          )}
        </div>
      </div>

      {/* Binder */}
      <div>
        <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Add to binder</label>
        <select
          value={binderId}
          onChange={e => setBinderId(e.target.value)}
          className="w-full bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-dbb-accent focus:outline-none"
        >
          {binders.map(b => (
            <option key={b.id} value={b.id}>{b.name}{b.is_default ? ' (default)' : ''}</option>
          ))}
        </select>
      </div>

      {/* Condition */}
      <div>
        <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Condition</label>
        <select
          value={condition}
          onChange={e => setCondition(e.target.value)}
          className="w-full bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-dbb-accent focus:outline-none"
        >
          {CONDITIONS.map(c => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </select>
      </div>

      {/* Foil */}
      <div>
        <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Printing</label>
        <div className="flex gap-2">
          <button
            onClick={() => setFoil('normal')}
            className={`flex-1 py-2 text-sm rounded-lg border transition-colors ${foil === 'normal' ? 'border-dbb-accent bg-dbb-accent/10 text-dbb-accent' : 'border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-gray-300 dark:hover:border-gray-600'}`}
          >
            Non-foil
          </button>
          {hasFoil && (
            <button
              onClick={() => setFoil('foil')}
              className={`flex-1 py-2 text-sm rounded-lg border transition-colors ${foil === 'foil' ? 'border-yellow-500 bg-yellow-500/10 text-yellow-400' : 'border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-gray-300 dark:hover:border-gray-600'}`}
            >
              Foil
            </button>
          )}
          {hasEtched && (
            <button
              onClick={() => setFoil('etched')}
              className={`flex-1 py-2 text-sm rounded-lg border transition-colors ${foil === 'etched' ? 'border-purple-500 bg-purple-500/10 text-purple-400' : 'border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-gray-300 dark:hover:border-gray-600'}`}
            >
              Etched
            </button>
          )}
        </div>
      </div>

      {/* Quantity */}
      <div>
        <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Quantity</label>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setQuantity(q => Math.max(1, q - 1))}
            className="w-8 h-8 rounded border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-dbb-accent hover:text-gray-900 dark:hover:text-white transition-colors flex items-center justify-center text-lg"
          >
            −
          </button>
          <input
            type="number"
            min={1}
            max={9999}
            value={quantity}
            onChange={e => setQuantity(Math.min(9999, Math.max(1, parseInt(e.target.value) || 1)))}
            className="w-16 text-center bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1.5 text-sm focus:border-dbb-accent focus:outline-none"
          />
          <button
            onClick={() => setQuantity(q => Math.min(9999, q + 1))}
            className="w-8 h-8 rounded border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-dbb-accent hover:text-gray-900 dark:hover:text-white transition-colors flex items-center justify-center text-lg"
          >
            +
          </button>
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-2 pt-2">
        <button
          onClick={onBack}
          disabled={adding}
          className="flex-1 py-2 text-sm border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 rounded-lg hover:border-gray-300 dark:hover:border-gray-600 hover:text-white transition-colors disabled:opacity-50"
        >
          ← Back
        </button>
        <button
          onClick={() => onAdd({ scryfall_id: card.scryfall_id, binder_id: binderId, quantity, foil, condition })}
          disabled={adding || !binderId}
          className="flex-1 py-2 text-sm btn-primary rounded-lg flex items-center justify-center gap-2 disabled:opacity-50"
        >
          {adding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
          Add to library
        </button>
      </div>
    </div>
  )
}

export default function AddCardModal({ binders = [], onClose, onAdded }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [selectedCard, setSelectedCard] = useState(null)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState(null)
  const debounceRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const search = useCallback((term) => {
    clearTimeout(debounceRef.current)
    if (!term.trim()) { setResults([]); setLoading(false); return }
    setLoading(true)
    setError(null)
    debounceRef.current = setTimeout(async () => {
      try {
        const url = `/api/catalog/search?q=${encodeURIComponent(term)}&limit=20`
        const res = await fetch(url)
        if (!res.ok) throw new Error('Search failed')
        const data = await res.json()
        setResults(data.results || [])
      } catch (e) {
        setError('Search failed. Please try again.')
        setResults([])
      } finally {
        setLoading(false)
      }
    }, 300)
  }, [])

  const handleInput = (e) => {
    const val = e.target.value
    setQ(val)
    setSelectedCard(null)
    search(val)
  }

  const handleAdd = async (payload) => {
    setAdding(true)
    setError(null)
    try {
      const res = await fetch('/api/library/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to add card')
      onAdded?.({ ...payload, card_name: data.card_name, inserted: data.inserted, merged: data.merged })
      onClose()
    } catch (e) {
      setError(e.message)
      setAdding(false)
    }
  }

  // Close on Escape
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70">
      <div className="bg-white dark:bg-dbb-primary border border-gray-200 dark:border-gray-700 rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            {selectedCard ? 'Add to library' : 'Search card catalog'}
          </h2>
          <button onClick={onClose} className="p-1 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white rounded transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {!selectedCard ? (
            <div className="space-y-3">
              {/* Search input */}
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500" />
                <input
                  ref={inputRef}
                  type="text"
                  placeholder="Search by card name..."
                  value={q}
                  onChange={handleInput}
                  className="w-full bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-gray-700 rounded-lg pl-9 pr-4 py-2.5 text-sm focus:border-dbb-accent focus:outline-none placeholder-gray-400 dark:placeholder-gray-600"
                />
                {loading && (
                  <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500 animate-spin" />
                )}
              </div>

              {error && <p className="text-sm text-red-400">{error}</p>}

              {/* Results */}
              {results.length > 0 && (
                <div className="space-y-1">
                  {results.map(card => (
                    <button
                      key={card.scryfall_id}
                      onClick={() => setSelectedCard(card)}
                      className="w-full flex items-center gap-3 p-2.5 rounded-lg hover:bg-gray-100 dark:hover:bg-dbb-secondary/70 border border-transparent hover:border-gray-200 dark:hover:border-gray-700 transition-colors text-left"
                    >
                      <CardImage card={card} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 dark:text-white truncate">{card.name}</p>
                        <p className="text-xs text-gray-500 dark:text-gray-400">{card.set_name} · #{card.collector_number}</p>
                        {card.rarity && (
                          <span className={`text-xs capitalize ${RARITY_COLORS[card.rarity] || 'text-gray-400'}`}>
                            {card.rarity}
                          </span>
                        )}
                      </div>
                      <ChevronRight className="w-4 h-4 text-gray-400 dark:text-gray-600 flex-shrink-0" />
                    </button>
                  ))}
                </div>
              )}

              {!loading && q.trim() && results.length === 0 && !error && (
                <p className="text-sm text-gray-500 text-center py-6">
                  No cards found for "{q}"
                </p>
              )}

              {!q && (
                <p className="text-sm text-gray-400 dark:text-gray-600 text-center py-6">
                  Type a card name to search the catalog
                </p>
              )}
            </div>
          ) : (
            <AddForm
              card={selectedCard}
              binders={binders}
              onAdd={handleAdd}
              onBack={() => setSelectedCard(null)}
              adding={adding}
            />
          )}

          {error && selectedCard && (
            <p className="mt-2 text-sm text-red-400">{error}</p>
          )}
        </div>
      </div>
    </div>
  )
}
