import { NextResponse } from 'next/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

const BUCKET = 'card-photos'
const SIGNED_URL_TTL = 300  // 5 minutes — condition proof photo for buyer viewing

function makeServiceClient() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

// GET /api/listings/[id]/condition-proof
// Returns a signed URL for the seller's real-life card photo (condition proof).
// Public endpoint — only works for active, non-expired listings.
// Buyer must explicitly click "View card condition" to fetch this (no auto-loading).
export async function GET(request, { params }) {
  const { id: listingId } = await params

  if (!listingId) {
    return NextResponse.json({ error: 'Listing ID required' }, { status: 400 })
  }

  const sc = makeServiceClient()

  // Load the listing (must be active + not expired)
  const now = new Date().toISOString()
  const { data: listing, error: listErr } = await sc
    .from('listings')
    .select('id, library_card_id, status, expires_at')
    .eq('id', listingId)
    .eq('status', 'active')
    .gt('expires_at', now)
    .maybeSingle()

  if (listErr?.code === '42703') {
    // Defensive: expires_at column not migrated yet
    const { data: fallbackListing } = await sc
      .from('listings')
      .select('id, library_card_id, status')
      .eq('id', listingId)
      .eq('status', 'active')
      .maybeSingle()

    if (!fallbackListing) {
      return NextResponse.json({ error: 'Listing not found or no longer active' }, { status: 404 })
    }
    return buildProofResponse(sc, fallbackListing.library_card_id)
  }

  if (listErr || !listing) {
    return NextResponse.json({ error: 'Listing not found or no longer active' }, { status: 404 })
  }

  return buildProofResponse(sc, listing.library_card_id)
}

async function buildProofResponse(sc, libraryCardId) {
  if (!libraryCardId) {
    return NextResponse.json({ photo_url: null })
  }

  const { data: photo } = await sc
    .from('card_photos')
    .select('storage_path')
    .eq('library_card_id', libraryCardId)
    .maybeSingle()

  if (!photo?.storage_path) {
    return NextResponse.json({ photo_url: null })
  }

  // Generate signed URL with width transformation for small variant
  const { data: signedData, error: signErr } = await sc.storage
    .from(BUCKET)
    .createSignedUrl(photo.storage_path, SIGNED_URL_TTL, {
      transform: { width: 640 },
    })

  if (signErr || !signedData?.signedUrl) {
    return NextResponse.json({ photo_url: null })
  }

  return NextResponse.json({ photo_url: signedData.signedUrl })
}