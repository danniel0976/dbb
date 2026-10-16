import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { importSrc, renderMarkup } from './lib/renderMarkup.mjs'
const Panel = (await importSrc('components/CardScannerPanel.js')).default
for (const count of [0, 1, 20]) {
  const markup = renderMarkup(Panel, { onEvidence() {}, onManual() {}, shelf: Array.from({ length: count }, (_, i) => ({ shelfId: `generic-${i}`, cardName: `Generic card ${i}`, selected: true, quantity: 1, finishes: ['nonfoil'], finish: 'nonfoil' })) })
  assert.match(markup, /data-scanner-camera=/, 'camera must own a separate non-scrolling region')
  assert.match(markup, /data-scanner-tray=/, 'shelf and chooser must own a separate scrolling region')
  assert.ok(markup.indexOf('data-scanner-camera=') < markup.indexOf('data-scanner-tray='))
}
const modal = readFileSync(new URL('../src/components/AddCardModal.js', import.meta.url), 'utf8')
assert.match(modal, /createPortal\(modal, document.body\)/, 'scanner must escape transformed drawer ancestors')
const { attachScannerViewport } = await import('../src/lib/scannerViewport.mjs')
const events = new Map()
const vv = { height: 530, width: 390, offsetTop: 12, offsetLeft: 0, addEventListener: (k, f) => events.set(`v-${k}`, f), removeEventListener: (k) => events.delete(`v-${k}`) }
const props = new Map()
const element = { style: { getPropertyValue: k => props.get(k) || '', setProperty: (k, v) => props.set(k, v), removeProperty: k => props.delete(k) } }
const win = { visualViewport: vv, innerHeight: 700, innerWidth: 390, addEventListener: (k, f) => events.set(k, f), removeEventListener: k => events.delete(k) }
const cleanup = attachScannerViewport(element, win)
assert.equal(props.get('--scanner-height'), '530px')
assert.equal(props.get('--scanner-top'), '12px')
vv.height = 320; events.get('v-resize')()
assert.equal(props.get('--scanner-height'), '320px')
cleanup(); assert.equal(events.size, 0); assert.equal(props.size, 0)
console.log('SCANNER_FIXED_VIEW_PASS: 0/1/20 rows, portal ownership, viewport resize and cleanup')
const { revealScannerNotice } = await import('../src/lib/scannerViewport.mjs')
let focused = false
const tray = { scrollTop: 999 }
const button = { focus: () => { focused = true } }
revealScannerNotice({ querySelector: selector => selector === '[data-scanner-tray]' ? tray : { querySelector: () => button } })
assert.equal(tray.scrollTop, 0, 'close/discard or retry warning must be visible even after shelf scrolling')
assert.equal(focused, true, 'warning action receives focus without moving camera')
