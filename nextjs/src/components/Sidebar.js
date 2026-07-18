'use client'

import { useEffect, useState } from 'react'
import { ChevronDown, Sparkles } from 'lucide-react'

function validatePriceRange(minRaw, maxRaw) {
  const min = minRaw === '' ? null : Number(minRaw)
  const max = maxRaw === '' ? null : Number(maxRaw)
  if (min !== null && min < 0) return 'Min price cannot be negative'
  if (max !== null && max < 0) return 'Max price cannot be negative'
  if (min !== null && max !== null && min > max) return 'Min price cannot exceed max price'
  return null
}

const rarityOrder = ['common', 'uncommon', 'rare', 'mythic']
const rarityLabels = {
  common: 'Common',
  uncommon: 'Uncommon',
  rare: 'Rare',
  mythic: 'Mythic Rare',
}
const rarityColors = {
  common: 'text-rarity-common',
  uncommon: 'text-rarity-uncommon',
  rare: 'text-rarity-rare',
  mythic: 'text-rarity-mythic',
}

const colorOptions = [
  { code: 'W', name: 'White', class: 'bg-white text-black' },
  { code: 'U', name: 'Blue', class: 'bg-blue-500 text-white' },
  { code: 'B', name: 'Black', class: 'bg-gray-800 text-white' },
  { code: 'R', name: 'Red', class: 'bg-red-500 text-white' },
  { code: 'G', name: 'Green', class: 'bg-green-500 text-white' },
]

export default function Sidebar({ filters, updateFilter, clearFilters, filterOptions }) {
  const [minPriceInput, setMinPriceInput] = useState(filters.minPrice ?? '')
  const [maxPriceInput, setMaxPriceInput] = useState(filters.maxPrice ?? '')
  const priceError = validatePriceRange(minPriceInput === '' ? '' : String(minPriceInput), maxPriceInput === '' ? '' : String(maxPriceInput))

  useEffect(() => {
    setMinPriceInput(filters.minPrice ?? '')
    setMaxPriceInput(filters.maxPrice ?? '')
  }, [filters.minPrice, filters.maxPrice])

  const handlePriceChange = (field, setLocal, rawValue) => {
    setLocal(rawValue)
    const nextMin = field === 'minPrice' ? rawValue : minPriceInput
    const nextMax = field === 'maxPrice' ? rawValue : maxPriceInput
    const error = validatePriceRange(nextMin === '' ? '' : String(nextMin), nextMax === '' ? '' : String(nextMax))
    // Only propagate to the actual query filter when the resulting range is valid,
    // so an in-progress invalid range never reaches the server as a silent zero-result query.
    updateFilter(field, error || rawValue === '' ? null : parseFloat(rawValue))
  }

  return (
    <div className="p-4 space-y-6">
      {/* Set Filter */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-500 mb-2">Set</h3>
        <select
          value={filters.setCode || ''}
          onChange={(e) => updateFilter('setCode', e.target.value || null)}
          className="w-full bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-dbb-tertiary/50 rounded-dbb px-3 py-2 text-sm focus:border-dbb-accent focus:outline-none"
        >
          <option value="">All Sets</option>
          {filterOptions.sets.map((set) => (
            <option key={set.code} value={set.code}>
              {set.name} ({set.code})
            </option>
          ))}
        </select>
      </div>

      {/* Rarity Filter */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-500 mb-2">Rarity</h3>
        <div className="space-y-0.5">
          {rarityOrder.map((rarity) => (
            <label
              key={rarity}
              className="flex items-center gap-2 cursor-pointer hover:bg-gray-100 dark:hover:bg-dbb-secondary p-1.5 rounded-dbb transition-colors"
            >
              <input
                type="checkbox"
                checked={filters.rarities.includes(rarity)}
                onChange={() => {
                  const current = filters.rarities
                  const next = current.includes(rarity)
                    ? current.filter(r => r !== rarity)
                    : [...current, rarity]
                  updateFilter('rarities', next)
                }}
                className="w-4 h-4 accent-dbb-accent rounded"
              />
              <span className={`text-sm ${rarityColors[rarity]}`}>
                {rarityLabels[rarity]}
              </span>
            </label>
          ))}
        </div>
      </div>

      {/* Color Filter */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-500 mb-2">Colors</h3>
        <div className="flex flex-wrap gap-2">
          {colorOptions.map((color) => (
            <button
              key={color.code}
              onClick={() => {
                const colors = filters.colors.includes(color.code)
                  ? filters.colors.filter(c => c !== color.code)
                  : [...filters.colors, color.code]
                updateFilter('colors', colors)
              }}
              className={`
                w-10 h-10 rounded-full ${color.class} font-bold text-sm
                transition-all duration-200
                ${filters.colors.includes(color.code) 
                  ? 'ring-2 ring-dbb-accent ring-offset-2 ring-offset-white dark:ring-offset-dbb-primary scale-110' 
                  : 'hover:scale-105 opacity-50'}
              `}
              title={color.name}
            >
              {color.code}
            </button>
          ))}
        </div>
        <p className="text-xs text-gray-600 dark:text-gray-500 mt-1">Match cards with any selected color</p>
      </div>

      {/* Card Type Filter */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-500 mb-2">Card Type</h3>
        <select
          value={filters.cardType || ''}
          onChange={(e) => updateFilter('cardType', e.target.value || null)}
          className="w-full bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-dbb-tertiary/50 rounded-dbb px-3 py-2 text-sm focus:border-dbb-accent focus:outline-none"
        >
          <option value="">All Types</option>
          {filterOptions.cardTypes.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
      </div>

      {/* Foil Filter */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-500 mb-2 flex items-center gap-2">
          <Sparkles className="w-4 h-4" />
          Foil
        </h3>
        <div className="space-y-0.5">
          <label className="flex items-center gap-2 cursor-pointer hover:bg-gray-100 dark:hover:bg-dbb-secondary p-1.5 rounded-dbb transition-colors">
            <input
              type="radio"
              name="foil"
              checked={filters.isFoil === null}
              onChange={() => updateFilter('isFoil', null)}
              className="w-4 h-4 accent-dbb-accent"
            />
            <span className="text-sm">All</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer hover:bg-gray-100 dark:hover:bg-dbb-secondary p-1.5 rounded-dbb transition-colors">
            <input
              type="radio"
              name="foil"
              checked={filters.isFoil === true}
              onChange={() => updateFilter('isFoil', true)}
              className="w-4 h-4 accent-dbb-accent"
            />
            <span className="text-sm">Foil Only</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer hover:bg-gray-100 dark:hover:bg-dbb-secondary p-1.5 rounded-dbb transition-colors">
            <input
              type="radio"
              name="foil"
              checked={filters.isFoil === false}
              onChange={() => updateFilter('isFoil', false)}
              className="w-4 h-4 accent-dbb-accent"
            />
            <span className="text-sm">Non-Foil Only</span>
          </label>
        </div>
      </div>

      {/* Price Range Filter */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-500 mb-2">Price Range (MYR)</h3>
        <div className="space-y-2">
          <input
            type="number"
            placeholder="Min"
            min="0"
            value={minPriceInput}
            onChange={(e) => handlePriceChange('minPrice', setMinPriceInput, e.target.value)}
            aria-invalid={priceError ? 'true' : 'false'}
            className={`w-full bg-white dark:bg-dbb-secondary border rounded-dbb px-3 py-2 text-sm focus:outline-none ${priceError ? 'border-red-500 focus:border-red-500' : 'border-gray-200 dark:border-dbb-tertiary/50 focus:border-dbb-accent'}`}
          />
          <input
            type="number"
            placeholder="Max"
            min="0"
            value={maxPriceInput}
            onChange={(e) => handlePriceChange('maxPrice', setMaxPriceInput, e.target.value)}
            aria-invalid={priceError ? 'true' : 'false'}
            className={`w-full bg-white dark:bg-dbb-secondary border rounded-dbb px-3 py-2 text-sm focus:outline-none ${priceError ? 'border-red-500 focus:border-red-500' : 'border-gray-200 dark:border-dbb-tertiary/50 focus:border-dbb-accent'}`}
          />
          {priceError && (
            <p className="text-xs text-red-500" role="alert">{priceError}</p>
          )}
        </div>
      </div>

      {/* Clear Filters Button */}
      <button
        onClick={clearFilters}
        className="w-full btn btn-outline btn-sm"
      >
        Clear All Filters
      </button>
    </div>
  )
}