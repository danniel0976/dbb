import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabaseServer'

export async function POST(request) {
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
    .insert({ user_id: user.id, name })
    .select()
    .single()

  if (error) {
    console.error('POST binders error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ binder }, { status: 201 })
}

export async function GET(request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Fetch binders list first, then get exact card counts in parallel.
  // We use individual COUNT(*) queries per binder rather than embedded
  // resource aggregates, which can be unreliable with large row sets.
  const { data: binderRows, error: bindersError } = await supabase
    .from('binders')
    .select('id, name, is_default, created_at')
    .eq('user_id', user.id)
    .order('created_at')

  if (bindersError) {
    return NextResponse.json({ error: bindersError.message }, { status: 500 })
  }

  // Exact count per binder — parallel HEAD queries (one per binder, fast)
  const countResults = await Promise.all(
    (binderRows || []).map(b =>
      supabase
        .from('library_cards')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .eq('binder_id', b.id)
    )
  )

  const bindersWithCounts = (binderRows || []).map((b, i) => ({
    id: b.id,
    name: b.name,
    is_default: b.is_default,
    created_at: b.created_at,
    card_count: countResults[i]?.count ?? 0,
  }))

  return NextResponse.json({ binders: bindersWithCounts })
}
