import { readFileSync } from 'node:fs'
import { assessManifestFreshness } from './catalogFreshness.mjs'

const manifestPath = process.argv[2]
const maxAgeHours = Number(process.env.CATALOG_MAX_AGE_HOURS || 48)
if (!manifestPath) {
  console.error('Usage: node scripts/check-catalog-freshness.mjs <manifest.json>')
  process.exit(2)
}
if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) {
  console.error('CATALOG_MAX_AGE_HOURS must be a positive number')
  process.exit(2)
}

try {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const result = assessManifestFreshness(manifest, new Date(), maxAgeHours * 60 * 60 * 1000)
  console.log(JSON.stringify({ manifest_path: manifestPath, ...result }, null, 2))
  process.exitCode = result.status === 'fresh' ? 0 : 1
} catch (error) {
  console.error(`Catalog freshness check failed: ${error.message}`)
  process.exit(1)
}
