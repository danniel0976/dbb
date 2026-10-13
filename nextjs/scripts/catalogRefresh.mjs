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

export function buildRefreshManifest({ sourceField, sourceUrl, total, skipped, completedAt = new Date().toISOString() }) {
  return {
    completed_at: completedAt,
    source_field: sourceField,
    source_url_sha256: sourceUrlHash(sourceUrl),
    row_count: total,
    skipped_count: skipped,
  }
}
