import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  assessCatalogReleaseReadiness,
  migrationVersionsFromPaths,
} from './catalogReleaseReadiness.mjs'

const now = new Date('2026-09-30T12:00:00.000Z')
const localMigrationPaths = [
  '/repo/supabase/migrations/20260101000000_baseline.sql',
  '/repo/supabase/migrations/20260930000000_catalog_refresh_atomic.sql',
  '/repo/supabase/migrations/not-a-migration.sql',
]
const localVersions = ['20260101000000', '20260930000000']
assert.deepEqual(migrationVersionsFromPaths(localMigrationPaths), localVersions)

const manifest = {
  completed_at: '2026-09-30T10:00:00.000Z',
  source_field: 'jsonl_download_uri',
  source_url_sha256: 'a'.repeat(64),
  row_count: 109271,
  skipped_count: 9135,
}
const preflightService = '[Unit]\nOnFailure=dbb-catalog-preflight-alert.service\n[Service]\nExecStart=/usr/local/bin/node import-catalog.mjs --dry-run\n'
const alertService = '[Service]\nExecStart=/usr/bin/logger -t dbb-catalog-preflight failed\n'

const ready = assessCatalogReleaseReadiness({
  manifest,
  now,
  maxAgeMs: 48 * 60 * 60 * 1000,
  localMigrationPaths,
  evidence: {
    hosted_migration_versions: localVersions,
    atomic_publication: {
      verified: true,
      verified_at: '2026-09-30T11:00:00.000Z',
      command: 'npm run test:catalog-atomic-local',
      last_known_good_verified: true,
    },
    operator_alert: {
      delivery_verified: true,
      verified_at: '2026-09-30T11:30:00.000Z',
      channel: 'on-call-test-channel',
    },
  },
  preflightService,
  alertService,
})
assert.equal(ready.status, 'ready')
assert.deepEqual(ready.blockers, [])
assert.equal(ready.gates.freshness.status, 'ready')
assert.equal(ready.gates.atomic_publication.status, 'ready')
assert.equal(ready.gates.hosted_schema.status, 'ready')
assert.equal(ready.gates.operator_alert.status, 'ready')

const blocked = assessCatalogReleaseReadiness({
  manifest: { ...manifest, completed_at: '2026-09-20T10:00:00.000Z' },
  now,
  maxAgeMs: 48 * 60 * 60 * 1000,
  localMigrationPaths,
  evidence: {
    hosted_migration_versions: ['20260101000000', '20260803000001'],
    atomic_publication: {
      verified: true,
      verified_at: '2026-09-30T11:00:00.000Z',
      command: 'npm run test:catalog-atomic-local',
      last_known_good_verified: false,
    },
  },
  preflightService,
  alertService,
})
assert.equal(blocked.status, 'blocked')
assert(blocked.blockers.includes('catalog_manifest_stale'))
assert(blocked.blockers.includes('atomic_last_known_good_evidence_missing'))
assert(blocked.blockers.includes('hosted_schema_mismatch'))
assert(blocked.blockers.includes('operator_alert_delivery_evidence_missing'))
assert.deepEqual(blocked.gates.hosted_schema.missing_on_hosted, ['20260930000000'])
assert.deepEqual(blocked.gates.hosted_schema.unexpected_on_hosted, ['20260803000001'])
assert.equal(blocked.gates.operator_alert.wiring_ready, true)

const noEvidence = assessCatalogReleaseReadiness({
  manifest,
  now,
  localMigrationPaths,
  evidence: null,
  preflightService,
  alertService,
})
assert.equal(noEvidence.status, 'blocked')
assert(noEvidence.blockers.includes('hosted_schema_evidence_missing'))
assert(noEvidence.blockers.includes('atomic_publication_evidence_missing'))
assert(noEvidence.blockers.includes('operator_alert_delivery_evidence_missing'))

const repoRoot = path.resolve(new URL('../../', import.meta.url).pathname)
const actualMigrationPaths = readdirSync(path.join(repoRoot, 'supabase', 'migrations'))
  .map(name => path.join(repoRoot, 'supabase', 'migrations', name))
const actualMigrationVersions = migrationVersionsFromPaths(actualMigrationPaths)
const tempDir = mkdtempSync(path.join(os.tmpdir(), 'dbb-catalog-release-test-'))
const fixtureScripts = path.join(tempDir, 'nextjs', 'scripts')
const fixtureMigrations = path.join(tempDir, 'supabase', 'migrations')
const fixtureOps = path.join(tempDir, 'ops')
for (const dir of [fixtureScripts, fixtureMigrations, fixtureOps]) mkdirSync(dir, { recursive: true })
// The real CLI derives its repo root from its own file location. Give it an
// explicit fixture rather than depending on untracked operator service files.
for (const name of ['check-catalog-release-readiness.mjs', 'catalogReleaseReadiness.mjs', 'catalogFreshness.mjs', 'catalogRefresh.mjs']) {
  copyFileSync(path.join(repoRoot, 'nextjs', 'scripts', name), path.join(fixtureScripts, name))
}
for (const file of actualMigrationPaths) writeFileSync(path.join(fixtureMigrations, path.basename(file)), '')
writeFileSync(path.join(fixtureOps, 'dbb-catalog-preflight.service'), preflightService)
writeFileSync(path.join(fixtureOps, 'dbb-catalog-preflight-alert.service'), alertService)
try {
  const manifestPath = path.join(tempDir, 'manifest.json')
  const evidencePath = path.join(tempDir, 'evidence.json')
  writeFileSync(manifestPath, JSON.stringify(manifest))
  writeFileSync(evidencePath, JSON.stringify({
    hosted_migration_versions: actualMigrationVersions,
    atomic_publication: {
      verified: true,
      verified_at: '2026-09-30T11:00:00.000Z',
      command: 'npm run test:catalog-atomic-local',
      last_known_good_verified: true,
    },
    operator_alert: {
      delivery_verified: true,
      verified_at: '2026-09-30T11:30:00.000Z',
      channel: 'on-call-test-channel',
    },
  }))

  const cli = path.join(fixtureScripts, 'check-catalog-release-readiness.mjs')
  const admitted = spawnSync(process.execPath, [cli, '--manifest', manifestPath, '--evidence', evidencePath], {
    cwd: path.join(repoRoot, 'nextjs'),
    encoding: 'utf8',
    env: { ...process.env, CATALOG_RELEASE_NOW: now.toISOString() },
  })
  assert.equal(admitted.status, 0, admitted.stderr)
  assert.equal(JSON.parse(admitted.stdout).status, 'ready')

  unlinkSync(path.join(fixtureOps, 'dbb-catalog-preflight-alert.service'))
  const unwired = spawnSync(process.execPath, [cli, '--manifest', manifestPath, '--evidence', evidencePath], {
    cwd: path.join(repoRoot, 'nextjs'), encoding: 'utf8',
    env: { ...process.env, CATALOG_RELEASE_NOW: now.toISOString() },
  })
  assert.equal(unwired.status, 1, unwired.stderr)
  assert(JSON.parse(unwired.stdout).blockers.includes('operator_alert_wiring_missing'))

  const refused = spawnSync(process.execPath, [cli, '--manifest', `${manifestPath}.missing`, '--evidence', `${evidencePath}.missing`], {
    cwd: path.join(repoRoot, 'nextjs'),
    encoding: 'utf8',
    env: { ...process.env, CATALOG_RELEASE_NOW: now.toISOString() },
  })
  assert.equal(refused.status, 1, refused.stderr)
  const refusal = JSON.parse(refused.stdout)
  assert.equal(refusal.status, 'blocked')
  assert(refusal.blockers.includes('catalog_manifest_missing'))
  assert(refusal.blockers.includes('hosted_schema_evidence_missing'))
} finally {
  for (const dir of [fixtureScripts, fixtureMigrations, fixtureOps]) {
    for (const name of readdirSync(dir)) unlinkSync(path.join(dir, name))
    rmdirSync(dir)
  }
  for (const name of ['manifest.json', 'evidence.json']) unlinkSync(path.join(tempDir, name))
  rmdirSync(path.join(tempDir, 'nextjs'))
  rmdirSync(path.join(tempDir, 'supabase'))
  rmdirSync(tempDir)
}

console.log('CATALOG_RELEASE_READINESS_PASS')
