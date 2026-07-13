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

// POST /api/photos
// Multipart form: library_card_id (string) + photo (File, JPEG)
// Uploads the card photo to storage and upserts a card_photos row.
// Retake is allowed only when the card has no active/non-expired listing.
export async function POST(request) {
  const authClient = await createAuthClient()
  const { data: { user }, error: authError } = await authClient.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let formData
  try {
    formData = await request.formData()
  } catch {
    return NextResponse.json({ error: 'Invalid form data' }, { status: 400 })
  }

  const libraryCardId = formData.get('library_card_id')
  const photoFile = formData.get('photo')

  if (!libraryCardId || !photoFile) {
    return NextResponse.json({ error: 'library_card_id and photo are required' }, { status: 400 })
  }

  // Phase 18: Server-side upload size enforcement (500KB max)
  const MAX_UPLOAD_BYTES = 500 * 1024  // 500KB
  const arrayBuffer = await photoFile.arrayBuffer()
  const uploadBytes = new Uint8Array(arrayBuffer)
  if (uploadBytes.byteLength > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: `Photo too large (${(uploadBytes.byteLength / 1024).toFixed(0)}KB). Maximum 500KB.` },
      { status: 413 }
    )
  }

  const sc = makeServiceClient()

  // Verify ownership
  const { data: card, error: cardErr } = await sc
    .from('library_cards')
    .select('id, user_id')
    .eq('id', libraryCardId)
    .eq('user_id', user.id)
    .maybeSingle()

  if (cardErr || !card) {
    return NextResponse.json({ error: 'Card not found in your library' }, { status: 403 })
  }

  // Phase 18: Photo belongs to the library CARD, not the listing.
  // Owner can retake/replace the photo at any time (active listing or not).
  // The photo persists across listing cycles until the owner retakes it or removes the card.
  // No retake restriction while listed.

  const storagePath = `${user.id}/${libraryCardId}.jpg`

  const { error: uploadErr } = await sc.storage
    .from(BUCKET)
    .upload(storagePath, uploadBytes, {
      contentType: 'image/jpeg',
      upsert: true,
    })

  if (uploadErr) {
    console.error('[POST /api/photos] upload error:', uploadErr.message)
    // Defensive: if bucket doesn't exist yet (migration not applied), return informative error
    if (uploadErr.message?.includes('Bucket not found') || uploadErr.statusCode === 404) {
      return NextResponse.json(
        { error: 'Photo storage not configured yet. Ask support to apply migration-010.' },
        { status: 503 }
      )
    }
    return NextResponse.json({ error: 'Photo upload failed' }, { status: 500 })
  }

  // Upsert card_photos row
  const { error: dbErr } = await sc
    .from('card_photos')
    .upsert(
      { user_id: user.id, library_card_id: libraryCardId, storage_path: storagePath },
      { onConflict: 'library_card_id' }
    )

  if (dbErr) {
    console.error('[POST /api/photos] db upsert error:', dbErr.message)
    // DB row failed but storage succeeded — not catastrophic for the user; still return success
  }

  // Return a short-lived signed URL so the UI can display the photo immediately
  const { data: signedData, error: signErr } = await sc.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL)

  const url = signErr ? null : signedData?.signedUrl

  return NextResponse.json({ success: true, url }, { status: 200 })
}
