import { NextResponse } from 'next/server'
import { createClient as createAuthClient } from '@/lib/supabaseServer'
import { createClient as createServiceClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

const UNDEF_TABLE = '42P01'

// POST /api/claim-sales/[id]/cancel — cancel claim sale (owner only)
export async function POST(request, { params }) {
  const { id } = await params
  const authClient = await createAuthClient()
  const { data: { user }, error: authError } = await authClient.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
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
      return NextResponse.json({ error: 'Only the owner can cancel this claim sale' }, { status: 403 })
    }

    if (claimSale.status !== 'active') {
      return NextResponse.json({ error: `Claim sale is already ${claimSale.status}` }, { status: 400 })
    }

    // Set status to cancelled
    const { error: updateErr } = await sc
      .from('claim_sales')
      .update({ status: 'cancelled' })
      .eq('id', id)

    if (updateErr) throw updateErr

    // Unlink listings (set claim_sale_id = null)
    try {
      await sc
        .from('listings')
        .update({ claim_sale_id: null })
        .eq('claim_sale_id', id)
    } catch {
      // claim_sale_id column might not exist — non-fatal
    }

    // Purge follows on this cancelled claim sale
    try {
      await sc
        .from('follows')
        .delete()
        .eq('claim_sale_id', id)
    } catch {
      // follows table might not exist — non-fatal
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[POST /api/claim-sales/[id]/cancel]', err?.message || err)
    return NextResponse.json({ error: err?.message || 'Failed to cancel claim sale' }, { status: 500 })
  }
}

function makeServiceClient() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}