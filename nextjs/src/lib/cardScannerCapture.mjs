import { extractScanEvidence } from './cardScanner.mjs'

// Fractions of the located portrait card, never fractions of its title alone.
export const SCANNER_OCR_REGIONS = {
  info: { role: 'info', x: 0.02, y: 0.86, w: 0.94, h: 0.13 },
  title: { role: 'title', x: 0.03, y: 0.02, w: 0.94, h: 0.16 },
  verticalTitle: { role: 'vertical-title', x: 0.74, y: 0.03, w: 0.23, h: 0.72 },
}

// Serialise jobs on the shared worker, including abandoned reads. A resumed
// camera must not change the OCR language while an older read is still running.
const workerReads = new WeakMap()
export async function readScannerFrame({ frame, worker, prepare, isCancelled = () => false }) {
  const previous = workerReads.get(worker) || Promise.resolve()
  const pending = previous.catch(() => {}).then(async () => {
    if (isCancelled()) return null
    await worker.reinitialize('eng')
    await worker.setParameters({ tessedit_pageseg_mode: '6' })
    const info = await worker.recognize(prepare(frame, SCANNER_OCR_REGIONS.info))
    if (isCancelled()) return null
    const infoText = info?.data?.text || ''
    const japanese = /\b(?:jp|ja|jpn)\b/i.test(infoText)
    let titleText = ''
    let languageUnavailable = false
    try {
      if (japanese) await worker.reinitialize('jpn_vert')
      await worker.setParameters({ tessedit_pageseg_mode: japanese ? '5' : '7' })
      if (isCancelled()) return null
      const title = await worker.recognize(prepare(frame, japanese
        ? SCANNER_OCR_REGIONS.verticalTitle : SCANNER_OCR_REGIONS.title))
      titleText = title?.data?.text || ''
    } catch (error) {
      if (!japanese) throw error
      // Optional Japanese assets may be unavailable. Keep the Roman printing
      // clues usable rather than inventing an English name from unreadable art.
      languageUnavailable = true
    } finally {
      if (japanese) await worker.reinitialize('eng')
    }
    if (isCancelled()) return null
    return {
      ...extractScanEvidence(infoText),
      nameQuery: japanese ? '' : extractScanEvidence(titleText).nameQuery,
      rawText: [titleText, infoText].join('\n'),
      titleText,
      infoText,
      titleLayout: japanese ? 'vertical-japanese' : 'horizontal',
      languageUnavailable,
    }
  })
  workerReads.set(worker, pending)
  return pending
}

// Bounded, axis-aligned card-boundary detection. This is not perspective
// correction: uncertain frames retain the portrait viewfinder crop.
export function locateScannerCard(image) {
  const { width, height, data } = image || {}
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 16 || height < 16 ||
      !data || data.length !== width * height * 4) return null
  const grey = (x, y) => {
    const i = (y * width + x) * 4
    return (data[i] + data[i + 1] + data[i + 2]) / 3
  }
  const columns = []
  const rows = []
  for (let x = 1; x < width; x++) {
    let score = 0
    for (let y = 0; y < height; y++) score += Math.abs(grey(x, y) - grey(x - 1, y))
    columns.push({ position: x, score: score / height })
  }
  for (let y = 1; y < height; y++) {
    let score = 0
    for (let x = 0; x < width; x++) score += Math.abs(grey(x, y) - grey(x, y - 1))
    rows.push({ position: y, score: score / width })
  }
  const peaks = edges => edges.filter(edge => edge.score >= 18)
    .sort((a, b) => b.score - a.score || a.position - b.position).slice(0, 12)
    .sort((a, b) => a.position - b.position)
  const xs = peaks(columns)
  const ys = peaks(rows)
  let best = null
  let bestScore = 0
  for (let l = 0; l < xs.length; l++) for (let r = l + 1; r < xs.length; r++) {
    for (let t = 0; t < ys.length; t++) for (let b = t + 1; b < ys.length; b++) {
      const rect = { x: xs[l].position, y: ys[t].position,
        w: xs[r].position - xs[l].position, h: ys[b].position - ys[t].position }
      const ratio = rect.w / rect.h
      if (ratio < 0.65 || ratio > 0.78 || rect.w * rect.h < width * height * 0.35) continue
      const score = Math.min(xs[l].score, xs[r].score, ys[t].score, ys[b].score)
      if (score > bestScore) { best = rect; bestScore = score }
    }
  }
  return best
}
