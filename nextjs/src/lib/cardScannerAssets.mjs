/**
 * Where the scanner's OCR engine assets come from.
 *
 * Two different privacy claims get conflated easily, so this module keeps them
 * apart. The captured frame is processed entirely in the browser and is never
 * uploaded — that is unconditionally true. Separately, tesseract.js needs three
 * runtime assets, and by default it fetches all three from the public jsdelivr
 * CDN on the first scan:
 *
 *   workerPath  tesseract.js@v5.1.1/dist/worker.min.js
 *   corePath    tesseract.js-core@v5.1.1/tesseract-core-*.wasm.js
 *   langPath    @tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz
 *
 * Self-hosting all three is NOT shipped, for reasons that are specific per
 * asset (see scripts/test-card-scanner-assets.mjs, which asserts each one
 * against the installed tree so this comment cannot drift):
 *
 *   - worker: `tesseract.js/dist/worker.min.js` does exist locally (~124 KB of
 *     minified JS), so this one is genuinely servable.
 *   - core: `tesseract.js-core` ships the wasm locally, but the browser loads
 *     it via importScripts of a wasm-in-JS bundle — 3.9–4.7 MB each, one per
 *     SIMD/LSTM variant, and the variant is chosen at runtime by feature
 *     detection. Serving it means committing multi-megabyte generated blobs.
 *   - lang: there is no local asset at all. `@tesseract.js-data` is not a
 *     dependency and no `.traineddata` exists anywhere in the tree, so the
 *     language model cannot be served from this repository as it stands.
 *
 * So instead of guessing at paths, this module is the explicit seam: an
 * operator who has actually placed the files behind their own origin points
 * the env vars at them and gets same-origin loads; with nothing configured we
 * forward nothing, tesseract.js keeps its CDN defaults, and the UI says so.
 */

export const SCANNER_ASSET_KEYS = ['workerPath', 'corePath', 'langPath']

// Absolute URLs and protocol-relative URLs leave our origin. Everything else
// ('/tesseract/...', a relative path) is resolved against window.location by
// tesseract.js itself, so it is served by us.
function isSameOrigin(value) {
  return !/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(value)
}

function cleanPath(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Turn a partial asset config into createWorker options plus an honest report
 * of what still gets fetched remotely.
 *
 * @param {{workerPath?: string, corePath?: string, langPath?: string}} [config]
 * @returns {{
 *   options: Record<string, string>,  // pass straight to createWorker
 *   local: string[],                  // asset keys served from our origin
 *   remote: string[],                 // asset keys fetched from another origin
 *   selfHosted: boolean,              // every asset is local
 * }}
 */
export function resolveScannerAssetSources(config = {}) {
  const options = {}
  const local = []
  const remote = []

  for (const key of SCANNER_ASSET_KEYS) {
    const path = cleanPath(config?.[key])
    if (path === null) {
      // Unset: omit the key so tesseract.js applies its own CDN default.
      remote.push(key)
      continue
    }
    options[key] = path
    ;(isSameOrigin(path) ? local : remote).push(key)
  }

  return { options, local, remote, selfHosted: remote.length === 0 }
}

/**
 * The scanner's privacy line. Always states that the image stays local, and
 * adds the engine-download caveat only while any asset is still remote.
 */
export function scannerPrivacyNotice(sources) {
  const base = 'Scanning stays on this device. No photo is uploaded.'
  if (sources?.selfHosted) return base
  return `${base} OCR engine files download from a public CDN on your first scan.`
}
