import { createClient } from '@/lib/supabaseServer'
import { redirect } from 'next/navigation'
import ImportWizard from '@/components/ImportWizard'
import Link from 'next/link'

export const metadata = { title: 'Import Collection — DBB' }

export default async function ImportPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  return (
    <div className="min-h-screen bg-gradient-to-br from-dbb-primary to-dbb-secondary">
      <header className="sticky top-0 z-40 bg-dbb-primary/95 backdrop-blur border-b border-dbb-accent/20">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <h1 className="text-xl font-bold text-dbb-accent">DBB Library</h1>
            <nav className="hidden sm:flex items-center gap-3 text-sm text-gray-400">
              <Link href="/library" className="hover:text-white transition-colors">Library</Link>
              <Link href="/import" className="text-white font-medium">Import</Link>
              <Link href="/bazaar" className="hover:text-white transition-colors">Bazaar</Link>
            </nav>
          </div>
          <div className="flex items-center gap-3">
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

      <main className="container mx-auto px-4 py-10">
        <div className="mb-8">
          <h2 className="text-2xl font-bold text-white">Import Collection</h2>
          <p className="text-gray-400 text-sm mt-1">Import your ManaBox collection export into your DBB library.</p>
        </div>
        <ImportWizard />
      </main>
    </div>
  )
}
