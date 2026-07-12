import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabaseServer'
import { createClient as createServiceClient } from '@supabase/supabase-js'

const BUCKET = 'card-photos'

function makeServiceClient() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

export async function PATCH(request, { params }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const allowed = ['quantity', 'condition', 'foil', 'starred']
  const updates = {}
  for (const key of allowed) {
    if (key in body) updates[key] = body[key]
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
  }

  const { data: card, error } = await supabase
    .from('library_cards')
    .update(updates)
    .eq('id', params.id)
    .eq('user_id', user.id)
    .select()
    .single()

  if (error) {
    console.error('PATCH library_cards error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!card) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  return NextResponse.json({ card })
}

export async function DELETE(request, { params }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Clean up card photo before deleting the card (storage object must be removed manually)
  const sc = makeServiceClient()
  const { data: photo } = await sc
    .from('card_photos')
    .select('storage_path')
    .eq('library_card_id', params.id)
    .maybeSingle()
  if (photo?.storage_path) {
    await sc.storage.from(BUCKET).remove([photo.storage_path])
    // DB row will cascade-delete with library_cards, but explicit cleanup is safer
    await sc.from('card_photos').delete().eq('library_card_id', params.id)
  }

  const { error } = await supabase
    .from('library_cards')
    .delete()
    .eq('id', params.id)
    .eq('user_id', user.id)

  if (error) {
    console.error('DELETE library_cards error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
