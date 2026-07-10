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

  const { data: binders, error } = await supabase
    .from('binders')
    .select('id, name, is_default, created_at')
    .eq('user_id', user.id)
    .order('created_at')

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Get card counts per binder
  const { data: counts } = await supabase
    .from('library_cards')
    .select('binder_id')
    .eq('user_id', user.id)

  const countMap = {}
  for (const row of (counts || [])) {
    countMap[row.binder_id] = (countMap[row.binder_id] || 0) + 1
  }

  const bindersWithCounts = (binders || []).map(b => ({
    ...b,
    card_count: countMap[b.id] || 0,
  }))

  return NextResponse.json({ binders: bindersWithCounts })
}
