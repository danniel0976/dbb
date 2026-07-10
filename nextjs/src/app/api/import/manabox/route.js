import { NextResponse } from 'next/server'
import { parse } from 'csv-parse/sync'
import { createClient as createAuthClient } from '@/lib/supabaseServer'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { parseRow, aggregateRows } from '@/lib/manabox'

export const maxDuration = 60

const MAX_FILE_BYTES = 5 * 1024 * 1024
const SCRYFALL_BATCH = 75
const SCRYFALL_DELAY = 100
const RPC_CHUNK = 500

function makeServiceClient() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

export async function POST(request) {
  const authClient = await createAuthClient()
  const { data: { user }, error: authError } = await authClient.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let formData
  try {
    formData = await request.formData()
  } catch {
    return NextResponse.json({ error: 'Invalid form data' }, { status: 400 })
  }

  const file = formData.get('file')
  const destination = formData.get('destination') || 'general'
  const binderName = (formData.get('binderName') || 'Imported Collection').trim()

  if (!file || typeof file === 'string') {
    return NextResponse.json({ error: 'No file uploaded' }, { status: 400 })
  }

  const bytes = await file.arrayBuffer()
  if (bytes.byteLength > MAX_FILE_BYTES) {
    return NextResponse.json({ error: 'File too large (max 5 MB)' }, { status: 413 })
  }

  let csvText = new TextDecoder().decode(bytes)
  if (csvText.charCodeAt(0) === 0xFEFF) csvText = csvText.slice(1)

  let rawRows
  try {
    rawRows = parse(csvText, { columns: true, bom: true, trim: true, skip_empty_lines: true })
  } catch (e) {
    return NextResponse.json({ error: 'CSV parse error: ' + e.message }, { status: 400 })
  }

  const mapped = rawRows.map((row, i) => ({ ...parseRow(row), _line: i + 2 }))
  const skipped = mapped
    .filter(r => r._skip)
    .map(r => ({ line: r._line, name: r._name, set_code: r._set_code, reason: r._reason }))

  const aggregated = aggregateRows(mapped)

  const db = makeServiceClient()

  // Resolve or create binder
  let binderId, resolvedBinderName
  if (destination === 'new' && binderName) {
    const { data: newBinder, error: binderErr } = await db
      .from('binders')
      .insert({ user_id: user.id, name: binderName })
      .select('id, name')
      .single()
    if (binderErr) {
      return NextResponse.json({ error: 'Failed to create binder: ' + binderErr.message }, { status: 500 })
    }
    binderId = newBinder.id
    resolvedBinderName = newBinder.name
  } else {
    const { data: defaultBinder, error: defaultErr } = await db
      .from('binders')
      .select('id, name')
      .eq('user_id', user.id)
      .eq('is_default', true)
      .single()
    if (defaultErr || !defaultBinder) {
      return NextResponse.json({ error: 'Could not find default binder' }, { status: 500 })
    }
    binderId = defaultBinder.id
    resolvedBinderName = defaultBinder.name
  }

  // Find IDs not yet in card_index — batch the query to avoid URL length limits
  const allIds = [...new Set(aggregated.map(r => r.scryfall_id))]

  const existingSet = new Set()
  for (let i = 0; i < allIds.length; i += 200) {
    const batch = allIds.slice(i, i + 200)
    const { data: batchExisting } = await db
      .from('card_index')
      .select('scryfall_id')
      .in('scryfall_id', batch)
    if (batchExisting) batchExisting.forEach(r => existingSet.add(r.scryfall_id))
  }
  const toHydrate = allIds.filter(id => !existingSet.has(id))

  // Hydrate card_index from Scryfall
  const notFoundIds = new Set()
  for (let i = 0; i < toHydrate.length; i += SCRYFALL_BATCH) {
    if (i > 0) await sleep(SCRYFALL_DELAY)
    const batch = toHydrate.slice(i, i + SCRYFALL_BATCH)

    let sfData
    try {
      const resp = await fetch('https://api.scryfall.com/cards/collection', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'DansBizarreBazaar/1.0',
        },
        body: JSON.stringify({ identifiers: batch.map(id => ({ id })) }),
      })
      sfData = await resp.json()
    } catch {
      batch.forEach(id => notFoundIds.add(id))
      continue
    }

    if (sfData.not_found) {
      sfData.not_found.forEach(nf => { if (nf.id) notFoundIds.add(nf.id) })
    }

    const cardRows = (sfData.data || []).map(card => {
      const face = card.card_faces?.[0]
      return {
        scryfall_id: card.id,
        name: card.name,
        set_code: card.set,
        set_name: card.set_name,
        collector_number: card.collector_number,
        rarity: card.rarity,
        colors: card.color_identity || [],
        type_line: card.type_line || face?.type_line || null,
        cmc: card.cmc ?? null,
        mana_cost: card.mana_cost || face?.mana_cost || null,
      }
    })

    if (cardRows.length > 0) {
      await db.from('card_index').upsert(cardRows, { onConflict: 'scryfall_id' })
    }
  }

  // Add not-found IDs to skipped list
  const notFoundSkipped = aggregated
    .filter(r => notFoundIds.has(r.scryfall_id))
    .map(r => ({ line: null, name: r._name, set_code: r._set_code, reason: 'Not found on Scryfall' }))

  const importRows = aggregated.filter(r => !notFoundIds.has(r.scryfall_id))

  // Import in RPC chunks
  let totalInserted = 0
  let totalMerged = 0

  for (let i = 0; i < importRows.length; i += RPC_CHUNK) {
    const chunk = importRows.slice(i, i + RPC_CHUNK).map(r => ({
      scryfall_id: r.scryfall_id,
      quantity: r.quantity,
      foil: r.foil,
      condition: r.condition,
      language: r.language,
      purchase_price: r.purchase_price,
      purchase_currency: r.purchase_currency,
      date_added: r.date_added,
    }))

    const { data: rpcResult, error: rpcErr } = await db.rpc('import_library_cards', {
      p_user_id: user.id,
      p_binder_id: binderId,
      p_rows: chunk,
    })

    if (rpcErr) {
      console.error('RPC error:', rpcErr.message)
      continue
    }

    if (rpcResult?.[0]) {
      totalInserted += rpcResult[0].inserted || 0
      totalMerged += rpcResult[0].merged || 0
    }
  }

  return NextResponse.json({
    inserted: totalInserted,
    merged: totalMerged,
    skipped: [...skipped, ...notFoundSkipped],
    binderId,
    binderName: resolvedBinderName,
  })
}
