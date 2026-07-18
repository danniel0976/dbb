import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabaseServer'
import { dedupeValidIds, runSequentialBatches } from '@/lib/postgrestBatch'

export async function PATCH(request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const { ids, action, binder_id } = body

  if (!Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json({ error: 'ids required' }, { status: 400 })
  }

  if (action === 'star' || action === 'unstar') {
    const batchIds = dedupeValidIds(ids)
    if (!batchIds) {
      return NextResponse.json({ error: 'ids must contain valid UUIDs' }, { status: 400 })
    }

    const result = await runSequentialBatches(batchIds, batch => supabase
      .from('library_cards')
      .update({ starred: action === 'star' })
      .in('id', batch)
      .eq('user_id', user.id))

    if (result.error) {
      console.error('PATCH bulk star error:', result.error)
      return NextResponse.json({ error: result.error.message, processed: result.processed }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  }

  if (action === 'move') {
    if (!binder_id) {
      return NextResponse.json({ error: 'binder_id required for move' }, { status: 400 })
    }

    // Verify target binder belongs to user
    const { data: targetBinder } = await supabase
      .from('binders')
      .select('id')
      .eq('id', binder_id)
      .eq('user_id', user.id)
      .single()

    if (!targetBinder) {
      return NextResponse.json({ error: 'Binder not found' }, { status: 404 })
    }

    // Use RPC to handle merge on conflict
    const { data, error } = await supabase
      .rpc('move_library_cards', {
        p_user_id: user.id,
        p_target_binder_id: binder_id,
        p_ids: ids,
      })

    if (error) {
      console.error('PATCH bulk move error:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ success: true, moved: data })
  }

  return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
}

export async function DELETE(request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const { ids } = body

  if (!Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json({ error: 'ids required' }, { status: 400 })
  }

  const batchIds = dedupeValidIds(ids)
  if (!batchIds) {
    return NextResponse.json({ error: 'ids must contain valid UUIDs' }, { status: 400 })
  }

  const result = await runSequentialBatches(batchIds, batch => supabase
    .from('library_cards')
    .delete()
    .in('id', batch)
    .eq('user_id', user.id))

  if (result.error) {
    console.error('DELETE bulk error:', result.error)
    return NextResponse.json({ error: result.error.message, processed: result.processed }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
