// Pure card-scanner utilities — no camera, no worker, no network.
//
// Contract: brain/dbb/card-scanner-lld.md §4.2 and §5.4. These functions turn
// raw browser-local OCR text into search evidence and re-order catalog results.
// The parser must never invent evidence: absent set/collector/rarity data is
// neutral, not a mismatch, and only usable evidence can lower a candidate.

// Unicode punctuation OCR commonly emits, folded onto ASCII equivalents.
const UNICODE_FOLD = [
  [/[‘’‛ʼ]/g, "'"],
  [/[“”]/g, '"'],
  [/[‐-―−]/g, '-'],
  [/[•·∙]/g, ' '],
]

// Everything outside this set is OCR noise. Apostrophes, hyphens, commas,
// colons and slashes are load-bearing in card names ("Urza's Saga",
// "Fire // Ice", "Jace, the Mind Sculptor").
const ALLOWED = /[^a-z0-9 '",.:!?/&-]/g

const RARITY_LETTERS = { c: 'common', u: 'uncommon', r: 'rare', m: 'mythic' }

// Language codes printed on the same information strip as the set code.
const LANGUAGE_CODES = new Set(['en', 'jp', 'ja', 'fr', 'de', 'it', 'es', 'pt', 'ko', 'ru', 'zhs', 'zht', 'eng', 'jpn', 'fra', 'deu', 'ita', 'spa', 'por', 'kor', 'rus', 'chs', 'cht'])

const SET_CODE_RE = /^[a-z0-9]{3,5}$/
const COLLECTOR_RE = /^\d{1,4}[a-z]?$/

// "123/303", "0035a/0281" — printed serial over set size.
const SERIAL_OVER_TOTAL_RE = /(\d{1,4}[a-z]?)\s*\/\s*\d{1,4}[a-z]?/
// "R 035" — rarity letter followed by the printed serial.
const RARITY_SERIAL_RE = /\b([curmst])\s+(\d{1,4}[a-z]?)\b/
const MODERN_SERIAL_RE = /^(\d{1,4}[a-z]?)\s+([curm])$/

function setLanguageCode(line, rawLine = line) {
  const tokens = line.split(' ')
  const markedPrefix = rawLine.trim().match(/^([a-z0-9]{3,5})\s*[•·∙⋅◦▪|/-]\s*([a-z]{2,3})(?=\s|$)/i)
  const set = markedPrefix?.[1]?.toLowerCase() || tokens[0]
  const language = markedPrefix?.[2]?.toLowerCase() || tokens[1]
  return (tokens.length === 2 || markedPrefix) && SET_CODE_RE.test(set) &&
    !/^\d+$/.test(set) && !LANGUAGE_CODES.has(set) && LANGUAGE_CODES.has(language)
    ? set : null
}

// Cap the edit-distance DP so a pathological OCR read cannot stall the UI.
const MAX_EDIT_LEN = 64
const MAX_LEN_GAP = 8

/**
 * Normalize one run of OCR text for comparison: fold unicode punctuation,
 * drop noise glyphs, collapse whitespace, lowercase. Non-strings collapse to
 * the empty string — bad OCR output is an expected state, not an error.
 */
export function normalizeOcrText(text) {
  if (typeof text !== 'string') return ''
  let out = text.toLowerCase()
  for (const [pattern, replacement] of UNICODE_FOLD) out = out.replace(pattern, replacement)
  // Replace (never delete) noise so two words are not silently glued together.
  out = out.replace(ALLOWED, ' ')
  return out.replace(/\s+/g, ' ').trim()
}

function countDigits(line) {
  let digits = 0
  let dense = 0
  for (const ch of line) {
    if (ch === ' ') continue
    dense++
    if (ch >= '0' && ch <= '9') digits++
  }
  return { digits, dense }
}

// A printed information strip (set code, serial, rarity, language) rather than
// a title. Only these lines are read for printing evidence, so a type line like
// "Land" can never be mistaken for a set code.
function isInfoLine(line, rawLine = line) {
  if (setLanguageCode(line, rawLine) || MODERN_SERIAL_RE.test(line)) return true
  if (SERIAL_OVER_TOTAL_RE.test(line)) return true
  if (RARITY_SERIAL_RE.test(line)) return true
  const { digits, dense } = countDigits(line)
  return digits > 0 && dense > 0 && digits / dense >= 0.4
}

function isNameLine(line) {
  const letters = line.replace(/[^a-z]/g, '').length
  return letters >= 2 && !isInfoLine(line)
}

function normalizeCollectorNumber(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null
  const value = String(raw).trim().toLowerCase().replace(/^0+(?=\d)/, '')
  return value || null
}

/**
 * Extract a search seed from raw OCR text.
 * @returns {{nameQuery: string, setCode: string|null, collectorNumber: string|null, rarity: string|null, rawText: string}}
 */
export function extractScanEvidence(text) {
  const rawText = typeof text === 'string' ? text : ''
  const lines = rawText
    .split(/[\r\n]+/)
    .map(rawLine => ({ rawLine, line: normalizeOcrText(rawLine) }))
    .filter(entry => entry.line)

  const nameQuery = lines.find(entry => isNameLine(entry.line) && !setLanguageCode(entry.line, entry.rawLine))?.line || ''

  let setCode = null
  let collectorNumber = null
  let rarity = null

  for (const { rawLine, line } of lines) {
    if (!isInfoLine(line, rawLine)) continue

    let rest = line
    const printedSet = setLanguageCode(line, rawLine)
    if (printedSet) {
      if (setCode === null) setCode = printedSet
      rest = line.replace(/^[a-z0-9]{3,5}\s+[a-z]{2,3}\b\s*/, '')
      if (!rest) continue
    }

    if (collectorNumber === null) {
      const modern = rest.match(MODERN_SERIAL_RE)
      const serial = rest.match(SERIAL_OVER_TOTAL_RE)
      if (modern) {
        collectorNumber = normalizeCollectorNumber(modern[1])
        if (rarity === null) rarity = RARITY_LETTERS[modern[2]]
        rest = ''
      } else if (serial) {
        collectorNumber = normalizeCollectorNumber(serial[1])
        rest = rest.replace(serial[0], ' ')
      } else {
        const raritySerial = rest.match(RARITY_SERIAL_RE)
        if (raritySerial) {
          collectorNumber = normalizeCollectorNumber(raritySerial[2])
          if (rarity === null) rarity = RARITY_LETTERS[raritySerial[1]] ?? null
          rest = rest.replace(raritySerial[0], ' ')
        }
      }
    }

    const tokens = rest.split(/[^a-z0-9]+/).filter(Boolean)
    for (const token of tokens) {
      if (setCode === null && SET_CODE_RE.test(token) && !/^\d+$/.test(token) && !LANGUAGE_CODES.has(token)) {
        setCode = token
        continue
      }
      if (rarity === null && token.length === 1 && RARITY_LETTERS[token]) {
        rarity = RARITY_LETTERS[token]
      }
    }
  }

  return { nameQuery, setCode, collectorNumber, rarity, rawText }
}

/**
 * True when the scan carries a set code and/or collector number in an
 * accepted printed format — the denominator for the correct-printing metric.
 */
export function isUsablePrintingEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') return false
  return hasUsableSetCode(evidence) || hasUsableCollector(evidence)
}

/**
 * Whether a field parses as a printed set code / collector number at all.
 *
 * Exported because "present evidence" has to mean the same thing everywhere:
 * `rankScannerResults` applies a match/miss delta only for a field these
 * accept, so anything deciding whether a printing clue exists must ask the
 * same question rather than settling for a non-empty string.
 */
export function hasUsableSetCode(evidence) {
  return typeof evidence.setCode === 'string' && SET_CODE_RE.test(evidence.setCode.trim().toLowerCase())
}

export function hasUsableCollector(evidence) {
  return typeof evidence.collectorNumber === 'string' && COLLECTOR_RE.test(evidence.collectorNumber.trim().toLowerCase())
}

// Levenshtein distance, bounded in both length and work.
function editDistance(a, b) {
  if (a === b) return 0
  if (!a.length || !b.length) return Math.max(a.length, b.length)
  let prev = new Array(b.length + 1)
  let curr = new Array(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    const swap = prev
    prev = curr
    curr = swap
  }
  return prev[b.length]
}

function tokenOverlap(a, b) {
  const left = new Set(a.split(' ').filter(Boolean))
  const right = new Set(b.split(' ').filter(Boolean))
  if (!left.size || !right.size) return 0
  let shared = 0
  for (const token of left) if (right.has(token)) shared++
  return shared / (left.size + right.size - shared)
}

function similarity(a, b) {
  if (!a || !b) return 0
  const overlap = tokenOverlap(a, b)
  if (Math.abs(a.length - b.length) > MAX_LEN_GAP) return overlap
  const left = a.slice(0, MAX_EDIT_LEN)
  const right = b.slice(0, MAX_EDIT_LEN)
  const distance = editDistance(left, right)
  const editSim = 1 - distance / Math.max(left.length, right.length)
  return Math.max(overlap, Math.max(0, editSim))
}

// §5.4 order: exact name, prefix name, fuzzy name, then evidence agreement.
const SCORE_EXACT_NAME = 10000
const SCORE_PREFIX_NAME = 7000
const SCORE_FUZZY_NAME_MAX = 6000
const SCORE_SET_MATCH = 200
const PENALTY_SET_MISS = 150
const SCORE_COLLECTOR_MATCH = 150
const PENALTY_COLLECTOR_MISS = 100
const SCORE_RARITY_MATCH = 50
const PENALTY_RARITY_MISS = 25

function scoreName(catalogName, nameQuery) {
  const name = normalizeOcrText(catalogName)
  const query = normalizeOcrText(nameQuery)
  if (!name || !query) return { score: 0, kind: 'none' }
  if (name === query) return { score: SCORE_EXACT_NAME, kind: 'exact' }
  if (query.length >= 3 && (name.startsWith(query) || query.startsWith(name))) return { score: SCORE_PREFIX_NAME, kind: 'prefix' }
  const sim = similarity(name, query)
  if (sim <= 0) return { score: 0, kind: 'none' }
  return { score: Math.round(SCORE_FUZZY_NAME_MAX * sim), kind: 'fuzzy' }
}

function compare(a, b) {
  const left = a == null ? '' : String(a)
  const right = b == null ? '' : String(b)
  if (left === right) return 0
  return left < right ? -1 : 1
}

// Stable catalog order: name, set_code, collector_number, scryfall_id (§5.4.7).
function compareCatalogOrder(a, b) {
  return (
    compare(a.set_code, b.set_code) ||
    compare(a.collector_number, b.collector_number) ||
    compare(a.scryfall_id, b.scryfall_id)
  )
}

/**
 * Rank editions by scan evidence, then rebuild display groups. Each edition
 * keeps its catalog fields plus `scanScore` and `scanMatches`, so the
 * name-group metric and the correct-printing metric stay measurable.
 * Inputs are never mutated.
 */
export function rankScannerResults(groups, evidence) {
  if (!Array.isArray(groups) || groups.length === 0) return []
  const ev = evidence && typeof evidence === 'object' ? evidence : {}

  const setUsable = hasUsableSetCode(ev)
  const collectorUsable = hasUsableCollector(ev)
  const rarityUsable = typeof ev.rarity === 'string' && ev.rarity.trim() !== ''
  const wantSet = setUsable ? ev.setCode.trim().toLowerCase() : null
  const wantCollector = collectorUsable ? normalizeCollectorNumber(ev.collectorNumber) : null
  const wantRarity = rarityUsable ? ev.rarity.trim().toLowerCase() : null

  const ranked = groups
    .filter(group => group && typeof group === 'object')
    .map(group => {
      const name = scoreName(group.name, ev.nameQuery)
      const editions = (Array.isArray(group.editions) ? group.editions : [])
        .filter(edition => edition && typeof edition === 'object')
        .map(edition => {
          let score = name.score
          const matches = { name: name.kind, set: null, collector: null, rarity: null }

          if (setUsable) {
            matches.set = String(edition.set_code ?? '').trim().toLowerCase() === wantSet
            score += matches.set ? SCORE_SET_MATCH : -PENALTY_SET_MISS
          }
          if (collectorUsable) {
            matches.collector = normalizeCollectorNumber(edition.collector_number) === wantCollector
            score += matches.collector ? SCORE_COLLECTOR_MATCH : -PENALTY_COLLECTOR_MISS
          }
          if (rarityUsable) {
            matches.rarity = String(edition.rarity ?? '').trim().toLowerCase() === wantRarity
            score += matches.rarity ? SCORE_RARITY_MATCH : -PENALTY_RARITY_MISS
          }

          return { ...edition, scanScore: score, scanMatches: matches }
        })
        .sort((a, b) => b.scanScore - a.scanScore || compareCatalogOrder(a, b))

      const scanScore = editions.length ? editions[0].scanScore : name.score
      const scanMatches = editions.length
        ? editions[0].scanMatches
        : { name: name.kind, set: null, collector: null, rarity: null }

      return { ...group, editions, scanScore, scanMatches }
    })

  return ranked.sort((a, b) => b.scanScore - a.scanScore || compare(a.name, b.name))
}
