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
  const binder_id = searchParams.get('binder_id') || undefined

  // Advanced search filters
  const colorsParam = searchParams.get('colors')
  const colors = colorsParam ? colorsParam.split('') : undefined
  const color_mode = searchParams.get('color_mode') || 'or'
  const type_line = searchParams.get('type_line') || undefined
  const cmc_min = searchParams.get('cmc_min') || undefined
  const cmc_max = searchParams.get('cmc_max') || undefined
  const rarityParam = searchParams.get('rarity')
  const rarity = rarityParam ? rarityParam.split(',') : undefined
  const foil = searchParams.get('foil') || undefined
  const starredParam = searchParams.get('starred')
  const starred = starredParam === '1' ? true : undefined
  const set_code = searchParams.get('set') || undefined

  try {
    const result = await getLibrary(
      user.id,
      { sort, q, binder_id, colors, color_mode, type_line, cmc_min, cmc_max, rarity, foil, starred, set_code },
      page,
      48
    )
    return NextResponse.json(result)
  } catch (err) {
    console.error('getLibrary error:', err)
    return NextResponse.json({ error: 'Failed to load library' }, { status: 500 })
  }
}
