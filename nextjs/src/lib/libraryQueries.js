import { createClient } from '@/lib/supabaseServer'

const DEFAULT_PAGE_SIZE = 48

export async function getLibrary(userId, filters = {}, page = 1, pageSize = DEFAULT_PAGE_SIZE) {
  const supabase = await createClient()
  const { sort = 'newest', q = '', binder_id } = filters

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
