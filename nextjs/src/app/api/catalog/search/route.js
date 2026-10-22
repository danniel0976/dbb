import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabaseServer'
import { isMissingColumnError } from '@/lib/catalogSearchCompatibility.mjs'
import { buildNameMatchPlans, buildNameOrFilter, runNameMatchPlans } from '@/lib/catalogNameSearch.mjs'

const MAX_LIMIT = 40
const DEFAULT_LIMIT = 20

// Valid sort fields mapped to deterministic Postgres orderings. The primary
// CMC/rarity field is nullable, so explicitly put NULLs last in both
// directions. The remaining fields are ascending tie-breakers, ending in the
// unique Scryfall id so pagination is deterministic.
const SORT_OPTIONS = {
  name: [
    { column: 'name' },
    { column: 'set_code' },
    { column: 'collector_number' },
    { column: 'scryfall_id' },
  ],
  set: [
    { column: 'set_code' },
    { column: 'collector_number' },
    { column: 'name' },
    { column: 'scryfall_id' },
  ],
  cmc_low: [
    { column: 'cmc', ascending: true, nullsFirst: false },
    { column: 'name' },
    { column: 'set_code' },
    { column: 'collector_number' },
    { column: 'scryfall_id' },
  ],
  cmc_high: [
    { column: 'cmc', ascending: false, nullsFirst: false },
    { column: 'name' },
    { column: 'set_code' },
    { column: 'collector_number' },
    { column: 'scryfall_id' },
  ],
  rarity_low: [
    { column: 'rarity_rank', ascending: true, nullsFirst: false },
    { column: 'name' },
    { column: 'set_code' },
    { column: 'collector_number' },
    { column: 'scryfall_id' },
  ],
  rarity_high: [
    { column: 'rarity_rank', ascending: false, nullsFirst: false },
    { column: 'name' },
    { column: 'set_code' },
    { column: 'collector_number' },
    { column: 'scryfall_id' },
  ],
}

const SORT_ALIASES = {
  cmc: 'cmc_low',
  rarity: 'rarity_high',
}

// Apply one name-match plan. A single pattern stays a plain ILIKE — the exact
// filter manual search has always issued; several patterns become one bounded
// OR of ILIKEs. An unsafe pattern set degrades to the narrowest pattern rather
// than emitting filter text that could be reparsed as syntax.
function applyNamePlan(query, plan) {
  if (!plan || !plan.patterns?.length) return query
  if (plan.patterns.length === 1) return query.ilike('name', plan.patterns[0])
  const orFilter = buildNameOrFilter(plan.patterns)
  return orFilter ? query.or(orFilter) : query.ilike('name', plan.patterns[0])
}

function applyFilters(query, { namePlan, set_code, collector_number, rarity, type, colorArr, cmcMin, cmcMax, foilOnly }) {
  query = applyNamePlan(query, namePlan)
  if (set_code) query = query.eq('set_code', set_code)
  if (collector_number) query = query.eq('collector_number', collector_number)
  if (rarity) query = query.eq('rarity', rarity)
  if (type) query = query.ilike('type_line', `%${type}%`)
  if (colorArr.length > 0) query = query.overlaps('colors', colorArr)
  if (cmcMin !== null) query = query.gte('cmc', cmcMin)
  if (cmcMax !== null) query = query.lte('cmc', cmcMax)
  if (foilOnly) query = query.contains('finishes', ['foil'])
  return query
}

function applySort(query, sort, { legacyRarity = false } = {}) {
  const columns = legacyRarity && (sort === 'rarity_low' || sort === 'rarity_high')
    ? [
        { column: 'rarity', ascending: sort === 'rarity_low' },
        { column: 'name' },
        { column: 'set_code' },
        { column: 'collector_number' },
        { column: 'scryfall_id' },
      ]
    : SORT_OPTIONS[sort] || SORT_OPTIONS.name
  // Supabase .order() can be chained; each call adds an ordering column.
  for (const { column, ...options } of columns) {
    query = query.order(column, options)
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
  // Scanner-only retrieval widening. OCR substitutions make a substring-only
  // name filter miss a perfectly readable card, so a scan may escalate to
  // bounded token/half-word plans. Manual search never does.
  const scan = searchParams.get('scan') === '1' || searchParams.get('scan') === 'true'
  const collectorRaw = (searchParams.get('collector_number') || '').trim().toLowerCase()
  const collector_number = scan && !q && /^\d{1,4}[a-z]?$/.test(collectorRaw) ? collectorRaw : ''
  const requestedSort = (searchParams.get('sort') || 'name').trim().toLowerCase()
  const sort = SORT_ALIASES[requestedSort] || requestedSort
  const group = searchParams.get('group') !== '0' // default: group by name
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10))
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(searchParams.get('limit') || String(DEFAULT_LIMIT), 10)))

  if (!q && !set_code && !collector_number && !rarity && !type && !colorArr.length && cmcMin === null && cmcMax === null && !foilOnly) {
    return NextResponse.json({ results: [], groups: [], total: 0, page, limit })
  }

  const from = (page - 1) * limit
  const to = from + limit - 1

  // Select columns — try full set first (migration-007), fall back to basic
  const fullSelect = 'scryfall_id, name, set_code, set_name, collector_number, rarity, rarity_rank, colors, type_line, cmc, mana_cost, image_uris, finishes, lang, oracle_id, illustration_id, released_at, frame, frame_effects, promo_types, border_color, has_face_images, face_illustration_ids, promo, set_type, layout, games'

  // One catalog query for one name-match plan, keeping the pre-migration schema
  // fallback intact. Returns the Supabase result shape so plan escalation can
  // stop on the first plan that matches anything, or on any error.
  const runPlan = async (namePlan, queryPage = { from, to }) => {
    const filterArgs = { namePlan, set_code, collector_number, rarity, type, colorArr, cmcMin, cmcMax, foilOnly }
    const query = applySort(
      applyFilters(
        supabase.from('card_index').select(fullSelect, { count: 'exact' }).eq('catalog_current', true).range(queryPage.from, queryPage.to),
        filterArgs
      ),
      sort
    )

    const { data, error, count } = await query
    // Defensive compatibility fallback for a pre-migration catalog schema.
    // Do not mask unrelated query failures or drop foilOnly from the retry.
    if (!(error?.code === '42703')) return { data, error, count }

    const basicSelect = 'scryfall_id, name, set_code, set_name, collector_number, rarity, colors, type_line, cmc, mana_cost'
    const fallbackFilters = filterArgs
    const missingCatalogCurrent = isMissingColumnError(error, 'catalog_current')
    const runFallback = async (includeCatalogCurrent) => {
      let fallbackBase = supabase.from('card_index').select(basicSelect, { count: 'exact' })
      if (includeCatalogCurrent) fallbackBase = fallbackBase.eq('catalog_current', true)
      fallbackBase = fallbackBase.range(queryPage.from, queryPage.to)
      return applySort(
        applyFilters(fallbackBase, fallbackFilters),
        sort,
        { legacyRarity: true }
      )
    }

    let fb = await runFallback(!missingCatalogCurrent)
    if (fb.error && !missingCatalogCurrent && isMissingColumnError(fb.error, 'catalog_current')) {
      fb = await runFallback(false)
    }
    return { data: fb.data, error: fb.error, count: fb.count }
  }

  const { data, error, count, tier } = await runNameMatchPlans(
    buildNameMatchPlans(q, { scan }),
    runPlan,
    { pool: scan, page, limit }
  )

  if (error) {
    console.error('catalog/search error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const rows = data || []
  // Which name-match plan produced these rows, so a scan that only succeeded
  // after widening is distinguishable in UAT and in the client.
  const nameMatch = tier

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
        lang: card.lang ?? null,
        oracle_id: card.oracle_id ?? null,
        illustration_id: card.illustration_id ?? null,
        released_at: card.released_at ?? null,
        frame: card.frame ?? null,
        frame_effects: card.frame_effects ?? null,
        promo_types: card.promo_types ?? null,
        border_color: card.border_color ?? null,
        has_face_images: card.has_face_images ?? null,
        face_illustration_ids: card.face_illustration_ids ?? null,
        promo: card.promo ?? null,
        set_type: card.set_type ?? null,
        layout: card.layout ?? null,
        games: card.games ?? null,
        set_code: card.set_code,
        set_name: card.set_name,
        collector_number: card.collector_number,
        rarity: card.rarity,
        image_uris: card.image_uris || null,
        finishes: card.finishes || ['nonfoil'],
      })
    }
    const groups = Array.from(groupMap.values())
    return NextResponse.json({ groups, total: count ?? 0, page, limit, has_more: (from + rows.length) < (count ?? 0), name_match: nameMatch })
  }

  return NextResponse.json({ results: rows, total: count ?? 0, page, limit, has_more: (from + rows.length) < (count ?? 0), name_match: nameMatch })
}
