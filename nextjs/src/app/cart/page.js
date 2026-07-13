import { createClient } from '@/lib/supabaseServer'
import { redirect } from 'next/navigation'
import DBBNav from '@/components/DBBNav'
import CartView from '@/components/CartView'

export const metadata = { title: 'Cart — DBB' }

export default async function CartPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  return (
    <div className="min-h-screen">
      <DBBNav userEmail={user.email} />
      <main className="container mx-auto px-4 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white">Your Cart</h1>
          <p className="text-gray-400 text-sm mt-1">Items are grouped by seller</p>
        </div>
        <CartView />
      </main>
    </div>
  )
}
