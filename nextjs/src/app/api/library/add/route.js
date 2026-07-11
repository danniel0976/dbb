import { NextResponse } from 'next/server'
import { createClient as createAuthClient } from '@/lib/supabaseServer'
import { createClient as createServiceClient } from '@supabase/supabase-js'

function makeServiceClient() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

const VALID_FOIL = ['normal', 'foil', 'etched']
const VALID_CONDITION = ['M', 'NM', 'LP', 'MP', 'HP', 'DMG']

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

  const {
    scryfall_id,
    binder_id,
    quantity = 1,
    foil = 'normal',
    condition = 'NM',
  } = body

  // Validate inputs
  if (!scryfall_id || typeof scryfall_id !== 'string') {
    return NextResponse.json({ error: 'scryfall_id is required' }, { status: 400 })
  }
  if (!binder_id || typeof binder_id !== 'string') {
    return NextResponse.json({ error: 'binder_id is required' }, { status: 400 })
  }
  if (!VALID_FOIL.includes(foil)) {
    return NextResponse.json({ error: `foil must be one of ${VALID_FOIL.join(', ')}` }, { status: 400 })
  }
  if (!VALID_CONDITION.includes(condition)) {
    return NextResponse.json({ error: `condition must be one of ${VALID_CONDITION.join(', ')}` }, { status: 400 })
  }
  const qty = Math.min(9999, Math.max(1, parseInt(quantity, 10) || 1))

  const db = makeServiceClient()

  // Verify binder belongs to user
  const { data: binder, error: binderErr } = await db
    .from('binders')
    .select('id')
    .eq('id', binder_id)
    .eq('user_id', user.id)
    .single()

  if (binderErr || !binder) {
    return NextResponse.json({ error: 'Binder not found' }, { status: 404 })
  }

  // Verify card exists in card_index
  const { data: card, error: cardErr } = await db
    .from('card_index')
    .select('scryfall_id, name')
    .eq('scryfall_id', scryfall_id)
    .single()

  if (cardErr || !card) {
    return NextResponse.json({ error: 'Card not found in catalog' }, { status: 404 })
  }

  // Use import_library_cards RPC (handles upsert/merge exactly like CSV import)
  const { data: result, error: rpcErr } = await db.rpc('import_library_cards', {
    p_user_id: user.id,
    p_binder_id: binder_id,
    p_rows: JSON.stringify([{
      scryfall_id,
      quantity: qty,
      foil,
      condition,
      language: 'en',
      date_added: new Date().toISOString(),
    }]),
  })

  if (rpcErr) {
    console.error('library/add rpc error:', rpcErr)
    return NextResponse.json({ error: rpcErr.message }, { status: 500 })
  }

  const { inserted = 0, merged = 0 } = result?.[0] ?? {}
  return NextResponse.json({ ok: true, inserted, merged, card_name: card.name })
}
