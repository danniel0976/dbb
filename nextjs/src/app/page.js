import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabaseServer'

export default async function Home() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (user) redirect('/library')
  else redirect('/login')
}
