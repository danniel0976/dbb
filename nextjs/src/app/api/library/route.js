import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabaseServer'
import { getLibrary } from '@/lib/libraryQueries'

export async function GET(request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const page = Math.max(1, parseInt(searchParams.get('page') || '1'))
  const sort = searchParams.get('sort') || 'newest'
  const q = searchParams.get('q') || ''

  try {
    const result = await getLibrary(user.id, { sort, q }, page, 48)
    return NextResponse.json(result)
  } catch (err) {
    console.error('getLibrary error:', err)
    return NextResponse.json({ error: 'Failed to load library' }, { status: 500 })
  }
}
