import { createClient } from '@/lib/supabaseServer'
import { getLibrary } from '@/lib/libraryQueries'
import LibraryWithRail from '@/components/LibraryWithRail'
import DBBNav from '@/components/DBBNav'
import { redirect } from 'next/navigation'

export const metadata = { title: "Your Library — DBB" }

export default async function LibraryPage({ searchParams }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const selectedBinderId = searchParams?.binder || null

  // Fetch binders and prefetch the first library page in parallel.
  // Binder counts are deferred to client-side (BinderRail fetches /api/binders
  // after mount) so the server doesn't block HTML delivery on N count queries.
  const [libraryResult, { data: binderRows }] = await Promise.all([
    getLibrary(user.id, selectedBinderId ? { binder_id: selectedBinderId } : {}, 1, 48)
      .catch(() => ({ cards: [], total: 0, hasMore: false })),
    supabase.from('binders')
      .select('id, name, is_default, created_at')
      .eq('user_id', user.id)
      .order('created_at'),
  ])

  const binders = (binderRows || []).map(b => ({
    id: b.id,
    name: b.name,
    is_default: b.is_default,
    created_at: b.created_at,
    card_count: null, // loaded client-side by BinderRail
  }))

  // Validate the binder param belongs to this user
  const validBinderId = selectedBinderId && binders.some(b => b.id === selectedBinderId)
    ? selectedBinderId
    : null

  return (
    <div className="min-h-screen">
      <DBBNav userEmail={user.email} />

      <main className="container mx-auto px-4 py-6">
        <div className="mb-4">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Your Library</h1>
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
