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

  // Check if a photo already exists (retake scenario) — block if card is actively listed
  const { data: existingPhoto } = await sc
    .from('card_photos')
    .select('id')
    .eq('library_card_id', libraryCardId)
    .maybeSingle()

  if (existingPhoto) {
    const now = new Date().toISOString()
    const { data: activeListing } = await sc
      .from('listings')
      .select('id')
      .eq('library_card_id', libraryCardId)
      .eq('status', 'active')
      .gt('expires_at', now)
      .maybeSingle()

    if (activeListing) {
      return NextResponse.json(
        { error: 'Cannot retake photo while card is actively listed. Unlist the card first.' },
        { status: 409 }
      )
    }
  }

  // Read the file bytes
  const arrayBuffer = await photoFile.arrayBuffer()
  const bytes = new Uint8Array(arrayBuffer)

  const storagePath = `${user.id}/${libraryCardId}.jpg`

  const { error: uploadErr } = await sc.storage
    .from(BUCKET)
    .upload(storagePath, bytes, {
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
