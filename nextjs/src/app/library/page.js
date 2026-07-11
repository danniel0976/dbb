import { createClient } from '@/lib/supabaseServer'
import { getLibrary } from '@/lib/libraryQueries'
import LibraryView from '@/components/LibraryView'
import CollectionValue from '@/components/CollectionValue'
import DBBNav from '@/components/DBBNav'
import { redirect } from 'next/navigation'

export const metadata = { title: "Your Library — DBB" }

export default async function LibraryPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const [libraryResult, bindersResult] = await Promise.all([
    getLibrary(user.id, {}, 1, 48).catch(() => ({ cards: [], total: 0, hasMore: false })),
    supabase.from('binders').select('id, name, is_default').eq('user_id', user.id).order('created_at'),
  ])

  const binders = bindersResult.data || []

  return (
    <div className="min-h-screen bg-gradient-to-br from-dbb-primary to-dbb-secondary">
      <DBBNav userEmail={user.email} extra={<CollectionValue />} />

      <main className="container mx-auto px-4 py-6">
        <div className="mb-6">
          <h2 className="text-2xl font-bold text-white">Your Library</h2>
          {libraryResult.total > 0 && (
            <p className="text-gray-400 text-sm mt-1">{libraryResult.total} card{libraryResult.total !== 1 ? 's' : ''} in your collection</p>
          )}
        </div>

        <LibraryView
          userId={user.id}
          initialData={libraryResult}
          binders={binders}
        />
      </main>
    </div>
  )
}
