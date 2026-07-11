import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabaseServer'
import { getLibrarySets } from '@/lib/libraryQueries'

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const sets = await getLibrarySets(user.id)
    return NextResponse.json({ sets }, {
      headers: { 'Cache-Control': 'private, max-age=300' },
    })
  } catch (err) {
    console.error('getLibrarySets error:', err)
    return NextResponse.json({ error: 'Failed to load sets' }, { status: 500 })
  }
}
