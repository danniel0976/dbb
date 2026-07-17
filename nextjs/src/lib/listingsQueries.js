// Read-only facet source for the Bazaar filter UI — derives distinct sets,
// rarities, and top-level card types from ALL active, unexpired listings,
// not just the currently loaded page (Phase 41 tech audit P1 #4). Uses
// batched .range() reads rather than one unpaged query so the corpus can
// exceed PostgREST's default row cap safely (same defensive shape as the
// select-all/set-facet helpers in libraryQueries.js).

const BATCH_SIZE = 1000

// Card types recognized as "top-level" (not supertypes like Legendary/Basic/
// Snow, and not subtypes after the em dash).
export const KNOWN_CARD_TYPES = [
  'Artifact', 'Battle', 'Conspiracy', 'Creature', 'Dungeon', 'Enchantment',
  'Instant', 'Kindred', 'Land', 'Phenomenon', 'Plane', 'Planeswalker',
  'Scheme', 'Sorcery', 'Tribal', 'Vanguard',
]
const KNOWN_CARD_TYPES_SET = new Set(KNOWN_CARD_TYPES)

export function extractTopLevelTypes(typeLine) {
  if (!typeLine) return []
  const beforeDash = typeLine.split('—')[0]
  return beforeDash.split(/\s+/).map(w => w.trim()).filter(w => KNOWN_CARD_TYPES_SET.has(w))
}

// Postgres "undefined column" error — expires_at column not yet migrated.
// Mirrors the same fallback used by GET /api/listings.
const UNDEF_COLUMN = '42703'

export async function getActiveListingFacets(sc) {
  const selectCols = 'library_cards!inner(card_index!inner(set_code, set_name, rarity, type_line))'

  const fetchBatch = (withExpiry, from, to) => {
    let q = sc.from('listings').select(selectCols).eq('status', 'active')
    if (withExpiry) q = q.gt('expires_at', new Date().toISOString())
    return q.range(from, to)
  }

  let withExpiry = true
  const sets = new Map()
  const rarities = new Set()
  const cardTypes = new Set()

  let from = 0
  // Loop until a batch comes back short of BATCH_SIZE (exhausted), rather
  // than trusting any single unpaged query to return the full corpus.
  for (;;) {
    const to = from + BATCH_SIZE - 1
    let { data, error } = await fetchBatch(withExpiry, from, to)
    if (error?.code === UNDEF_COLUMN && withExpiry) {
      withExpiry = false
      ;({ data, error } = await fetchBatch(false, from, to))
    }
    if (error) throw error
    const rows = data || []
    for (const row of rows) {
      const ci = row.library_cards?.card_index
      if (!ci) continue
      if (ci.set_code) sets.set(ci.set_code, ci.set_name || ci.set_code)
      if (ci.rarity) rarities.add(ci.rarity)
      for (const t of extractTopLevelTypes(ci.type_line)) cardTypes.add(t)
    }
    if (rows.length < BATCH_SIZE) break
    from += BATCH_SIZE
  }

  return {
    sets: [...sets.entries()]
      .map(([code, name]) => ({ code, name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    rarities: [...rarities],
    // Keep a stable, domain-meaningful order rather than encounter order.
    cardTypes: KNOWN_CARD_TYPES.filter(t => cardTypes.has(t)),
  }
}
