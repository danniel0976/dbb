import { NextResponse } from 'next/server'
import { createClient as createAuthClient } from '@/lib/supabaseServer'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { normalizeBatchRequest } from '@/lib/libraryBatchAdd.mjs'

function makeServiceClient() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

// Batch add — the scanner shelf confirms through here.
//
// The whole shelf goes to import_library_cards_once in one transaction. A
// service-only receipt serializes duplicate batchIds and replays stored counts
// without incrementing inventory again: every scanned row lands or none does.
// The per-row POST loop this replaced could fail halfway
// and leave a partial scan session in the library with no record of how far it
// got. /api/library/add stays as-is for ordinary one-off manual adds.
export async function POST(request) {
  const authClient = await createAuthClient()
  const { data: { user }, error: authErr } = await authClient.auth.getUser()
  if (authErr || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const parsed = normalizeBatchRequest(body, { requireBatchId: true })
  if (parsed.error) {
    const { message, status, index } = parsed.error
    return NextResponse.json({ error: message, index }, { status })
  }
  const { binderId, rows, requestedCount, scryfallIds } = parsed

  const db = makeServiceClient()

  // One ownership check for the batch: every row lands in this one binder.
  const { data: binder, error: binderErr } = await db
    .from('binders')
    .select('id')
    .eq('id', binderId)
    .eq('user_id', user.id)
    .maybeSingle()

  if (binderErr) {
    console.error('library/add/batch binder lookup error:', binderErr)
    return NextResponse.json({ error: 'Could not validate binder' }, { status: 500 })
  }
  if (!binder) {
    return NextResponse.json({ error: 'Binder not found' }, { status: 404 })
  }

  // One catalog check for the batch. The library_cards FK would reject an
  // unknown printing anyway, but only as an opaque 500 naming no row — this
  // tells the caller exactly which printings are missing.
  const { data: known, error: cardErr } = await db
    .from('card_index')
    .select('scryfall_id')
    .in('scryfall_id', scryfallIds)

  if (cardErr) {
    console.error('library/add/batch card_index error:', cardErr)
    return NextResponse.json({ error: 'Could not validate scanned cards' }, { status: 500 })
  }

  const found = new Set((known || []).map(card => card.scryfall_id))
  const missing = scryfallIds.filter(id => !found.has(id))
  if (missing.length > 0) {
    return NextResponse.json({
      error: `Card not found in catalog: ${missing.join(', ')}`,
      missing,
    }, { status: 404 })
  }

  // p_rows must be a real JSON array, not a stringified one — the RPC parameter
  // is jsonb and jsonb_array_elements() rejects a scalar text value. The
  // Supabase client serialises the array for us.
  const { data: result, error: rpcErr } = await db.rpc('import_library_cards_once', {
    p_user_id: user.id,
    p_binder_id: binderId,
    p_batch_id: body.batchId,
    p_rows: rows,
  })

  if (rpcErr) {
    console.error('library/add/batch rpc error:', rpcErr)
    return NextResponse.json({ error: 'Could not add scanned cards' }, { status: 500 })
  }

  const { inserted = 0, merged = 0, replayed = false } = result?.[0] ?? {}
  return NextResponse.json({
    ok: true,
    inserted,
    merged,
    replayed,
    requested: requestedCount,
    rows: rows.length,
  })
}
