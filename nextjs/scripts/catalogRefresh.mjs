import crypto from 'node:crypto'

// Completeness admission for Scryfall's default-card catalog. The verified
// September 30, 2026 run accepted 109,271 rows and skipped 9,135, so the fixed
// floor and acceptance ratio reject clearly truncated/corrupt inputs while
// leaving measured headroom for normal source drift.
export const CATALOG_MIN_ACCEPTED_ROWS = 100_000
export const CATALOG_MIN_ACCEPTED_RATIO = 0.85

export function assertCatalogCompleteness({ rowCount, skippedCount }) {
  if (!Number.isInteger(rowCount) || rowCount < CATALOG_MIN_ACCEPTED_ROWS) {
    throw new Error('catalog completeness requires at least 100,000 accepted rows')
  }
  if (!Number.isInteger(skippedCount) || skippedCount < 0) {
    throw new Error('catalog completeness requires a non-negative skipped row count')
  }
  const parsedCount = rowCount + skippedCount
  if (rowCount / parsedCount < CATALOG_MIN_ACCEPTED_RATIO) {
    throw new Error('catalog completeness requires accepted rows to be at least 85% of parsed rows')
  }
  return { rowCount, skippedCount, parsedCount }
}

export async function runWithFailureCleanup(operation, cleanup, onCleanupError = () => {}) {
  try {
    return await operation()
  } catch (originalError) {
    try {
      await cleanup()
    } catch (cleanupError) {
      onCleanupError(cleanupError)
    }
    throw originalError
  }
}

function assertHttpsUrl(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`missing ${label}`)
  let parsed
  try { parsed = new URL(value) } catch { throw new Error(`invalid ${label}`) }
  if (parsed.protocol !== 'https:') throw new Error(`HTTPS bulk-data URL required for ${label}`)
  return parsed.toString()
}

export function selectBulkDownload(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('invalid bulk-data response')
  if (payload.jsonl_download_uri) {
    return { url: assertHttpsUrl(payload.jsonl_download_uri, 'jsonl_download_uri'), sourceField: 'jsonl_download_uri' }
  }
  if (payload.download_uri) {
    return { url: assertHttpsUrl(payload.download_uri, 'download_uri'), sourceField: 'download_uri' }
  }
  throw new Error('missing jsonl_download_uri and download_uri')
}

export function sourceUrlHash(url) {
  return crypto.createHash('sha256').update(String(url)).digest('hex')
}

export function normalizeCmc(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0 || number >= 10000) return null
  return Math.round(number * 100) / 100
}

export function catalogRow(card) {
  if (!card || card.digital || !card.id || !card.name || !card.set) return null
  if (Array.isArray(card.games) && !card.games.includes('paper')) return null
  const faces = Array.isArray(card.card_faces) ? card.card_faces : []
  const face = faces[0]
  const images = card.image_uris || faces.find(f => f.image_uris)?.image_uris
  const strings = value => Array.isArray(value) ? value.filter(v => typeof v === 'string') : null
  return {
    scryfall_id: card.id, name: card.name, set_code: card.set,
    set_name: card.set_name || null, collector_number: card.collector_number || '',
    rarity: card.rarity || null, colors: card.color_identity || [],
    type_line: card.type_line || face?.type_line || null, cmc: normalizeCmc(card.cmc),
    mana_cost: card.mana_cost || face?.mana_cost || null,
    image_uris: images ? { small: images.small || null, normal: images.normal || null } : null,
    finishes: card.finishes || [], lang: card.lang || null,
    oracle_id: card.oracle_id || face?.oracle_id || null,
    illustration_id: card.illustration_id || face?.illustration_id || null,
    face_illustration_ids: faces.some(f => Boolean(f.illustration_id)) ? faces.map(f => f.illustration_id || null) : null,
    has_face_images: faces.some(f => Boolean(f.image_uris)),
    released_at: card.released_at || null, frame: card.frame || null,
    frame_effects: strings(card.frame_effects), promo_types: strings(card.promo_types),
    border_color: card.border_color || null, promo: typeof card.promo === 'boolean' ? card.promo : null,
    set_type: card.set_type || null, layout: card.layout || null, games: strings(card.games),
  }
}

export function buildRefreshManifest({ sourceField, sourceUrl, total, skipped, completedAt = new Date().toISOString() }) {
  return {
    completed_at: completedAt,
    source_field: sourceField,
    source_url_sha256: sourceUrlHash(sourceUrl),
    row_count: total,
    skipped_count: skipped,
  }
}
