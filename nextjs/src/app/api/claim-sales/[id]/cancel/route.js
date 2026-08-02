import { NextResponse } from 'next/server'
import { createClient as createAuthClient } from '@/lib/supabaseServer'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { stockError } from '@/lib/stockErrors'

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
    const { data, error: cancelError } = await sc.rpc('phase45c_cancel_claim_sale', {
      p_claim_sale_id: id,
      p_actor_id: user.id,
    })
    if (cancelError) {
      if (cancelError.code === UNDEF_TABLE) return NextResponse.json({ error: 'Claim sales not yet available' }, { status: 503 })
      const message = String(cancelError.message || '')
      if (message.includes('CLAIM_SALE_NOT_FOUND')) return NextResponse.json({ error: 'Claim sale not found' }, { status: 404 })
      if (message.includes('CLAIM_SALE_NOT_OWNER')) return NextResponse.json({ error: 'Only the owner can cancel this claim sale' }, { status: 403 })
      if (message.includes('CLAIM_SALE_NOT_ACTIVE')) return NextResponse.json({ error: 'Claim sale is no longer active', code: 'CLAIM_SALE_NOT_ACTIVE' }, { status: 409 })
      throw cancelError
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

    return NextResponse.json({ success: true, claim_sale: data })
  } catch (err) {
    console.error('[POST /api/claim-sales/[id]/cancel]', err?.message || err)
    const safe = stockError(err, 'CLAIM_SALE_CANCEL_FAILED')
    return NextResponse.json({ error: safe.error, code: safe.code }, { status: safe.status })
  }
}

function makeServiceClient() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}
