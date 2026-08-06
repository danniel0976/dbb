import { NextResponse } from 'next/server'
import { createClient as createAuthClient } from '@/lib/supabaseServer'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { requireCompleteMerchantProfile } from '@/lib/merchantProfile'
import { ensurePriceCache, lookupPrice, sellPrice } from '@/lib/pricingCache'
import { normalizeBazaarSort } from '@/lib/bazaarSearchState'
import { collectInBatches, dedupeValidIds } from '@/lib/postgrestBatch'
import { stockError } from '@/lib/stockErrors'

export const runtime = 'nodejs'

const VALID_MULTIPLIERS = [2.5, 2.8, 3.0]
const VALID_DURATIONS = [1, 3, 6, 12, 24]
const MAX_DURATION_HOURS = 24
const PRICE_CORPUS_PAGE_SIZE = 1000
// Postgres "undefined column" error — expires_at column not yet migrated
const UNDEF_COLUMN = '42703'

// Escapes POSIX ERE metacharacters so user-typed search text can't inject
// regex syntax into the `imatch` (~*) filter below.
function escapeRegex(str) {
  return str.replace(/[.^$*+?()[\]{}|\\]/g, '\\$&')
}

function makeServiceClient() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

function normalizeBrowseRow(row) {
  const listing = Array.isArray(row?.listings) ? row.listings[0] : row?.listings
  if (!listing) return null
  return {
    ...listing,
    library_cards: {
      id: row.id,
      scryfall_id: row.scryfall_id,
      foil: row.foil,
      condition: row.condition,
      quantity: row.quantity,
      card_index: row.card_index,
    },
  }
}

// GET /api/listings
// ?library_card_id=<uuid>  → return listing for that card (owner or null)
// ?status=active&page=N&...  → bazaar browsing (service role, public)
export async function GET(request) {
  const { searchParams } = new URL(request.url)
  const library_card_id = searchParams.get('library_card_id')

  // Single-card listing lookup (for CardDetailModal).
  //
  // An explicit `{listing: null}` at 200 is the *only* confirmed-absence
  // signal, and the card-detail modal now hangs a displayed price on it. A
  // lookup that failed for any other reason must therefore never borrow that
  // shape: unauthenticated is 401 and a broken lookup is 503, so the client's
  // dedicated error state engages instead of rendering a preview price as if
  // the owner had no listing. Raw database text stays in the server log; the
  // response carries only a stable public code.
  if (library_card_id) {
    const authClient = await createAuthClient()
    const { data: { user } } = await authClient.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, { status: 401 })
    }

    const lookupUnavailable = (err) => {
      console.error('[GET /api/listings single]', err?.message || err)
      return NextResponse.json(
        { error: 'Listing lookup unavailable', code: 'LISTING_LOOKUP_UNAVAILABLE' },
        { status: 503 }
      )
    }

    try {
      const { data, error } = await authClient
        .from('listings')
        .select('id, multiplier, status, created_at, expires_at, quantity')
        .eq('library_card_id', library_card_id)
        .eq('user_id', user.id)
        .maybeSingle()

      if (error) throw error
      return NextResponse.json({ listing: data || null })
    } catch (err) {
      // Fallback without expires_at AND quantity if either column doesn't exist yet
      if (err?.code !== UNDEF_COLUMN) {
        return lookupUnavailable(err)
      }
      try {
        const authClient2 = await createAuthClient()
        const { data, error: err2 } = await authClient2
          .from('listings')
          .select('id, multiplier, status, created_at')
          .eq('library_card_id', library_card_id)
          .eq('user_id', user.id)
          .maybeSingle()
        if (err2) throw err2
        return NextResponse.json({ listing: data || null })
      } catch (fallbackErr) {
        return lookupUnavailable(fallbackErr)
      }
    }
  }

  // Bazaar browsing — service role so we can join across RLS-protected tables
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10))
  const PAGE_SIZE = 24
  const sort = normalizeBazaarSort(searchParams.get('sort') || 'newest')
  const search = (searchParams.get('search') || '').trim()
  const setCode = searchParams.get('setCode') || null
  const isFoil = searchParams.get('isFoil')
  const rarities = (searchParams.get('rarities') || '').split(',').filter(Boolean)
  const colors = (searchParams.get('colors') || '').split(',').filter(Boolean)
  const cardType = searchParams.get('cardType') || null
  const minPriceRaw = searchParams.get('minPrice')
  const maxPriceRaw = searchParams.get('maxPrice')
  const minPrice = minPriceRaw !== null && minPriceRaw !== '' && !Number.isNaN(Number(minPriceRaw)) ? Number(minPriceRaw) : null
  const maxPrice = maxPriceRaw !== null && maxPriceRaw !== '' && !Number.isNaN(Number(maxPriceRaw)) ? Number(maxPriceRaw) : null
  // Price mode: any request that needs the *displayed* MYR price (CKD USD ×
  // multiplier) rather than DB columns must be resolved in application code,
  // because the price cache lives outside Postgres (Storage-backed JSON, no
  // snapshot column — see Phase 41 Decisions #1). Filtering/sorting therefore
  // fetches every row matching the non-price predicates (no DB range/limit)
  // and slices the page after computing/filtering/sorting by price in JS.
  const priceMode = minPrice !== null || maxPrice !== null || sort === 'price_high' || sort === 'price_low'

  const sc = makeServiceClient()

  const buildQuery = (withExpiry, rangeStart = null) => {
    const selectCols = withExpiry
      ? `id, scryfall_id, foil, condition, quantity,
        listings!inner(id, user_id, multiplier, status, created_at, expires_at, quantity),
        card_index!inner(name, set_code, set_name, collector_number, rarity, rarity_rank, type_line, colors, cmc, image_uris)`
      : `id, scryfall_id, foil, condition, quantity,
        listings!inner(id, user_id, multiplier, status, created_at),
        card_index!inner(name, set_code, set_name, collector_number, rarity, rarity_rank, type_line, colors, cmc, image_uris)`
    let q = sc
      .from('library_cards')
      .select(selectCols, priceMode ? {} : { count: 'exact' })
      .eq('listings.status', 'active')

    if (withExpiry) q = q.gt('listings.expires_at', new Date().toISOString())

    // Word-prefix match (not substring-anywhere): "D" should surface "Altar of
    // Dementia" via the word "Dementia", not any name containing a lowercase d.
    if (search) q = q.regexIMatch('card_index.name', `\\m${escapeRegex(search)}`)
    if (setCode) q = q.eq('card_index.set_code', setCode)
    if (rarities.length > 0) q = q.in('card_index.rarity', rarities)
    if (isFoil === 'true') q = q.neq('foil', 'normal')
    else if (isFoil === 'false') q = q.eq('foil', 'normal')
    if (colors.length > 0) q = q.overlaps('card_index.colors', colors)
    if (cardType) q = q.ilike('card_index.type_line', `%${cardType}%`)

    if (priceMode) {
      // Price filter/sort is resolved in JS below; keep a deterministic base
      // order for complete-corpus paging. The final price sort has its own
      // listing-id tie-breaker.
      q = q.order('id', { ascending: true })
      if (rangeStart !== null) {
        q = q.range(rangeStart, rangeStart + PRICE_CORPUS_PAGE_SIZE - 1)
      }
    } else {
      if (sort === 'name_az') {
        q = q.order('card_index(name)', { ascending: true })
          .order('card_index(set_code)', { ascending: true })
          .order('card_index(collector_number)', { ascending: true })
      } else if (sort === 'cmc_low' || sort === 'cmc_high') {
        q = q.order('card_index(cmc)', { ascending: sort === 'cmc_low', nullsFirst: false })
          .order('card_index(name)', { ascending: true })
      } else if (sort === 'rarity_low' || sort === 'rarity_high') {
        q = q.order('card_index(rarity_rank)', { ascending: sort === 'rarity_low', nullsFirst: false })
          .order('card_index(name)', { ascending: true })
      } else {
        q = q.order('listings(created_at)', { ascending: false })
      }
      q = q.order('id', { ascending: true })

      const from = (page - 1) * PAGE_SIZE
      q = q.range(from, from + PAGE_SIZE - 1)
    }
    return q
  }

  try {
    let rows
    let total
    let result

    if (priceMode) {
      // This is a bounded linear interim fix for the PostgREST response cap;
      // it is not the long-term price-snapshot redesign.
      const fetchPriceCorpus = async (withExpiry) => {
        const corpus = []
        for (let offset = 0; ; offset += PRICE_CORPUS_PAGE_SIZE) {
          const pageResult = await buildQuery(withExpiry, offset)
          if (pageResult.error) throw pageResult.error
          const pageRows = (pageResult.data || []).map(normalizeBrowseRow).filter(Boolean)
          corpus.push(...pageRows)
          if (pageRows.length < PRICE_CORPUS_PAGE_SIZE) return corpus
        }
      }

      try {
        rows = await fetchPriceCorpus(true)
      } catch (err) {
        if (err?.code !== UNDEF_COLUMN) throw err
        rows = await fetchPriceCorpus(false)
      }
      total = 0
    } else {
      result = await buildQuery(true)
      if (result.error?.code === UNDEF_COLUMN) {
        result = await buildQuery(false)
      }
      const { data, error, count } = result
      if (error) throw error
      rows = (data || []).map(normalizeBrowseRow).filter(Boolean)
      total = count || 0
    }
    let from = (page - 1) * PAGE_SIZE

    if (priceMode) {
      try {
        await ensurePriceCache()
      } catch (err) {
        console.error('[GET /api/listings] price cache unavailable:', err?.message || err)
      }

      const priced = rows.map(l => {
        const scryfallId = l.library_cards?.scryfall_id
        const foil = l.library_cards?.foil || 'normal'
        const ckdUsd = scryfallId ? lookupPrice(scryfallId, foil) : null
        const myrPrice = ckdUsd != null ? sellPrice(ckdUsd, Number(l.multiplier)) : null
        return { listing: l, myrPrice }
      })

      let filtered = priced
      if (minPrice !== null || maxPrice !== null) {
        // A price range is active: exclude listings whose displayed price is
        // unknown (matches the tile's "Price unavailable" state) rather than
        // silently including them.
        filtered = filtered.filter(({ myrPrice }) => {
          if (myrPrice == null) return false
          if (minPrice !== null && myrPrice < minPrice) return false
          if (maxPrice !== null && myrPrice > maxPrice) return false
          return true
        })
      }

      if (sort === 'price_low' || sort === 'price_high') {
        const dir = sort === 'price_low' ? 1 : -1
        filtered = filtered.slice().sort((a, b) => {
          // Missing-price listings always sort after priced listings.
          if (a.myrPrice == null && b.myrPrice == null) return a.listing.id < b.listing.id ? -1 : 1
          if (a.myrPrice == null) return 1
          if (b.myrPrice == null) return -1
          if (a.myrPrice !== b.myrPrice) return dir * (a.myrPrice - b.myrPrice)
          return a.listing.id < b.listing.id ? -1 : 1
        })
      }

      total = filtered.length
      from = (page - 1) * PAGE_SIZE
      rows = filtered.slice(from, from + PAGE_SIZE).map(({ listing, myrPrice }) => ({ ...listing, _myr_price: myrPrice }))
    }

    // Bazaar tiles deliberately do not expose a seller identity. Count the
    // distinct sellers offering each exact printing; identities remain in the
    // card-detail seller selector.
    const scryfallIds = [...new Set((rows || [])
      .map(l => l.library_cards?.scryfall_id)
      .filter(Boolean))]
    const sellersByCard = new Map()
    if (scryfallIds.length > 0) {
      const { data: sellerRows } = await sc
        .from('listings')
        .select('user_id, library_cards!inner(scryfall_id)')
        .eq('status', 'active')
        .gt('expires_at', new Date().toISOString())
        .in('library_cards.scryfall_id', scryfallIds)

      for (const row of sellerRows || []) {
        const cardId = row.library_cards?.scryfall_id
        if (!cardId) continue
        if (!sellersByCard.has(cardId)) sellersByCard.set(cardId, new Set())
        sellersByCard.get(cardId).add(row.user_id)
      }
    }

    const listings = (rows || []).map(l => ({
      ...l,
      seller_count: sellersByCard.get(l.library_cards?.scryfall_id)?.size || 1,
    }))

    return NextResponse.json({ listings, total, hasMore: from + PAGE_SIZE < total, page })
  } catch (err) {
    console.error('[GET /api/listings]', err?.message || err)
    return NextResponse.json({ listings: [], total: 0, hasMore: false, page: 1 })
  }
}

// POST /api/listings
// Body: { library_card_id, multiplier, duration_hours }
//    OR { items: [{library_card_id, multiplier, duration_hours}], duration_hours }
// duration_hours is REQUIRED (1 | 3 | 6 | 12 | 24); max 24h enforced server-side
export async function POST(request) {
  const authClient = await createAuthClient()
  const { data: { user }, error: authError } = await authClient.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const merchantGate = await requireCompleteMerchantProfile(authClient, user.id)
  if (merchantGate) {
    return NextResponse.json({ error: merchantGate.error, code: merchantGate.code }, { status: merchantGate.status })
  }

  let body
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Normalise to array; top-level duration_hours applies to all items if not per-item
  const topDuration = body.duration_hours
  const items = body.items
    ? body.items.map(i => ({ ...i, duration_hours: i.duration_hours ?? topDuration }))
    : [{ library_card_id: body.library_card_id, multiplier: body.multiplier, duration_hours: topDuration, quantity: body.quantity }]

  for (const item of items) {
    if (!item.library_card_id) {
      return NextResponse.json({ error: 'library_card_id required' }, { status: 400 })
    }
    if (!VALID_MULTIPLIERS.includes(Number(item.multiplier))) {
      return NextResponse.json({ error: 'multiplier must be 2.5, 2.8 or 3.0' }, { status: 400 })
    }
    const dur = Number(item.duration_hours)
    if (!dur || !VALID_DURATIONS.includes(dur)) {
      return NextResponse.json(
        { error: 'duration_hours required and must be 1, 3, 6, 12, or 24' },
        { status: 400 }
      )
    }
    if (dur > MAX_DURATION_HOURS) {
      return NextResponse.json({ error: 'Maximum listing duration is 24 hours' }, { status: 400 })
    }
    // Validate quantity: integer ≥ 1 (default 1)
    const qty = item.quantity !== undefined ? Number(item.quantity) : 1
    if (!Number.isInteger(qty) || qty < 1) {
      return NextResponse.json(
        { error: 'quantity must be a positive integer' },
        { status: 400 }
      )
    }
    item._quantity = qty
  }

  // Verify all library cards belong to this user AND fetch owned quantities
  const libraryCardIds = items.map(i => i.library_card_id)
  const uniqueLibraryCardIds = dedupeValidIds(libraryCardIds)
  if (!uniqueLibraryCardIds) {
    return NextResponse.json({ error: 'library_card_id values must be valid UUIDs and contain at most 10,000 unique cards' }, { status: 400 })
  }
  const ownedResult = await collectInBatches(uniqueLibraryCardIds, batch => authClient
    .from('library_cards')
    .select('id, quantity')
    .in('id', batch)
    .eq('user_id', user.id))
  const { data: ownedCards, error: ownErr } = ownedResult

  if (ownErr) {
    return NextResponse.json({ error: 'Failed to verify ownership' }, { status: 500 })
  }

  const ownedMap = new Map((ownedCards || []).map(c => [c.id, c.quantity]))
  const unowned = libraryCardIds.filter(id => !ownedMap.has(id))
  if (unowned.length > 0) {
    return NextResponse.json({ error: 'One or more cards not found in your library' }, { status: 403 })
  }

  // Validate each item's quantity against owned quantity
  for (const item of items) {
    const ownedQty = ownedMap.get(item.library_card_id)
    if (item._quantity > ownedQty) {
      return NextResponse.json(
        { error: `Cannot list ${item._quantity} copies; you only own ${ownedQty} of this card`, library_card_id: item.library_card_id },
        { status: 400 }
      )
    }
  }

  // Photo gate — every card being listed must have a photo
  const sc2 = makeServiceClient()
  const photoResult = await collectInBatches(uniqueLibraryCardIds, batch => sc2
    .from('card_photos')
    .select('library_card_id')
    .in('library_card_id', batch))
  const { data: photoRows } = photoResult

  const photoSet = new Set((photoRows || []).map(p => p.library_card_id))
  const missingPhotos = libraryCardIds.filter(id => !photoSet.has(id))
  if (missingPhotos.length > 0) {
    return NextResponse.json(
      { error: 'A real-life card photo is required before listing. Please photograph your card first.', missing_photos: missingPhotos },
      { status: 422 }
    )
  }

  const now = Date.now()
  const rows = items.map(item => ({
    user_id: user.id,
    library_card_id: item.library_card_id,
    multiplier: Number(item.multiplier),
    quantity: item._quantity,
    status: 'active',
    expires_at: new Date(now + Number(item.duration_hours) * 3600 * 1000).toISOString(),
  }))

  // Try with expires_at + quantity; fall back if columns not yet migrated
  let result = await authClient
    .from('listings')
    .upsert(rows, { onConflict: 'library_card_id' })
    .select()

  if (result.error?.code === UNDEF_COLUMN) {
    // migration-014 may be pending while expires_at already exists.
    // Preserve expiry and retry without quantity first.
    const rowsFallback = rows.map(({ quantity: _q, ...r }) => r)
    result = await authClient
      .from('listings')
      .upsert(rowsFallback, { onConflict: 'library_card_id' })
      .select()

    if (result.error?.code === UNDEF_COLUMN) {
      // Pre-migration-009 fallback: expires_at is also unavailable.
      const rowsLegacy = rowsFallback.map(({ expires_at: _e, ...r }) => r)
      result = await authClient
        .from('listings')
        .upsert(rowsLegacy, { onConflict: 'library_card_id' })
        .select()
    }
  }

  if (result.error) {
    console.error('[POST /api/listings]', result.error.message)
    const { error: errCode, code, status } = stockError(result.error, 'LISTING_CREATE_FAILED')
    return NextResponse.json({ error: errCode, code }, { status })
  }

  return NextResponse.json({ listings: result.data }, { status: 201 })
}
