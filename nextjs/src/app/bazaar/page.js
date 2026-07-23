import { createClient as createAuthClient } from '@/lib/supabaseServer'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import DBBNav from '@/components/DBBNav'
import BazaarView from '@/components/BazaarView'
import { getActiveListingFacets } from '@/lib/listingsQueries'

export const metadata = { title: 'Bazaar — DBB' }

function makeServiceClient() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

export default async function BazaarPage() {
  const authClient = await createAuthClient()
  const { data: { user } } = await authClient.auth.getUser().catch(() => ({ data: { user: null } }))

  let initialData = null
  let filterOptions = { sets: [], rarities: [], cardTypes: [] }

  try {
    const sc = makeServiceClient()

    // Main grid data (first page of results)
    const { data: listings, error, count } = await sc
      .from('listings')
      .select(`
        id, user_id, multiplier, status, created_at,
        library_cards!inner(
          id, scryfall_id, foil, condition, quantity,
          card_index!inner(
            name, set_code, set_name, collector_number, rarity, type_line, colors, cmc, image_uris
          )
        )
      `, { count: 'exact' })
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .range(0, 23)

    if (!error && listings) {
      const scryfallIds = [...new Set(listings.map(l => l.library_cards?.scryfall_id).filter(Boolean))]
      const sellersByCard = new Map()
      if (scryfallIds.length > 0) {
        const { data: sellerRows } = await sc
          .from('listings')
          .select('user_id, library_cards!inner(scryfall_id)')
          .eq('status', 'active')
          .in('library_cards.scryfall_id', scryfallIds)
        for (const row of sellerRows || []) {
          const id = row.library_cards?.scryfall_id
          if (!id) continue
          if (!sellersByCard.has(id)) sellersByCard.set(id, new Set())
          sellersByCard.get(id).add(row.user_id)
        }
      }
      const enriched = listings.map(l => ({
        ...l,
        seller_count: sellersByCard.get(l.library_cards?.scryfall_id)?.size || 1,
      }))
      const total = count || 0
      initialData = { listings: enriched, total, hasMore: 24 < total, page: 1 }

      // Facet options must reflect ALL active, unexpired listings, not just
      // this first page — otherwise most valid set/type filter values are
      // invisible (Phase 41 tech audit P1 #4).
      try {
        filterOptions = await getActiveListingFacets(sc)
      } catch {
        // Facet source failed — fall back to deriving from the loaded page
        // rather than showing a broken/empty filter panel.
        const setMap = {}
        const raritySet = new Set()
        for (const l of listings) {
          const ci = l.library_cards?.card_index
          if (ci?.set_code) setMap[ci.set_code] = ci.set_name || ci.set_code
          if (ci?.rarity) raritySet.add(ci.rarity)
        }
        filterOptions = {
          sets: Object.entries(setMap).map(([code, name]) => ({ code, name })),
          rarities: [...raritySet],
          cardTypes: [],
        }
      }
    }
  } catch {
    // listings table not yet created — render empty gracefully
  }

  return (
    <div className="min-h-screen">
      <DBBNav userEmail={user?.email} />
      <BazaarView
        initialData={initialData}
        filterOptions={filterOptions}
        userId={user?.id || null}
      />
    </div>
  )
}
