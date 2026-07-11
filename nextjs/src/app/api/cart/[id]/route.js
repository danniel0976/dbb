import { NextResponse } from 'next/server'
import { createClient as createAuthClient } from '@/lib/supabaseServer'

export const runtime = 'nodejs'

// DELETE /api/cart/[id] — remove a cart item by cart item id
export async function DELETE(request, { params }) {
  const { id } = await params
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const authClient = await createAuthClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const { error } = await authClient
      .from('cart_items')
      .delete()
      .eq('id', id)
      .eq('user_id', user.id) // belt-and-suspenders alongside RLS

    if (error) {
      // table not yet created — treat as success
      if (error.code === '42P01') return NextResponse.json({ success: true })
      throw error
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[DELETE /api/cart/[id]]', err?.message || err)
    return NextResponse.json({ error: err?.message || 'Failed to remove from cart' }, { status: 500 })
  }
}
