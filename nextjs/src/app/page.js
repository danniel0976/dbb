import { redirect } from 'next/navigation'
import { createClient as createAuthClient } from '@/lib/supabaseServer'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import DBBNav from '@/components/DBBNav'
import HomeView from '@/components/HomeView'
import { getHeroListings } from '@/lib/heroListings'

export const metadata = { title: 'Home — DBB' }

function makeServiceClient() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

export default async function HomePage() {
  const authClient = await createAuthClient()
  const { data: { user } } = await authClient.auth.getUser().catch(() => ({ data: { user: null } }))

  if (!user) redirect('/login')

  let hotListings = []
  let latestListings = []
  try {
    const sc = makeServiceClient()
    ;({ hotListings, latestListings } = await getHeroListings(sc))
  } catch {
    // listings table not yet created — render empty gracefully
  }

  return (
    <div className="min-h-screen">
      <DBBNav userEmail={user.email} />
      <HomeView hotListings={hotListings} latestListings={latestListings} userId={user.id} />
    </div>
  )
}
