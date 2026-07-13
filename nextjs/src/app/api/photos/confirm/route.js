import { NextResponse } from 'next/server'
import { createClient as createAuthClient } from '@/lib/supabaseServer'
import { createClient as createServiceClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

const BUCKET = 'card-photos'
const SIGNED_DOWNLOAD_TTL = 300 // 5 minutes
const MAX_UPLOAD_BYTES = 500 * 1024 // 500KB

function makeServiceClient() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

// POST /api/photos/confirm
// Body: { library_card_id, storage_path }
// Called by the client after a successful direct upload to Supabase Storage.
// Verifies the upload (checks object exists + size ≤500KB), upserts DB row,
// returns a signed download URL for immediate display.
export async function POST(request) {
  const authClient = await createAuthClient()
  const { data: { user }, error: authError } = await authClient.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { library_card_id: libraryCardId, storage_path: storagePath } = body
  if (!libraryCardId || !storagePath) {
    return NextResponse.json({ error: 'library_card_id and storage_path are required' }, { status: 400 })
  }

  // Verify the storage path matches the expected pattern (prevent path injection)
  const expectedPath = `${user.id}/${libraryCardId}.jpg`
  if (storagePath !== expectedPath) {
    return NextResponse.json({ error: 'Storage path mismatch' }, { status: 403 })
  }

  const sc = makeServiceClient()

  // Verify ownership of the library card
  const { data: card } = await sc
    .from('library_cards')
    .select('id, user_id')
    .eq('id', libraryCardId)
    .eq('user_id', user.id)
    .maybeSingle()

  if (!card) {
    return NextResponse.json({ error: 'Card not found in your library' }, { status: 403 })
  }

  // Verify the uploaded object exists and check its size
  const { data: fileList, error: listErr } = await sc.storage
    .from(BUCKET)
    .list(user.id, { limit: 100, search: `${libraryCardId}.jpg` })

  if (listErr) {
    console.error('[POST /api/photos/confirm] list error:', listErr.message)
    return NextResponse.json({ error: 'Could not verify upload' }, { status: 500 })
  }

  const uploadedFile = (fileList || []).find(f => f.name === `${libraryCardId}.jpg`)
  if (!uploadedFile) {
    return NextResponse.json({ error: 'Upload not found — please try again' }, { status: 404 })
  }

  // Enforce 500KB server-side via the uploaded object metadata
  if (uploadedFile.metadata?.size && uploadedFile.metadata.size > MAX_UPLOAD_BYTES) {
    // Delete the oversized object
    await sc.storage.from(BUCKET).remove([storagePath])
    return NextResponse.json(
      { error: `Photo too large (${(uploadedFile.metadata.size / 1024).toFixed(0)}KB). Maximum 500KB.` },
      { status: 413 }
    )
  }

  // Upsert card_photos row
  const { error: dbErr } = await sc
    .from('card_photos')
    .upsert(
      { user_id: user.id, library_card_id: libraryCardId, storage_path: storagePath },
      { onConflict: 'library_card_id' }
    )

  if (dbErr) {
    console.error('[POST /api/photos/confirm] db upsert error:', dbErr.message)
    // DB row failed but storage succeeded — still return success (photo is stored)
  }

  // Return a short-lived signed URL so the UI can display the photo immediately
  const { data: signedData } = await sc.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, SIGNED_DOWNLOAD_TTL, { transform: { width: 640 } })

  const url = signedData?.signedUrl || null

  return NextResponse.json({ success: true, url })
}