import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabaseServer'
import { createClient as createServiceClient } from '@supabase/supabase-js'

// POST /api/profile/deactivate
// Soft-disables the account (sets deactivated_at), then signs out.
// Middleware will block future logins with ?deactivated=1 redirect.
export async function POST() {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Use service role to update deactivated_at (bypasses RLS for safety)
  const service = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )

  const { error } = await service
    .from('profiles')
    .update({ deactivated_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', user.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Sign the user out
  await supabase.auth.signOut()

  return NextResponse.json({ success: true })
}
