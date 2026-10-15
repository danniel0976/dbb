import { hasUsableCollector, hasUsableSetCode } from './cardScanner.mjs'
import { createClientUuid } from './clientUuid.mjs'

const SCANNER_SOURCES = new Set(['scanner-direct', 'scanner-confirmed'])

// Exits that only leave scanner mode. The shelf outlives them, so the user can
// be handed it back instead of re-scanning.
const SHELF_PRESERVING_EXITS = new Set(['manual', 'clear'])
// Exits taken after the shelf has already been written to the library.
const SHELF_SETTLED_EXITS = new Set(['batch-confirmed'])

// One scan may sweep at most this many catalog pages into its candidate pool.
// Retrieval is deliberately broad (OCR clues rank, they do not filter), so the
// printing a scan describes can sit past the first page; the cap keeps that
// reachable without turning one scan into unbounded paging.
export const SCAN_POOL_MAX_PAGES = 3
const VALID_CONDITIONS = new Set(['M', 'NM', 'LP', 'MP', 'HP', 'DMG'])
const FINISH_TO_API = { nonfoil: 'normal', foil: 'foil', etched: 'etched' }

function hasText(value) {
  return typeof value === 'string' && value.trim() !== ''
}

// Which printing clues this scan actually carries. "Carries" has to mean the
// same thing here as it does in rankScannerResults: that ranker scores a set
// code or collector number only when it parses as one, so a garbage read gets
// no match/miss delta and leaves its scanMatches entry null. Treating such a
// read as present evidence would report a printing *conflict* for a clue that
// was never usable in the first place.
function printingFields(evidence) {
  const ev = evidence && typeof evidence === 'object' ? evidence : {}
  const fields = []
  if (hasUsableSetCode(ev)) fields.push('set')
  if (hasUsableCollector(ev)) fields.push('collector')
  if (hasText(ev.rarity)) fields.push('rarity')
  return fields
}

/**
 * Flatten ranked groups into the scanner's ordered candidate list. Exported so
 * an appended catalog page can widen the list the user is choosing from without
 * re-deciding the match.
 */
export function listScannerCandidates(groups) {
  const candidates = []
  for (const group of Array.isArray(groups) ? groups : []) {
    if (!group || typeof group !== 'object') continue
    for (const edition of Array.isArray(group.editions) ? group.editions : []) {
      if (!edition?.scryfall_id) continue
      candidates.push({ cardName: group.name || '', edition })
    }
  }
  return candidates
}

const scannerCandidates = listScannerCandidates

/** A title seeds broad name search; absent titles need BOTH printing clues.
 * The latter uses the existing set browse path, never a collection query or
 * an invented translation. Its results always require explicit confirmation.
 */
export function scannerRetrievalSeed(evidence) {
  if (hasText(evidence?.nameQuery)) return { query: evidence.nameQuery.trim(), set: '' }
  if (evidence && hasUsableSetCode(evidence) && hasUsableCollector(evidence)) {
    return { query: '', set: evidence.setCode.trim().toLowerCase() }
  }
  return null
}

/**
 * Whether to pull one more catalog page into this scan's candidate pool.
 *
 * The name-group top-five metric applies to every usable name read, so both
 * name-only and printing-evidence scans sweep the same bounded page count.
 */
export function shouldSweepAnotherScanPage({ pagesFetched, hasMore, decision, evidence } = {}) {
  if (hasMore !== true) return false
  if (!Number.isInteger(pagesFetched) || pagesFetched < 1) return false
  if (pagesFetched >= SCAN_POOL_MAX_PAGES) return false
  if (decision?.kind === 'direct') return false
  return scannerRetrievalSeed(evidence) !== null
}

/** Route a catalog-row click according to the active modal mode. */
export function routeCatalogSelection({ scannerOpen = false, hasScanEvidence = false } = {}) {
  if (!scannerOpen) return 'manual-add'
  return hasScanEvidence ? 'scanner-shelf' : 'blocked'
}

/**
 * Route ranked catalog output without guessing a printing. A direct result must
 * have an exact/prefix name, agree with every OCR printing clue that exists,
 * and beat the next candidate rather than tying it.
 */
export function routeScannerMatch(groups, evidence) {
  const candidates = scannerCandidates(groups)
  const uncertain = (reason, pool) => ({ kind: 'uncertain', reason, candidates: pool })
  if (candidates.length === 0) return uncertain('no-candidates', candidates)

  if (!hasText(evidence?.nameQuery) && scannerRetrievalSeed(evidence)) {
    const matching = candidates.filter(candidate => candidate.edition.scanMatches?.set === true &&
      candidate.edition.scanMatches?.collector === true)
    return uncertain('printing-only', matching)
  }

  const top = candidates[0]
  const matches = top.edition.scanMatches || {}
  const fields = printingFields(evidence)
  const strongName = matches.name === 'exact' || matches.name === 'prefix'

  if (!strongName) return uncertain('strong-name-required', candidates)

  // A different card scoring exactly as well as the identified top card is a
  // genuine name tie (an OCR read that is a shared prefix of two card names,
  // such as "Saruman"). It has to be detected before any evidence-required or
  // conflict return, because narrowing to `top`'s card would hide the card the
  // user may actually have scanned. Offer every edition tied at the top score
  // and nothing below it, in the pool's existing order.
  const topScore = Number(top.edition.scanScore)
  if (Number.isFinite(topScore)) {
    const tied = candidates.filter(candidate => Number(candidate.edition.scanScore) === topScore)
    if (tied.some(candidate => candidate.cardName !== top.cardName)) {
      return uncertain('card-name-tie', tied)
    }
  }

  // Once the name is confidently identified, the printing choices shown to
  // the user must come from that one card -- not the whole fuzzy-retrieval
  // pool, which can hold unrelated cards that merely share wording.
  const sameCard = candidates.filter(candidate => candidate.cardName === top.cardName)

  if (fields.length === 0) return uncertain('printing-evidence-required', sameCard)
  if (!fields.every(field => matches[field] === true)) {
    return uncertain('printing-evidence-conflict', sameCard)
  }

  // A same-card printing tie has no other card to show, so it stays narrowed.
  const secondScore = sameCard.length > 1 ? Number(sameCard[1].edition.scanScore) : -Infinity
  if (!Number.isFinite(topScore) || secondScore === topScore) {
    return uncertain('printing-tie', sameCard)
  }

  // The narrowed list rides along on a direct result too. Auto-add reads only
  // `candidate`, but a user-triggered "load more" re-decides over the widened
  // pool and still has to show that pool's printings for the identified card:
  // without this, a page load that happens to resolve the ambiguity would
  // leave the picker stuck on the older, narrower list, making the printing
  // the user just loaded unreachable.
  return { kind: 'direct', candidate: top, candidates: sameCard }
}

function supportedFinishes(edition) {
  const finishes = Array.isArray(edition?.finishes)
    ? edition.finishes.filter(finish => finish in FINISH_TO_API)
    : []
  return finishes.length > 0 ? finishes : ['nonfoil']
}

function clampQuantity(value) {
  return Math.min(9999, Math.max(1, Number.parseInt(value, 10) || 1))
}

// A shelf row is one printing in one finish, so the key names both: the same
// Scryfall id can hold a nonfoil, a foil and an etched row at once.
function shelfIdFor(scryfallId, finish) {
  return `${scryfallId}:${finish}`
}

/** Add one scanner-originated printing to the temporary shelf. */
export function addScannerShelfItem(shelf, selection) {
  const current = Array.isArray(shelf) ? shelf : []
  if (!SCANNER_SOURCES.has(selection?.source) || !selection?.edition?.scryfall_id) return current

  const finishes = supportedFinishes(selection.edition)
  const finish = finishes.includes('nonfoil') ? 'nonfoil' : finishes[0]
  const existing = current.find(item => (
    item.source && SCANNER_SOURCES.has(item.source) &&
    item.scryfallId === selection.edition.scryfall_id &&
    item.finish === finish
  ))

  if (existing) {
    return current.map(item => item.shelfId === existing.shelfId
      ? { ...item, quantity: clampQuantity(item.quantity + 1) }
      : item)
  }

  return [...current, {
    shelfId: shelfIdFor(selection.edition.scryfall_id, finish),
    source: selection.source,
    scryfallId: selection.edition.scryfall_id,
    cardName: selection.cardName || '',
    setName: selection.edition.set_name || '',
    setCode: selection.edition.set_code || '',
    collectorNumber: selection.edition.collector_number || '',
    rarity: selection.edition.rarity || null,
    imageUris: selection.edition.image_uris || null,
    finishes,
    finish,
    quantity: 1,
    selected: true,
  }]
}

export function removeScannerShelfItem(shelf, shelfId) {
  return (Array.isArray(shelf) ? shelf : []).filter(item => item.shelfId !== shelfId)
}

export function editScannerShelfItem(shelf, shelfId, patch) {
  const current = Array.isArray(shelf) ? shelf : []
  return current.map(item => {
    if (item.shelfId !== shelfId) return item
    const next = { ...item }
    if (patch && Object.hasOwn(patch, 'quantity')) next.quantity = clampQuantity(patch.quantity)
    if (hasText(patch?.finish) && item.finishes?.includes(patch.finish)) {
      // Changing the finish changes the row's identity, so it may not land on a
      // printing+finish the shelf already holds; merging would lose a quantity.
      const taken = current.some(other => (
        other.shelfId !== item.shelfId &&
        other.scryfallId === item.scryfallId &&
        other.finish === patch.finish
      ))
      if (!taken) {
        next.finish = patch.finish
        next.shelfId = shelfIdFor(item.scryfallId, patch.finish)
      }
    }
    if (typeof patch?.selected === 'boolean') next.selected = patch.selected
    return next
  })
}

/**
 * What a shelf would cost to lose, counted in rows and in cards. One row can be
 * nine cards, so a warning that names only one of the two is not true enough to
 * decide on. Deselected rows count: they were scanned, just not chosen yet.
 */
export function pendingShelfSummary(shelf) {
  const rows = (Array.isArray(shelf) ? shelf : [])
    .filter(item => SCANNER_SOURCES.has(item?.source) && hasText(item?.scryfallId))
  return {
    rows: rows.length,
    quantity: rows.reduce((sum, item) => sum + clampQuantity(item.quantity), 0),
  }
}

/**
 * Whether an exit may take the temporary shelf with it.
 *
 * The shelf is the only record of a scanning session, so nothing here discards
 * it quietly: leaving scanner mode preserves it, ending the modal asks first,
 * and only explicit consent (`discardConfirmed === true`) resolves to a discard.
 * An exit this module does not recognise fails closed to `confirm`, so a new
 * exit path added upstream cannot drop pending scans by omission.
 */
export function resolveScannerExit({ exit, shelf, discardConfirmed } = {}) {
  const { rows, quantity } = pendingShelfSummary(shelf)
  if (rows === 0 || SHELF_SETTLED_EXITS.has(exit)) return { kind: 'proceed', rows, quantity }
  if (SHELF_PRESERVING_EXITS.has(exit)) return { kind: 'preserve', rows, quantity }
  return { kind: discardConfirmed === true ? 'discard' : 'confirm', rows, quantity }
}

/**
 * Keep the modal and its shelf owned while the transactional batch write is in
 * flight. A pending request overrides even explicit discard consent because the
 * server may already have committed by the time that click is handled.
 */
export function resolveScannerBatchExit({ batchPending = false, ...exitOptions } = {}) {
  if (batchPending === true) {
    const { rows, quantity } = pendingShelfSummary(exitOptions.shelf)
    return { kind: 'blocked', rows, quantity }
  }
  return resolveScannerExit(exitOptions)
}

/**
 * Own one scanner batch request at a time. The request token is also the
 * continuation generation: only the mounted lifecycle that began it may fail
 * or commit it, and invalidation makes every late continuation inert.
 */
export function createScannerBatchLifecycle() {
  let generation = 0
  let activeRequest = null
  let mounted = true
  let attempt = null

  const owns = request => mounted && activeRequest === request

  return {
    begin(payload) {
      if (!mounted || activeRequest) return null
      if (payload) {
        const fingerprint = JSON.stringify(payload)
        if (attempt?.fingerprint !== fingerprint) attempt = { fingerprint, batchId: createClientUuid() }
      }
      activeRequest = { generation: ++generation, ...(payload ? { batchId: attempt.batchId } : {}) }
      return activeRequest
    },
    canMutate() {
      return mounted && activeRequest === null
    },
    isCurrent(request) {
      return owns(request)
    },
    isMounted() {
      return mounted
    },
    fail(request) {
      if (!owns(request)) return false
      activeRequest = null
      return true
    },
    commit(request) {
      if (!owns(request)) return false
      activeRequest = null
      attempt = null
      return true
    },
    resetAttempt() {
      if (!mounted || activeRequest) return false
      attempt = null
      return true
    },
    invalidate() {
      mounted = false
      attempt = null
      activeRequest = null
      generation += 1
    },
    // Re-arms a lifecycle invalidated by a prior mount's cleanup. React
    // StrictMode double-invokes an effect (mount -> cleanup -> mount) in dev,
    // and this object lives in a useRef that survives that, so invalidate()
    // must not be terminal: each new mount calls arm() to make the same
    // instance usable again rather than leaving it permanently unmounted.
    arm() {
      mounted = true
      activeRequest = null
    },
  }
}

/**
 * Decide whether a batch response means the server committed the write,
 * using the HTTP status alone -- before the body is ever parsed. A truncated
 * or malformed 2xx body must never be able to turn an already-committed,
 * non-idempotent additive write into a reported failure, so this reads only
 * `ok` and has no awareness of whether the body can be parsed at all.
 */
export function classifyBatchResponse({ ok } = {}) {
  return ok === true ? 'commit' : 'fail'
}

/**
 * Parse a batch response body defensively. Used only after the commit/fail
 * boundary has already been decided from `ok`, so a rejected `.json()` call
 * (e.g. a truncated body) resolves to `{}` instead of throwing.
 */
export async function parseBatchResponseBody(res) {
  try {
    const data = await res.json()
    return data && typeof data === 'object' ? data : {}
  } catch {
    return {}
  }
}

/**
 * Build the single /api/library/add/batch request body from scanner-originated,
 * selected shelf rows. The binder is named once for the whole request because
 * one confirmation writes one binder in one transaction.
 *
 * Returns null when there is nothing to send — no binder, or nothing selected —
 * so the caller can explain the gap instead of posting a batch the server would
 * only reject.
 */
export function buildScannerBatchPayload(shelf, options = {}) {
  if (!hasText(options.binderId)) return null
  const condition = VALID_CONDITIONS.has(options.condition) ? options.condition : 'NM'
  const cards = (Array.isArray(shelf) ? shelf : [])
    .filter(item => SCANNER_SOURCES.has(item?.source) && hasText(item?.scryfallId))
    .filter(item => item.selected === true)
    .filter(item => item.finish in FINISH_TO_API)
    .map(item => ({
      scryfall_id: item.scryfallId,
      quantity: clampQuantity(item.quantity),
      foil: FINISH_TO_API[item.finish],
      condition,
    }))
  if (cards.length === 0) return null
  return { binder_id: options.binderId.trim(), cards }
}
