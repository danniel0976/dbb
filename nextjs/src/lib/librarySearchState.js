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
    sort: getParam(sp, 'sort') || 'newest',
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
  if (sort && sort !== 'newest') params.set('sort', sort)
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
    sort: parsed.sort,
    q: parsed.q,
    binder_id: binderIdOverride || parsed.filters.binder_id || undefined,
  }
}
