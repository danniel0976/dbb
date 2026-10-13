// Presentation facts for the scanner's own surfaces: what a temporary shelf row
// shows, and how the inline printing chooser describes itself. Kept out of the
// components so the wording and the image fallback order are assertable without
// a browser.

// Smallest usable face first: a shelf row is a thumbnail, not a card preview.
const THUMBNAIL_FACES = ['small', 'normal', 'large', 'png']

const RARITY_TONE = {
  mythic: 'text-rarity-mythic',
  rare: 'text-rarity-rare',
  uncommon: 'text-rarity-uncommon',
}

const PRINTING_SELECTION_HEADING = 'Select the printing'
const PRINTING_SELECTION_HEADING_BY_REASON = {
  'card-name-tie': 'Select the card',
  'direct-confirm': 'Confirm the printing',
}
const PRINTING_SELECTION_DETAIL = {
  'printing-only': 'The title could not be matched. These candidates match the printed set and number; check the card image and confirm the printing.',
  'printing-evidence-required': 'The name matched, but the scan did not identify a printing.',
  // Same card, several printings that agree equally well with the scan.
  'printing-tie': 'More than one printing of this card fits the scan equally well. Pick the one you scanned.',
  // Different cards tied: the scan is a name two cards share, so the choice
  // below is between cards, not only between printings.
  'card-name-tie': 'The scan matched more than one card equally well. Check the card names below — or search manually — to confirm which one you scanned.',
  // A page load resolved the ambiguity, but the scanner never auto-adds then.
  'direct-confirm': 'The scan now points to one printing, but nothing is added automatically. Select it below to confirm.',
}
const PRINTING_SELECTION_FALLBACK = 'The scan was not strong enough to choose one printing automatically.'

/**
 * Where this chooser lives. Stated because it is an inline panel inside the
 * scanner, not a separate thing to dismiss before scanning can continue.
 */
export const PRINTING_SELECTION_NOTE =
  'Selecting here stays in the scanner panel — the camera is still above, and nothing is added until you confirm the shelf.'

/** The shelf row's thumbnail, or null when the catalog row carried no image. */
export function shelfThumbnailSource(item) {
  const uris = item?.imageUris
  if (!uris || typeof uris !== 'object') return null
  for (const face of THUMBNAIL_FACES) {
    const value = uris[face]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return null
}

/** The shelf row's rarity as a label, or null when the catalog row had none. */
export function shelfRarityLabel(item) {
  const rarity = item?.rarity
  if (typeof rarity !== 'string' || rarity.trim() === '') return null
  const trimmed = rarity.trim()
  return trimmed[0].toUpperCase() + trimmed.slice(1)
}

/** Rarity tint. Unknown and common rarities share the neutral tone. */
export function rarityToneClass(rarity) {
  return RARITY_TONE[rarity] || 'text-gray-400'
}

/** Plain-language state for the optional browser-local visual tie-breaker. */
export function scannerVisualStatusCopy(result) {
  switch (result?.status) {
    case 'checking':
      return 'Checking visual tie-breaker locally…'
    case 'compared': {
      const count = Number.isInteger(result.compared) && result.compared > 0 ? result.compared : 0
      return `Visual tie-breaker compared ${count} candidate${count === 1 ? '' : 's'} locally. OCR and printing clues still control automatic matching.`
    }
    case 'unavailable':
      return 'Visual evidence unavailable — using OCR and printing clues only.'
    case 'ocr-only':
      return 'Candidate images could not be compared — using OCR and printing clues only.'
    case 'not-needed':
      return 'OCR and printing clues separated the candidates; visual tie-breaker was not needed.'
    default:
      return null
  }
}

/** Wording for scans held outside scanner mode, or null when none are held. */
export function heldScansLabel(summary) {
  const rows = Number(summary?.rows)
  const quantity = Number(summary?.quantity)
  if (!Number.isFinite(rows) || rows < 1) return null
  const printings = `${rows} scanned printing${rows === 1 ? '' : 's'}`
  const cards = `${quantity} card${quantity === 1 ? '' : 's'}`
  return `${printings} (${cards}) ${rows === 1 ? 'is' : 'are'} still held`
}

/** Heading and explanation for the inline printing-selection panel. */
export function printingSelectionCopy(reason) {
  return {
    heading: PRINTING_SELECTION_HEADING_BY_REASON[reason] || PRINTING_SELECTION_HEADING,
    // A cross-card tie is a choice between cards, so its count is not "printings".
    countNoun: reason === 'card-name-tie' ? 'candidate option' : 'printing',
    detail: PRINTING_SELECTION_DETAIL[reason] || PRINTING_SELECTION_FALLBACK,
  }
}

/**
 * The reason the printing chooser should describe, derived from the decision's
 * current candidate set so a "load more" re-decision cannot leave stale copy.
 */
export function scannerSelectionReason(decision) {
  if (decision?.kind === 'direct') return 'direct-confirm'
  return decision?.reason
}
