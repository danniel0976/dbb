/**
 * import-catalog.mjs
 *
 * Stream-parse Scryfall default_cards bulk data (~90MB JSON) and upsert into card_index.
 * Uses readline to process one line at a time — never JSON.parse the whole file.
 *
 * Usage:
 *   node scripts/import-catalog.mjs
 *   node scripts/import-catalog.mjs --dry-run     # count only, no upserts
 *
 * Prerequisites:
 *   - supabase/migration-007-catalog.sql applied (adds image_uris + finishes columns)
 *   - NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in nextjs/.env.local
 */

import { createInterface } from 'node:readline'
import { createReadStream, unlinkSync, existsSync } from 'node:fs'
import { createWriteStream } from 'node:fs'
import https from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Load env from .env.local
function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env.local')
  try {
    const text = readFileSync(envPath, 'utf8')
    for (const line of text.split('\n')) {
      const m = line.match(/^([^#=]+)=(.*)$/)
      if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '')
    }
  } catch {
    console.error('Could not read .env.local')
    process.exit(1)
  }
}

loadEnv()

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const DRY_RUN = process.argv.includes('--dry-run')
const BATCH_SIZE = 500
const TEMP_FILE = '/tmp/scryfall-default-cards.json'

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

async function fetchBulkDataUrl() {
  return new Promise((resolve, reject) => {
    const req = https.get(
      'https://api.scryfall.com/bulk-data/default-cards',
      { headers: { 'User-Agent': 'DansBizarreBazaar/1.0', 'Accept': 'application/json' } },
      (res) => {
        let data = ''
        res.on('data', c => data += c)
        res.on('end', () => {
          try {
            const json = JSON.parse(data)
            resolve(json.download_uri)
          } catch (e) {
            reject(e)
          }
        })
      }
    )
    req.on('error', reject)
  })
}

function httpsGet(url, opts, cb) {
  // Follow up to 5 redirects
  let hops = 0
  function go(u) {
    https.get(u, opts, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location && hops < 5) {
        hops++
        go(res.headers.location)
        return
      }
      cb(res)
    }).on('error', cb)
  }
  go(url)
}

async function downloadFile(url, dest) {
  console.log(`Downloading: ${url}`)
  console.log(`To: ${dest}`)
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest)
    let downloaded = 0
    httpsGet(url, { headers: { 'User-Agent': 'DansBizarreBazaar/1.0' } }, (res) => {
      if (res instanceof Error) { file.close(); reject(res); return }
      res.on('data', chunk => {
        downloaded += chunk.length
        if (downloaded % (5 * 1024 * 1024) < chunk.length) {
          process.stdout.write(`\r  ${(downloaded / 1024 / 1024).toFixed(0)} MB downloaded...`)
        }
      })
      res.pipe(file)
      file.on('finish', () => { file.close(); console.log(''); resolve() })
      res.on('error', (e) => { file.close(); reject(e) })
    })
  })
}

function extractImageUris(card) {
  if (card.image_uris) {
    return { small: card.image_uris.small || null, normal: card.image_uris.normal || null }
  }
  const face = card.card_faces?.[0]
  if (face?.image_uris) {
    return { small: face.image_uris.small || null, normal: face.image_uris.normal || null }
  }
  return null
}

async function upsertBatch(rows) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/card_index`, {
    method: 'POST',
    headers: {
      'apikey': SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Upsert failed ${res.status}: ${text.slice(0, 200)}`)
  }
}

async function processFile(filePath) {
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity })
  let batch = []
  let total = 0
  let skipped = 0
  let batchNum = 0
  const start = Date.now()

  for await (const line of rl) {
    const trimmed = line.trim()
    // Skip the array bracket lines
    if (trimmed === '[' || trimmed === ']' || trimmed === '') continue

    // Each card line looks like: {"object":"card",...}, or {"object":"card",...}
    // Strip trailing comma
    const jsonStr = trimmed.endsWith(',') ? trimmed.slice(0, -1) : trimmed

    let card
    try {
      card = JSON.parse(jsonStr)
    } catch {
      skipped++
      continue
    }

    // Only include paper cards (exclude digital-only)
    if (card.digital) { skipped++; continue }
    if (!card.id || !card.name || !card.set) { skipped++; continue }

    const face = card.card_faces?.[0]
    const row = {
      scryfall_id: card.id,
      name: card.name,
      set_code: card.set,
      set_name: card.set_name || null,
      collector_number: card.collector_number || '',
      rarity: card.rarity || null,
      colors: card.color_identity || [],
      type_line: card.type_line || face?.type_line || null,
      cmc: card.cmc ?? null,
      mana_cost: card.mana_cost || face?.mana_cost || null,
      image_uris: extractImageUris(card),
      finishes: card.finishes || [],
    }

    batch.push(row)
    total++

    if (batch.length >= BATCH_SIZE) {
      batchNum++
      if (!DRY_RUN) {
        try {
          await upsertBatch(batch)
        } catch (e) {
          console.error(`\nBatch ${batchNum} error: ${e.message}`)
        }
      }
      batch = []
      const elapsed = ((Date.now() - start) / 1000).toFixed(0)
      process.stdout.write(`\r  ${total.toLocaleString()} cards processed (${elapsed}s)...`)
    }
  }

  // Final partial batch
  if (batch.length > 0) {
    batchNum++
    if (!DRY_RUN) {
      try {
        await upsertBatch(batch)
      } catch (e) {
        console.error(`\nFinal batch error: ${e.message}`)
      }
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1)
  console.log(`\n\nDone. ${total.toLocaleString()} cards processed (${skipped} skipped) in ${elapsed}s`)
  console.log(`Batches: ${batchNum} × ${BATCH_SIZE}`)
  if (DRY_RUN) console.log('(dry run — no data written)')
}

async function main() {
  console.log('=== DBB Scryfall Catalog Import ===')
  if (DRY_RUN) console.log('DRY RUN mode')

  // Fetch download URL from Scryfall bulk-data API
  console.log('Fetching bulk data URL from Scryfall...')
  let downloadUrl
  try {
    downloadUrl = await fetchBulkDataUrl()
    console.log(`URL: ${downloadUrl}`)
  } catch (e) {
    console.error('Failed to fetch bulk data URL:', e.message)
    process.exit(1)
  }

  // Download to temp file
  const tempExists = existsSync(TEMP_FILE)
  if (tempExists) {
    console.log(`Reusing existing temp file: ${TEMP_FILE}`)
    console.log('(delete /tmp/scryfall-default-cards.json to force re-download)')
  } else {
    try {
      await downloadFile(downloadUrl, TEMP_FILE)
    } catch (e) {
      console.error('Download failed:', e.message)
      process.exit(1)
    }
  }

  // Stream-parse and upsert
  console.log('Stream-parsing and upserting...')
  try {
    await processFile(TEMP_FILE)
  } catch (e) {
    console.error('Processing failed:', e.message)
    process.exit(1)
  }

  // Clean up temp file
  if (!DRY_RUN && existsSync(TEMP_FILE)) {
    try { unlinkSync(TEMP_FILE) } catch {}
    console.log('Temp file cleaned up.')
  }
}

main().catch(e => { console.error(e); process.exit(1) })
