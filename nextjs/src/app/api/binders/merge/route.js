import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabaseServer'
import { createClient as createServiceClient } from '@supabase/supabase-js'

function makeServiceClient() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

export async function POST(request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const { source_id, target_id } = body

  if (!source_id || !target_id) {
    return NextResponse.json({ error: 'source_id and target_id are required' }, { status: 400 })
  }
  if (source_id === target_id) {
    return NextResponse.json({ error: 'Cannot merge a binder into itself' }, { status: 400 })
  }

  // Verify ownership of both binders (RLS enforces user_id match)
  const { data: sourceBinder } = await supabase
    .from('binders')
    .select('id, name')
    .eq('id', source_id)
    .eq('user_id', user.id)
    .single()

  if (!sourceBinder) return NextResponse.json({ error: 'Source binder not found' }, { status: 404 })

  const { data: targetBinder } = await supabase
    .from('binders')
    .select('id, name')
    .eq('id', target_id)
    .eq('user_id', user.id)
    .single()

  if (!targetBinder) return NextResponse.json({ error: 'Target binder not found' }, { status: 404 })

  const db = makeServiceClient()

  // Fetch all library card IDs in the source binder
  const { data: cards, error: cardsErr } = await db
    .from('library_cards')
    .select('id')
    .eq('binder_id', source_id)
    .eq('user_id', user.id)
    .limit(50000)

  if (cardsErr) {
    return NextResponse.json({ error: 'Failed to fetch cards: ' + cardsErr.message }, { status: 500 })
  }

  const cardIds = (cards || []).map(c => c.id)

  if (cardIds.length > 0) {
    const { error: rpcErr } = await db.rpc('move_library_cards', {
      p_user_id: user.id,
      p_target_binder_id: target_id,
      p_ids: cardIds,
    })

    if (rpcErr) {
      return NextResponse.json({ error: 'Failed to move cards: ' + rpcErr.message }, { status: 500 })
    }
  }

  // Delete the now-empty source binder
  const { error: deleteErr } = await supabase
    .from('binders')
    .delete()
    .eq('id', source_id)
    .eq('user_id', user.id)

  if (deleteErr) {
    return NextResponse.json({ error: 'Failed to delete source binder: ' + deleteErr.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, moved: cardIds.length })
}
