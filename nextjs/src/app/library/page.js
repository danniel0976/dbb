import { createClient } from '@/lib/supabaseServer'
import { getLibrary } from '@/lib/libraryQueries'
import LibraryWithRail from '@/components/LibraryWithRail'
import CollectionValue from '@/components/CollectionValue'
import DBBNav from '@/components/DBBNav'
import { redirect } from 'next/navigation'

export const metadata = { title: "Your Library — DBB" }

export default async function LibraryPage({ searchParams }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const selectedBinderId = searchParams?.binder || null

  const [libraryResult, bindersResult] = await Promise.all([
    getLibrary(user.id, selectedBinderId ? { binder_id: selectedBinderId } : {}, 1, 48)
      .catch(() => ({ cards: [], total: 0, hasMore: false })),
    supabase.from('binders')
      .select('id, name, is_default, created_at, library_cards(count)')
      .eq('user_id', user.id)
      .order('created_at'),
  ])

  const binders = (bindersResult.data || []).map(b => ({
    id: b.id,
    name: b.name,
    is_default: b.is_default,
    created_at: b.created_at,
    card_count: b.library_cards?.[0]?.count ?? 0,
  }))

  // Validate the binder param belongs to this user
  const validBinderId = selectedBinderId && binders.some(b => b.id === selectedBinderId)
    ? selectedBinderId
    : null

  return (
    <div className="min-h-screen bg-gradient-to-br from-dbb-primary to-dbb-secondary">
      <DBBNav userEmail={user.email} extra={<CollectionValue />} />

      <main className="container mx-auto px-4 py-6">
        <div className="mb-4">
          <h2 className="text-2xl font-bold text-white">Your Library</h2>
        </div>

        <LibraryWithRail
          userId={user.id}
          initialData={libraryResult}
          initialBinders={binders}
          initialBinderId={validBinderId}
        />
      </main>
    </div>
  )
}
