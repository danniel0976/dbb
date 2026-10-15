import assert from 'node:assert/strict'
import { assessManifestFreshness } from './catalogFreshness.mjs'

const now = new Date('2026-09-30T12:00:00.000Z')
const baseManifest = {
  completed_at: '2026-09-29T12:00:00.000Z',
  row_count: 109271,
  skipped_count: 9135,
  source_field: 'jsonl_download_uri',
  source_url_sha256: 'a'.repeat(64),
}

const fresh = assessManifestFreshness(baseManifest, now, 48 * 60 * 60 * 1000)
assert.equal(fresh.status, 'fresh')
assert.equal(fresh.age_ms, 24 * 60 * 60 * 1000)

const stale = assessManifestFreshness(
  { ...baseManifest, completed_at: '2026-09-28T11:00:00.000Z' },
  now,
  48 * 60 * 60 * 1000
)
assert.equal(stale.status, 'stale')

assert.equal(assessManifestFreshness(null, now).status, 'missing')
assert.equal(assessManifestFreshness({}, now).status, 'invalid')
assert.equal(
  assessManifestFreshness({ ...baseManifest, completed_at: '2026-10-01T00:00:00.000Z' }, now).status,
  'invalid'
)

for (const manifest of [
  { ...baseManifest, row_count: 0 },
  { ...baseManifest, row_count: -1 },
  { ...baseManifest, row_count: 1.5 },
  { ...baseManifest, row_count: '109271' },
  { ...baseManifest, skipped_count: -1 },
  { ...baseManifest, skipped_count: 1.5 },
  { ...baseManifest, source_field: '' },
  { ...baseManifest, source_url_sha256: 'not-a-sha256' },
]) {
  assert.equal(assessManifestFreshness(manifest, now).status, 'invalid')
}

console.log('CATALOG_FRESHNESS_PASS')
