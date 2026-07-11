import { createClient } from '@/lib/supabaseServer'

const DEFAULT_PAGE_SIZE = 48

export async function getLibrary(userId, filters = {}, page = 1, pageSize = DEFAULT_PAGE_SIZE) {
  const supabase = await createClient()
  const {
    sort = 'newest',
    q = '',
    binder_id,
    colors,        // string[] of W/U/B/R/G/C
    color_mode,    // 'or' | 'and' (default 'or')
    type_line,
    cmc_min,
    cmc_max,
    rarity,        // string[]
    foil,          // 'normal' | 'foil' | 'etched'
    starred,       // boolean
    set_code,
  } = filters

  const from = (page - 1) * pageSize
  const to = from + pageSize - 1

  let query = supabase
    .from('library_cards')
    .select('*, card_index!inner(*)', { count: 'exact' })
    .eq('user_id', userId)

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

  switch (sort) {
    case 'name':
      query = query.order('name', { referencedTable: 'card_index', ascending: true })
      break
    case 'set':
      query = query
        .order('set_code', { referencedTable: 'card_index', ascending: true })
        .order('collector_number', { referencedTable: 'card_index', ascending: true })
      break
    case 'cmc':
      query = query.order('cmc', { referencedTable: 'card_index', ascending: true })
      break
    case 'rarity':
      query = query.order('rarity', { referencedTable: 'card_index', ascending: true })
      break
    default:
      query = query.order('date_added', { ascending: false })
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

export async function getLibrarySets(userId) {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('library_cards')
    .select('card_index!inner(set_code, set_name)')
    .eq('user_id', userId)
  if (error) throw error

  // Deduplicate server-side
  const seen = new Set()
  const sets = []
  for (const row of data || []) {
    const ci = row.card_index
    if (ci && !seen.has(ci.set_code)) {
      seen.add(ci.set_code)
      sets.push({ set_code: ci.set_code, set_name: ci.set_name })
    }
  }
  return sets.sort((a, b) => (a.set_name || a.set_code).localeCompare(b.set_name || b.set_code))
}
