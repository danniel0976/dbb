import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabaseServer'

const MAX_LIMIT = 20

function applyFilters(query, { q, set_code, rarity, type, colorArr }) {
  if (q) query = query.ilike('name', `%${q}%`)
  if (set_code) query = query.eq('set_code', set_code)
  if (rarity) query = query.eq('rarity', rarity)
  if (type) query = query.ilike('type_line', `%${type}%`)
  if (colorArr.length > 0) query = query.overlaps('colors', colorArr)
  return query.order('name').order('set_code').order('collector_number')
}

export async function GET(request) {
  const supabase = await createClient()
  const { data: { user }, error: authErr } = await supabase.auth.getUser()
  if (authErr || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const q = (searchParams.get('q') || '').trim()
  const set_code = (searchParams.get('set') || '').trim().toLowerCase()
  const rarity = (searchParams.get('rarity') || '').trim().toLowerCase()
  const type = (searchParams.get('type') || '').trim()
  const colorStr = (searchParams.get('color') || '').trim().toUpperCase()
  const colorArr = colorStr.split('').filter(c => 'WUBRG'.includes(c))
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10))
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(searchParams.get('limit') || '20', 10)))

  if (!q && !set_code && !rarity && !type && !colorArr.length) {
    return NextResponse.json({ results: [], total: 0 })
  }

  const from = (page - 1) * limit
  const to = from + limit - 1
  const filterArgs = { q, set_code, rarity, type, colorArr }

  // Try full select including migration-007 columns
  const fullSelect = 'scryfall_id, name, set_code, set_name, collector_number, rarity, colors, type_line, cmc, mana_cost, image_uris, finishes'
  let { data, error, count } = await applyFilters(
    supabase.from('card_index').select(fullSelect, { count: 'exact' }).range(from, to),
    filterArgs
  )

  // Defensive fallback: if migration-007 columns not yet applied, retry without them
  if (error) {
    const basicSelect = 'scryfall_id, name, set_code, set_name, collector_number, rarity, colors, type_line, cmc, mana_cost'
    const fb = await applyFilters(
      supabase.from('card_index').select(basicSelect, { count: 'exact' }).range(from, to),
      filterArgs
    )
    if (fb.error) {
      console.error('catalog/search error:', fb.error)
      return NextResponse.json({ error: fb.error.message }, { status: 500 })
    }
    data = fb.data
    count = fb.count
    error = null
  }

  return NextResponse.json({ results: data || [], total: count ?? 0, page, limit })
}
