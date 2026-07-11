import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabaseServer'
import { createClient as createServiceClient } from '@supabase/supabase-js'

// GET /api/profile — returns profile + collection stats
export async function GET() {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const [profileRes, statsRes, binderRes] = await Promise.all([
    supabase.from('profiles').select('username, display_name, created_at').eq('id', user.id).single(),
    supabase.from('library_cards')
      .select('quantity, scryfall_id')
      .eq('user_id', user.id),
    supabase.from('binders').select('id', { count: 'exact', head: true }).eq('user_id', user.id),
  ])

  const profile = profileRes.data || {}
  const cards = statsRes.data || []
  const totalCards = cards.reduce((sum, c) => sum + (c.quantity || 1), 0)
  const uniqueCards = new Set(cards.map(c => c.scryfall_id)).size
  const binderCount = binderRes.count || 0

  return NextResponse.json({
    email: user.email,
    created_at: user.created_at,
    username: profile.username || null,
    display_name: profile.display_name || null,
    profile_created_at: profile.created_at || null,
    stats: { total_cards: totalCards, unique_cards: uniqueCards, binder_count: binderCount },
  })
}

// PATCH /api/profile — update display_name
export async function PATCH(request) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const { display_name } = body

  if (typeof display_name !== 'string') {
    return NextResponse.json({ error: 'display_name must be a string' }, { status: 400 })
  }
  const trimmed = display_name.trim().slice(0, 60)

  const { error } = await supabase
    .from('profiles')
    .update({ display_name: trimmed || null, updated_at: new Date().toISOString() })
    .eq('id', user.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, display_name: trimmed || null })
}
