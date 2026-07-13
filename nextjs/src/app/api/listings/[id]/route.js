import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabaseServer'
import { createClient as createServiceClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

const VALID_MULTIPLIERS = [2.5, 2.8, 3.0]
const VALID_DURATIONS = [1, 3, 6, 12, 24]
const MAX_DURATION_HOURS = 24
const UNDEF_COLUMN = '42703'

// DELETE /api/listings/[id]  — unlist a card (photo persists, NOT deleted)
export async function DELETE(request, { params }) {
  const { id } = await params
  const authClient = await createClient()
  const { data: { user }, error: authError } = await authClient.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Fetch the listing to get library_card_id before deleting
  const { data: listing } = await authClient
    .from('listings')
    .select('id, library_card_id')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle()

  const { error } = await authClient
    .from('listings')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id)

  if (error) {
    console.error('[DELETE /api/listings/[id]]', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Phase 18: Photo self-destruct REMOVED from unlist.
  // Photos belong to the library CARD, not the listing — they persist through
  // unlist/relist cycles. Photo is only deleted when the library card is deleted
  // or the owner explicitly retakes/removes it.

  return NextResponse.json({ success: true })
}

// PATCH /api/listings/[id]
// Update multiplier: { multiplier }
// Relist (reset expired listing): { multiplier?, duration_hours } — sets status='active', new expires_at
export async function PATCH(request, { params }) {
  const { id } = await params
  const authClient = await createClient()
  const { data: { user }, error: authError } = await authClient.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const updates = {}

  if (body.multiplier !== undefined) {
    if (!VALID_MULTIPLIERS.includes(Number(body.multiplier))) {
      return NextResponse.json({ error: 'multiplier must be 2.5, 2.8 or 3.0' }, { status: 400 })
    }
    updates.multiplier = Number(body.multiplier)
  }

  if (body.quantity !== undefined) {
    const qty = Number(body.quantity)
    if (!Number.isInteger(qty) || qty < 1) {
      return NextResponse.json(
        { error: 'quantity must be a positive integer' },
        { status: 400 }
      )
    }
    // Validate against owned library_cards.quantity
    const { data: listing } = await authClient
      .from('listings')
      .select('library_card_id')
      .eq('id', id)
      .eq('user_id', user.id)
      .maybeSingle()
    if (!listing) {
      return NextResponse.json({ error: 'Listing not found' }, { status: 404 })
    }
    const sc = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    )
    const { data: card } = await sc
      .from('library_cards')
      .select('quantity')
      .eq('id', listing.library_card_id)
      .maybeSingle()
    const ownedQty = card?.quantity ?? 0
    if (qty > ownedQty) {
      return NextResponse.json(
        { error: `Cannot list ${qty} copies; you only own ${ownedQty} of this card` },
        { status: 400 }
      )
    }
    updates.quantity = qty
  }

  if (body.duration_hours !== undefined) {
    const dur = Number(body.duration_hours)
    if (!VALID_DURATIONS.includes(dur)) {
      return NextResponse.json(
        { error: 'duration_hours must be 1, 3, 6, 12, or 24' },
        { status: 400 }
      )
    }
    if (dur > MAX_DURATION_HOURS) {
      return NextResponse.json({ error: 'Maximum listing duration is 24 hours' }, { status: 400 })
    }
    updates.expires_at = new Date(Date.now() + dur * 3600 * 1000).toISOString()
    updates.status = 'active'
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 })
  }

  let result = await authClient
    .from('listings')
    .update(updates)
    .eq('id', id)
    .eq('user_id', user.id)
    .select()
    .maybeSingle()

  // Defensive: migration-014 may be pending while expires_at already exists.
  if (result.error?.code === UNDEF_COLUMN) {
    const { quantity: _qty, ...updatesNoQuantity } = updates
    result = await authClient
      .from('listings')
      .update(updatesNoQuantity)
      .eq('id', id)
      .eq('user_id', user.id)
      .select()
      .maybeSingle()

    if (result.error?.code === UNDEF_COLUMN) {
      // Pre-migration-009 fallback: expires_at is also unavailable.
      const { expires_at: _exp, ...updatesLegacy } = updatesNoQuantity
      result = await authClient
        .from('listings')
        .update(updatesLegacy)
        .eq('id', id)
        .eq('user_id', user.id)
        .select()
        .maybeSingle()
    }
  }

  if (result.error) return NextResponse.json({ error: result.error.message }, { status: 500 })
  return NextResponse.json({ listing: result.data })
}
