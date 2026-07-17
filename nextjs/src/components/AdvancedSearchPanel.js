'use client'

import { useState, useEffect, useCallback } from 'react'
import { X, ChevronDown, ChevronUp } from 'lucide-react'

const COLORS = [
  { code: 'W', label: 'White', symbol: 'W', bg: 'bg-[#f5f5dc]', text: 'text-gray-900' },
  { code: 'U', label: 'Blue',  symbol: 'U', bg: 'bg-blue-600',   text: 'text-white' },
  { code: 'B', label: 'Black', symbol: 'B', bg: 'bg-gray-700',   text: 'text-white' },
  { code: 'R', label: 'Red',   symbol: 'R', bg: 'bg-red-600',    text: 'text-white' },
  { code: 'G', label: 'Green', symbol: 'G', bg: 'bg-green-600',  text: 'text-white' },
  { code: 'C', label: 'Colorless', symbol: 'C', bg: 'bg-gray-500', text: 'text-white' },
]

const RARITIES = [
  { value: 'common',   label: 'Common',   color: 'text-rarity-common' },
  { value: 'uncommon', label: 'Uncommon', color: 'text-rarity-uncommon' },
  { value: 'rare',     label: 'Rare',     color: 'text-rarity-rare' },
  { value: 'mythic',   label: 'Mythic',   color: 'text-rarity-mythic' },
]

const FOIL_OPTIONS = [
  { value: 'all',    label: 'All' },
  { value: 'normal', label: 'Normal' },
  { value: 'foil',   label: 'Foil' },
  { value: 'etched', label: 'Etched' },
]

export function buildFilterChips(filters, binders, sets) {
  const chips = []

  if (filters.colors && filters.colors.length > 0) {
    chips.push({
      key: 'colors',
      label: `Colors: ${filters.colors.join('')} (${filters.color_mode || 'or'})`,
    })
  }
  if (filters.type_line) chips.push({ key: 'type_line', label: `Type: ${filters.type_line}` })
  if (filters.cmc_min != null && filters.cmc_min !== '') chips.push({ key: 'cmc_min', label: `CMC ≥ ${filters.cmc_min}` })
  if (filters.cmc_max != null && filters.cmc_max !== '') chips.push({ key: 'cmc_max', label: `CMC ≤ ${filters.cmc_max}` })
  if (filters.rarity && filters.rarity.length > 0) {
    chips.push({ key: 'rarity', label: `Rarity: ${filters.rarity.join(', ')}` })
  }
  if (filters.foil && filters.foil !== 'all') chips.push({ key: 'foil', label: `Foil: ${filters.foil}` })
  if (filters.starred) chips.push({ key: 'starred', label: 'Starred only' })
  if (filters.set_code) {
    const found = sets?.find(s => s.set_code === filters.set_code)
    chips.push({ key: 'set_code', label: `Set: ${found?.set_name || filters.set_code.toUpperCase()}` })
  }
  if (filters.binder_id) {
    const found = binders?.find(b => b.id === filters.binder_id)
    chips.push({ key: 'binder_id', label: `Binder: ${found?.name || '…'}` })
  }

  return chips
}

export default function AdvancedSearchPanel({
  open,
  onClose,
  filters,
  onFiltersChange,
  binders = [],
  binderId,
  // When true, renders without its own card chrome/header — used inside
  // FilterSheet, which already supplies the title/close row and container.
  embedded = false,
}) {
  const [sets, setSets] = useState([])
  const [localFilters, setLocalFilters] = useState(filters)

  useEffect(() => { setLocalFilters(filters) }, [filters])

  useEffect(() => {
    if (!open) return
    fetch('/api/library/sets')
      .then(r => r.json())
      .then(d => setSets(d.sets || []))
      .catch(() => {})
  }, [open])

  const update = useCallback((patch) => {
    setLocalFilters(prev => {
      const next = { ...prev, ...patch }
      onFiltersChange(next)
      return next
    })
  }, [onFiltersChange])

  const toggleColor = (code) => {
    const current = localFilters.colors || []
    const next = current.includes(code)
      ? current.filter(c => c !== code)
      : [...current, code]
    update({ colors: next.length ? next : [] })
  }

  const toggleRarity = (val) => {
    const current = localFilters.rarity || []
    const next = current.includes(val)
      ? current.filter(r => r !== val)
      : [...current, val]
    update({ rarity: next.length ? next : [] })
  }

  if (!open) return null

  return (
    <div className={embedded ? 'space-y-4 p-4' : 'bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-gray-700 rounded-xl p-4 mb-4 space-y-4'}>
      {!embedded && (
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-sm text-gray-800 dark:text-gray-200">Advanced Filters</h3>
          <button onClick={onClose} className="text-gray-400 dark:text-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Colors */}
      <div className="space-y-2">
        <div className="text-xs text-gray-600 dark:text-gray-400 uppercase tracking-wider">Colors</div>
        <div className="flex items-center gap-2 flex-wrap">
          {COLORS.map(c => (
            <button
              key={c.code}
              onClick={() => toggleColor(c.code)}
              title={c.label}
              className={`w-8 h-8 rounded-full font-bold text-xs transition-all border-2 ${c.bg} ${c.text} ${
                (localFilters.colors || []).includes(c.code)
                  ? 'border-white scale-110 shadow-lg'
                  : 'border-transparent opacity-50 hover:opacity-80'
              }`}
            >
              {c.symbol}
            </button>
          ))}
          {(localFilters.colors || []).length > 0 && (
            <div className="flex items-center gap-1 ml-2">
              <button
                onClick={() => update({ color_mode: 'or' })}
                className={`px-2 py-0.5 text-xs rounded border transition-colors ${
                  (localFilters.color_mode || 'or') === 'or'
                    ? 'border-dbb-accent text-dbb-accent'
                    : 'border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-400'
                }`}
              >OR</button>
              <button
                onClick={() => update({ color_mode: 'and' })}
                className={`px-2 py-0.5 text-xs rounded border transition-colors ${
                  localFilters.color_mode === 'and'
                    ? 'border-dbb-accent text-dbb-accent'
                    : 'border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-400'
                }`}
              >AND</button>
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* Type line */}
        <div className="space-y-1">
          <label className="text-xs text-gray-600 dark:text-gray-400 uppercase tracking-wider">Type line</label>
          <input
            type="text"
            value={localFilters.type_line || ''}
            onChange={e => update({ type_line: e.target.value })}
            placeholder="e.g. Creature"
            className="w-full bg-white dark:bg-dbb-primary border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-1.5 text-sm focus:border-dbb-accent focus:outline-none placeholder-gray-400 dark:placeholder-gray-600"
          />
        </div>

        {/* CMC */}
        <div className="space-y-1">
          <label className="text-xs text-gray-600 dark:text-gray-400 uppercase tracking-wider">Mana value (CMC)</label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              value={localFilters.cmc_min ?? ''}
              onChange={e => update({ cmc_min: e.target.value })}
              placeholder="Min"
              min="0"
              className="w-full bg-white dark:bg-dbb-primary border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-1.5 text-sm focus:border-dbb-accent focus:outline-none placeholder-gray-400 dark:placeholder-gray-600"
            />
            <span className="text-gray-400 dark:text-gray-500 text-sm">–</span>
            <input
              type="number"
              value={localFilters.cmc_max ?? ''}
              onChange={e => update({ cmc_max: e.target.value })}
              placeholder="Max"
              min="0"
              className="w-full bg-white dark:bg-dbb-primary border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-1.5 text-sm focus:border-dbb-accent focus:outline-none placeholder-gray-400 dark:placeholder-gray-600"
            />
          </div>
        </div>

        {/* Set */}
        <div className="space-y-1">
          <label className="text-xs text-gray-600 dark:text-gray-400 uppercase tracking-wider">Set</label>
          <select
            value={localFilters.set_code || ''}
            onChange={e => update({ set_code: e.target.value || undefined })}
            className="w-full bg-white dark:bg-dbb-primary border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-1.5 text-sm focus:border-dbb-accent focus:outline-none"
          >
            <option value="">Any set</option>
            {sets.map(s => (
              <option key={s.set_code} value={s.set_code}>
                {s.set_name || s.set_code.toUpperCase()} ({s.set_code.toUpperCase()})
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* Rarity */}
        <div className="space-y-1">
          <label className="text-xs text-gray-600 dark:text-gray-400 uppercase tracking-wider">Rarity</label>
          <div className="flex gap-1.5 flex-wrap">
            {RARITIES.map(r => (
              <button
                key={r.value}
                onClick={() => toggleRarity(r.value)}
                className={`px-2.5 py-0.5 text-xs rounded-full border transition-colors ${
                  (localFilters.rarity || []).includes(r.value)
                    ? `border-dbb-accent bg-dbb-accent/10 ${r.color}`
                    : 'border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-400'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {/* Foil */}
        <div className="space-y-1">
          <label className="text-xs text-gray-600 dark:text-gray-400 uppercase tracking-wider">Foil</label>
          <div className="flex gap-1.5 flex-wrap">
            {FOIL_OPTIONS.map(f => (
              <button
                key={f.value}
                onClick={() => update({ foil: f.value })}
                className={`px-2.5 py-0.5 text-xs rounded-full border transition-colors ${
                  (localFilters.foil || 'all') === f.value
                    ? 'border-dbb-accent bg-dbb-accent/10 text-dbb-accent'
                    : 'border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-400'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {/* Binder (only on /library, not on /binders/[id]) */}
        {!binderId && binders.length > 0 && (
          <div className="space-y-1">
            <label className="text-xs text-gray-600 dark:text-gray-400 uppercase tracking-wider">Binder</label>
            <select
              value={localFilters.binder_id || ''}
              onChange={e => update({ binder_id: e.target.value || undefined })}
              className="w-full bg-white dark:bg-dbb-primary border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-1.5 text-sm focus:border-dbb-accent focus:outline-none"
            >
              <option value="">All binders</option>
              {binders.map(b => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>
        )}

        {/* Starred */}
        <div className="space-y-1 flex flex-col justify-end">
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <div
              onClick={() => update({ starred: !localFilters.starred })}
              className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-colors ${
                localFilters.starred
                  ? 'bg-dbb-gold border-dbb-gold'
                  : 'border-gray-300 dark:border-gray-600 hover:border-dbb-gold'
              }`}
            >
              {localFilters.starred && (
                <svg className="w-2.5 h-2.5 text-gray-900" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
              )}
            </div>
            <span className="text-sm text-gray-700 dark:text-gray-300">Starred only</span>
          </label>
        </div>
      </div>
    </div>
  )
}
