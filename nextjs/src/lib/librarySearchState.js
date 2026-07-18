// Shared Library query-state parser used by both the server prefetch
// (`app/library/page.js`, plain search-param object) and the client view
// (`LibraryView.js`, Next's ReadonlyURLSearchParams). Keeping one parser
// guarantees a copied/reloaded/back-navigated URL reconstructs the exact
// same query, sort, and filters — see Phase 41 tech audit P0-2.

export const EMPTY_LIBRARY_FILTERS = {
  colors: [],
  color_mode: 'or',
  type_line: '',
  cmc_min: '',
  cmc_max: '',
  rarity: [],
  foil: 'all',
  starred: false,
  set_code: '',
  binder_id: '',
}

export const LIBRARY_SORT_KEYS = [
  'newest',
  'name',
  'set',
  'cmc_low',
  'cmc_high',
  'rarity_low',
  'rarity_high',
  'price_high',
  'price_low',
]

export const LIBRARY_SORT_OPTIONS = [
  { value: 'newest', label: 'Newest first' },
  { value: 'name', label: 'Name A–Z' },
  { value: 'set', label: 'Set / Number' },
  { value: 'cmc_low', label: 'Mana value: Low → High' },
  { value: 'cmc_high', label: 'Mana value: High → Low' },
  { value: 'rarity_low', label: 'Rarity: Low → High' },
  { value: 'rarity_high', label: 'Rarity: High → Low' },
  { value: 'price_high', label: 'Price: High → Low' },
  { value: 'price_low', label: 'Price: Low → High' },
]

export const LIBRARY_SORT_ALIASES = {
  cmc: 'cmc_low',
  rarity: 'rarity_high',
}

export function normalizeLibrarySort(sort) {
  const normalized = LIBRARY_SORT_ALIASES[sort] || sort
  return LIBRARY_SORT_KEYS.includes(normalized) ? normalized : 'newest'
}

const CATALOG_TIE_BREAKERS = ['name', 'set_code', 'collector_number', 'scryfall_id']

export function getLibrarySortOrder(sort) {
  const normalizedSort = normalizeLibrarySort(sort)
  const direction = {
    cmc_low: { column: 'cmc', ascending: true },
    cmc_high: { column: 'cmc', ascending: false },
    rarity_low: { column: 'rarity_rank', ascending: true },
    rarity_high: { column: 'rarity_rank', ascending: false },
  }[normalizedSort]

  if (!direction) return null

  return [
    { column: `card_index(${direction.column})`, ascending: direction.ascending, nullsFirst: false },
    ...CATALOG_TIE_BREAKERS.map(column => ({
      column: `card_index(${column})`,
      ascending: true,
      nullsFirst: false,
    })),
    { column: 'id', ascending: true },
  ]
}

function getParam(sp, key) {
  if (!sp) return null
  if (typeof sp.get === 'function') return sp.get(key)
  const v = sp[key]
  if (Array.isArray(v)) return v[0] ?? null
  return v ?? null
}

// Accepts a URLSearchParams / ReadonlyURLSearchParams instance (client) or a
// plain record of string|string[] (Next server-component `searchParams`).
export function parseLibraryQueryState(sp) {
  const colorsStr = getParam(sp, 'colors') || ''
  const colors = colorsStr ? colorsStr.split('') : []
  const rarityStr = getParam(sp, 'rarity') || ''
  const rarity = rarityStr ? rarityStr.split(',') : []

  return {
    q: getParam(sp, 'q') || '',
    sort: normalizeLibrarySort(getParam(sp, 'sort') || 'newest'),
    filters: {
      colors,
      color_mode: getParam(sp, 'color_mode') || 'or',
      type_line: getParam(sp, 'type_line') || '',
      cmc_min: getParam(sp, 'cmc_min') || '',
      cmc_max: getParam(sp, 'cmc_max') || '',
      rarity,
      foil: getParam(sp, 'foil') || 'all',
      starred: getParam(sp, 'starred') === '1',
      set_code: getParam(sp, 'set') || '',
      binder_id: getParam(sp, 'binder_id') || '',
    },
  }
}

// Serializes query state back into URLSearchParams, mirroring parseLibraryQueryState.
export function serializeLibraryQueryState(filters, q, sort) {
  const params = new URLSearchParams()
  if (q) params.set('q', q)
  const normalizedSort = normalizeLibrarySort(sort)
  if (normalizedSort !== 'newest') params.set('sort', normalizedSort)
  if (filters.colors && filters.colors.length) params.set('colors', filters.colors.join(''))
  if (filters.colors && filters.colors.length && filters.color_mode && filters.color_mode !== 'or') {
    params.set('color_mode', filters.color_mode)
  }
  if (filters.type_line) params.set('type_line', filters.type_line)
  if (filters.cmc_min != null && filters.cmc_min !== '') params.set('cmc_min', filters.cmc_min)
  if (filters.cmc_max != null && filters.cmc_max !== '') params.set('cmc_max', filters.cmc_max)
  if (filters.rarity && filters.rarity.length) params.set('rarity', filters.rarity.join(','))
  if (filters.foil && filters.foil !== 'all') params.set('foil', filters.foil)
  if (filters.starred) params.set('starred', '1')
  if (filters.set_code) params.set('set', filters.set_code)
  if (filters.binder_id) params.set('binder_id', filters.binder_id)
  return params
}

// Combines a parsed query state into the shape getLibrary()/getLibraryIds() expect.
export function toLibraryQueryFilters(parsed, binderIdOverride) {
  return {
    ...parsed.filters,
    sort: normalizeLibrarySort(parsed.sort),
    q: parsed.q,
    binder_id: binderIdOverride || parsed.filters.binder_id || undefined,
  }
}
