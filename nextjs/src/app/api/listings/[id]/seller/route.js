import { NextResponse } from 'next/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

const BUCKET = 'card-photos'
const SIGNED_URL_TTL = 60  // 1 minute — short TTL for buyer-facing seller photo

function makeServiceClient() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

// GET /api/listings/[id]/seller
// Returns the seller profile + card photo for an active listing.
// Used by BazaarDetailModal to show the seller popup when a buyer clicks a seller.
// No auth required (listing is public); service role fetches and signs the photo URL.
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
    .select('id, user_id, library_card_id, status, expires_at, multiplier, library_cards!inner(foil, condition)')
    .eq('id', listingId)
    .eq('status', 'active')
    .gt('expires_at', now)
    .maybeSingle()

  if (listErr || !listing) {
    // Defensive: if expires_at column doesn't exist yet, retry without expiry filter
    if (listErr?.code === '42703') {
      const { data: fallbackListing } = await sc
        .from('listings')
        .select('id, user_id, library_card_id, status, multiplier, library_cards!inner(foil, condition)')
        .eq('id', listingId)
        .eq('status', 'active')
        .maybeSingle()
      if (!fallbackListing) {
        return NextResponse.json({ error: 'Listing not found or no longer active' }, { status: 404 })
      }
      return buildResponse(sc, fallbackListing)
    }
    return NextResponse.json({ error: 'Listing not found or no longer active' }, { status: 404 })
  }

  return buildResponse(sc, listing)
}

async function buildResponse(sc, listing) {
  const { user_id, library_card_id, multiplier } = listing
  const lc = listing.library_cards

  // Load seller profile
  const { data: profile } = await sc
    .from('profiles')
    .select('display_name, created_at')
    .eq('id', user_id)
    .maybeSingle()

  // Load card photo if it exists
  let photoUrl = null
  const { data: photo } = await sc
    .from('card_photos')
    .select('storage_path')
    .eq('library_card_id', library_card_id)
    .maybeSingle()

  if (photo?.storage_path) {
    const { data: signedData } = await sc.storage
      .from(BUCKET)
      .createSignedUrl(photo.storage_path, SIGNED_URL_TTL)
    photoUrl = signedData?.signedUrl || null
  }

  return NextResponse.json({
    seller: {
      display_name: profile?.display_name || 'Seller',
      member_since: profile?.created_at || null,
      condition: lc?.condition || 'NM',
      foil: lc?.foil || 'normal',
      multiplier: Number(multiplier),
      photo_url: photoUrl,
    },
  })
}
