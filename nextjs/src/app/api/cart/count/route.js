import { NextResponse } from 'next/server'
import { createClient as createAuthClient } from '@/lib/supabaseServer'

export const runtime = 'nodejs'

// GET /api/cart/count — lightweight count for nav badge
export async function GET() {
  const authClient = await createAuthClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return NextResponse.json({ count: 0 })

  try {
    const { data, error } = await authClient
      .from('cart_items')
      .select('quantity')
      .eq('user_id', user.id)

    if (error) {
      // table not yet created — return 0 silently
      return NextResponse.json({ count: 0 })
    }

    return NextResponse.json({ count: (data || []).reduce((sum, row) => sum + Number(row.quantity || 0), 0) })
  } catch {
    return NextResponse.json({ count: 0 })
  }
}
