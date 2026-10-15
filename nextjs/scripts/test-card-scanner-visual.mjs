import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  createPerceptualSignature,
  perceptualSimilarity,
  rerankScannerResultsWithVisual,
} from '../src/lib/cardScannerVisual.mjs'
import { compareScannerCandidatesVisually } from '../src/lib/cardScannerVisualBrowser.mjs'
import { routeScannerMatch } from '../src/lib/cardScannerSession.mjs'

function rgba(width, height, luminanceAt) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4
      const value = luminanceAt(x, y)
      data[offset] = value
      data[offset + 1] = value
      data[offset + 2] = value
      data[offset + 3] = 255
    }
  }
  return { width, height, data }
}

// A horizontal difference hash is stable across a global brightness shift.
const darkGradient = rgba(18, 16, x => 20 + x * 4)
const lightGradient = rgba(18, 16, x => 80 + x * 4)
assert.equal(createPerceptualSignature(darkGradient), createPerceptualSignature(lightGradient))
assert.match(createPerceptualSignature(darkGradient), /^[0-9a-f]{16}$/)
// A blank/covered frame carries no useful visual structure and fails soft.
assert.equal(createPerceptualSignature(rgba(18, 16, () => 80)), null)

const rising = createPerceptualSignature(rgba(18, 16, x => 20 + x * 4))
const falling = createPerceptualSignature(rgba(18, 16, x => 220 - x * 4))
assert.equal(perceptualSimilarity(rising, rising), 1)
assert.equal(perceptualSimilarity(rising, falling), 0)
assert.equal(perceptualSimilarity(null, rising), null)
assert.equal(perceptualSimilarity('not-a-hash', rising), null)

const edition = (id, scanScore) => ({
  scryfall_id: id,
  set_code: id,
  collector_number: '1',
  scanScore,
  scanMatches: { name: 'exact', set: null, collector: null, rarity: null },
})
const visualGroups = [{
  name: 'Test Card',
  scanScore: 10000,
  editions: [edition('first', 10000), edition('second', 10000)],
}]

// Visual evidence only breaks an existing OCR-score tie; it never changes the
// OCR score that direct/uncertain routing uses.
{
  const reranked = rerankScannerResultsWithVisual(visualGroups, { first: 0.25, second: 0.875 })
  assert.deepEqual(reranked[0].editions.map(item => item.scryfall_id), ['second', 'first'])
  assert.deepEqual(reranked[0].editions.map(item => item.scanScore), [10000, 10000])
  assert.deepEqual(reranked[0].editions.map(item => item.visualSimilarity), [0.875, 0.25])
  const routed = routeScannerMatch(reranked.map(group => ({
    ...group,
    editions: group.editions.map(item => ({
      ...item,
      scanMatches: { ...item.scanMatches, set: true },
    })),
  })), { nameQuery: 'test card', setCode: 'tst' })
  assert.equal(routed.kind, 'uncertain')
  assert.equal(routed.reason, 'printing-tie')
}

// A visually closer candidate cannot jump ahead of stronger OCR evidence.
{
  const groups = [{
    name: 'Test Card',
    editions: [edition('strong', 10200), edition('weak', 10000)],
  }]
  const reranked = rerankScannerResultsWithVisual(groups, { strong: 0.1, weak: 1 })
  assert.deepEqual(reranked[0].editions.map(item => item.scryfall_id), ['strong', 'weak'])
}

// Missing/unloadable candidate images fail soft: do not reward the candidate
// that happened to load or disturb the existing OCR/catalog order.
{
  const reranked = rerankScannerResultsWithVisual(visualGroups, { second: 1 })
  assert.deepEqual(reranked[0].editions.map(item => item.scryfall_id), ['first', 'second'])
  assert.equal(reranked[0].editions[0].visualSimilarity, null)
  assert.equal(reranked[0].editions[1].visualSimilarity, 1)
}

// A partial three-way tie also preserves the whole OCR/catalog bucket; pairwise
// sorting around one missing image must not produce an unstable reorder.
{
  const groups = [{
    name: 'Test Card',
    editions: [edition('first', 10000), edition('third', 10000), edition('missing', 10000)],
  }]
  const reranked = rerankScannerResultsWithVisual(groups, { first: 0.1, third: 0.9 })
  assert.deepEqual(reranked[0].editions.map(item => item.scryfall_id), ['first', 'third', 'missing'])
}

assert.deepEqual(rerankScannerResultsWithVisual(null, {}), [])

const candidateGroup = (items) => [{
  name: 'Test Card',
  scanScore: items[0]?.scanScore ?? 0,
  editions: items,
}]

// Browser orchestration is dependency-injected here: synthetic signatures prove
// the path without canvas, image decoding, a network call, or captured pixels.
{
  const calls = []
  const result = await compareScannerCandidatesVisually(
    candidateGroup([
      { ...edition('first', 10000), image_uris: { small: 'first.jpg' } },
      { ...edition('second', 10000), image_uris: { small: 'second.jpg' } },
    ]),
    rising,
    {
      loadSignature: async url => {
        calls.push(url)
        return url === 'second.jpg' ? rising : falling
      },
    },
  )
  assert.equal(result.status, 'compared')
  assert.equal(result.compared, 2)
  assert.deepEqual(calls.sort(), ['first.jpg', 'second.jpg'])
  assert.deepEqual(result.groups[0].editions.map(item => item.scryfall_id), ['second', 'first'])
}

// Cross-origin, decode, timeout, and missing-image failures all collapse to the
// existing OCR order instead of rejecting the scan.
{
  const input = candidateGroup([
    { ...edition('first', 10000), image_uris: { small: 'blocked.jpg' } },
    { ...edition('second', 10000), image_uris: null },
  ])
  const result = await compareScannerCandidatesVisually(input, rising, {
    loadSignature: async () => { throw new Error('cross-origin') },
  })
  assert.equal(result.status, 'ocr-only')
  assert.equal(result.compared, 0)
  assert.deepEqual(result.groups, input)
}

// Two successful loads from different incomplete tie buckets still cannot break
// either tie, so the scanner must label the result OCR-only rather than imply
// that visual evidence affected ordering.
{
  const input = [
    { name: 'One', scanScore: 10000, editions: [
      { ...edition('one-a', 10000), image_uris: { small: 'one-a.jpg' } },
      { ...edition('one-b', 10000), image_uris: { small: 'one-b.jpg' } },
    ] },
    { name: 'Two', scanScore: 9000, editions: [
      { ...edition('two-a', 9000), image_uris: { small: 'two-a.jpg' } },
      { ...edition('two-b', 9000), image_uris: { small: 'two-b.jpg' } },
    ] },
  ]
  const result = await compareScannerCandidatesVisually(input, rising, {
    loadSignature: async url => url.endsWith('-a.jpg') ? rising : null,
  })
  assert.equal(result.compared, 2)
  assert.equal(result.status, 'ocr-only')
  assert.deepEqual(result.groups, input)
}

// No capture signature and no OCR-score tie both avoid image requests entirely.
{
  let calls = 0
  const loadSignature = async () => { calls += 1; return rising }
  const tied = candidateGroup([
    { ...edition('first', 10000), image_uris: { small: 'first.jpg' } },
    { ...edition('second', 10000), image_uris: { small: 'second.jpg' } },
  ])
  assert.equal((await compareScannerCandidatesVisually(tied, null, { loadSignature })).status, 'unavailable')
  const untied = candidateGroup([
    { ...edition('first', 10200), image_uris: { small: 'first.jpg' } },
    { ...edition('second', 10000), image_uris: { small: 'second.jpg' } },
  ])
  assert.equal((await compareScannerCandidatesVisually(untied, rising, { loadSignature })).status, 'not-needed')
  assert.equal(calls, 0)
}

// The UI keeps capture pixels local: it derives only a small signature from the
// in-memory frame, while catalog comparison downloads reference images and never
// adds visual data to the search URL or any request body.
{
  const panelSource = readFileSync(new URL('../src/components/CardScannerPanel.js', import.meta.url), 'utf8')
  assert.match(panelSource, /visualSignatureFromDrawable\(frame\)/)
  assert.match(panelSource, /visualSignature/)
  assert.doesNotMatch(panelSource, /fetch\(|FormData|toDataURL|toBlob/)

  const modalSource = readFileSync(new URL('../src/components/AddCardModal.js', import.meta.url), 'utf8')
  assert.match(modalSource, /compareScannerCandidatesVisually\(/)
  assert.match(modalSource, /setScannerVisualStatus/)
  const buildUrl = modalSource.match(/const buildSearchUrl = useCallback\([\s\S]*?\n  \}, \[\]\)/)?.[0]
  assert.ok(buildUrl, 'buildSearchUrl not found')
  assert.doesNotMatch(buildUrl, /visual|signature|image/)
}

console.log('CARD_SCANNER_VISUAL_PASS')
