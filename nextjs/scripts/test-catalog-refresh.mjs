import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  assertCatalogCompleteness,
  buildRefreshManifest,
  normalizeCmc,
  runWithFailureCleanup,
  selectBulkDownload,
  sourceUrlHash,
} from './catalogRefresh.mjs'

assert.deepEqual(
  selectBulkDownload({ jsonl_download_uri: 'https://example.test/cards.jsonl.gz', download_uri: 'https://example.test/cards.json' }),
  { url: 'https://example.test/cards.jsonl.gz', sourceField: 'jsonl_download_uri' }
)

assert.deepEqual(
  selectBulkDownload({ download_uri: 'https://example.test/cards.json' }),
  { url: 'https://example.test/cards.json', sourceField: 'download_uri' }
)

assert.throws(() => selectBulkDownload({ jsonl_download_uri: 'http://example.test/cards.jsonl.gz' }), /HTTPS bulk-data URL/)
assert.throws(() => selectBulkDownload({}), /missing jsonl_download_uri and download_uri/)

const manifest = buildRefreshManifest({
  sourceField: 'jsonl_download_uri',
  sourceUrl: 'https://example.test/cards.jsonl.gz',
  total: 123,
  skipped: 4,
  completedAt: '2026-09-29T09:00:00.000Z',
})
assert.equal(manifest.source_field, 'jsonl_download_uri')
assert.equal(manifest.row_count, 123)
assert.equal(manifest.skipped_count, 4)
assert.equal(manifest.completed_at, '2026-09-29T09:00:00.000Z')
assert.equal(manifest.source_url_sha256, sourceUrlHash('https://example.test/cards.jsonl.gz'))
assert.match(manifest.source_url_sha256, /^[a-f0-9]{64}$/)

assert.equal(normalizeCmc(7.5), 7.5)
assert.equal(normalizeCmc('7.50'), 7.5)
assert.equal(normalizeCmc(10000), null)
assert.equal(normalizeCmc(-1), null)
assert.equal(normalizeCmc('not-a-number'), null)

assert.doesNotThrow(() => assertCatalogCompleteness({ rowCount: 109271, skippedCount: 9135 }))
assert.throws(
  () => assertCatalogCompleteness({ rowCount: 99999, skippedCount: 0 }),
  /at least 100,000 accepted rows/
)
assert.throws(
  () => assertCatalogCompleteness({ rowCount: 109271, skippedCount: 20000 }),
  /at least 85% of parsed rows/
)

const originalFailure = new Error('publish failed')
const cleanupFailure = new Error('cleanup failed')
let cleanupAttempted = false
let reportedCleanupFailure = null
await assert.rejects(
  runWithFailureCleanup(
    async () => { throw originalFailure },
    async () => { cleanupAttempted = true; throw cleanupFailure },
    error => { reportedCleanupFailure = error }
  ),
  error => error === originalFailure
)
assert.equal(cleanupAttempted, true)
assert.equal(reportedCleanupFailure, cleanupFailure)

const importerSource = readFileSync(new URL('./import-catalog.mjs', import.meta.url), 'utf8')
const admissionIndex = importerSource.indexOf('assertCatalogCompleteness({')
const publishIndex = importerSource.indexOf('await publishRefresh(')
assert(admissionIndex >= 0, 'importer must apply catalog completeness admission')
assert(publishIndex > admissionIndex, 'importer must admit completeness before publishing')
assert.match(importerSource, /method:\s*'DELETE'/)
assert.match(importerSource, /runWithFailureCleanup\(/)

console.log('CATALOG_REFRESH_PASS')
