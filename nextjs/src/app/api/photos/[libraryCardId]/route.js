import { NextResponse } from 'next/server'
import { createClient as createAuthClient } from '@/lib/supabaseServer'
import { createClient as createServiceClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

const BUCKET = 'card-photos'
const SIGNED_URL_TTL = 300  // 5 minutes

function makeServiceClient() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

// GET /api/photos/[libraryCardId]
// Returns a short-TTL signed URL for the owner's card photo.
// 404 if no photo exists. 403 if caller doesn't own the card.
export async function GET(request, { params }) {
  const { libraryCardId } = await params

  const authClient = await createAuthClient()
  const { data: { user }, error: authError } = await authClient.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const sc = makeServiceClient()

  // Verify caller owns this library card (via card_photos.user_id)
  const { data: photo } = await sc
    .from('card_photos')
    .select('storage_path, user_id')
    .eq('library_card_id', libraryCardId)
    .maybeSingle()

  if (!photo) {
    return NextResponse.json({ error: 'No photo found' }, { status: 404 })
  }

  if (photo.user_id !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { data: signedData, error: signErr } = await sc.storage
    .from(BUCKET)
    .createSignedUrl(photo.storage_path, SIGNED_URL_TTL)

  if (signErr || !signedData?.signedUrl) {
    return NextResponse.json({ error: 'Could not generate photo URL' }, { status: 500 })
  }

  return NextResponse.json({ url: signedData.signedUrl })
}

// DELETE /api/photos/[libraryCardId]
// Owner deletes their card photo (storage object + DB row).
// Internal: also called by listing cleanup (uses service role check via user_id).
export async function DELETE(request, { params }) {
  const { libraryCardId } = await params

  const authClient = await createAuthClient()
  const { data: { user }, error: authError } = await authClient.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const sc = makeServiceClient()

  const { data: photo } = await sc
    .from('card_photos')
    .select('storage_path, user_id')
    .eq('library_card_id', libraryCardId)
    .maybeSingle()

  if (!photo) {
    return NextResponse.json({ success: true })  // idempotent
  }

  if (photo.user_id !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Delete storage object (ignore errors — row cleanup is more important)
  await sc.storage.from(BUCKET).remove([photo.storage_path])

  // Delete DB row (CASCADE from library_cards also handles this, but explicit is safer)
  await sc.from('card_photos').delete().eq('library_card_id', libraryCardId)

  return NextResponse.json({ success: true })
}
