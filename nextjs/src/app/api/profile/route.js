import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabaseServer'

const VALID_THEMES = ['light', 'dark', 'system']

// GET /api/profile — returns profile + collection stats
export async function GET() {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Try to include theme_preference; gracefully degrade if column not yet migrated
  let themePreference = 'system'
  const [profileRes, themeRes, statsRes, binderRes] = await Promise.all([
    supabase.from('profiles').select('username, display_name, created_at').eq('id', user.id).single(),
    supabase.from('profiles').select('theme_preference').eq('id', user.id).single(),
    supabase.from('library_cards').select('quantity, scryfall_id').eq('user_id', user.id),
    supabase.from('binders').select('id', { count: 'exact', head: true }).eq('user_id', user.id),
  ])

  if (!themeRes.error && themeRes.data?.theme_preference) {
    themePreference = themeRes.data.theme_preference
  }

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
    theme_preference: themePreference,
    profile_created_at: profile.created_at || null,
    stats: { total_cards: totalCards, unique_cards: uniqueCards, binder_count: binderCount },
  })
}

// PATCH /api/profile — update display_name and/or theme_preference
export async function PATCH(request) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const updates = { updated_at: new Date().toISOString() }
  const response = {}

  if ('display_name' in body) {
    if (typeof body.display_name !== 'string') {
      return NextResponse.json({ error: 'display_name must be a string' }, { status: 400 })
    }
    const trimmed = body.display_name.trim().slice(0, 60)
    updates.display_name = trimmed || null
    response.display_name = trimmed || null
  }

  if ('theme_preference' in body) {
    if (!VALID_THEMES.includes(body.theme_preference)) {
      return NextResponse.json({ error: 'Invalid theme_preference' }, { status: 400 })
    }
    // Try to update theme_preference; silently skip if column not migrated yet
    try {
      await supabase
        .from('profiles')
        .update({ theme_preference: body.theme_preference })
        .eq('id', user.id)
      response.theme_preference = body.theme_preference
    } catch {
      // Pre-migration: column doesn't exist yet, ignore
      response.theme_preference = body.theme_preference
    }
    // Remove from main updates since we handled it separately
    delete updates.theme_preference
  }

  if (Object.keys(updates).length > 1) {
    const { error } = await supabase
      .from('profiles')
      .update(updates)
      .eq('id', user.id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, ...response })
}
