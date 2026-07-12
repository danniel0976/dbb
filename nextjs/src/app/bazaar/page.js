import { createClient as createAuthClient } from '@/lib/supabaseServer'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import DBBNav from '@/components/DBBNav'
import BazaarView from '@/components/BazaarView'

export const metadata = { title: 'Bazaar — DBB' }

function makeServiceClient() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

export default async function BazaarPage() {
  // Auth (optional — bazaar is public but shows more when logged in)
  const authClient = await createAuthClient()
  const { data: { user } } = await authClient.auth.getUser().catch(() => ({ data: { user: null } }))

  // Fetch initial listings using service role so the JOIN works server-side
  // regardless of whether the viewer is authenticated.
  let initialData = null
  let filterOptions = { sets: [], rarities: [], cardTypes: [] }

  try {
    const sc = makeServiceClient()

    const { data: listings, error, count } = await sc
      .from('listings')
      .select(`
        id, user_id, multiplier, status, created_at,
        library_cards!inner(
          id, scryfall_id, foil, condition, quantity,
          card_index!inner(
            name, set_code, set_name, collector_number, rarity, type_line, colors, cmc
          )
        )
      `, { count: 'exact' })
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .range(0, 23)

    if (!error && listings) {
      // Fetch seller display names
      const userIds = [...new Set(listings.map(l => l.user_id))]
      let sellerMap = {}
      if (userIds.length > 0) {
        const { data: profiles } = await sc
          .from('profiles')
          .select('id, display_name')
          .in('id', userIds)
        for (const p of profiles || []) sellerMap[p.id] = p.display_name
      }

      const enriched = listings.map(l => ({ ...l, seller_name: sellerMap[l.user_id] || null }))
      const total = count || 0
      initialData = { listings: enriched, total, hasMore: 24 < total, page: 1 }

      // Build filter options from active listings
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
  } catch {
    // listings table not yet created — render empty gracefully
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-dbb-primary to-dbb-secondary">
      <DBBNav userEmail={user?.email} />
      <BazaarView initialData={initialData} filterOptions={filterOptions} userId={user?.id || null} />
    </div>
  )
}
