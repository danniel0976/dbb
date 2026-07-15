import { NextResponse } from 'next/server'
import { createClient as createAuthClient } from '@/lib/supabaseServer'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { requireCompleteMerchantProfile } from '@/lib/merchantProfile'

export const runtime = 'nodejs'

const UNDEF_TABLE = '42P01'

function makeServiceClient() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

// PATCH /api/claim-sales/[id]/edit — update claim sale description (owner only)
export async function PATCH(request, { params }) {
  const { id } = await params
  const authClient = await createAuthClient()
  const { data: { user }, error: authError } = await authClient.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const sellerGate = await requireCompleteMerchantProfile(authClient, user.id)
  if (sellerGate) {
    return NextResponse.json({ error: sellerGate.error, code: sellerGate.code }, { status: sellerGate.status })
  }

  let body
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const sc = makeServiceClient()

  try {
    // Verify ownership
    const { data: claimSale, error: fetchErr } = await sc
      .from('claim_sales')
      .select('id, user_id, status')
      .eq('id', id)
      .maybeSingle()

    if (fetchErr) {
      if (fetchErr.code === UNDEF_TABLE) {
        return NextResponse.json({ error: 'Claim sales not yet available' }, { status: 503 })
      }
      throw fetchErr
    }

    if (!claimSale) {
      return NextResponse.json({ error: 'Claim sale not found' }, { status: 404 })
    }

    if (claimSale.user_id !== user.id) {
      return NextResponse.json({ error: 'Only the owner can edit this claim sale' }, { status: 403 })
    }

    if (claimSale.status !== 'active') {
      return NextResponse.json({ error: `Cannot edit a ${claimSale.status} claim sale` }, { status: 400 })
    }

    // Only allow description editing
    const updates = {}
    if (body.description !== undefined) {
      updates.description = body.description?.trim() || null
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No updatable fields provided' }, { status: 400 })
    }

    const { error: updateErr } = await sc
      .from('claim_sales')
      .update(updates)
      .eq('id', id)

    if (updateErr) throw updateErr

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[PATCH /api/claim-sales/[id]/edit]', err?.message || err)
    return NextResponse.json({ error: err?.message || 'Failed to edit claim sale' }, { status: 500 })
  }
}
