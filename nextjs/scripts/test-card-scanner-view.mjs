// Scanner surface integrity: what the temporary shelf actually shows, and how
// the inline printing chooser describes itself.
//
// These assertions run against real rendered markup (react-dom/server via
// scripts/lib/renderMarkup.mjs), not against component source text, so a field
// that is computed but never rendered fails here.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { importSrc, renderMarkup, visibleText } from './lib/renderMarkup.mjs'
import {
  PRINTING_SELECTION_NOTE,
  heldScansLabel,
  printingSelectionCopy,
  rarityToneClass,
  scannerSelectionReason,
  scannerVisualStatusCopy,
  shelfRarityLabel,
  shelfThumbnailSource,
} from '../src/lib/cardScannerView.mjs'

const shelfRow = (overrides = {}) => ({
  shelfId: 'id-mh2-123:nonfoil',
  source: 'scanner-direct',
  scryfallId: 'id-mh2-123',
  cardName: 'Lightning Bolt',
  setName: 'Modern Horizons 2',
  setCode: 'mh2',
  collectorNumber: '123',
  rarity: 'uncommon',
  imageUris: { small: 'https://example.invalid/bolt-small.jpg' },
  finishes: ['nonfoil', 'foil'],
  finish: 'nonfoil',
  quantity: 2,
  selected: true,
  ...overrides,
})

// ─── Thumbnail source ─────────────────────────────────────────────────────
// The shelf keeps whatever image_uris the catalog row carried; the smallest
// usable face wins, because a shelf row is a ~56px thumbnail.
assert.equal(
  shelfThumbnailSource(shelfRow()),
  'https://example.invalid/bolt-small.jpg',
)
assert.equal(shelfThumbnailSource(shelfRow({ imageUris: { normal: 'n.jpg' } })), 'n.jpg')
assert.equal(shelfThumbnailSource(shelfRow({ imageUris: { large: 'l.jpg', png: 'p.png' } })), 'l.jpg')
assert.equal(shelfThumbnailSource(shelfRow({ imageUris: { png: 'p.png' } })), 'p.png')
// A missing or blank image is an expected catalog state, never a broken <img>.
assert.equal(shelfThumbnailSource(shelfRow({ imageUris: null })), null)
assert.equal(shelfThumbnailSource(shelfRow({ imageUris: {} })), null)
assert.equal(shelfThumbnailSource(shelfRow({ imageUris: { small: '   ' } })), null)
assert.equal(shelfThumbnailSource(null), null)

// ─── Rarity ───────────────────────────────────────────────────────────────
assert.equal(shelfRarityLabel(shelfRow()), 'Uncommon')
assert.equal(shelfRarityLabel(shelfRow({ rarity: 'mythic' })), 'Mythic')
assert.equal(shelfRarityLabel(shelfRow({ rarity: '' })), null)
assert.equal(shelfRarityLabel(shelfRow({ rarity: null })), null)
assert.equal(shelfRarityLabel(null), null)
assert.equal(rarityToneClass('mythic'), 'text-rarity-mythic')
assert.equal(rarityToneClass('rare'), 'text-rarity-rare')
assert.equal(rarityToneClass('uncommon'), 'text-rarity-uncommon')
assert.equal(rarityToneClass('common'), 'text-gray-400')
assert.equal(rarityToneClass('bonus'), 'text-gray-400')
assert.equal(rarityToneClass(null), 'text-gray-400')

// ─── Visual evidence status ────────────────────────────────────────────────
assert.equal(scannerVisualStatusCopy(null), null)
assert.equal(scannerVisualStatusCopy({ status: 'checking' }), 'Checking visual tie-breaker locally…')
assert.equal(
  scannerVisualStatusCopy({ status: 'compared', compared: 2 }),
  'Visual tie-breaker compared 2 candidates locally. OCR and printing clues still control automatic matching.',
)
assert.equal(
  scannerVisualStatusCopy({ status: 'unavailable' }),
  'Visual evidence unavailable — using OCR and printing clues only.',
)
assert.equal(
  scannerVisualStatusCopy({ status: 'ocr-only' }),
  'Candidate images could not be compared — using OCR and printing clues only.',
)
assert.equal(
  scannerVisualStatusCopy({ status: 'not-needed' }),
  'OCR and printing clues separated the candidates; visual tie-breaker was not needed.',
)

// ─── Held-shelf wording ───────────────────────────────────────────────────
// Rows and cards are counted separately: three rows can be nine cards, and the
// warning has to be true about both before a user decides to discard.
assert.equal(heldScansLabel({ rows: 1, quantity: 1 }), '1 scanned printing (1 card) is still held')
assert.equal(heldScansLabel({ rows: 1, quantity: 3 }), '1 scanned printing (3 cards) is still held')
assert.equal(heldScansLabel({ rows: 2, quantity: 5 }), '2 scanned printings (5 cards) are still held')
assert.equal(heldScansLabel({ rows: 0, quantity: 0 }), null)
assert.equal(heldScansLabel(null), null)

// ─── Printing-selection copy ──────────────────────────────────────────────
// The chooser is an inline panel inside the scanner. Its own copy must not
// describe it as a separate popup/dialog the user has to dismiss.
{
  const required = printingSelectionCopy('printing-evidence-required')
  assert.equal(required.heading, 'Select the printing')
  assert.equal(required.detail, 'The name matched, but the scan did not identify a printing.')

  // A tie is two strong matches, not one weak one. Telling the user the scan
  // "was not strong enough" describes the opposite situation and hides the
  // thing they have to act on: the scan matched more than one possible card,
  // so the choice below is between cards, not just between printings.
  const tie = printingSelectionCopy('printing-tie')
  assert.equal(tie.heading, 'Select the printing')
  const fallback = printingSelectionCopy('some-unknown-reason')
  assert.equal(fallback.detail, 'The scan was not strong enough to choose one printing automatically.')
  assert.deepEqual(printingSelectionCopy(undefined), fallback)
  assert.notEqual(
    tie.detail,
    fallback.detail,
    'a tie must not fall through to the generic "not strong enough" copy',
  )
  assert.match(tie.detail, /more than one/i)
  assert.doesNotMatch(tie.detail, /not strong enough/i)

  for (const text of [required.heading, required.detail, tie.detail, fallback.detail, PRINTING_SELECTION_NOTE]) {
    assert.doesNotMatch(text, /pop-?up|dialog|window|overlay/i)
  }
  assert.match(PRINTING_SELECTION_NOTE, /scanner/i)
}

// ─── Cross-card vs same-card copy ─────────────────────────────────────────
{
  const cardTie = printingSelectionCopy('card-name-tie')
  const printingTie = printingSelectionCopy('printing-tie')
  assert.match(cardTie.detail, /more than one card/i)
  assert.doesNotMatch(printingTie.detail, /more than one card|different card/i)
  assert.match(printingTie.detail, /printing/i)
  assert.notEqual(cardTie.detail, printingTie.detail)
  assert.doesNotMatch(cardTie.detail, /not strong enough/i)

  // Widened-to-direct: manual confirmation, never claims an automatic add.
  const confirm = printingSelectionCopy('direct-confirm')
  assert.match(confirm.detail, /confirm/i)
  assert.match(confirm.detail, /nothing is added automatically|not added automatically/i)
  assert.notEqual(confirm.detail, printingSelectionCopy('x').detail)

  const cand = (cardName, id) => ({ cardName, edition: { scryfall_id: id } })
  assert.equal(scannerSelectionReason({ kind: 'direct', reason: undefined, candidates: [cand('A', '1')] }), 'direct-confirm')
  assert.equal(scannerSelectionReason({ kind: 'uncertain', reason: 'printing-tie', candidates: [cand('A', '1'), cand('A', '2')] }), 'printing-tie')
  assert.equal(scannerSelectionReason({ kind: 'uncertain', reason: 'card-name-tie', candidates: [cand('A', '1'), cand('B', '2')] }), 'card-name-tie')
}

// ─── Rendered shelf row ───────────────────────────────────────────────────
const CardScannerPanel = (await importSrc('components/CardScannerPanel.js')).default

{
  const markup = renderMarkup(CardScannerPanel, {
    onEvidence() {},
    onManual() {},
    shelf: [shelfRow()],
  })
  const text = visibleText(markup)

  // The thumbnail the shelf already stores has to reach the DOM.
  assert.match(markup, /<img[^>]+src="https:\/\/example\.invalid\/bolt-small\.jpg"/)
  assert.match(markup, /<img[^>]+alt="Lightning Bolt"/)

  // Rarity sits alongside the set / code / collector line, not instead of it.
  assert.match(text, /Modern Horizons 2 · MH2 #123/)
  assert.match(text, /Uncommon/)
  assert.match(markup, /text-rarity-uncommon/)

  // Quantity and finish stay editable, as before.
  assert.match(markup, /<input[^>]+type="number"[^>]+value="2"/)
  // React marks the active option with `selected` on a server render, so the
  // attribute list between value and text is not fixed.
  assert.match(markup, /<option value="nonfoil"[^>]*>Non-foil<\/option>/)
  assert.match(markup, /<option value="foil"[^>]*>Foil<\/option>/)

  // Low-risk physical-UAT guidance stays next to the live frame.
  assert.match(text, /Fill the frame, hold steady, and tilt away from glare before scanning\./)
}

// Once confirmation submits the batch, every scanner-session control is visibly
// locked until settlement. The copy describes a committed-in-progress action,
// not temporary data the user can still discard or edit.
{
  const markup = renderMarkup(CardScannerPanel, {
    onEvidence() {},
    onManual() {},
    shelf: [shelfRow()],
    binders: [{ id: 'binder-1', name: 'Main binder' }],
    binderId: 'binder-1',
    condition: 'NM',
    conditions: [{ value: 'NM', label: 'Near Mint' }],
    confirming: true,
  })
  const controls = markup.match(/<(?:button|input|select)\b[^>]*>/g) || []
  assert.ok(controls.length >= 9, 'expected scanner, shelf, and batch controls')
  for (const control of controls) {
    assert.match(control, /\sdisabled(?:="")?/, `pending batch control must be disabled: ${control}`)
  }
  const text = visibleText(markup)
  assert.match(text, /Saving submitted shelf/)
  assert.doesNotMatch(text, /Temporary until confirmed|discard/i)
}

// Visual comparison state is explicit; failure never looks like silent visual
// evidence and names the OCR-only fallback.
{
  const compared = visibleText(renderMarkup(CardScannerPanel, {
    onEvidence() {},
    onManual() {},
    visualStatus: { status: 'compared', compared: 3 },
  }))
  assert.match(compared, /Visual tie-breaker compared 3 candidates locally/)
  assert.match(compared, /OCR and printing clues still control automatic matching/)

  const fallback = visibleText(renderMarkup(CardScannerPanel, {
    onEvidence() {},
    onManual() {},
    visualStatus: { status: 'ocr-only', compared: 0 },
  }))
  assert.match(fallback, /Candidate images could not be compared/)
  assert.match(fallback, /using OCR and printing clues only/)
}

// A printing with no catalog image gets a placeholder, not a broken thumbnail.
{
  const markup = renderMarkup(CardScannerPanel, {
    onEvidence() {},
    onManual() {},
    shelf: [shelfRow({ imageUris: null })],
  })
  assert.doesNotMatch(markup, /<img/)
  assert.match(markup, /aria-hidden="true"/)
  assert.match(visibleText(markup), /Uncommon/)
}

// ─── Rendered printing-selection panel ────────────────────────────────────
const { PrintingSelectionPanel } = await importSrc('components/ScannerPrintingSelection.js')

{
  const markup = renderMarkup(PrintingSelectionPanel, {
    reason: 'printing-evidence-required',
    count: 4,
    hasMore: true,
    loadingMore: false,
    onLoadMore() {},
    children: 'CANDIDATE_ROWS',
  })
  const text = visibleText(markup)

  // Labelled as a panel, and labelled for assistive tech as one region.
  assert.match(markup, /role="group"/)
  assert.match(markup, /aria-label="Printing selection"/)
  assert.match(text, /Select the printing/)
  assert.match(text, /The name matched, but the scan did not identify a printing\./)
  assert.match(text, /4 printings/)
  assert.ok(text.includes(PRINTING_SELECTION_NOTE))
  assert.match(text, /CANDIDATE_ROWS/)
  assert.match(text, /Load more printings/)

  // It is inline in the scanner panel, so it must not present itself as a
  // separate modal popup — no dialog semantics, no popup wording.
  assert.doesNotMatch(markup, /role="dialog"|role="alertdialog"|aria-modal|aria-haspopup/)
  assert.doesNotMatch(text, /pop-?up|dialog/i)
}

// Cross-card tie: the panel copy says cards, and each visible row names its card.
{
  const { CandidateCardName } = await importSrc('components/ScannerPrintingSelection.js')
  const markupOf = reason => renderMarkup(PrintingSelectionPanel, { reason, count: 2, children: 'ROWS' })
  const text = visibleText(renderMarkup(PrintingSelectionPanel, {
    reason: 'card-name-tie',
    count: 2,
    hasMore: false,
    children: 'ROWS',
  }))
  assert.match(text, /more than one card/i)
  // Heading and count describe a choice between cards, not only printings.
  assert.match(text, /Select the card/)
  assert.doesNotMatch(text, /Select the printing/)
  assert.match(text, /2 candidate options to choose from/)
  assert.doesNotMatch(text, /2 printings/)
  assert.match(text, /Selecting here stays in the scanner panel/)
  const oneTie = visibleText(renderMarkup(PrintingSelectionPanel, { reason: 'card-name-tie', count: 1, children: 'ROWS' }))
  assert.match(oneTie, /1 candidate option to choose from/)
  assert.doesNotMatch(oneTie, /1 candidate options/)
  assert.doesNotMatch(markupOf('card-name-tie'), /role="dialog"|role="alertdialog"|aria-modal|aria-haspopup/)

  // Widened-to-direct: confirmation heading, one printing still counted as such.
  const confirmText = visibleText(renderMarkup(PrintingSelectionPanel, { reason: 'direct-confirm', count: 1, children: 'ROWS' }))
  assert.match(confirmText, /Confirm the printing/)
  assert.doesNotMatch(confirmText, /Select the printing/)
  assert.match(confirmText, /nothing is added automatically/i)
  assert.match(confirmText, /1 printing to choose from/)

  assert.match(visibleText(renderMarkup(CandidateCardName, { cardName: 'Saruman, the White Hand' })), /Saruman, the White Hand/)
  assert.equal(renderMarkup(CandidateCardName, { cardName: '' }), '')

  // The modal must show names only for multi-card option sets.
  const modalSource = readFileSync(new URL('../src/components/AddCardModal.js', import.meta.url), 'utf8')
  assert.match(modalSource, /showCardName=\{new Set\(scannerDecision\.candidates\.map\(c => c\.cardName\)\)\.size > 1\}/)
  assert.match(modalSource, /\{showCardName && <CandidateCardName cardName=\{cardName\} \/>\}/)
}

// Load-more is a property of the pool, not of the panel: no pool tail, no button.
{
  const markup = renderMarkup(PrintingSelectionPanel, {
    reason: 'printing-tie',
    count: 2,
    hasMore: false,
    onLoadMore() {},
    children: 'ROWS',
  })
  assert.doesNotMatch(visibleText(markup), /Load more printings/)
  assert.match(visibleText(markup), /2 printings/)
}

// One candidate is still a selection, and still reads as one.
{
  const text = visibleText(renderMarkup(PrintingSelectionPanel, {
    reason: 'printing-tie',
    count: 1,
    hasMore: false,
    children: 'ROWS',
  }))
  assert.match(text, /1 printing\b/)
  assert.doesNotMatch(text, /1 printings/)
}

// ─── Rendered pending-scan notices ────────────────────────────────────────
const { HeldScansBanner, ScannerExitPrompt } = await importSrc('components/ScannerShelfNotices.js')

{
  const markup = renderMarkup(ScannerExitPrompt, {
    rows: 2,
    quantity: 5,
    onKeep() {},
    onDiscard() {},
  })
  const text = visibleText(markup)
  // The prompt has to say what would be lost, in both counts, and offer a way
  // back that is not "discard". The safe action must not promise to reopen the
  // camera when the prompt can also appear from manual-search mode.
  assert.match(text, /2 scanned printings \(5 cards\)/)
  assert.match(text, /Keep scans and stay/)
  assert.doesNotMatch(text, /Keep scanning/)
  assert.match(text, /Discard scans and close/)
  // Announced, because it appears in response to a close the user already asked
  // for and would otherwise be a silent refusal to close.
  assert.match(markup, /role="alert"/)
}

// Nothing pending means no prompt at all — the close must not be interrupted.
assert.equal(renderMarkup(ScannerExitPrompt, { rows: 0, quantity: 0 }), '')

{
  const markup = renderMarkup(HeldScansBanner, { rows: 1, quantity: 3, onResume() {} })
  const text = visibleText(markup)
  assert.match(text, /1 scanned printing \(3 cards\) is still held/)
  assert.match(text, /Resume scanning/)
}
assert.equal(renderMarkup(HeldScansBanner, { rows: 0, quantity: 0 }), '')

// ─── Wiring: the panel and modal use these surfaces ───────────────────────
{
  const panelSource = readFileSync(new URL('../src/components/CardScannerPanel.js', import.meta.url), 'utf8')
  assert.match(panelSource, /from '@\/lib\/cardScannerView\.mjs'/)

  const modalSource = readFileSync(new URL('../src/components/AddCardModal.js', import.meta.url), 'utf8')
  assert.match(modalSource, /<PrintingSelectionPanel/)
  assert.match(modalSource, /<ScannerExitPrompt/)
  assert.match(modalSource, /<HeldScansBanner/)
  // The old inline heading claimed the shelf, not the selection; it is gone.
  assert.doesNotMatch(modalSource, /Choose the printing before it enters the shelf/)
}

// Metadata-only recovery must explain the absent name, not imply confidence.
{
  const text = visibleText(renderMarkup(PrintingSelectionPanel, { reason: 'printing-only', count: 1, children: 'ROWS' }))
  assert.match(text, /title could not be matched/i)
  assert.match(text, /set and number/i)
  assert.match(text, /confirm/i)
}

console.log('CARD_SCANNER_VIEW_PASS')
