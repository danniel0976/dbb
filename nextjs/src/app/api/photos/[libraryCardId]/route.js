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
// Query param ?size=small for thumbnail variant (640px), default full size.
// 404 if no photo exists. 403 if caller doesn't own the card.
export async function GET(request, { params }) {
  const { libraryCardId } = await params
  const url = new URL(request.url)
  const wantSmall = url.searchParams.get('size') === 'small'

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

  const signOpts = wantSmall ? { transform: { width: 640 } } : undefined
  const { data: signedData, error: signErr } = await sc.storage
    .from(BUCKET)
    .createSignedUrl(photo.storage_path, SIGNED_URL_TTL, signOpts)

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

  const { data: card } = await sc
    .from('library_cards')
    .select('id, user_id')
    .eq('id', libraryCardId)
    .maybeSingle()

  if (card && card.user_id !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  if (!card) return NextResponse.json({ success: true }) // idempotent for a missing card

  // Remove canonical metadata and its snapshot atomically before deleting bytes.
  const { data: deletedStoragePath, error: dbError } = await sc.rpc('delete_card_photo_and_invalidate_export', {
    p_user_id: user.id,
    p_library_card_id: libraryCardId,
  })
  if (dbError) return NextResponse.json({ error: 'Could not delete card photo' }, { status: 500 })

  // The RPC returns the exact path that was canonical inside the transaction.
  // Remove only those bytes: sweeping the prefix can race with a concurrent
  // confirm and delete a newly promoted photo.
  let photoCleanupError = null
  if (typeof deletedStoragePath === 'string' && deletedStoragePath.length > 0) {
    const { error } = await sc.storage.from(BUCKET).remove([deletedStoragePath])
    photoCleanupError = error
  }
  if (photoCleanupError) console.error('DELETE /api/photos orphan cleanup error:', photoCleanupError)

  return NextResponse.json({
    success: true,
    deleted_storage_path: deletedStoragePath || null,
    photo_cleanup_pending: Boolean(photoCleanupError),
  })
}
