// Pure, deterministic visual helpers for browser-local scanner matching.
// No camera, canvas, DOM, worker, or network dependency belongs in this module.

const HASH_COLUMNS = 9
const HASH_ROWS = 8
const HASH_BITS = (HASH_COLUMNS - 1) * HASH_ROWS

function validPixels(source) {
  if (!source || typeof source !== 'object') return false
  const width = Number(source.width)
  const height = Number(source.height)
  const data = source.data
  return (
    Number.isInteger(width) && width > 0 &&
    Number.isInteger(height) && height > 0 &&
    data != null && typeof data.length === 'number' &&
    data.length >= width * height * 4
  )
}

function luminance(data, offset) {
  const alpha = data[offset + 3] / 255
  const red = data[offset] * alpha + 255 * (1 - alpha)
  const green = data[offset + 1] * alpha + 255 * (1 - alpha)
  const blue = data[offset + 2] * alpha + 255 * (1 - alpha)
  return 0.299 * red + 0.587 * green + 0.114 * blue
}

function averageCell(source, column, row) {
  const startX = Math.floor(column * source.width / HASH_COLUMNS)
  const endX = Math.max(startX + 1, Math.floor((column + 1) * source.width / HASH_COLUMNS))
  const startY = Math.floor(row * source.height / HASH_ROWS)
  const endY = Math.max(startY + 1, Math.floor((row + 1) * source.height / HASH_ROWS))
  let total = 0
  let count = 0
  for (let y = startY; y < Math.min(endY, source.height); y++) {
    for (let x = startX; x < Math.min(endX, source.width); x++) {
      total += luminance(source.data, (y * source.width + x) * 4)
      count += 1
    }
  }
  return count > 0 ? total / count : 0
}

/**
 * Build a 64-bit horizontal difference hash from RGBA pixels.
 * Returns null for malformed or empty input so callers can fall back to OCR.
 */
export function createPerceptualSignature(source) {
  if (!validPixels(source)) return null
  const grid = []
  for (let row = 0; row < HASH_ROWS; row++) {
    const values = []
    for (let column = 0; column < HASH_COLUMNS; column++) {
      values.push(averageCell(source, column, row))
    }
    grid.push(values)
  }
  const flat = grid.flat()
  if (Math.max(...flat) - Math.min(...flat) < 8) return null

  let bits = 0n
  for (const row of grid) {
    for (let column = 1; column < HASH_COLUMNS; column++) {
      bits = (bits << 1n) | (row[column] > row[column - 1] ? 1n : 0n)
    }
  }
  return bits.toString(16).padStart(HASH_BITS / 4, '0')
}

const SIGNATURE_RE = /^[0-9a-f]{16}$/

/** Similarity in [0, 1], or null when either signature is unusable. */
export function perceptualSimilarity(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return null
  const a = left.trim().toLowerCase()
  const b = right.trim().toLowerCase()
  if (!SIGNATURE_RE.test(a) || !SIGNATURE_RE.test(b)) return null
  let differing = BigInt(`0x${a}`) ^ BigInt(`0x${b}`)
  let distance = 0
  while (differing > 0n) {
    differing &= differing - 1n
    distance += 1
  }
  return 1 - distance / HASH_BITS
}

function visualScore(similarities, id) {
  const value = similarities instanceof Map ? similarities.get(id) : similarities?.[id]
  const score = Number(value)
  return Number.isFinite(score) && score >= 0 && score <= 1 ? score : null
}

function rerankCompleteVisualTies(entries) {
  const buckets = new Map()
  for (const entry of entries) {
    const score = Number(entry.item.scanScore)
    const key = Number.isFinite(score) ? `score:${score}` : `index:${entry.index}`
    const bucket = buckets.get(key) || []
    bucket.push(entry)
    buckets.set(key, bucket)
  }

  for (const [key, bucket] of buckets) {
    if (bucket.length > 1 && bucket.every(entry => entry.item.visualSimilarity !== null)) {
      buckets.set(key, [...bucket].sort((left, right) => (
        right.item.visualSimilarity - left.item.visualSimilarity || left.index - right.index
      )))
    }
  }

  const offsets = new Map()
  return entries.map(entry => {
    const score = Number(entry.item.scanScore)
    const key = Number.isFinite(score) ? `score:${score}` : `index:${entry.index}`
    const offset = offsets.get(key) || 0
    offsets.set(key, offset + 1)
    return buckets.get(key)[offset]
  })
}

/**
 * Reorder only candidates whose OCR scores are already tied. If any member of
 * a tie lacks visual evidence, retain that whole OCR/catalog bucket unchanged.
 * The OCR score is never changed, preserving direct/uncertain safety semantics.
 */
export function rerankScannerResultsWithVisual(groups, similarities) {
  if (!Array.isArray(groups)) return []
  const rankedGroups = groups.map((group, groupIndex) => {
    const editions = rerankCompleteVisualTies(
      (Array.isArray(group?.editions) ? group.editions : []).map((edition, index) => ({
        index,
        item: {
          ...edition,
          visualSimilarity: visualScore(similarities, edition?.scryfall_id),
        },
      })),
    ).map(entry => entry.item)
    const top = editions[0]
    return {
      index: groupIndex,
      item: {
        ...group,
        editions,
        visualSimilarity: top?.visualSimilarity ?? null,
      },
    }
  })
  return rerankCompleteVisualTies(rankedGroups).map(entry => entry.item)
}
