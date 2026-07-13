import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabaseServer'

const MAX_LIMIT = 40
const DEFAULT_LIMIT = 20

// Valid sort fields mapped to deterministic Postgres orderings.
// Every ordering includes name + set_code + collector_number as tiebreakers
// so pagination is deterministic regardless of which sort the user picks.
const SORT_OPTIONS = {
  name: ['name', 'set_code', 'collector_number'],
  set: ['set_code', 'collector_number', 'name'],
  cmc: ['cmc', 'name', 'set_code', 'collector_number'],
  rarity: ['rarity', 'name', 'set_code', 'collector_number'],
}

function applyFilters(query, { q, set_code, rarity, type, colorArr, cmcMin, cmcMax, foilOnly }) {
  if (q) query = query.ilike('name', `%${q}%`)
  if (set_code) query = query.eq('set_code', set_code)
  if (rarity) query = query.eq('rarity', rarity)
  if (type) query = query.ilike('type_line', `%${type}%`)
  if (colorArr.length > 0) query = query.overlaps('colors', colorArr)
  if (cmcMin !== null) query = query.gte('cmc', cmcMin)
  if (cmcMax !== null) query = query.lte('cmc', cmcMax)
  if (foilOnly) query = query.contains('finishes', ['foil'])
  return query
}

function applySort(query, sort) {
  const columns = SORT_OPTIONS[sort] || SORT_OPTIONS.name
  // Supabase .order() can be chained; each call adds an ordering column.
  for (const col of columns) {
    query = query.order(col)
  }
  return query
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
  const colorArr = colorStr.split('').filter(c => 'WUBRGC'.includes(c))
  const cmcMinRaw = searchParams.get('cmc_min')
  const cmcMaxRaw = searchParams.get('cmc_max')
  const cmcMin = cmcMinRaw !== null && cmcMinRaw !== '' && !isNaN(parseFloat(cmcMinRaw)) ? parseFloat(cmcMinRaw) : null
  const cmcMax = cmcMaxRaw !== null && cmcMaxRaw !== '' && !isNaN(parseFloat(cmcMaxRaw)) ? parseFloat(cmcMaxRaw) : null
  const foilOnly = searchParams.get('foil_only') === '1' || searchParams.get('foil_only') === 'true'
  const sort = (searchParams.get('sort') || 'name').trim().toLowerCase()
  const group = searchParams.get('group') !== '0' // default: group by name
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10))
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(searchParams.get('limit') || String(DEFAULT_LIMIT), 10)))

  if (!q && !set_code && !rarity && !type && !colorArr.length && cmcMin === null && cmcMax === null && !foilOnly) {
    return NextResponse.json({ results: [], groups: [], total: 0, page, limit })
  }

  const from = (page - 1) * limit
  const to = from + limit - 1
  const filterArgs = { q, set_code, rarity, type, colorArr, cmcMin, cmcMax, foilOnly }

  // Select columns — try full set first (migration-007), fall back to basic
  const fullSelect = 'scryfall_id, name, set_code, set_name, collector_number, rarity, colors, type_line, cmc, mana_cost, image_uris, finishes'
  let query = applySort(
    applyFilters(
      supabase.from('card_index').select(fullSelect, { count: 'exact' }).range(from, to),
      filterArgs
    ),
    sort
  )

  let { data, error, count } = await query

  // Defensive fallback: if migration-007 columns not yet applied, retry without them
  if (error) {
    const basicSelect = 'scryfall_id, name, set_code, set_name, collector_number, rarity, colors, type_line, cmc, mana_cost'
    // When finishes column is missing, foilOnly filter is not applicable
    const fallbackFilters = { ...filterArgs, foilOnly: false }
    let fbQuery = applySort(
      applyFilters(
        supabase.from('card_index').select(basicSelect, { count: 'exact' }).range(from, to),
        fallbackFilters
      ),
      sort
    )
    const fb = await fbQuery
    if (fb.error) {
      console.error('catalog/search error:', fb.error)
      return NextResponse.json({ error: fb.error.message }, { status: 500 })
    }
    data = fb.data
    count = fb.count
    error = null
  }

  const rows = data || []

  // Group by card name when requested (default).
  // Each group contains the card name and all matching editions/printings.
  if (group && rows.length > 0) {
    const groupMap = new Map()
    for (const card of rows) {
      if (!groupMap.has(card.name)) {
        groupMap.set(card.name, {
          name: card.name,
          type_line: card.type_line || null,
          cmc: card.cmc || null,
          mana_cost: card.mana_cost || null,
          colors: card.colors || [],
          editions: [],
        })
      }
      groupMap.get(card.name).editions.push({
        scryfall_id: card.scryfall_id,
        set_code: card.set_code,
        set_name: card.set_name,
        collector_number: card.collector_number,
        rarity: card.rarity,
        image_uris: card.image_uris || null,
        finishes: card.finishes || ['nonfoil'],
      })
    }
    const groups = Array.from(groupMap.values())
    return NextResponse.json({ groups, total: count ?? 0, page, limit, has_more: (from + rows.length) < (count ?? 0) })
  }

  return NextResponse.json({ results: rows, total: count ?? 0, page, limit, has_more: (from + rows.length) < (count ?? 0) })
}