import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { summarizeUatRows, validateUatRows } from './cardScannerUat.mjs'

const rows = [
  {
    card_id: 'card-a', attempt: 1, device: 'iPhone 15', browser: 'Safari',
    name_group_top5: true, printing_evidence_usable: true, printing_top5: true,
    fallback_used: false, scan_ms: 1200,
  },
  {
    card_id: 'card-a', attempt: 2, device: 'iPhone 15', browser: 'Safari',
    name_group_top5: true, printing_evidence_usable: true, printing_top5: false,
    fallback_used: true, scan_ms: 2400,
  },
  {
    card_id: 'card-b', attempt: 1, device: 'Pixel 9', browser: 'Chrome',
    name_group_top5: false, printing_evidence_usable: false, printing_top5: null,
    fallback_used: true, scan_ms: 800,
  },
]

assert.deepEqual(validateUatRows(rows), { valid: true, errors: [] })

const summary = summarizeUatRows(rows)
assert.equal(summary.total_scans, 3)
assert.equal(summary.name_group_top5_count, 2)
assert.equal(summary.name_group_top5_rate, 2 / 3)
assert.equal(summary.evidence_bearing_scans, 2)
assert.equal(summary.printing_top5_count, 1)
assert.equal(summary.printing_top5_rate, 0.5)
assert.equal(summary.printing_metric_admissible, false)
assert.equal(summary.measurement_rows_valid, true)
assert.equal(summary.protocol_admissible, false)
assert.deepEqual(summary.measurement_errors, [])
assert.equal(summary.fallback_count, 2)
assert.equal(summary.median_scan_ms, 1200)
assert.equal(summary.p95_scan_ms, 2400)

const invalid = validateUatRows([
  {
    card_id: 'card-a', attempt: 1, device: 'iPhone 15', browser: 'Safari',
    name_group_top5: true, printing_evidence_usable: false, printing_top5: true,
    fallback_used: false, scan_ms: 1000,
  },
  {
    card_id: 'card-a', attempt: 1, device: '', browser: '',
    name_group_top5: 'maybe', printing_evidence_usable: true, printing_top5: null,
    fallback_used: 'maybe', scan_ms: 0,
  },
])
assert.equal(invalid.valid, false)
assert(invalid.errors.some(error => error.includes('printing_top5 must be blank')))
assert(invalid.errors.some(error => error.includes('duplicate card_id + attempt')))
assert(invalid.errors.some(error => error.includes('device is required')))
assert(invalid.errors.some(error => error.includes('browser is required')))
assert(invalid.errors.some(error => error.includes('name_group_top5 must be boolean')))
assert(invalid.errors.some(error => error.includes('printing_top5 must be boolean')))
assert(invalid.errors.some(error => error.includes('fallback_used must be boolean')))
assert(invalid.errors.some(error => error.includes('scan_ms must be greater than zero')))

assert.deepEqual(
  summarizeUatRows([]),
  {
    total_scans: 0,
    name_group_top5_count: 0,
    name_group_top5_rate: null,
    evidence_bearing_scans: 0,
    printing_top5_count: 0,
    printing_top5_rate: null,
    printing_metric_admissible: false,
    measurement_rows_valid: true,
    protocol_admissible: false,
    measurement_errors: [],
    fallback_count: 0,
    median_scan_ms: null,
    p95_scan_ms: null,
  }
)

const tempDir = mkdtempSync(path.join(os.tmpdir(), 'dbb-scanner-uat-test-'))
try {
  const cli = new URL('./summarize-card-scanner-uat.mjs', import.meta.url).pathname
  const admittedPath = path.join(tempDir, 'admitted.json')
  const admittedRows = Array.from({ length: 10 }, (_, index) => ({
    card_id: `physical-card-${index + 1}`,
    attempt: 1,
    device: 'iPhone 15',
    browser: 'Safari',
    name_group_top5: true,
    printing_evidence_usable: true,
    printing_top5: true,
    fallback_used: false,
    scan_ms: 1000 + index,
  }))
  writeFileSync(admittedPath, JSON.stringify(admittedRows))
  const admitted = spawnSync(process.execPath, [cli, admittedPath], { encoding: 'utf8' })
  assert.equal(admitted.status, 0, admitted.stderr)
  assert.equal(JSON.parse(admitted.stdout).protocol_admissible, true)

  const refusedPath = path.join(tempDir, 'refused.json')
  writeFileSync(refusedPath, JSON.stringify(rows))
  const refused = spawnSync(process.execPath, [cli, refusedPath], { encoding: 'utf8' })
  assert.equal(refused.status, 1, refused.stderr)
  assert.equal(JSON.parse(refused.stdout).protocol_admissible, false)
} finally {
  rmSync(tempDir, { recursive: true, force: true })
}

console.log('UAT_SUMMARY_PASS')
