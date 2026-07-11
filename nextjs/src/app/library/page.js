import { createClient } from '@/lib/supabaseServer'
import { getLibrary } from '@/lib/libraryQueries'
import LibraryView from '@/components/LibraryView'
import CollectionValue from '@/components/CollectionValue'
import { redirect } from 'next/navigation'
import Link from 'next/link'

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
      {/* Header */}
      <header className="sticky top-0 z-40 bg-dbb-primary/95 backdrop-blur border-b border-dbb-accent/20">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <h1 className="text-xl font-bold text-dbb-accent">DBB Library</h1>
            <nav className="hidden sm:flex items-center gap-3 text-sm text-gray-400">
              <Link href="/library" className="text-white font-medium">Library</Link>
              <Link href="/binders" className="hover:text-white transition-colors">Binders</Link>
              <Link href="/import" className="hover:text-white transition-colors">Import</Link>
              <Link href="/bazaar" className="hover:text-white transition-colors">Bazaar</Link>
              <Link href="/profile" className="hover:text-white transition-colors">Profile</Link>
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <CollectionValue />
            <span className="text-xs text-gray-500 hidden sm:inline">{user.email}</span>
            <form action="/api/auth/signout" method="POST">
              <button
                type="submit"
                className="text-sm text-gray-400 hover:text-white border border-gray-700 hover:border-gray-500 rounded-lg px-3 py-1.5 transition-colors"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

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
