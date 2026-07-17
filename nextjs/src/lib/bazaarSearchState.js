// Shared Bazaar (Singles) query-state parser/serializer, generalized from
// librarySearchState.js's "one shared parser" pattern (Phase 41 tech audit
// P0-2 / P1-7) so a copied/reloaded/back-navigated Bazaar URL reconstructs
// the exact same search, filters, and sort. Used by both the client view
// (`BazaarView.js`, Next's ReadonlyURLSearchParams) and its own popstate
// sync.

export const EMPTY_BAZAAR_FILTERS = {
  setCode: null,
  rarities: [],
  colors: [],
  cardType: null,
  minPrice: null,
  maxPrice: null,
  isFoil: null,
  sortBy: 'newest',
  search: '',
}

function getParam(sp, key) {
  if (!sp) return null
  if (typeof sp.get === 'function') return sp.get(key)
  const v = sp[key]
  if (Array.isArray(v)) return v[0] ?? null
  return v ?? null
}

// Accepts a URLSearchParams / ReadonlyURLSearchParams instance.
export function parseBazaarQueryState(sp) {
  const raritiesStr = getParam(sp, 'rarity') || ''
  const colorsStr = getParam(sp, 'colors') || ''
  const foilParam = getParam(sp, 'foil')
  const minRaw = getParam(sp, 'min')
  const maxRaw = getParam(sp, 'max')

  return {
    search: getParam(sp, 'q') || '',
    sortBy: getParam(sp, 'sort') || 'newest',
    setCode: getParam(sp, 'set') || null,
    rarities: raritiesStr ? raritiesStr.split(',').filter(Boolean) : [],
    colors: colorsStr ? colorsStr.split('') : [],
    cardType: getParam(sp, 'type') || null,
    isFoil: foilParam === 'foil' ? true : foilParam === 'normal' ? false : null,
    minPrice: minRaw !== null && minRaw !== '' && !Number.isNaN(Number(minRaw)) ? Number(minRaw) : null,
    maxPrice: maxRaw !== null && maxRaw !== '' && !Number.isNaN(Number(maxRaw)) ? Number(maxRaw) : null,
  }
}

// Serializes Bazaar filter state back into URLSearchParams, mirroring
// parseBazaarQueryState.
export function serializeBazaarQueryState(filters) {
  const params = new URLSearchParams()
  if (filters.search) params.set('q', filters.search)
  if (filters.sortBy && filters.sortBy !== 'newest') params.set('sort', filters.sortBy)
  if (filters.setCode) params.set('set', filters.setCode)
  if (filters.rarities && filters.rarities.length) params.set('rarity', filters.rarities.join(','))
  if (filters.colors && filters.colors.length) params.set('colors', filters.colors.join(''))
  if (filters.cardType) params.set('type', filters.cardType)
  if (filters.isFoil === true) params.set('foil', 'foil')
  else if (filters.isFoil === false) params.set('foil', 'normal')
  if (filters.minPrice !== null && filters.minPrice !== undefined && filters.minPrice !== '') {
    params.set('min', String(filters.minPrice))
  }
  if (filters.maxPrice !== null && filters.maxPrice !== undefined && filters.maxPrice !== '') {
    params.set('max', String(filters.maxPrice))
  }
  return params
}

// Human-readable, individually-removable chips for every applied facet.
// Mirrors AdvancedSearchPanel's buildFilterChips — search/sort are not
// chips (same convention as Library, where `q` has its own clear button).
export function buildBazaarFilterChips(filters, filterOptions) {
  const chips = []
  if (filters.setCode) {
    const found = filterOptions?.sets?.find(s => s.code === filters.setCode)
    chips.push({ key: 'setCode', label: `Set: ${found?.name || filters.setCode.toUpperCase()}` })
  }
  if (filters.rarities && filters.rarities.length) {
    chips.push({ key: 'rarities', label: `Rarity: ${filters.rarities.join(', ')}` })
  }
  if (filters.colors && filters.colors.length) {
    chips.push({ key: 'colors', label: `Colors: ${filters.colors.join('')}` })
  }
  if (filters.cardType) chips.push({ key: 'cardType', label: `Type: ${filters.cardType}` })
  if (filters.isFoil === true) chips.push({ key: 'isFoil', label: 'Foil only' })
  else if (filters.isFoil === false) chips.push({ key: 'isFoil', label: 'Non-foil only' })
  if (filters.minPrice !== null && filters.minPrice !== undefined) {
    chips.push({ key: 'minPrice', label: `Min RM${filters.minPrice}` })
  }
  if (filters.maxPrice !== null && filters.maxPrice !== undefined) {
    chips.push({ key: 'maxPrice', label: `Max RM${filters.maxPrice}` })
  }
  return chips
}

// Per-chip "remove only this predicate" patches, keyed the same as the
// chips above.
export const BAZAAR_CHIP_CLEAR_PATCH = {
  setCode: { setCode: null },
  rarities: { rarities: [] },
  colors: { colors: [] },
  cardType: { cardType: null },
  isFoil: { isFoil: null },
  minPrice: { minPrice: null },
  maxPrice: { maxPrice: null },
}

export function hasActiveBazaarFilters(filters) {
  return !!(
    filters.setCode ||
    (filters.rarities && filters.rarities.length) ||
    (filters.colors && filters.colors.length) ||
    filters.cardType ||
    filters.isFoil !== null ||
    (filters.minPrice !== null && filters.minPrice !== undefined) ||
    (filters.maxPrice !== null && filters.maxPrice !== undefined) ||
    !!filters.search ||
    (filters.sortBy && filters.sortBy !== 'newest')
  )
}
