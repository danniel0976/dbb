import { createClient as createAuthClient } from '@/lib/supabaseServer'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import DBBNav from '@/components/DBBNav'
import ClaimSaleView from '@/components/ClaimSaleView'

export const runtime = 'nodejs'

function makeServiceClient() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

export async function generateMetadata({ params }) {
  const { id } = await params
  const sc = makeServiceClient()
  try {
    const { data } = await sc
      .from('claim_sales')
      .select('title')
      .eq('id', id)
      .maybeSingle()
    return { title: data?.title ? `${data.title} — DBB` : 'Claim Sale — DBB' }
  } catch {
    return { title: 'Claim Sale — DBB' }
  }
}

export default async function ClaimSalePage({ params }) {
  const { id } = await params
  const authClient = await createAuthClient()
  const { data: { user } } = await authClient.auth.getUser().catch(() => ({ data: { user: null } }))
  const sc = makeServiceClient()

  let claimSale = null
  let seller = null
  let listings = []
  let isFollowing = false
  let followerCount = 0
  let notFound = false

  try {
    const { data: csData, error: csError } = await sc
      .from('claim_sales')
      .select(`
        id, title, description, set_code, user_id, duration_hours,
        expires_at, status, delivery_option, created_at, featured_listing_id
      `)
      .eq('id', id)
      .maybeSingle()

    if (csError) {
      if (csError.code === '42P01') {
        notFound = true
      } else {
        throw csError
      }
    } else if (!csData) {
      notFound = true
    } else {
      claimSale = csData

      // Get seller display name
      const { data: sellerData } = await sc
        .from('profiles')
        .select('display_name')
        .eq('id', claimSale.user_id)
        .maybeSingle()
      seller = sellerData

      // Get listings linked to this claim sale
      try {
        const { data: listingData, error: listErr } = await sc
          .from('listings')
          .select(`
            id, multiplier, quantity, status, created_at, expires_at,
            library_cards!inner(
              id, scryfall_id, foil, condition, quantity,
              card_index!inner(
                name, set_code, set_name, collector_number, rarity, type_line, colors, cmc, image_uris
              )
            )
          `)
          .eq('claim_sale_id', id)

        if (!listErr && listingData) {
          listings = listingData
        }
      } catch {
        // claim_sale_id column might not exist
      }

      // Check if current user follows this claim sale
      if (user) {
        try {
          const { data: followRow } = await sc
            .from('follows')
            .select('id')
            .eq('follower_id', user.id)
            .eq('claim_sale_id', id)
            .maybeSingle()
          isFollowing = !!followRow
        } catch {
          // follows table might not exist
        }
      }

      // Get follower count
      try {
        const { count } = await sc
          .from('follows')
          .select('id', { count: 'exact', head: true })
          .eq('claim_sale_id', id)
        followerCount = count || 0
      } catch {
        // follows table might not exist
      }
    }
  } catch (err) {
    console.error('[ClaimSalePage]', err?.message || err)
    notFound = true
  }

  return (
    <div className="min-h-screen">
      <DBBNav userEmail={user?.email} />
      <ClaimSaleView
        claimSale={claimSale}
        sellerName={seller?.display_name || null}
        listings={listings}
        isFollowing={isFollowing}
        followerCount={followerCount}
        isOwner={user?.id === claimSale?.user_id}
        notFound={notFound}
        claimSaleId={id}
        userId={user?.id || null}
        featuredListingId={claimSale?.featured_listing_id || null}
      />
    </div>
  )
}
