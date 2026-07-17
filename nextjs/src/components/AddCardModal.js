'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { X, Search, Loader2, Plus, ChevronRight, ChevronDown, Filter } from 'lucide-react'

// Focus trap + scroll lock (matches CardDetailModal Pass 4a pattern)
function useFocusTrap(sheetRef, closeBtnRef, onClose, extraDeps = []) {
  useEffect(() => {
    closeBtnRef.current?.focus()

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key !== 'Tab') return
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

    document.addEventListener('keydown', onKeyDown)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = prevOverflow
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, ...extraDeps])
}

const CONDITIONS = [
  { value: 'NM', label: 'NM – Near Mint' },
  { value: 'LP', label: 'LP – Lightly Played' },
  { value: 'MP', label: 'MP – Moderately Played' },
  { value: 'HP', label: 'HP – Heavily Played' },
  { value: 'DMG', label: 'DMG – Damaged' },
  { value: 'M', label: 'M – Mint' },
]

const RARITY_OPTIONS = [
  { value: '', label: 'Any rarity' },
  { value: 'common', label: 'Common' },
  { value: 'uncommon', label: 'Uncommon' },
  { value: 'rare', label: 'Rare' },
  { value: 'mythic', label: 'Mythic' },
]

const SORT_OPTIONS = [
  { value: 'name', label: 'Name' },
  { value: 'set', label: 'Set / Collector' },
  { value: 'cmc', label: 'Mana value' },
  { value: 'rarity', label: 'Rarity' },
]

const COLOR_OPTIONS = [
  { value: 'W', label: 'W', title: 'White' },
  { value: 'U', label: 'U', title: 'Blue' },
  { value: 'B', label: 'B', title: 'Black' },
  { value: 'R', label: 'R', title: 'Red' },
  { value: 'G', label: 'G', title: 'Green' },
  { value: 'C', label: 'C', title: 'Colorless' },
]

const RARITY_COLORS = {
  mythic: 'text-rarity-mythic',
  rare: 'text-rarity-rare',
  uncommon: 'text-rarity-uncommon',
  common: 'text-gray-400',
}

const DEFAULT_LIMIT = 20

function CardImage({ card, size = 'sm' }) {
  const [src, setSrc] = useState(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (card.image_uris?.small) {
      setSrc(card.image_uris.small)
      return
    }
    // Fallback: fetch card JSON from Scryfall to get image URI
    let cancelled = false
    fetch(`https://api.scryfall.com/cards/${card.scryfall_id}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (cancelled || !data) return
        const uri = data.image_uris?.small ?? data.card_faces?.[0]?.image_uris?.small ?? null
        if (uri) setSrc(uri)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [card.scryfall_id, card.image_uris])

  const dims = size === 'lg' ? 'w-16 h-24' : 'w-14 h-20'

  if (!src) {
    return (
      <div className={`${dims} bg-gray-100 dark:bg-dbb-secondary border border-gray-200 dark:border-gray-700 rounded flex items-center justify-center flex-shrink-0`}>
        <span className="text-gray-400 dark:text-gray-600 text-xs">?</span>
      </div>
    )
  }
  return (
    <img
      src={src}
      alt={card.name}
      loading="lazy"
      onLoad={() => setLoaded(true)}
      className={`${dims} object-contain rounded-dbb-md flex-shrink-0 transition-opacity duration-200 ${loaded ? 'opacity-100' : 'opacity-0'}`}
    />
  )
}

function AddForm({ edition, cardName, binders, onAdd, onBack, adding }) {
  const [binderId, setBinderId] = useState(binders.find(b => b.is_default)?.id || binders[0]?.id || '')
  const [foil, setFoil] = useState('normal')
  const [condition, setCondition] = useState('NM')
  const [quantity, setQuantity] = useState(1)

  // Available foil finishes from catalog data
  const finishes = edition.finishes || ['nonfoil', 'foil']
  const hasFoil = finishes.includes('foil')
  const hasEtched = finishes.includes('etched')

  const card = {
    scryfall_id: edition.scryfall_id,
    name: cardName,
    set_name: edition.set_name,
    set_code: edition.set_code,
    collector_number: edition.collector_number,
    rarity: edition.rarity,
    image_uris: edition.image_uris,
    finishes: edition.finishes,
  }

  return (
    <div className="space-y-4">
      {/* Card summary */}
      <div className="flex gap-3 p-3 bg-gray-50 dark:bg-dbb-secondary/50 rounded-lg border border-gray-200 dark:border-gray-700/50">
        <CardImage card={card} size="lg" />
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-gray-900 dark:text-white truncate">{cardName}</h3>
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
          className="h-11 w-full rounded-dbb-md border border-gray-200 bg-white px-3 text-dbb-sm focus:border-dbb-accent focus:outline-none dark:border-gray-700 dark:bg-dbb-secondary"
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
          className="h-11 w-full rounded-dbb-md border border-gray-200 bg-white px-3 text-dbb-sm focus:border-dbb-accent focus:outline-none dark:border-gray-700 dark:bg-dbb-secondary"
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
            className={`flex min-h-[44px] flex-1 items-center justify-center rounded-dbb-md border text-dbb-sm transition-colors ${foil === 'normal' ? 'border-dbb-accent bg-dbb-accent/10 text-dbb-accent' : 'border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-gray-300 dark:hover:border-gray-600'}`}
          >
            Non-foil
          </button>
          {hasFoil && (
            <button
              onClick={() => setFoil('foil')}
              className={`flex min-h-[44px] flex-1 items-center justify-center rounded-dbb-md border text-dbb-sm transition-colors ${foil === 'foil' ? 'border-yellow-500 bg-yellow-500/10 text-yellow-400' : 'border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-gray-300 dark:hover:border-gray-600'}`}
            >
              Foil
            </button>
          )}
          {hasEtched && (
            <button
              onClick={() => setFoil('etched')}
              className={`flex min-h-[44px] flex-1 items-center justify-center rounded-dbb-md border text-dbb-sm transition-colors ${foil === 'etched' ? 'border-purple-500 bg-purple-500/10 text-purple-400' : 'border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-gray-300 dark:hover:border-gray-600'}`}
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
            className="flex h-11 w-11 items-center justify-center rounded-dbb-md border border-gray-200 text-lg transition-colors hover:border-dbb-accent hover:text-gray-900 dark:border-gray-700 dark:text-gray-400 dark:hover:text-white"
          >
            −
          </button>
          <input
            type="number"
            min={1}
            max={9999}
            value={quantity}
            onChange={e => setQuantity(Math.min(9999, Math.max(1, parseInt(e.target.value) || 1)))}
            className="h-11 w-16 rounded-dbb-md border border-gray-200 bg-white text-center text-dbb-sm focus:border-dbb-accent focus:outline-none dark:border-gray-700 dark:bg-dbb-secondary"
          />
          <button
            onClick={() => setQuantity(q => Math.min(9999, q + 1))}
            className="flex h-11 w-11 items-center justify-center rounded-dbb-md border border-gray-200 text-lg transition-colors hover:border-dbb-accent hover:text-gray-900 dark:border-gray-700 dark:text-gray-400 dark:hover:text-white"
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
          className="flex min-h-[44px] flex-1 items-center justify-center rounded-dbb-md border border-gray-200 text-dbb-sm text-gray-500 transition-colors hover:border-gray-300 hover:text-white disabled:opacity-50 dark:border-gray-700 dark:text-gray-400 dark:hover:border-gray-600"
        >
          ← Back
        </button>
        <button
          onClick={() => onAdd({ scryfall_id: card.scryfall_id, binder_id: binderId, quantity, foil, condition })}
          disabled={adding || !binderId}
          className="flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-dbb-md bg-dbb-accent text-dbb-sm font-semibold text-white transition-colors hover:bg-dbb-accent-hov disabled:opacity-50"
        >
          {adding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
          Add to library
        </button>
      </div>
    </div>
  )
}

// ─── Filter bar ───────────────────────────────────────────────────────────
function FilterBar({ filters, setFilters, onApply }) {
  const [expanded, setExpanded] = useState(false)

  const toggleColor = (c) => {
    const current = new Set(filters.colors)
    if (current.has(c)) current.delete(c)
    else current.add(c)
    setFilters({ ...filters, colors: Array.from(current) })
  }

  return (
    <div className="space-y-2">
      <button
        onClick={() => setExpanded(e => !e)}
        className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
      >
        <Filter className="w-3.5 h-3.5" />
        Filters {expanded ? <ChevronDown className="w-3 h-3 rotate-180" /> : <ChevronDown className="w-3 h-3" />}
      </button>

      {expanded && (
        <div className="space-y-3 p-3 bg-gray-50 dark:bg-dbb-secondary/50 rounded-lg border border-gray-200 dark:border-gray-700/50">
          {/* Sort */}
          <div>
            <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Sort by</label>
            <select
              value={filters.sort}
              onChange={e => setFilters({ ...filters, sort: e.target.value })}
              className="h-11 w-full rounded-dbb-md border border-gray-200 bg-white px-2.5 text-dbb-xs focus:border-dbb-accent focus:outline-none dark:border-gray-700 dark:bg-dbb-secondary"
            >
              {SORT_OPTIONS.map(s => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </div>

          {/* Set code */}
          <div>
            <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Set code</label>
            <input
              type="text"
              placeholder="e.g. fin, dmh"
              value={filters.set}
              onChange={e => setFilters({ ...filters, set: e.target.value })}
              className="h-11 w-full rounded-dbb-md border border-gray-200 bg-white px-2.5 text-dbb-xs focus:border-dbb-accent focus:outline-none dark:border-gray-700 dark:bg-dbb-secondary"
            />
          </div>

          {/* Rarity */}
          <div>
            <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Rarity</label>
            <select
              value={filters.rarity}
              onChange={e => setFilters({ ...filters, rarity: e.target.value })}
              className="h-11 w-full rounded-dbb-md border border-gray-200 bg-white px-2.5 text-dbb-xs focus:border-dbb-accent focus:outline-none dark:border-gray-700 dark:bg-dbb-secondary"
            >
              {RARITY_OPTIONS.map(r => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </div>

          {/* Colors */}
          <div>
            <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Colors</label>
            <div className="flex gap-1">
              {COLOR_OPTIONS.map(c => (
                <button
                  key={c.value}
                  onClick={() => toggleColor(c.value)}
                  title={c.title}
                  className={`flex h-11 w-11 items-center justify-center rounded-dbb-md text-dbb-xs font-bold border transition-colors ${
                    filters.colors.includes(c.value)
                      ? 'border-dbb-accent bg-dbb-accent/10 text-dbb-accent'
                      : 'border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-gray-300 dark:hover:border-gray-600'
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>

          {/* Mana value range */}
          <div>
            <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Mana value range</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="0"
                step="0.5"
                placeholder="min"
                value={filters.cmcMin}
                onChange={e => setFilters({ ...filters, cmcMin: e.target.value })}
                className="w-20 bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1 text-xs focus:border-dbb-accent focus:outline-none"
              />
              <span className="text-xs text-gray-400">–</span>
              <input
                type="number"
                min="0"
                step="0.5"
                placeholder="max"
                value={filters.cmcMax}
                onChange={e => setFilters({ ...filters, cmcMax: e.target.value })}
                className="w-20 bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1 text-xs focus:border-dbb-accent focus:outline-none"
              />
            </div>
          </div>

          {/* Foil only */}
          <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400 cursor-pointer">
            <input
              type="checkbox"
              checked={filters.foilOnly}
              onChange={e => setFilters({ ...filters, foilOnly: e.target.checked })}
              className="rounded border-gray-300 dark:border-gray-700 text-dbb-accent focus:ring-dbb-accent"
            />
            Foil available only
          </label>
        </div>
      )}
    </div>
  )
}

// ─── Edition row within a card group ──────────────────────────────────────
function EditionRow({ edition, cardName, onSelect }) {
  return (
    <button
      onClick={() => onSelect(edition, cardName)}
      className="w-full flex items-center gap-2.5 p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-dbb-secondary/70 border border-transparent hover:border-gray-200 dark:hover:border-gray-700 transition-colors text-left"
    >
      <CardImage card={{ scryfall_id: edition.scryfall_id, image_uris: edition.image_uris }} />
      <div className="flex-1 min-w-0">
        <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
          {edition.set_name} · {edition.set_code?.toUpperCase()} #{edition.collector_number}
        </p>
        <div className="flex items-center gap-2">
          {edition.rarity && (
            <span className={`text-xs capitalize ${RARITY_COLORS[edition.rarity] || 'text-gray-400'}`}>
              {edition.rarity}
            </span>
          )}
          {edition.finishes && edition.finishes.length > 0 && (
            <span className="text-xs text-gray-400 dark:text-gray-500">
              {edition.finishes.join(' / ')}
            </span>
          )}
        </div>
      </div>
      <ChevronRight className="w-4 h-4 text-gray-400 dark:text-gray-600 flex-shrink-0" />
    </button>
  )
}

// ─── Card group (name + all editions) ─────────────────────────────────────
function CardGroup({ group, onSelect }) {
  const [expanded, setExpanded] = useState(false)
  const editionCount = group.editions.length

  // Show first edition thumbnail as the group preview
  const firstEdition = group.editions[0]

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700/50 overflow-hidden">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center gap-3 p-2.5 hover:bg-gray-100 dark:hover:bg-dbb-secondary/50 transition-colors text-left"
      >
        <CardImage card={{ scryfall_id: firstEdition.scryfall_id, image_uris: firstEdition.image_uris }} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-900 dark:text-white truncate">{group.name}</p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {editionCount} edition{editionCount !== 1 ? 's' : ''}
            {group.type_line && ` · ${group.type_line}`}
          </p>
        </div>
        {expanded ? <ChevronDown className="w-4 h-4 text-gray-400 rotate-180 flex-shrink-0" /> : <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0" />}
      </button>

      {expanded && (
        <div className="space-y-0.5 px-2 pb-2 border-t border-gray-200 dark:border-gray-700/50 pt-2">
          {group.editions.map(ed => (
            <EditionRow key={ed.scryfall_id} edition={ed} cardName={group.name} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  )
}

const INITIAL_FILTERS = {
  sort: 'name',
  set: '',
  rarity: '',
  colors: [],
  cmcMin: '',
  cmcMax: '',
  foilOnly: false,
}

export default function AddCardModal({ binders = [], onClose, onAdded }) {
  // ─── Search state ──────────────────────────────────────────────────────
  const [q, setQ] = useState('')                    // input value (typing — zero requests)
  const [committedQ, setCommittedQ] = useState('')  // query actually submitted to the API
  const [filters, setFilters] = useState({ ...INITIAL_FILTERS })
  const [appliedFilters, setAppliedFilters] = useState({ ...INITIAL_FILTERS }) // filters used in the last committed search
  const [groups, setGroups] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [selectedEdition, setSelectedEdition] = useState(null)  // { edition, cardName }
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState(null)

  // ─── Refs ──────────────────────────────────────────────────────────────
  const inputRef = useRef(null)
  const abortRef = useRef(null)           // AbortController for in-flight search
  const searchGenRef = useRef(0)          // generation counter for staleness protection

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // ─── Build the search URL from query + filters ─────────────────────────
  const buildSearchUrl = useCallback((searchQ, searchFilters, pageNum) => {
    const params = new URLSearchParams()
    params.set('q', searchQ)
    params.set('limit', String(DEFAULT_LIMIT))
    params.set('page', String(pageNum))
    params.set('group', '1')
    if (searchFilters.sort && searchFilters.sort !== 'name') params.set('sort', searchFilters.sort)
    if (searchFilters.set) params.set('set', searchFilters.set.trim().toLowerCase())
    if (searchFilters.rarity) params.set('rarity', searchFilters.rarity)
    if (searchFilters.colors.length > 0) params.set('color', searchFilters.colors.join(''))
    if (searchFilters.cmcMin !== '' && !isNaN(parseFloat(searchFilters.cmcMin))) params.set('cmc_min', searchFilters.cmcMin)
    if (searchFilters.cmcMax !== '' && !isNaN(parseFloat(searchFilters.cmcMax))) params.set('cmc_max', searchFilters.cmcMax)
    if (searchFilters.foilOnly) params.set('foil_only', '1')
    return `/api/catalog/search?${params.toString()}`
  }, [])

  // ─── Submit search (Enter or Search button) ────────────────────────────
  const doSearch = useCallback(async (searchQ, searchFilters, pageNum = 1, append = false) => {
    // Cancel any in-flight request
    if (abortRef.current) {
      abortRef.current.abort()
    }
    // Increment generation so stale responses are ignored
    const gen = ++searchGenRef.current
    const controller = new AbortController()
    abortRef.current = controller

    if (!append) {
      setGroups([])
      setTotal(0)
      setHasMore(false)
      setPage(1)
    }
    setLoading(!append)
    setLoadingMore(append)
    setError(null)

    try {
      const url = buildSearchUrl(searchQ, searchFilters, pageNum)
      const res = await fetch(url, { signal: controller.signal })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Search failed')
      }
      const data = await res.json()

      // Ignore stale responses — only accept if our generation is still current
      if (gen !== searchGenRef.current) return

      const newGroups = data.groups || []
      if (append) {
        setGroups(prev => {
          const map = new Map(prev.map(g => [g.name, { ...g, editions: [...g.editions] }]))
          for (const g of newGroups) {
            if (map.has(g.name)) {
              const existing = map.get(g.name)
              const seenIds = new Set(existing.editions.map(e => e.scryfall_id))
              for (const ed of g.editions) {
                if (!seenIds.has(ed.scryfall_id)) existing.editions.push(ed)
              }
            } else {
              map.set(g.name, { ...g, editions: [...g.editions] })
            }
          }
          return [...map.values()]
        })
      } else {
        setGroups(newGroups)
      }
      setTotal(data.total ?? 0)
      setHasMore(data.has_more ?? false)
      setPage(pageNum)
    } catch (e) {
      if (e.name === 'AbortError') return  // cancelled — ignore silently
      if (gen !== searchGenRef.current) return  // stale — ignore
      setError(e.message || 'Search failed. Please try again.')
      if (!append) {
        setGroups([])
        setTotal(0)
        setHasMore(false)
      }
    } finally {
      if (gen === searchGenRef.current) {
        setLoading(false)
        setLoadingMore(false)
        if (abortRef.current === controller) {
          abortRef.current = null
        }
      }
    }
  }, [buildSearchUrl])

  // ─── Input handler — typing only, zero requests ────────────────────────
  const handleInput = (e) => {
    setQ(e.target.value)
    // Do NOT search here. User must press Enter or click Search.
  }

  // ─── Submit on Enter ───────────────────────────────────────────────────
  const handleSubmit = (e) => {
    e?.preventDefault?.()
    const term = q.trim()
    if (!term) {
      setGroups([])
      setTotal(0)
      setHasMore(false)
      setCommittedQ('')
      return
    }
    setCommittedQ(term)
    setAppliedFilters({ ...filters })
    doSearch(term, filters, 1, false)
  }

  // ─── Load more (next page) ─────────────────────────────────────────────
  const handleLoadMore = () => {
    if (loadingMore || !hasMore) return
    doSearch(committedQ, appliedFilters, page + 1, true)
  }

  // ─── Clear — resets everything and cancels in-flight ───────────────────
  const handleClear = () => {
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = null
    }
    searchGenRef.current++  // invalidate any in-flight response
    setQ('')
    setCommittedQ('')
    setFilters({ ...INITIAL_FILTERS })
    setAppliedFilters({ ...INITIAL_FILTERS })
    setGroups([])
    setTotal(0)
    setPage(1)
    setHasMore(false)
    setSelectedEdition(null)
    setError(null)
    setLoading(false)
    setLoadingMore(false)
    inputRef.current?.focus()
  }

  // ─── Add card to library ───────────────────────────────────────────────
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

  // ─── Select an edition ─────────────────────────────────────────────────
  const handleSelectEdition = (edition, cardName) => {
    setSelectedEdition({ edition, cardName })
    setError(null)
  }

  // ─── Back navigation on Escape (when in add form) ────────────────────
  // The focus trap hook handles Escape → onClose; this intercepts first
  // when the user is in the edition form to go back to search instead.
  useEffect(() => {
    if (!selectedEdition) return
    const handler = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setSelectedEdition(null)
      }
    }
    // Use capture phase so this fires before the focus trap's keydown
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [selectedEdition])

  // ─── Cleanup on unmount ────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (abortRef.current) {
        abortRef.current.abort()
      }
    }
  }, [])

  const sheetRef = useRef(null)
  const closeBtnRef = useRef(null)

  useFocusTrap(sheetRef, closeBtnRef, onClose, [selectedEdition])

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
      role="presentation"
    >
      {/* Mobile: full-height bottom sheet. Desktop: centered panel.
          Solid content body; glass chrome only on header. */}
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={selectedEdition ? 'Add to library' : 'Search card catalog'}
        className="relative flex h-[92vh] w-full flex-col overflow-hidden rounded-t-dbb-xl bg-white shadow-2xl dark:bg-dbb-primary sm:h-auto sm:max-h-[90vh] sm:max-w-md sm:rounded-dbb-xl"
      >
        {/* Header — glass chrome */}
        <div className="dbb-glass-chrome flex shrink-0 items-center justify-between gap-3 px-4 py-3">
          <h2 className="truncate text-dbb-lg font-semibold tracking-heading text-gray-900 dark:text-white">
            {selectedEdition ? 'Add to library' : 'Search card catalog'}
          </h2>
          <button
            ref={closeBtnRef}
            onClick={onClose}
            aria-label="Close"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-gray-500 transition-colors hover:bg-black/5 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-white/10 dark:hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Scrollable solid body */}
        <div className="flex-1 overflow-y-auto overscroll-contain p-4">
          {!selectedEdition ? (
            <div className="space-y-3">
              {/* Search input — explicit submit only */}
              <form onSubmit={handleSubmit} className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500" />
                <input
                  ref={inputRef}
                  type="text"
                  placeholder="Type a card name, then press Enter or Search"
                  value={q}
                  onChange={handleInput}
                  className="h-11 w-full rounded-dbb-md border border-gray-200 bg-white pl-9 pr-24 text-dbb-sm focus:border-dbb-accent focus:outline-none placeholder-gray-400 dark:border-gray-700 dark:bg-dbb-secondary dark:placeholder-gray-600"
                />
                <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                  {q && (
                    <button
                      type="button"
                      onClick={handleClear}
                      className="flex min-h-[36px] items-center px-2 text-dbb-xs text-gray-500 transition-colors hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
                    >
                      Clear
                    </button>
                  )}
                  <button
                    type="submit"
                    disabled={!q.trim() || loading}
                    className="flex min-h-[36px] items-center gap-1 rounded-dbb-md bg-dbb-accent px-2.5 text-dbb-xs text-white transition-colors hover:bg-dbb-accent-hov disabled:opacity-50"
                  >
                    {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Search className="w-3 h-3" />}
                    Search
                  </button>
                </div>
              </form>

              {/* Filters */}
              <FilterBar filters={filters} setFilters={setFilters} onApply={handleSubmit} />

              {error && <p className="text-sm text-red-500 dark:text-red-400">{error}</p>}

              {/* Results — grouped by card name */}
              {groups.length > 0 && (
                <>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {total} result{total !== 1 ? 's' : ''} for &ldquo;{committedQ}&rdquo;
                  </p>
                  <div className="space-y-2">
                    {groups.map(group => (
                      <CardGroup key={group.name} group={group} onSelect={handleSelectEdition} />
                    ))}
                  </div>

                  {/* Load more */}
                  {hasMore && (
                    <button
                      onClick={handleLoadMore}
                      disabled={loadingMore}
                      className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-dbb-md border border-gray-200 text-dbb-sm text-gray-600 transition-colors hover:border-dbb-accent hover:text-dbb-accent disabled:opacity-50 dark:border-gray-700 dark:text-gray-400"
                    >
                      {loadingMore ? <Loader2 className="w-4 h-4 animate-spin" /> : <ChevronDown className="w-4 h-4" />}
                      Load more
                    </button>
                  )}
                </>
              )}

              {!loading && committedQ && groups.length === 0 && !error && (
                <p className="text-sm text-gray-500 text-center py-6">
                  No cards found for &ldquo;{committedQ}&rdquo;
                </p>
              )}

              {!committedQ && (
                <p className="text-sm text-gray-400 dark:text-gray-600 text-center py-6">
                  Type a card name, then press Enter or click Search to find cards in the catalog
                </p>
              )}
            </div>
          ) : (
            <AddForm
              edition={selectedEdition.edition}
              cardName={selectedEdition.cardName}
              binders={binders}
              onAdd={handleAdd}
              onBack={() => setSelectedEdition(null)}
              adding={adding}
            />
          )}

          {error && selectedEdition && (
            <p className="mt-2 text-sm text-red-500 dark:text-red-400">{error}</p>
          )}
        </div>
      </div>
    </div>
  )
}