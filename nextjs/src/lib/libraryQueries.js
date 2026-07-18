import { createClient } from '@/lib/supabaseServer'
import { collectPagedIds, collectPagedRows } from '@/lib/postgrestBatch'
import { getLibrarySortOrder, normalizeLibrarySort } from '@/lib/librarySearchState'

const DEFAULT_PAGE_SIZE = 48
export { collectPagedIds as collectPagedLibraryIds }

/**
 * Apply the predicates shared by the card page and select-all queries.
 * Keep the user scope and ordering outside this helper so callers can choose
 * the smallest useful select and their own deterministic order.
 */
export function applyLibraryFilters(query, filters = {}) {
  const {
    q = '',
    binder_id,
    colors,
    color_mode,
    type_line,
    cmc_min,
    cmc_max,
    rarity,
    foil,
    starred,
    set_code,
  } = filters

  if (binder_id) {
    query = query.eq('binder_id', binder_id)
  }

  if (q) {
    query = query.ilike('card_index.name', `%${q}%`)
  }

  // Color filter — handle colorless (C) separately
  if (colors && colors.length > 0) {
    const hasColorless = colors.includes('C')
    const chromatic = colors.filter(c => c !== 'C')

    if (hasColorless && chromatic.length === 0) {
      // Colorless only
      query = query.eq('card_index.colors', '{}')
    } else if (hasColorless && chromatic.length > 0) {
      // Colorless OR chromatic — use .or() on overlaps + eq
      // PostgREST: overlaps uses &&, eq for empty array
      const overlapsVal = `{${chromatic.join(',')}}`
      query = query.or(`colors.eq.{},colors.ov.${overlapsVal}`, { referencedTable: 'card_index' })
    } else {
      // Chromatic only
      if (color_mode === 'and') {
        query = query.contains('card_index.colors', chromatic)
      } else {
        query = query.overlaps('card_index.colors', chromatic)
      }
    }
  }

  if (type_line) {
    query = query.ilike('card_index.type_line', `%${type_line}%`)
  }

  if (cmc_min != null && cmc_min !== '') {
    query = query.gte('card_index.cmc', Number(cmc_min))
  }

  if (cmc_max != null && cmc_max !== '') {
    query = query.lte('card_index.cmc', Number(cmc_max))
  }

  if (rarity && rarity.length > 0) {
    query = query.in('card_index.rarity', rarity)
  }

  if (foil && foil !== 'all') {
    query = query.eq('foil', foil)
  }

  if (starred === true || starred === 'true') {
    query = query.eq('starred', true)
  }

  if (set_code) {
    query = query.eq('card_index.set_code', set_code)
  }

  return query
}

/**
 * Return the PostgREST order descriptors for Library's canonical CMC/rarity
 * sorts. The final library_cards.id order makes equal catalog rows stable even
 * when a user owns multiple copies of the same card.
 */
function applyLibrarySort(query, sort) {
  const descriptors = getLibrarySortOrder(sort)
  if (!descriptors) return query

  return descriptors.reduce((current, descriptor) => {
    const { column, ...options } = descriptor
    return current.order(column, options)
  }, query)
}

export async function getLibrary(userId, filters = {}, page = 1, pageSize = DEFAULT_PAGE_SIZE) {
  const supabase = await createClient()
  const sort = normalizeLibrarySort(filters.sort || 'newest')

  const from = (page - 1) * pageSize
  const to = from + pageSize - 1

  let query = supabase
    .from('library_cards')
    .select('*, card_index!inner(*)', { count: 'exact' })
    .eq('user_id', userId)

  query = applyLibraryFilters(query, filters)

  switch (sort) {
    case 'name':
      query = query
        .order('name', { referencedTable: 'card_index', ascending: true })
        .order('set_code', { referencedTable: 'card_index', ascending: true })
        .order('collector_number', { referencedTable: 'card_index', ascending: true })
        .order('id', { ascending: true })
      break
    case 'set':
      query = query
        .order('set_code', { referencedTable: 'card_index', ascending: true })
        .order('collector_number', { referencedTable: 'card_index', ascending: true })
        .order('id', { ascending: true })
      break
    case 'cmc_low':
    case 'cmc_high':
    case 'rarity_low':
    case 'rarity_high':
      query = applyLibrarySort(query, sort)
      break
    case 'price_high':
      // Sort by purchase_price descending (server-side, no client reordering)
      // NULLs are pushed to the end so cards without purchase price don't disappear
      query = query
        .order('purchase_price', { ascending: false, nullsFirst: false })
        .order('id', { ascending: true })
      break
    case 'price_low':
      // Sort by purchase_price ascending — cards without price shown last
      query = query
        .order('purchase_price', { ascending: true, nullsFirst: false })
        .order('id', { ascending: true })
      break
    default:
      query = query
        .order('date_added', { ascending: false })
        .order('id', { ascending: true })
  }

  query = query.range(from, to)

  const { data, error, count } = await query
  if (error) throw error

  return {
    cards: data || [],
    total: count || 0,
    page,
    hasMore: count ? from + pageSize < count : false,
  }
}

 /**
 * Lightweight ID-only query: returns just the `id` column for every row matching
 * the given filters, paged below PostgREST's response cap. Used by select-all so
 * it can operate on the full binder regardless of how many cards are loaded.
 */
export async function getLibraryIds(userId, filters = {}) {
  const supabase = await createClient()

  return collectPagedIds(async (from, to) => {
    // Keep the inner relation so joined catalog predicates have the same
    // semantics as getLibrary(), but request only the minimum relation field.
    let query = supabase
      .from('library_cards')
      .select('id, card_index!inner(scryfall_id)')
      .eq('user_id', userId)

    query = applyLibraryFilters(query, filters)
    query = query
      .order('id', { ascending: true })
      .range(from, to)

    const { data, error } = await query
    if (error) throw error
    return data || []
  })
}

export async function getLibrarySets(userId) {
  const supabase = await createClient()
  // This is the existing set-options helper; page it for the same PostgREST
  // row-cap reason as select-all. No separate getLibrarySetOptions API exists.
  const rows = await collectPagedRows(async (from, to) => {
    const { data, error } = await supabase
      .from('library_cards')
      .select('id, card_index!inner(set_code, set_name)')
      .eq('user_id', userId)
      .order('id', { ascending: true })
      .range(from, to)
    if (error) throw error
    return data || []
  })

  // Deduplicate server-side
  const seen = new Set()
  const sets = []
  for (const row of rows) {
    const ci = row.card_index
    if (ci && !seen.has(ci.set_code)) {
      seen.add(ci.set_code)
      sets.push({ set_code: ci.set_code, set_name: ci.set_name })
    }
  }
  return sets.sort((a, b) => (a.set_name || a.set_code).localeCompare(b.set_name || b.set_code))
}
