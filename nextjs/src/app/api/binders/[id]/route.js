import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabaseServer'

export async function PATCH(request, { params }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const name = (body.name || '').trim()
  if (!name || name.length > 60) {
    return NextResponse.json({ error: 'Name must be 1–60 characters' }, { status: 400 })
  }

  const { data: binder, error } = await supabase
    .from('binders')
    .update({ name })
    .eq('id', params.id)
    .eq('user_id', user.id)
    .select()
    .single()

  if (error) {
    console.error('PATCH binders error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!binder) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  return NextResponse.json({ binder })
}

export async function DELETE(request, { params }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Check ownership and default status
  const { data: binder } = await supabase
    .from('binders')
    .select('id, is_default')
    .eq('id', params.id)
    .eq('user_id', user.id)
    .single()

  if (!binder) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (binder.is_default) {
    return NextResponse.json({ error: 'Cannot delete the default binder' }, { status: 400 })
  }

  const { error } = await supabase
    .from('binders')
    .delete()
    .eq('id', params.id)
    .eq('user_id', user.id)

  if (error) {
    console.error('DELETE binders error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
