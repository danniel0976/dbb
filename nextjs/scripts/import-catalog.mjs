/**
 * import-catalog.mjs
 *
 * Stream-parse Scryfall default_cards bulk data (gzip-compressed JSONL, ~80MB
 * compressed) and upsert into card_index. Decompresses and reads one line at a
 * time — never buffers the whole file in memory.
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
import { createReadStream, createWriteStream, mkdtempSync, renameSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import https from 'node:https'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import {
  assertCatalogCompleteness,
  buildRefreshManifest,
  normalizeCmc,
  runWithFailureCleanup,
  selectBulkDownload,
  sourceUrlHash,
} from './catalogRefresh.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Load env from .env.local
function loadEnv() {
  const envPath = process.env.CATALOG_ENV_PATH || path.join(__dirname, '..', '.env.local')
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
const INPUT_FILE = argValue('--input')
const MANIFEST_PATH = process.env.CATALOG_MANIFEST_PATH || path.join(__dirname, '..', '.catalog-refresh-manifest.json')
const BATCH_SIZE = 500
let refreshId = null

function argValue(flag) {
  const index = process.argv.indexOf(flag)
  if (index === -1) return null
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}

// Each run gets a fresh directory so a partial download can never be mistaken
// for a successful previous run by a scheduled invocation.
let tempDir = null
let tempFile = null

if (!DRY_RUN && (!SUPABASE_URL || !SERVICE_KEY)) {
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
          if (res.statusCode !== 200) {
            reject(new Error(`Scryfall bulk-data API returned HTTP ${res.statusCode}`))
            return
          }
          try {
            resolve(selectBulkDownload(JSON.parse(data)))
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
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume()
        file.close()
        try { rmSync(dest, { force: true }) } catch {}
        reject(new Error(`Bulk download returned HTTP ${res.statusCode}`))
        return
      }
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
  const stagedRows = rows.map(row => ({ refresh_id: refreshId, ...row }))
  const res = await fetch(`${SUPABASE_URL}/rest/v1/catalog_refresh_staging`, {
    method: 'POST',
    headers: {
      'apikey': SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(stagedRows),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Staging upsert failed ${res.status}: ${text.slice(0, 200)}`)
  }
}

async function publishRefresh(source, rowCount, skippedCount) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/publish_catalog_refresh`, {
    method: 'POST',
    headers: {
      'apikey': SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      p_refresh_id: refreshId,
      p_source_field: source.sourceField,
      p_source_url_sha256: sourceUrlHash(source.url),
      p_row_count: rowCount,
      p_skipped_count: skippedCount,
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Catalog publish failed ${res.status}: ${text.slice(0, 200)}`)
  }
  return res.json()
}

async function cleanupFailedRefresh() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/catalog_refresh_staging?refresh_id=eq.${encodeURIComponent(refreshId)}`,
    {
      method: 'DELETE',
      headers: {
        'apikey': SERVICE_KEY,
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'Prefer': 'return=minimal',
      },
    }
  )
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Staging cleanup failed ${res.status}: ${text.slice(0, 200)}`)
  }
}

async function processFile(filePath) {
  const rl = createInterface({
    input: createReadStream(filePath).pipe(zlib.createGunzip()),
    crlfDelay: Infinity,
  })
  let batch = []
  let total = 0
  let skipped = 0
  let batchNum = 0
  const start = Date.now()

  for await (const line of rl) {
    const trimmed = line.trim()
    if (trimmed === '') continue

    // JSONL: one complete card object per line, no brackets or trailing commas.
    let card
    try {
      card = JSON.parse(trimmed)
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
      cmc: normalizeCmc(card.cmc),
      mana_cost: card.mana_cost || face?.mana_cost || null,
      image_uris: extractImageUris(card),
      finishes: card.finishes || [],
    }

    batch.push(row)
    total++

    if (batch.length >= BATCH_SIZE) {
      batchNum++
      if (!DRY_RUN) {
        await upsertBatch(batch)
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
      await upsertBatch(batch)
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1)
  console.log(`\n\nDone. ${total.toLocaleString()} cards processed (${skipped} skipped) in ${elapsed}s`)
  console.log(`Batches: ${batchNum} × ${BATCH_SIZE}`)
  if (DRY_RUN) console.log('(dry run — no data written)')
  return { total, skipped, batchNum }
}

function writeManifest(manifest) {
  const tempManifest = `${MANIFEST_PATH}.tmp`
  writeFileSync(tempManifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  renameSync(tempManifest, MANIFEST_PATH)
}

async function main() {
  console.log('=== DBB Scryfall Catalog Import ===')
  if (DRY_RUN) console.log('DRY RUN mode')
  if (INPUT_FILE && !DRY_RUN) throw new Error('--input is only supported with --dry-run')
  refreshId = randomUUID()

  let source = null
  if (INPUT_FILE) {
    tempFile = path.resolve(INPUT_FILE)
    console.log(`Using local input: ${tempFile}`)
  } else {
    console.log('Fetching bulk data URL from Scryfall...')
    source = await fetchBulkDataUrl()
    console.log(`Source field: ${source.sourceField}`)
    console.log(`URL: ${source.url}`)
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'dbb-scryfall-'))
    tempFile = path.join(tempDir, 'default-cards.jsonl.gz')
    await downloadFile(source.url, tempFile)
  }

  try {
    await runWithFailureCleanup(
      async () => {
        console.log('Stream-parsing and upserting...')
        const stats = await processFile(tempFile)
        if (!DRY_RUN) {
          assertCatalogCompleteness({ rowCount: stats.total, skippedCount: stats.skipped })
          await publishRefresh(source, stats.total, stats.skipped)
          writeManifest(buildRefreshManifest({
            sourceField: source.sourceField,
            sourceUrl: source.url,
            total: stats.total,
            skipped: stats.skipped,
          }))
          console.log(`Refresh manifest written: ${MANIFEST_PATH}`)
        }
      },
      async () => {
        if (!DRY_RUN) await cleanupFailedRefresh()
      },
      cleanupError => console.error(`Catalog staging cleanup failed: ${cleanupError.message}`)
    )
  } finally {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      console.log('Temp directory cleaned up.')
    }
  }
}

main().catch(e => { console.error(`Catalog refresh failed: ${e.message}`); process.exit(1) })
