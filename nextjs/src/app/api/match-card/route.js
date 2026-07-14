import { NextResponse } from 'next/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'

function makeServiceClient() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

// Hamming distance between two BigInt hashes
function hammingDistance(a, b) {
  const xor = a ^ b
  let count = 0n
  let x = xor
  while (x) {
    count += x & 1n
    x >>= 1n
  }
  return Number(count)
}

// POST /api/match-card
// Receives: { hash: "bigint as string" } — the pHash computed client-side
// Returns: { match: { scryfall_id, name, set_code, set_name, image_uris, distance, confidence } | null }
export async function POST(request) {
  try {
    const body = await request.json()
    const { hash } = body

    if (hash == null) {
      return NextResponse.json({ error: 'No hash provided' }, { status: 400 })
    }

    const capturedHash = BigInt(hash)

    // Fetch all stored hashes from Supabase
    const sc = makeServiceClient()
    const { data: hashes, error: hashErr } = await sc
      .from('card_hashes')
      .select('scryfall_id, phash, image_uri')

    if (hashErr) throw hashErr

    if (!hashes || hashes.length === 0) {
      return NextResponse.json({
        error: 'No card hashes in database. Run build-card-hashes script first.'
      }, { status: 503 })
    }

    // Find nearest match by Hamming distance
    let bestMatch = null
    let bestDistance = 64

    for (const row of hashes) {
      const storedHash = BigInt(row.phash)
      const dist = hammingDistance(capturedHash, storedHash)

      if (dist < bestDistance) {
        bestDistance = dist
        bestMatch = row
      }
    }

    // Threshold: distance <= 22 is a confident match
    const MATCH_THRESHOLD = 22

    if (!bestMatch || bestDistance > MATCH_THRESHOLD) {
      return NextResponse.json({
        match: null,
        best_distance: bestDistance,
        threshold: MATCH_THRESHOLD,
      })
    }

    // Fetch card details
    const { data: card, error: cardErr } = await sc
      .from('card_index')
      .select('scryfall_id, name, set_code, set_name, collector_number, rarity, image_uris')
      .eq('scryfall_id', bestMatch.scryfall_id)
      .single()

    if (cardErr || !card) {
      return NextResponse.json({ match: null, error: 'Hash matched but card not found in index' })
    }

    return NextResponse.json({
      match: {
        ...card,
        distance: bestDistance,
        confidence: Math.round((1 - bestDistance / 64) * 100),
      },
    })
  } catch (err) {
    console.error('[POST /api/match-card]', err?.message || err)
    return NextResponse.json({ error: 'Failed to match card' }, { status: 500 })
  }
}