#!/usr/bin/env node
/**
 * Build perceptual hash index for card images.
 * 
 * Downloads card images from Scryfall, computes pHash, stores in card_hashes table.
 * 
 * Usage:
 *   node scripts/build-card-hashes.mjs --sample          # hash 5 sample cards
 *   node scripts/build-card-hashes.mjs --card <scryfall_id>  # hash one card
 *   node scripts/build-card-hashes.mjs                    # hash all (paginated)
 * 
 * pHash algorithm: resize to 32x32 grayscale -> 8x8 DCT -> median threshold -> 64-bit hash
 * Uses pure-JS JPEG decoding via 'jpeg-js' (pure JS, no native deps).
 */

import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing Supabase env vars. Check .env.local')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

// Compute pHash from raw RGBA pixel data
function computePHashFromRGBA(rgba, width, height) {
  // Step 1: Downscale to 32x32 grayscale using nearest-neighbor
  const small32 = new Uint8Array(32 * 32)
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      const sx = Math.floor(x * width / 32)
      const sy = Math.floor(y * height / 32)
      const idx = (sy * width + sx) * 4
      const gray = Math.round(0.299 * rgba[idx] + 0.587 * rgba[idx + 1] + 0.114 * rgba[idx + 2])
      small32[y * 32 + x] = gray
    }
  }

  // Step 2: Compute 8x8 DCT from 32x32
  const dct = new Float64Array(64)
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      let sum = 0
      for (let i = 0; i < 32; i++) {
        for (let j = 0; j < 32; j++) {
          const cu = u === 0 ? Math.sqrt(1 / 32) : Math.sqrt(2 / 32)
          const cv = v === 0 ? Math.sqrt(1 / 32) : Math.sqrt(2 / 32)
          sum += cu * cv * small32[i * 32 + j] *
            Math.cos(((2 * i + 1) * u * Math.PI) / (2 * 32)) *
            Math.cos(((2 * j + 1) * v * Math.PI) / (2 * 32))
        }
      }
      dct[u * 8 + v] = sum
    }
  }

  // Step 3: Median (excluding DC component)
  const sorted = Array.from(dct).slice(1).sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]

  // Step 4: Build 64-bit hash
  let hash = 0n
  for (let i = 0; i < 64; i++) {
    if (dct[i] > median) {
      hash = hash | (1n << BigInt(i))
    }
  }

  return hash
}

// Fetch image from URL, decode, return {rgba, width, height}
async function fetchAndDecodeImage(url) {
  const jpegJs = await import('jpeg-js')
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const arrayBuffer = await res.arrayBuffer()
  const jpegData = new Uint8Array(arrayBuffer)
  const raw = jpegJs.decode(jpegData, { useTArray: true })
  return { rgba: raw.data, width: raw.width, height: raw.height }
}

// Upsert hash into Supabase
async function storeHash(scryfallId, phash, imageUri) {
  const { error } = await sb
    .from('card_hashes')
    .upsert({
      scryfall_id: scryfallId,
      phash: Number(phash),  // Supabase handles bigint as numeric
      image_uri: imageUri,
    }, { onConflict: 'scryfall_id' })
  if (error) throw new Error(`Store failed: ${error.message}`)
}

// Parse image_uris from card_index (stored as JSON string or object)
function getSmallImageUri(card) {
  if (!card.image_uris) return null
  try {
    const uris = typeof card.image_uris === 'string' ? JSON.parse(card.image_uris) : card.image_uris
    return uris?.small || uris?.normal || null
  } catch { return null }
}

async function main() {
  const args = process.argv.slice(2)
  const mode = args[0] === '--card' ? 'single' : args[0] === '--sample' ? 'sample' : 'all'

  let cards = []

  if (mode === 'single') {
    const sid = args[1]
    const { data, error } = await sb.from('card_index')
      .select('scryfall_id, name, image_uris').eq('scryfall_id', sid).single()
    if (error || !data) { console.error(`Card not found: ${sid}`); process.exit(1) }
    cards = [data]
  } else if (mode === 'sample') {
    const { data, error } = await sb.from('card_index')
      .select('scryfall_id, name, image_uris')
      .not('image_uris', 'is', null)
      .limit(5)
    if (error) throw error
    cards = data || []
  } else {
    console.log('Fetching all cards with image_uris...')
    const pageSize = 1000
    let offset = 0
    while (true) {
      const { data, error } = await sb.from('card_index')
        .select('scryfall_id, name, image_uris')
        .not('image_uris', 'is', null)
        .range(offset, offset + pageSize - 1)
      if (error) throw error
      if (!data || data.length === 0) break
      cards = cards.concat(data)
      offset += pageSize
      process.stdout.write(`\rFetched ${cards.length} cards...`)
      if (data.length < pageSize) break
    }
    console.log()
  }

  console.log(`\nHashing ${cards.length} card(s)...\n`)

  let ok = 0, fail = 0
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i]
    try {
      const imageUri = getSmallImageUri(card)
      if (!imageUri) { console.log(`[${i+1}/${cards.length}] SKIP ${card.name}`); fail++; continue }

      const { rgba, width, height } = await fetchAndDecodeImage(imageUri)
      const hash = computePHashFromRGBA(rgba, width, height)
      await storeHash(card.scryfall_id, hash, imageUri)
      ok++
      console.log(`[${i+1}/${cards.length}] OK ${card.name} hash=${hash.toString(16).padStart(16, '0')}`)

      // Scryfall rate limit: ~10 req/s, be safe with 100ms
      if (i < cards.length - 1) await new Promise(r => setTimeout(r, 100))
    } catch (err) {
      console.log(`[${i+1}/${cards.length}] FAIL ${card.name} - ${err.message}`)
      fail++
    }
  }

  console.log(`\nDone: ${ok} hashed, ${fail} failed.`)
}

main().catch(err => { console.error('Fatal:', err); process.exit(1) })