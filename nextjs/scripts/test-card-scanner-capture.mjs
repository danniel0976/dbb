import assert from 'node:assert/strict'

// No camera/model downloads: synthetic card pixels test geometry only.
const capture = await import('../src/lib/cardScannerCapture.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {}
  throw error
})
assert.equal(typeof capture.locateScannerCard, 'function', 'scanner must locate a card-shaped boundary before choosing OCR regions')

const width = 240
const height = 336
function cardPixels(rect) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const inside = rect && x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h
    const value = inside ? 210 : 25
    const i = (y * width + x) * 4
    data[i] = data[i + 1] = data[i + 2] = value
    data[i + 3] = 255
  }
  return { width, height, data }
}
function framedCardPixels(outer, inner) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const inOuter = x >= outer.x && x < outer.x + outer.w && y >= outer.y && y < outer.y + outer.h
    const inInner = x >= inner.x && x < inner.x + inner.w && y >= inner.y && y < inner.y + inner.h
    const value = !inOuter ? 25 : inInner ? 230 : 125
    const i = (y * width + x) * 4
    data[i] = data[i + 1] = data[i + 2] = value
    data[i + 3] = 255
  }
  return { width, height, data }
}
const found = capture.locateScannerCard(cardPixels({ x: 34, y: 35, w: 172, h: 240 }))
assert.ok(found, 'offset portrait card must be found, not treated as the entire viewfinder')
for (const [key, value] of Object.entries({ x: 34, y: 35, w: 172, h: 240 })) {
  assert.ok(Math.abs(found[key] - value) <= 2, `${key}: ${found[key]} vs ${value}`)
}
const framed = capture.locateScannerCard(framedCardPixels(
  { x: 30, y: 30, w: 180, h: 250 },
  { x: 38, y: 38, w: 164, h: 234 },
))
assert.ok(framed, 'strong inner artwork edges must not hide the full card boundary')
for (const [key, value] of Object.entries({ x: 30, y: 30, w: 180, h: 250 })) {
  assert.ok(Math.abs(framed[key] - value) <= 3, `full card ${key}: ${framed[key]} vs ${value}`)
}
assert.equal(capture.locateScannerCard(cardPixels(null)), null, 'a uniform blank frame has no card boundary')
assert.equal(capture.locateScannerCard(cardPixels({ x: 20, y: 130, w: 200, h: 65 })), null, 'landscape strip is not a portrait card')
assert.equal(capture.locateScannerCard(null), null)
// Exercise OCR orchestration at its browser/worker seam. Engine text is scripted;
// this does not establish Japanese model accuracy on Dan's physical card.
assert.equal(typeof capture.readScannerFrame, 'function', 'OCR must choose region and language from card layout/metadata')
{
  const calls = []
  const worker = {
    async reinitialize(language) { calls.push(['language', language]) },
    async setParameters(parameters) { calls.push(['parameters', parameters]) },
    async recognize(region) {
      calls.push(['read', region.role])
      return { data: { text: region.role === 'info' ? '117 R\nSTA • JP' : '自然の秩序' } }
    },
  }
  const ev = await capture.readScannerFrame({ frame: {}, worker, prepare: (_, region) => region })
  assert.equal(ev.nameQuery, '', 'Japanese title is not translated or replaced by an artist/set line')
  assert.equal(ev.setCode, 'sta')
  assert.equal(ev.collectorNumber, '117')
  assert.match(ev.rawText, /自然の秩序/)
  assert.deepEqual(calls.filter(call => call[0] === 'read').map(call => call[1]), ['info', 'vertical-title'])
  assert.ok(calls.some(call => call[0] === 'language' && call[1] === 'jpn_vert'))
  assert.ok(calls.some(call => call[0] === 'parameters' && call[1].tessedit_pageseg_mode === '5'))
  assert.deepEqual(calls.at(-1), ['language', 'eng'], 'subsequent English scan must not inherit Japanese mode')
}
{
  const ev = await capture.readScannerFrame({
    frame: {}, prepare: (_, region) => region,
    worker: {
      async reinitialize() {}, async setParameters() {},
      async recognize(region) { return { data: { text: region.role === 'info' ? 'MOM EN\nArtist Smith' : '' } } },
    },
  })
  assert.equal(ev.nameQuery, '', 'information-strip artist/set text must never become a card name')
}
// Missing optional Japanese assets must retain printing-only confirmation.
{
  let restored = false
  const ev = await capture.readScannerFrame({
    frame: {}, prepare: (_, region) => region,
    worker: {
      async reinitialize(language) { if (language === 'jpn_vert') throw new Error('offline language asset'); restored = true },
      async setParameters() {},
      async recognize() { return { data: { text: '117 R\nSTA JP' } } },
    },
  })
  assert.equal(ev.languageUnavailable, true)
  assert.equal(ev.nameQuery, '')
  assert.equal(ev.setCode, 'sta')
  assert.equal(ev.collectorNumber, '117')
  assert.equal(restored, true)
}
// Check cancellation before a queued OCR job touches the shared worker.
{
  const ev = await capture.readScannerFrame({ frame: {}, worker: {}, prepare() { throw new Error('cancelled read touched pixels') }, isCancelled: () => true })
  assert.equal(ev, null)
}
console.log('CARD_SCANNER_CAPTURE_PASS')
