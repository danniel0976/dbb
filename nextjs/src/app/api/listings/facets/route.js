import { NextResponse } from 'next/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { getActiveListingFacets } from '@/lib/listingsQueries'

export const runtime = 'nodejs'

function makeServiceClient() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

// GET /api/listings/facets — read-only facet source for the Bazaar filter
// UI. Derives distinct sets/rarities/card types from ALL active, unexpired
// listings rather than the currently loaded page (Phase 41 tech audit P1
// #4). Service-role, public — same visibility as GET /api/listings.
export async function GET() {
  try {
    const sc = makeServiceClient()
    const facets = await getActiveListingFacets(sc)
    return NextResponse.json(facets)
  } catch (err) {
    console.error('[GET /api/listings/facets]', err?.message || err)
    return NextResponse.json({ sets: [], rarities: [], cardTypes: [] })
  }
}
