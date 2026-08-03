import { createClient as createAuthClient } from '@/lib/supabaseServer'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import DBBNav from '@/components/DBBNav'
import ClaimSaleList from '@/components/ClaimSaleList'
import { indexClaimSaleListings, resolveFeaturedImageUri } from '@/lib/claimSaleThumbnails.mjs'

export const metadata = { title: 'Claim Sales — DBB' }

export const runtime = 'nodejs'

function makeServiceClient() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

export default async function ClaimSalesPage() {
  const authClient = await createAuthClient()
  const { data: { user } } = await authClient.auth.getUser().catch(() => ({ data: { user: null } }))
  const sc = makeServiceClient()

  let claimSales = []
  let hasMore = false
  let total = 0

  try {
    const { data, error, count } = await sc
      .from('claim_sales')
      .select(`
        id, title, description, set_code, user_id, expires_at,
        delivery_option, created_at, status, featured_listing_id
      `, { count: 'exact' })
      .eq('status', 'active')
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .range(0, 19)

    if (!error && data) {
      const claimSaleIds = data.map(cs => cs.id)
      const userIds = [...new Set(data.map(cs => cs.user_id))]
      let sellerMap = {}
      let followerCountMap = {}
      const [profilesResult, listingsResult, followsResult] = await Promise.all([
        userIds.length > 0
          ? sc.from('profiles').select('id, display_name').in('id', userIds)
          : Promise.resolve({ data: [] }),
        claimSaleIds.length > 0
          ? sc
            .from('listings')
            .select(`
              id, claim_sale_id,
              library_cards!inner(
                card_index!inner(image_uris)
              )
            `)
            .in('claim_sale_id', claimSaleIds)
            .eq('status', 'active')
          : Promise.resolve({ data: [] }),
        claimSaleIds.length > 0
          ? sc
            .from('follows')
            .select('claim_sale_id')
            .in('claim_sale_id', claimSaleIds)
          : Promise.resolve({ data: [] }),
      ])
      for (const p of profilesResult.data || []) sellerMap[p.id] = p.display_name
      // Thumbnails come from the stored card_index.image_uris on the active
      // child listings — the same resolution the Bazaar browse API uses, so a
      // sale never shows a thumbnail on one surface and a blank tile on the
      // other. Synthetic fixture scryfall_ids have no Scryfall record, so no
      // client-side lookup is attempted.
      const thumbIndex = indexClaimSaleListings(listingsResult.data || [])
      for (const row of followsResult.data || []) {
        followerCountMap[row.claim_sale_id] = (followerCountMap[row.claim_sale_id] || 0) + 1
      }

      claimSales = data.map(({ featured_listing_id: featuredListingId, ...cs }) => ({
        ...cs,
        seller_name: sellerMap[cs.user_id] || null,
        card_count: thumbIndex.cardCount[cs.id] || 0,
        follower_count: followerCountMap[cs.id] || 0,
        featured_image_uri: resolveFeaturedImageUri(thumbIndex, cs.id, featuredListingId),
      }))
      total = count || 0
      hasMore = 20 < total
    }
  } catch {
    // claim_sales table not yet migrated
  }

  return (
    <div className="min-h-screen">
      <DBBNav userEmail={user?.email} />
      <ClaimSaleList claimSales={claimSales} hasMore={hasMore} total={total} />
    </div>
  )
}
