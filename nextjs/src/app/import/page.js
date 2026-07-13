import { createClient } from '@/lib/supabaseServer'
import { redirect } from 'next/navigation'
import ImportWizard from '@/components/ImportWizard'
import DBBNav from '@/components/DBBNav'

export const metadata = { title: 'Import Collection — DBB' }

export default async function ImportPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  return (
    <div className="min-h-screen">
      <DBBNav userEmail={user.email} />

      <main className="container mx-auto px-4 py-10">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Import Collection</h1>
          <p className="text-gray-500 dark:text-gray-400 text-sm mt-1">Import your ManaBox collection export into your DBB library.</p>
        </div>
        <ImportWizard />
      </main>
    </div>
  )
}
