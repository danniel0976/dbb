export const POSTGREST_RANGE_PAGE_SIZE = 1000
export const LIBRARY_BULK_BATCH_SIZE = 100
export const MAX_LIBRARY_BULK_IDS = 10000

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Collect rows from range pages. The callback receives an inclusive range. A
 * full final page is followed by one empty request so exact 1,000-row
 * boundaries are not mistaken for completion.
 */
export async function collectPagedRows(fetchPage, pageSize = POSTGREST_RANGE_PAGE_SIZE) {
  const rows = []

  for (let offset = 0; ; offset += pageSize) {
    const page = (await fetchPage(offset, offset + pageSize - 1)) || []
    rows.push(...page)
    if (page.length < pageSize) break
  }

  return rows
}

export async function collectPagedIds(fetchPage, pageSize = POSTGREST_RANGE_PAGE_SIZE) {
  const ids = new Set()
  for (const row of await collectPagedRows(fetchPage, pageSize)) {
    if (row?.id) ids.add(row.id)
  }
  return [...ids]
}

/**
 * Validate UUID library-card IDs and remove duplicates before constructing an
 * URL-backed PostgREST .in() filter. Returns null when any ID is invalid.
 */
export function dedupeValidIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return null

  const seen = new Set()
  const unique = []
  for (const id of ids) {
    if (typeof id !== 'string' || !UUID_PATTERN.test(id)) return null
    const key = id.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      unique.push(id)
    }
  }
  if (unique.length > MAX_LIBRARY_BULK_IDS) return null
  return unique
}

/**
 * Run each .in()-backed operation sequentially and stop at the first error.
 * The processed count only includes batches whose operation completed.
 */
export async function runSequentialBatches(ids, operation, batchSize = LIBRARY_BULK_BATCH_SIZE) {
  let processed = 0

  for (let offset = 0; offset < ids.length; offset += batchSize) {
    const batch = ids.slice(offset, offset + batchSize)
    try {
      const result = await operation(batch)
      if (result?.error) return { processed, error: result.error }
    } catch (error) {
      return { processed, error }
    }
    processed += batch.length
  }

  return { processed, error: null }
}

/**
 * Read every row for a potentially large UUID list without putting the full
 * list in one URL-backed PostgREST `.in()` filter.
 */
export async function collectInBatches(ids, operation, batchSize = LIBRARY_BULK_BATCH_SIZE) {
  const rows = []
  for (let offset = 0; offset < ids.length; offset += batchSize) {
    const result = await operation(ids.slice(offset, offset + batchSize))
    if (result?.error) return { data: rows, error: result.error }
    rows.push(...(result?.data || []))
  }
  return { data: rows, error: null }
}
