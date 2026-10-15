export function assessManifestFreshness(manifest, now = new Date(), maxAgeMs = 48 * 60 * 60 * 1000) {
  if (!manifest) return { status: 'missing', age_ms: null, max_age_ms: maxAgeMs, reason: 'manifest missing' }
  const validShape = typeof manifest.completed_at === 'string'
    && Number.isInteger(manifest.row_count)
    && manifest.row_count > 0
    && Number.isInteger(manifest.skipped_count)
    && manifest.skipped_count >= 0
    && typeof manifest.source_field === 'string'
    && manifest.source_field.trim() !== ''
    && typeof manifest.source_url_sha256 === 'string'
    && /^[a-f0-9]{64}$/.test(manifest.source_url_sha256)
  if (!validShape) {
    return { status: 'invalid', age_ms: null, max_age_ms: maxAgeMs, reason: 'manifest shape is invalid' }
  }

  const completedAt = Date.parse(manifest.completed_at)
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now)
  if (!Number.isFinite(completedAt) || !Number.isFinite(nowMs) || completedAt > nowMs) {
    return { status: 'invalid', age_ms: null, max_age_ms: maxAgeMs, reason: 'manifest timestamp is invalid or in the future' }
  }

  const ageMs = nowMs - completedAt
  return {
    status: ageMs <= maxAgeMs ? 'fresh' : 'stale',
    age_ms: ageMs,
    max_age_ms: maxAgeMs,
    reason: ageMs <= maxAgeMs ? 'manifest is within freshness window' : 'manifest exceeds freshness window',
  }
}
