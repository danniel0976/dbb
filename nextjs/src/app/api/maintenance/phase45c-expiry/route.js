import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Vercel invokes this zero-token maintenance endpoint hourly. The database
// function is bounded, lock-safe, and independently revalidates expiry at
// checkout; a buyer read is not the lifecycle cleanup mechanism.
export async function GET(request) {
  const expected = process.env.CRON_SECRET
  const supplied = request.headers.get('authorization') || ''
  if (!expected || supplied !== `Bearer ${expected}`) {
    return NextResponse.json({ error: 'MAINTENANCE_UNAUTHORIZED', code: 'MAINTENANCE_UNAUTHORIZED' }, { status: 401 })
  }
  const client = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  )
  const { data, error } = await client.rpc('phase45c_reconcile_expired_listings', { p_limit: 200 })
  if (error) {
    return NextResponse.json({ error: 'EXPIRY_SWEEP_UNAVAILABLE' }, {
      status: 503,
      headers: { 'Cache-Control': 'private, no-store, max-age=0' },
    })
  }
  return NextResponse.json({ ok: true, expired: data || 0 }, {
    headers: { 'Cache-Control': 'private, no-store, max-age=0' },
  })
}
