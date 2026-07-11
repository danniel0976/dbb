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

  const t0 = Date.now()

  // Single query: binders + exact card count via PostgREST resource embedding
  const { data: binders, error } = await supabase
    .from('binders')
    .select('id, name, is_default, created_at, library_cards(count)')
    .eq('user_id', user.id)
    .order('created_at')

  const elapsed = Date.now() - t0
  console.log(`GET /api/binders db query: ${elapsed}ms`)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const bindersWithCounts = (binders || []).map(b => ({
    id: b.id,
    name: b.name,
    is_default: b.is_default,
    created_at: b.created_at,
    card_count: b.library_cards?.[0]?.count ?? 0,
  }))

  return NextResponse.json({ binders: bindersWithCounts })
}
