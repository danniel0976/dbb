import { createClient } from '@/lib/supabaseServer'
import { redirect } from 'next/navigation'
import DBBNav from '@/components/DBBNav'
import OrdersView from './OrdersView'

export const metadata = { title: 'Orders — DBB' }

export default async function OrdersPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  return (
    <div className="min-h-screen">
      <DBBNav userEmail={user.email} />
      <main className="container mx-auto px-4 py-8 max-w-4xl">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Orders</h1>
        <p className="text-sm text-gray-500 mt-1 mb-6">Manual bank-in orders and TCG-store pickup progress</p>
        <OrdersView />
      </main>
    </div>
  )
}
