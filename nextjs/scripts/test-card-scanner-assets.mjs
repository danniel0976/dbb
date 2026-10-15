import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  SCANNER_ASSET_KEYS,
  resolveScannerAssetSources,
  scannerPrivacyNotice,
} from '../src/lib/cardScannerAssets.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')

// --- Pure resolver -----------------------------------------------------------

assert.deepEqual(SCANNER_ASSET_KEYS, ['workerPath', 'corePath', 'langPath'])

// No config at all: pass nothing to createWorker, so tesseract.js keeps its own
// CDN defaults. Every asset is therefore a remote fetch, and we say so.
{
  const sources = resolveScannerAssetSources()
  assert.deepEqual(sources.options, {})
  assert.deepEqual(sources.remote, ['workerPath', 'corePath', 'langPath'])
  assert.deepEqual(sources.local, [])
  assert.equal(sources.selfHosted, false)
}

// Blank / non-string config values are treated as unset, not forwarded as ''.
for (const blank of ['', '   ', null, undefined, 5, {}]) {
  const sources = resolveScannerAssetSources({ workerPath: blank })
  assert.deepEqual(sources.options, {}, `blank ${JSON.stringify(blank)} must not configure a path`)
}

// A repository-local (same-origin) path counts as local and is forwarded verbatim.
{
  const sources = resolveScannerAssetSources({ workerPath: '/tesseract/worker.min.js' })
  assert.deepEqual(sources.options, { workerPath: '/tesseract/worker.min.js' })
  assert.deepEqual(sources.local, ['workerPath'])
  assert.deepEqual(sources.remote, ['corePath', 'langPath'])
  assert.equal(sources.selfHosted, false)
}

// Values are trimmed so a stray newline in an env file cannot break the URL.
assert.deepEqual(
  resolveScannerAssetSources({ corePath: '  /tesseract/core  ' }).options,
  { corePath: '/tesseract/core' }
)

// Pointing an asset at somebody else's origin is still a remote fetch. Honest
// classification matters more than the fact that it was explicitly configured.
{
  const sources = resolveScannerAssetSources({
    workerPath: 'https://cdn.example.com/worker.min.js',
    corePath: '//cdn.example.com/core',
  })
  assert.deepEqual(sources.remote, ['workerPath', 'corePath', 'langPath'])
  assert.deepEqual(sources.local, [])
}

// Only all three being same-origin earns the self-hosted claim.
{
  const sources = resolveScannerAssetSources({
    workerPath: '/tesseract/worker.min.js',
    corePath: '/tesseract/core',
    langPath: '/tesseract/lang',
  })
  assert.deepEqual(sources.local, ['workerPath', 'corePath', 'langPath'])
  assert.deepEqual(sources.remote, [])
  assert.equal(sources.selfHosted, true)
}

// --- UI disclosure -----------------------------------------------------------

// The captured frame never leaves the browser in either case. The notice must
// not let that fact imply the OCR engine is local too.
{
  const notice = scannerPrivacyNotice(resolveScannerAssetSources())
  assert.match(notice, /stays on this device/)
  assert.match(notice, /No photo is uploaded/)
  assert.match(notice, /engine files/i)
  assert.match(notice, /first scan/i)
}
{
  const notice = scannerPrivacyNotice(resolveScannerAssetSources({
    workerPath: '/tesseract/worker.min.js',
    corePath: '/tesseract/core',
    langPath: '/tesseract/lang',
  }))
  assert.match(notice, /stays on this device/)
  assert.match(notice, /No photo is uploaded/)
  assert.doesNotMatch(notice, /first scan/i)
}

// --- Installed-package facts -------------------------------------------------
// These lock in *why* full self-hosting is not shipped. If a future dependency
// change makes a local asset available, the matching assertion fails and this
// slice gets revisited instead of silently staying on the CDN.

const workerDist = resolve(repo, 'node_modules/tesseract.js/dist/worker.min.js')
assert.ok(existsSync(workerDist), 'tesseract.js ships dist/worker.min.js locally')

const coreDir = resolve(repo, 'node_modules/tesseract.js-core')
assert.ok(existsSync(coreDir), 'tesseract.js-core is installed')
const coreWasm = readdirSync(coreDir).filter(name => name.endsWith('.wasm.js'))
assert.ok(coreWasm.length >= 4, 'core ships one wasm-in-JS bundle per SIMD/LSTM variant')

// No .traineddata anywhere in the dependency tree: the language model has no
// local asset to serve, so langPath cannot be self-hosted from current deps.
assert.equal(
  existsSync(resolve(repo, 'node_modules/@tesseract.js-data')),
  false,
  '@tesseract.js-data is not a dependency; adding one is a separate decision'
)

// --- Panel wiring ------------------------------------------------------------

const panel = readFileSync(resolve(repo, 'src/components/CardScannerPanel.js'), 'utf8')
assert.match(panel, /resolveScannerAssetSources/, 'panel resolves asset sources')
assert.match(panel, /scannerPrivacyNotice/, 'panel renders the resolved disclosure')
assert.match(
  panel,
  /NEXT_PUBLIC_TESSERACT_WORKER_PATH/,
  'panel reads the worker path from an explicit env var'
)
assert.doesNotMatch(
  panel,
  /Scanning stays on this device\. No photo is uploaded\.<\/span>/,
  'the hardcoded notice is replaced by the resolved one'
)

console.log('card scanner asset tests passed')
