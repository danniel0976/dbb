/**
 * Bounded fetch with per-attempt timeout + retry/backoff.
 *
 * Used by scripts/build-price-cache.js so one hung upstream request (MTGJSON,
 * Supabase REST/storage) can't consume the whole cron timeout and block the
 * downstream pipeline stages. See scripts/README-price-pipeline.md.
 */

const DEFAULT_BACKOFF_MS = 750

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isRetryableError(err) {
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true
  if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ECONNREFUSED') return true
  if (err.cause && isRetryableError(err.cause)) return true
  return /fetch failed|network|socket/i.test(err.message || '')
}

// Aborts a hung request after timeoutMs instead of letting it run forever,
// and retries transient failures (timeout, reset, 5xx) with backoff.
// Non-retryable (4xx) responses are returned as-is so callers keep their
// existing res.ok handling.
async function fetchWithRetry(label, url, options = {}, { timeoutMs = 30000, maxAttempts = 3, fetchImpl = fetch } = {}) {
  let lastErr
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(timeoutMs) })
      if (res.ok || res.status < 500 || attempt === maxAttempts) return res
      lastErr = new Error(`${label}: HTTP ${res.status}`)
    } catch (err) {
      const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError'
      if (attempt === maxAttempts || !isRetryableError(err)) {
        throw new Error(
          `${label}: ${timedOut ? `timed out after ${timeoutMs}ms` : err.message} (attempt ${attempt}/${maxAttempts})`
        )
      }
      lastErr = err
    }
    console.warn(`  [${label}] attempt ${attempt}/${maxAttempts} failed, retrying in ${DEFAULT_BACKOFF_MS * attempt}ms...`)
    await sleep(DEFAULT_BACKOFF_MS * attempt)
  }
  throw lastErr
}

module.exports = { fetchWithRetry, isRetryableError, sleep }
