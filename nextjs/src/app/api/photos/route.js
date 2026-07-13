import { NextResponse } from 'next/server'
import { createClient as createAuthClient } from '@/lib/supabaseServer'
import { createClient as createServiceClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

const BUCKET = 'card-photos'
const SIGNED_UPLOAD_TTL = 120   // 2 minutes for upload
const SIGNED_DOWNLOAD_TTL = 300 // 5 minutes for viewing

function makeServiceClient() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

// POST /api/photos
// Body: { library_card_id } — creates a signed upload URL for direct client→Supabase upload.
// The file NEVER touches the VPS or Vercel functions — it goes directly to Supabase Storage.
// Client uploads via PUT to the returned URL, then calls POST /api/photos/confirm.
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

  const { library_card_id: libraryCardId } = body
  if (!libraryCardId) {
    return NextResponse.json({ error: 'library_card_id is required' }, { status: 400 })
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

  const storagePath = `${user.id}/${libraryCardId}.jpg`

  // Create signed upload URL — client uploads directly to Supabase Storage
  const { data: uploadData, error: uploadUrlErr } = await sc.storage
    .from(BUCKET)
    .createSignedUploadUrl(storagePath)

  if (uploadUrlErr || !uploadData?.signedUrl) {
    console.error('[POST /api/photos] signed upload URL error:', uploadUrlErr?.message)
    if (uploadUrlErr?.message?.includes('Bucket not found') || uploadUrlErr?.statusCode === 404) {
      return NextResponse.json(
        { error: 'Photo storage not configured yet. Ask support to apply migration-010.' },
        { status: 503 }
      )
    }
    return NextResponse.json({ error: 'Could not create upload URL' }, { status: 500 })
  }

  // For upsert, the signed upload URL needs to be used with PUT and the x-upsert header
  // The Supabase SDK returns a signed_url that can be used with a PUT request
  // Build the full URL with upsert param
  const uploadUrl = uploadData.signedUrl

  return NextResponse.json({
    upload_url: uploadUrl,
    storage_path: storagePath,
    library_card_id: libraryCardId,
  })
}