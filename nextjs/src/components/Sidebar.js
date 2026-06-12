'use client'

import { ChevronDown, Sparkles } from 'lucide-react'

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
  return (
    <div className="p-4 space-y-6">
      {/* Set Filter */}
      <div>
        <h3 className="text-sm font-semibold mb-2 text-gray-300">Set</h3>
        <select
          value={filters.setCode || ''}
          onChange={(e) => updateFilter('setCode', e.target.value || null)}
          className="w-full bg-dbb-secondary border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-dbb-accent focus:outline-none"
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
        <h3 className="text-sm font-semibold mb-2 text-gray-300">Rarity</h3>
        <div className="space-y-2">
          {rarityOrder.map((rarity) => (
            <label
              key={rarity}
              className="flex items-center gap-2 cursor-pointer hover:bg-dbb-secondary p-2 rounded-lg transition-colors"
            >
              <input
                type="radio"
                name="rarity"
                checked={filters.rarity === rarity}
                onChange={() => updateFilter('rarity', filters.rarity === rarity ? null : rarity)}
                className="w-4 h-4 accent-dbb-accent"
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
        <h3 className="text-sm font-semibold mb-2 text-gray-300">Colors</h3>
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
                  ? 'ring-2 ring-dbb-accent ring-offset-2 ring-offset-dbb-primary scale-110' 
                  : 'hover:scale-105'}
              `}
              title={color.name}
            >
              {color.code}
            </button>
          ))}
        </div>
      </div>

      {/* Card Type Filter */}
      <div>
        <h3 className="text-sm font-semibold mb-2 text-gray-300">Card Type</h3>
        <select
          value={filters.cardType || ''}
          onChange={(e) => updateFilter('cardType', e.target.value || null)}
          className="w-full bg-dbb-secondary border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-dbb-accent focus:outline-none"
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
        <h3 className="text-sm font-semibold mb-2 text-gray-300 flex items-center gap-2">
          <Sparkles className="w-4 h-4" />
          Foil
        </h3>
        <div className="space-y-2">
          <label className="flex items-center gap-2 cursor-pointer hover:bg-dbb-secondary p-2 rounded-lg transition-colors">
            <input
              type="radio"
              name="foil"
              checked={filters.isFoil === true}
              onChange={() => updateFilter('isFoil', filters.isFoil === true ? undefined : true)}
              className="w-4 h-4 accent-dbb-accent"
            />
            <span className="text-sm">Foil Only</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer hover:bg-dbb-secondary p-2 rounded-lg transition-colors">
            <input
              type="radio"
              name="foil"
              checked={filters.isFoil === false}
              onChange={() => updateFilter('isFoil', filters.isFoil === false ? undefined : false)}
              className="w-4 h-4 accent-dbb-accent"
            />
            <span className="text-sm">Non-Foil Only</span>
          </label>
        </div>
      </div>

      {/* Price Range Filter */}
      <div>
        <h3 className="text-sm font-semibold mb-2 text-gray-300">Price Range (MYR)</h3>
        <div className="space-y-2">
          <input
            type="number"
            placeholder="Min"
            value={filters.minPrice || ''}
            onChange={(e) => updateFilter('minPrice', e.target.value ? parseFloat(e.target.value) : null)}
            className="w-full bg-dbb-secondary border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-dbb-accent focus:outline-none"
          />
          <input
            type="number"
            placeholder="Max"
            value={filters.maxPrice || ''}
            onChange={(e) => updateFilter('maxPrice', e.target.value ? parseFloat(e.target.value) : null)}
            className="w-full bg-dbb-secondary border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-dbb-accent focus:outline-none"
          />
        </div>
      </div>

      {/* Clear Filters Button */}
      <button
        onClick={clearFilters}
        className="w-full btn-outline text-sm py-2"
      >
        Clear All Filters
      </button>
    </div>
  )
}
