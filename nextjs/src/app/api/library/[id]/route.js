import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabaseServer'
import { createClient as createServiceClient } from '@supabase/supabase-js'

const BUCKET = 'card-photos'
const UNDEF_COLUMN = '42703'

function makeServiceClient() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

// Check if any active listing for this library_card has a quantity exceeding the new owned quantity.
// If so, reject — the seller would be offering more copies than they own.
// FAILS CLOSED: any query error returns a 503 so the quantity update is blocked until
// the DB is healthy. The only deliberate exception is pre-migration UNDEF_COLUMN (42703)
// for the `quantity` column — in that case we treat every active listing as quantity=1
// (the migration default) and still guard against reduction below 1.
async function checkOversell(sc, libraryCardId, newQuantity) {
  let listings, error
  try {
    ({ data: listings, error } = await sc
      .from('listings')
      .select('id, quantity, status, expires_at')
      .eq('library_card_id', libraryCardId)
      .eq('status', 'active'))
  } catch (err) {
    return { ok: false, status: 503, error: 'Oversell check failed — database error. Please try again.' }
  }

  if (error) {
    // Pre-migration: listings.quantity column doesn't exist yet. Every listing is
    // effectively quantity=1 (the migration DEFAULT). We still guard: if newQuantity < 1
    // and there's an active listing, block it.
    if (error.code === UNDEF_COLUMN) {
      let fallbackListings, fbError
      try {
        ({ data: fallbackListings, error: fbError } = await sc
          .from('listings')
          .select('id, status, expires_at')
          .eq('library_card_id', libraryCardId)
          .eq('status', 'active'))
      } catch {
        return { ok: false, status: 503, error: 'Oversell check failed — database error. Please try again.' }
      }
      if (fbError) {
        return { ok: false, status: 503, error: 'Oversell check failed — database error. Please try again.' }
      }
      const now = new Date().toISOString()
      for (const l of fallbackListings || []) {
        const isExpired = l.status === 'expired' || (l.expires_at && l.expires_at <= now)
        if (!isExpired && newQuantity < 1) {
          return {
            ok: false,
            status: 409,
            error: `Cannot reduce quantity to ${newQuantity}; you have an active listing for this card. Unlist it first.`,
            listing_id: l.id,
            listed_quantity: 1,
          }
        }
      }
      return { ok: true }
    }
    // Any other error → fail closed
    return { ok: false, status: 503, error: 'Oversell check failed — database error. Please try again.' }
  }

  const now = new Date().toISOString()
  for (const l of listings || []) {
    const isExpired = l.status === 'expired' || (l.expires_at && l.expires_at <= now)
    if (!isExpired && l.quantity && l.quantity > newQuantity) {
      return {
        ok: false,
        status: 409,
        error: `Cannot reduce quantity to ${newQuantity}; you have an active listing offering ${l.quantity} copies. Unlist or reduce the listing first.`,
        listing_id: l.id,
        listed_quantity: l.quantity,
      }
    }
  }
  return { ok: true }
}

export async function PATCH(request, { params }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const allowed = ['quantity', 'condition', 'foil', 'starred']
  const updates = {}
  for (const key of allowed) {
    if (key in body) updates[key] = body[key]
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
  }

  // Oversell protection: if quantity is being reduced, check active listings
  if (updates.quantity !== undefined) {
    const sc = makeServiceClient()
    const guard = await checkOversell(sc, params.id, updates.quantity)
    if (!guard.ok) {
      return NextResponse.json(
        { error: guard.error, listing_id: guard.listing_id, listed_quantity: guard.listed_quantity },
        { status: guard.status || 409 }
      )
    }
  }

  const { data: card, error } = await supabase
    .from('library_cards')
    .update(updates)
    .eq('id', params.id)
    .eq('user_id', user.id)
    .select()
    .single()

  if (error) {
    console.error('PATCH library_cards error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!card) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  return NextResponse.json({ card })
}

export async function DELETE(request, { params }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Clean up card photo before deleting the card (storage object must be removed manually)
  const sc = makeServiceClient()
  const { data: photo } = await sc
    .from('card_photos')
    .select('storage_path')
    .eq('library_card_id', params.id)
    .maybeSingle()
  if (photo?.storage_path) {
    await sc.storage.from(BUCKET).remove([photo.storage_path])
    // DB row will cascade-delete with library_cards, but explicit cleanup is safer
    await sc.from('card_photos').delete().eq('library_card_id', params.id)
  }

  const { error } = await supabase
    .from('library_cards')
    .delete()
    .eq('id', params.id)
    .eq('user_id', user.id)

  if (error) {
    console.error('DELETE library_cards error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
