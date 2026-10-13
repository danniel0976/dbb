import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assessCatalogReleaseReadiness } from './catalogReleaseReadiness.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..', '..')

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}

function readJsonOrNull(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function readTextOrEmpty(filePath) {
  try {
    return readFileSync(filePath, 'utf8')
  } catch {
    return ''
  }
}

try {
  const manifestPath = path.resolve(argValue('--manifest', path.join(repoRoot, 'nextjs', '.catalog-refresh-manifest.json')))
  const evidencePath = path.resolve(argValue('--evidence', path.join(repoRoot, 'nextjs', '.catalog-release-evidence.json')))
  const migrationDir = path.join(repoRoot, 'supabase', 'migrations')
  const localMigrationPaths = readdirSync(migrationDir)
    .filter(name => name.endsWith('.sql'))
    .map(name => path.join(migrationDir, name))
  const now = process.env.CATALOG_RELEASE_NOW ? new Date(process.env.CATALOG_RELEASE_NOW) : new Date()
  const maxAgeHours = Number(process.env.CATALOG_MAX_AGE_HOURS || 48)
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) throw new Error('CATALOG_MAX_AGE_HOURS must be a positive number')

  const result = assessCatalogReleaseReadiness({
    manifest: readJsonOrNull(manifestPath),
    now,
    maxAgeMs: maxAgeHours * 60 * 60 * 1000,
    localMigrationPaths,
    evidence: readJsonOrNull(evidencePath),
    preflightService: readTextOrEmpty(path.join(repoRoot, 'ops', 'dbb-catalog-preflight.service')),
    alertService: readTextOrEmpty(path.join(repoRoot, 'ops', 'dbb-catalog-preflight-alert.service')),
  })

  console.log(JSON.stringify({
    manifest_path: manifestPath,
    evidence_path: evidencePath,
    ...result,
  }, null, 2))
  process.exitCode = result.status === 'ready' ? 0 : 1
} catch (error) {
  console.error(`Catalog release readiness check failed: ${error.message}`)
  process.exit(2)
}
