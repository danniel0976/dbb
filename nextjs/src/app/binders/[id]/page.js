import { createClient } from '@/lib/supabaseServer'
import { getLibrary } from '@/lib/libraryQueries'
import LibraryView from '@/components/LibraryView'
import DBBNav from '@/components/DBBNav'
import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'

export async function generateMetadata({ params }) {
  return { title: 'Binder — DBB' }
}

export default async function BinderPage({ params }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: binder } = await supabase
    .from('binders')
    .select('id, name, is_default, created_at')
    .eq('id', params.id)
    .eq('user_id', user.id)
    .single()

  if (!binder) notFound()

  const [libraryResult, bindersResult] = await Promise.all([
    getLibrary(user.id, { binder_id: binder.id }, 1, 48).catch(() => ({ cards: [], total: 0, hasMore: false })),
    supabase.from('binders').select('id, name, is_default').eq('user_id', user.id).order('created_at'),
  ])

  const binders = bindersResult.data || []

  return (
    <div className="min-h-screen bg-gradient-to-br from-dbb-primary to-dbb-secondary">
      <DBBNav userEmail={user.email} />

      <main className="container mx-auto px-4 py-6">
        <div className="mb-6">
          <Link
            href="/binders"
            className="inline-flex items-center gap-1 text-sm text-gray-400 hover:text-white transition-colors mb-3"
          >
            <ChevronLeft className="w-4 h-4" /> Back to binders
          </Link>
          <div className="flex items-center gap-3">
            <h2 className="text-2xl font-bold text-white">{binder.name}</h2>
            {binder.is_default && (
              <span className="text-xs text-dbb-accent border border-dbb-accent/40 rounded px-2 py-0.5">Default</span>
            )}
          </div>
          <p className="text-gray-400 text-sm mt-1">
            {libraryResult.total} card{libraryResult.total !== 1 ? 's' : ''}
          </p>
        </div>

        <LibraryView
          userId={user.id}
          initialData={libraryResult}
          binders={binders}
          binderId={binder.id}
        />
      </main>
    </div>
  )
}
