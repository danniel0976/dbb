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
  if (!libraryCardId || !storagePath || typeof storagePath !== 'string') {
    return NextResponse.json({ error: 'library_card_id and storage_path are required' }, { status: 400 })
  }

  // Verify the storage path matches the expected pattern (prevent path injection)
  const expectedPrefix = `${user.id}/${libraryCardId}/`
  const candidateName = storagePath.slice(expectedPrefix.length)
  const candidatePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jpg$/i
  if (!storagePath.startsWith(expectedPrefix) || !candidatePattern.test(candidateName)) {
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
    .list(`${user.id}/${libraryCardId}`, { limit: 100, search: candidateName })

  if (listErr) {
    console.error('[POST /api/photos/confirm] list error:', listErr.message)
    return NextResponse.json({ error: 'Could not verify upload' }, { status: 500 })
  }

  const uploadedFile = (fileList || []).find(f => f.name === candidateName)
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

  // Promote the candidate and invalidate its export snapshot in one DB transaction.
  // The previous object remains readable until this transaction has succeeded.
  const { data: previousPath, error: dbErr } = await sc.rpc('promote_card_photo', {
    p_user_id: user.id,
    p_library_card_id: libraryCardId,
    p_storage_path: storagePath,
  })

  if (dbErr) {
    console.error('[POST /api/photos/confirm] db upsert error:', dbErr.message)
    // The candidate never became canonical. Avoid leaving it orphaned.
    await sc.storage.from(BUCKET).remove([storagePath])
    return NextResponse.json({ error: 'Could not confirm photo upload' }, { status: 500 })
  }

  // Promotion is complete; only now is it safe to remove the former canonical bytes.
  if (previousPath && previousPath !== storagePath) {
    const { error: removeErr } = await sc.storage.from(BUCKET).remove([previousPath])
    if (removeErr) console.error('[POST /api/photos/confirm] previous photo cleanup error:', removeErr.message)
  }

  // Return a short-lived signed URL so the UI can display the photo immediately
  const { data: signedData } = await sc.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, SIGNED_DOWNLOAD_TTL, { transform: { width: 640 } })

  const url = signedData?.signedUrl || null

  return NextResponse.json({ success: true, url })
}
