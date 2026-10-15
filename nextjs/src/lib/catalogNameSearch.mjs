// OCR-tolerant catalog name retrieval.
//
// The catalog route filters names with a substring ILIKE. That is exact about
// the characters it is handed: a single OCR substitution ("lightnmg bolt")
// matches zero rows, so the scanner's client-side fuzzy ranking never receives
// a candidate to rank and a readable card fails on retrieval alone.
//
// This module answers that with a small ordered list of substring plans that
// stay inside plain PostgREST ILIKE — no hosted extension (pg_trgm) to depend
// on, no migration to apply, and a hard cap on the OR fan-out. Broadening is
// scanner-gated and escalation-only: a plan runs solely when every cheaper plan
// matched nothing at all, so ordinary manual search issues the same single
// query it always has.

export const NAME_MATCH_SUBSTRING = 'substring'
export const NAME_MATCH_TOKENS = 'tokens'
export const NAME_MATCH_SPLIT = 'split'
export const NAME_MATCH_WILDCARD = 'wildcard'

// Bounds. These cap work, not quality: the wider plans only ever run after a
// narrower one returned an empty count.
export const SCAN_MAX_NAME_PATTERNS = 8
export const SCAN_SOURCE_PAGE_SIZE = 200
export const SCAN_SOURCE_MAX_PAGES = 3
const MAX_TOKENS = 4
const MAX_SPLIT_TOKENS = 3
const MIN_TOKEN_LEN = 3
const MIN_SPLIT_TOKEN_LEN = 6
const MIN_WILDCARD_TOKEN_LEN = 4
const MAX_WILDCARD_TOKEN_LEN = 5

// Connective words carry no retrieval signal but would widen a token plan to
// most of the catalog. They are dropped only when a real word remains.
const STOPWORDS = new Set(['the', 'and', 'for', 'from', 'with', 'into', 'of', 'to', 'in', 'on'])

// Only these patterns may reach a PostgREST `or=` filter: commas, parentheses
// and quotes are filter syntax there, so a name fragment must not contain them.
const SAFE_OR_PATTERN = /^%[a-z0-9_]+%$/

function tokenize(query) {
  const parts = query.toLowerCase().split(/[^a-z0-9]+/).filter(part => part.length >= MIN_TOKEN_LEN)
  const unique = [...new Set(parts)]
  const meaningful = unique.filter(part => !STOPWORDS.has(part))
  // Longest first: the longest run of characters is the most selective, and the
  // ordering is deterministic so the emitted filter is stable per query.
  return (meaningful.length > 0 ? meaningful : unique)
    .sort((a, b) => b.length - a.length || (a < b ? -1 : 1))
    .slice(0, MAX_TOKENS)
}

// Non-overlapping halves, so any single substitution lands in exactly one of
// them and the other half is still a clean substring of the true name.
function splitToken(token) {
  const half = Math.floor(token.length / 2)
  return [token.slice(0, half), token.slice(half)]
}

function wildcardToken(token) {
  return [...token].map((_, index) => `%${token.slice(0, index)}_${token.slice(index + 1)}%`)
}

/**
 * Build the ordered name-match plans for one query.
 *
 * @param {string} query raw user/OCR query text
 * @param {{scan?: boolean}} options `scan` enables the OCR-tolerant plans
 * @returns {Array<{tier: string, patterns: string[]}>} narrowest plan first;
 *   empty when there is no name to match on
 */
export function buildNameMatchPlans(query, { scan = false } = {}) {
  const raw = typeof query === 'string' ? query.trim() : ''
  if (!raw) return []

  // Case is left as typed: ILIKE is case-insensitive, so this stays byte-for-byte
  // the filter the route already issues for manual search.
  const substring = `%${raw}%`
  const plans = [{ tier: NAME_MATCH_SUBSTRING, patterns: [substring] }]
  if (!scan) return plans

  const tokens = tokenize(raw)

  const tokenPatterns = tokens.map(token => `%${token}%`).slice(0, SCAN_MAX_NAME_PATTERNS)
  // A lone token that is already the whole query would just repeat the
  // substring plan, and repeating it cannot find anything new.
  const tokensAddNothing = tokenPatterns.length === 0
    || (tokenPatterns.length === 1 && tokenPatterns[0] === substring)
  if (!tokensAddNothing) plans.push({ tier: NAME_MATCH_TOKENS, patterns: tokenPatterns })

  if (
    tokens.length === 1 &&
    tokens[0].length >= MIN_WILDCARD_TOKEN_LEN &&
    tokens[0].length <= MAX_WILDCARD_TOKEN_LEN
  ) {
    plans.push({
      tier: NAME_MATCH_WILDCARD,
      patterns: wildcardToken(tokens[0]).slice(0, SCAN_MAX_NAME_PATTERNS),
    })
  }

  const splitPatterns = [...new Set(
    tokens
      .filter(token => token.length >= MIN_SPLIT_TOKEN_LEN)
      .slice(0, MAX_SPLIT_TOKENS)
      .flatMap(splitToken)
      .map(part => `%${part}%`)
  )].slice(0, SCAN_MAX_NAME_PATTERNS)
  if (splitPatterns.length > 0) plans.push({ tier: NAME_MATCH_SPLIT, patterns: splitPatterns })

  return plans
}

/**
 * Render patterns as a PostgREST `or=` filter over name ILIKE.
 * Returns null when nothing safe remains, so a caller must fall back rather
 * than emit a filter whose text could be reparsed as syntax.
 */
export function buildNameOrFilter(patterns) {
  const safe = (Array.isArray(patterns) ? patterns : []).filter(pattern => SAFE_OR_PATTERN.test(pattern))
  if (safe.length === 0) return null
  return safe.map(pattern => `name.ilike.${pattern}`).join(',')
}

/**
 * Run name-match plans.
 *
 * Manual search keeps the historical first-nonempty behavior. Scanner pool mode
 * executes every bounded plan so an incidental substring row cannot suppress a
 * tolerant candidate, then deduplicates rows by Scryfall id.
 *
 * @param {Array<{tier: string, patterns: string[]}>} plans
 * @param {(plan: object|null, page?: object) => Promise<{data: any, count: number|null, error: any}>} runQuery
 * @param {{pool?: boolean, page?: number, limit?: number, sourcePageSize?: number, maxSourcePages?: number}} options
 */
function nameFairRows(rows) {
  const buckets = new Map()
  for (const row of rows) {
    const name = typeof row?.name === 'string' ? row.name : ''
    if (!buckets.has(name)) buckets.set(name, [])
    buckets.get(name).push(row)
  }

  const ordered = []
  let offset = 0
  while (ordered.length < rows.length) {
    for (const bucket of buckets.values()) {
      if (offset < bucket.length) ordered.push(bucket[offset])
    }
    offset++
  }
  return ordered
}

export async function runNameMatchPlans(
  plans,
  runQuery,
  {
    pool = false,
    page = 1,
    limit = 20,
    sourcePageSize = SCAN_SOURCE_PAGE_SIZE,
    maxSourcePages = SCAN_SOURCE_MAX_PAGES,
  } = {}
) {
  const ordered = Array.isArray(plans) && plans.length > 0 ? plans : [null]
  if (pool) {
    const rows = []
    const seen = new Set()
    const tiers = []
    const boundedPageSize = Math.max(1, Math.min(SCAN_SOURCE_PAGE_SIZE, Number.parseInt(sourcePageSize, 10) || SCAN_SOURCE_PAGE_SIZE))
    const boundedMaxPages = Math.max(1, Math.min(SCAN_SOURCE_MAX_PAGES, Number.parseInt(maxSourcePages, 10) || SCAN_SOURCE_MAX_PAGES))
    for (const plan of ordered) {
      tiers.push(plan?.tier ?? null)
      for (let sourcePage = 1; sourcePage <= boundedMaxPages; sourcePage++) {
        const from = (sourcePage - 1) * boundedPageSize
        const result = await runQuery(plan, {
          page: sourcePage,
          limit: boundedPageSize,
          from,
          to: from + boundedPageSize - 1,
        })
        if (result?.error) return { ...result, tier: plan?.tier ?? null }
        const pageRows = Array.isArray(result?.data) ? result.data : []
        for (const row of pageRows) {
          const key = row?.scryfall_id
          if (key && seen.has(key)) continue
          if (key) seen.add(key)
          rows.push(row)
        }
        const total = Number.isInteger(result?.count) ? result.count : null
        if (pageRows.length < boundedPageSize || (total !== null && from + pageRows.length >= total)) break
      }
    }
    const safePage = Number.isInteger(page) && page > 0 ? page : 1
    const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 20
    const from = (safePage - 1) * safeLimit
    const fairRows = nameFairRows(rows)
    return {
      data: fairRows.slice(from, from + safeLimit),
      count: rows.length,
      error: null,
      tier: tiers.filter(Boolean).join('+') || null,
      tiers,
    }
  }

  let last = { data: [], count: 0, error: null, tier: null }
  for (const plan of ordered) {
    const result = await runQuery(plan)
    last = { ...result, tier: plan?.tier ?? null }
    // Never broaden the name filter to paper over a failed query.
    if (result?.error) return last
    if ((result?.count ?? 0) > 0) return last
  }
  return last
}
