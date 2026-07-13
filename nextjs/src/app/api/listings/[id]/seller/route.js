import { NextResponse } from 'next/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

const BUCKET = 'card-photos'
const SIGNED_URL_TTL = 300  // 5 minutes — condition proof photo for buyer

function makeServiceClient() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

// GET /api/listings/[id]/seller
// Returns the seller profile (display name, member since) for an active listing.
// Used by BazaarDetailModal SellerPopup — name/member-since ONLY (no photo).
// Photo is now served via /api/listings/[id]/condition-proof for explicit viewing.
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
      return buildSellerResponse(sc, fallbackListing)
    }
    return NextResponse.json({ error: 'Listing not found or no longer active' }, { status: 404 })
  }

  return buildSellerResponse(sc, listing)
}

async function buildSellerResponse(sc, listing) {
  const { user_id } = listing

  // Load seller profile (name + member-since ONLY — no photo in seller popup)
  const { data: profile } = await sc
    .from('profiles')
    .select('display_name, created_at')
    .eq('id', user_id)
    .maybeSingle()

  return NextResponse.json({
    seller: {
      display_name: profile?.display_name || 'Seller',
      member_since: profile?.created_at || null,
    },
  })
}
