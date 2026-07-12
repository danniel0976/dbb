import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabaseServer'
import { createClient as createServiceClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

const BUCKET = 'card-photos'

function makeServiceClient() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

const VALID_MULTIPLIERS = [2.5, 2.8, 3.0]
const VALID_DURATIONS = [1, 3, 6, 12, 24]
const MAX_DURATION_HOURS = 24
const UNDEF_COLUMN = '42703'

// DELETE /api/listings/[id]  — unlist a card + self-destruct its photo
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

  // Self-destruct: delete card photo for this listing (fire-and-forget)
  if (listing?.library_card_id) {
    const sc = makeServiceClient()
    const { data: photo } = await sc
      .from('card_photos')
      .select('storage_path')
      .eq('library_card_id', listing.library_card_id)
      .maybeSingle()
    if (photo?.storage_path) {
      await sc.storage.from(BUCKET).remove([photo.storage_path])
      await sc.from('card_photos').delete().eq('library_card_id', listing.library_card_id)
    }
  }

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

  // Defensive: if expires_at column not yet migrated, retry without it
  if (result.error?.code === UNDEF_COLUMN) {
    const { expires_at: _exp, ...updatesNoExpiry } = updates
    result = await authClient
      .from('listings')
      .update(updatesNoExpiry)
      .eq('id', id)
      .eq('user_id', user.id)
      .select()
      .maybeSingle()
  }

  if (result.error) return NextResponse.json({ error: result.error.message }, { status: 500 })
  return NextResponse.json({ listing: result.data })
}
