import { createClient as createAuthClient } from '@/lib/supabaseServer'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import DBBNav from '@/components/DBBNav'
import ClaimSaleList from '@/components/ClaimSaleList'

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
        delivery_option, created_at, status
      `, { count: 'exact' })
      .eq('status', 'active')
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .range(0, 19)

    if (!error && data) {
      const userIds = [...new Set(data.map(cs => cs.user_id))]
      let sellerMap = {}
      if (userIds.length > 0) {
        const { data: profiles } = await sc
          .from('profiles')
          .select('id, display_name')
          .in('id', userIds)
        for (const p of profiles || []) sellerMap[p.id] = p.display_name
      }

      // Get card counts
      const claimSaleIds = data.map(cs => cs.id)
      let cardCountMap = {}
      let followerCountMap = {}
      if (claimSaleIds.length > 0) {
        try {
          const { data: listingCounts } = await sc
            .from('listings')
            .select('claim_sale_id')
            .in('claim_sale_id', claimSaleIds)
            .eq('status', 'active')
          for (const row of listingCounts || []) {
            cardCountMap[row.claim_sale_id] = (cardCountMap[row.claim_sale_id] || 0) + 1
          }
        } catch {}

        try {
          const { data: followCounts } = await sc
            .from('follows')
            .select('claim_sale_id')
            .in('claim_sale_id', claimSaleIds)
          for (const row of followCounts || []) {
            followerCountMap[row.claim_sale_id] = (followerCountMap[row.claim_sale_id] || 0) + 1
          }
        } catch {}
      }

      claimSales = data.map(cs => ({
        ...cs,
        seller_name: sellerMap[cs.user_id] || null,
        card_count: cardCountMap[cs.id] || 0,
        follower_count: followerCountMap[cs.id] || 0,
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