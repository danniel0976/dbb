import {
  createPerceptualSignature,
  perceptualSimilarity,
  rerankScannerResultsWithVisual,
} from './cardScannerVisual.mjs'

const MAX_VISUAL_CANDIDATES = 12
const SAMPLE_WIDTH = 72
const SAMPLE_HEIGHT = 101
const IMAGE_TIMEOUT_MS = 3500
const IMAGE_FACES = ['small', 'normal', 'large', 'png']

function imageSource(edition) {
  const faces = [edition?.image_uris, ...(Array.isArray(edition?.card_faces)
    ? edition.card_faces.map(face => face?.image_uris)
    : [])]
  for (const uris of faces) {
    if (!uris || typeof uris !== 'object') continue
    for (const face of IMAGE_FACES) {
      const value = uris[face]
      if (typeof value === 'string' && value.trim() !== '') return value
    }
  }
  return null
}

/** Read a canvas/image into a small local pixel buffer and hash it. */
export function visualSignatureFromDrawable(drawable) {
  if (!drawable || typeof document === 'undefined') return null
  try {
    const canvas = document.createElement('canvas')
    canvas.width = SAMPLE_WIDTH
    canvas.height = SAMPLE_HEIGHT
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return null
    context.drawImage(drawable, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT)
    return createPerceptualSignature(context.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT))
  } catch {
    return null
  }
}

/** Load one remote catalog image for local comparison. Every failure is soft. */
export function loadCatalogImageSignature(url, timeoutMs = IMAGE_TIMEOUT_MS) {
  if (typeof url !== 'string' || !url.trim() || typeof Image === 'undefined') {
    return Promise.resolve(null)
  }
  return new Promise(resolve => {
    const image = new Image()
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      image.onload = null
      image.onerror = null
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    image.crossOrigin = 'anonymous'
    image.referrerPolicy = 'no-referrer'
    image.onload = () => finish(visualSignatureFromDrawable(image))
    image.onerror = () => finish(null)
    image.src = url
  })
}

function tiedCandidateBuckets(groups) {
  const byScore = new Map()
  for (const group of Array.isArray(groups) ? groups : []) {
    for (const edition of Array.isArray(group?.editions) ? group.editions : []) {
      const score = Number(edition?.scanScore)
      if (!edition?.scryfall_id || !Number.isFinite(score)) continue
      const bucket = byScore.get(score) || []
      bucket.push(edition)
      byScore.set(score, bucket)
    }
  }
  return [...byScore.values()].filter(bucket => bucket.length > 1)
}

/**
 * Download only reference images for OCR-tied candidates, hash them locally,
 * then apply the pure tie-breaker. Captured pixels/signatures are never sent.
 */
export async function compareScannerCandidatesVisually(groups, capturedSignature, options = {}) {
  if (perceptualSimilarity(capturedSignature, capturedSignature) === null) {
    return { groups, status: 'unavailable', compared: 0, attempted: 0 }
  }

  const allBuckets = tiedCandidateBuckets(groups)
  if (allBuckets.length === 0) {
    return { groups, status: 'not-needed', compared: 0, attempted: 0 }
  }

  const buckets = []
  let selectedCount = 0
  for (const bucket of allBuckets) {
    if (selectedCount + bucket.length > MAX_VISUAL_CANDIDATES) continue
    buckets.push(bucket)
    selectedCount += bucket.length
  }
  if (buckets.length === 0) {
    return { groups, status: 'ocr-only', compared: 0, attempted: 0 }
  }

  const candidates = buckets.flat()
  const loadSignature = options.loadSignature || loadCatalogImageSignature
  const attempts = candidates
    .map(edition => ({ edition, url: imageSource(edition) }))
    .filter(item => item.url)
  if (attempts.length < 2) {
    return { groups, status: 'ocr-only', compared: 0, attempted: attempts.length }
  }

  const loaded = await Promise.all(attempts.map(async item => {
    try {
      return { ...item, signature: await loadSignature(item.url) }
    } catch {
      return { ...item, signature: null }
    }
  }))

  const similarities = {}
  let compared = 0
  for (const item of loaded) {
    const similarity = perceptualSimilarity(capturedSignature, item.signature)
    if (similarity === null) continue
    similarities[item.edition.scryfall_id] = similarity
    compared += 1
  }

  // A bucket must be complete before visual evidence may affect its order. This
  // keeps one blocked/missing candidate image from being silently demoted.
  const hasCompleteTie = buckets.some(bucket => bucket.every(edition => (
    Object.hasOwn(similarities, edition.scryfall_id)
  )))
  if (!hasCompleteTie) {
    return { groups, status: 'ocr-only', compared, attempted: attempts.length }
  }

  return {
    groups: rerankScannerResultsWithVisual(groups, similarities),
    status: 'compared',
    compared,
    attempted: attempts.length,
  }
}
