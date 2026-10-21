import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { extractScanEvidence, rankScannerResults } from '../src/lib/cardScanner.mjs'
import * as scannerSession from '../src/lib/cardScannerSession.mjs'
import {
  SCAN_POOL_MAX_PAGES,
  addScannerShelfItem,
  buildScannerBatchPayload,
  classifyBatchResponse,
  createScannerBatchLifecycle,
  editScannerShelfItem,
  listScannerCandidates,
  parseBatchResponseBody,
  removeScannerShelfItem,
  pendingShelfSummary,
  resolveScannerExit,
  routeCatalogSelection,
  routeScannerMatch,
  shouldSweepAnotherScanPage,
} from '../src/lib/cardScannerSession.mjs'

const edition = (overrides = {}) => ({
  scryfall_id: 'id-mh2-123',
  set_code: 'mh2',
  set_name: 'Modern Horizons 2',
  collector_number: '123',
  rarity: 'uncommon',
  finishes: ['nonfoil', 'foil'],
  image_uris: { small: 'https://example.invalid/card.jpg' },
  scanScore: 10350,
  scanMatches: { name: 'exact', set: true, collector: true, rarity: null },
  ...overrides,
})

const group = (editions, overrides = {}) => ({
  name: 'Lightning Bolt',
  scanScore: editions[0]?.scanScore ?? 0,
  scanMatches: editions[0]?.scanMatches ?? null,
  editions,
  ...overrides,
})

// Raw OCR text must survive the complete local decision path: extraction,
// ranking, and direct/uncertain routing. This is the executable pipeline fixture
// that separate parser and ranker examples cannot substitute for.
{
  const evidence = extractScanEvidence('Lightning Bolt\nMH2 • EN 123/303 U')
  const ranked = rankScannerResults([
    group([
      edition({
        scryfall_id: 'id-lea-161',
        set_code: 'lea',
        collector_number: '161',
        rarity: 'common',
      }),
      edition(),
    ]),
  ], evidence)
  const decision = routeScannerMatch(ranked, evidence)
  assert.equal(decision.kind, 'direct')
  assert.equal(decision.candidate.edition.scryfall_id, 'id-mh2-123')
}

// Direct routing requires a strong name AND uniquely best agreement with every
// available printing clue.
{
  const best = edition()
  const other = edition({
    scryfall_id: 'id-lea-161',
    set_code: 'lea',
    collector_number: '161',
    finishes: ['nonfoil'],
    scanScore: 9750,
    scanMatches: { name: 'exact', set: false, collector: false, rarity: null },
  })
  const decision = routeScannerMatch([group([best, other])], {
    nameQuery: 'lightning bolt',
    setCode: 'mh2',
    collectorNumber: '123',
  })
  assert.equal(decision.kind, 'direct')
  assert.equal(decision.candidate.edition.scryfall_id, 'id-mh2-123')
}

// Name-only scans never silently choose a printing.
{
  const decision = routeScannerMatch([group([
    edition({ scanScore: 10000, scanMatches: { name: 'exact', set: null, collector: null, rarity: null } }),
  ])], { nameQuery: 'lightning bolt' })
  assert.equal(decision.kind, 'uncertain')
  assert.equal(decision.reason, 'printing-evidence-required')
}

// Printing evidence cannot override a weak/fuzzy card-name read (the AND rule).
{
  const decision = routeScannerMatch([group([
    edition({ scanMatches: { name: 'fuzzy', set: true, collector: true, rarity: null } }),
  ])], { nameQuery: 'lightnlng bott', setCode: 'mh2', collectorNumber: '123' })
  assert.equal(decision.kind, 'uncertain')
  assert.equal(decision.reason, 'strong-name-required')
}

// A conflict in any available printing clue stays uncertain even if ranking
// weights put that candidate first.
{
  const decision = routeScannerMatch([group([
    edition({ scanMatches: { name: 'exact', set: true, collector: false, rarity: null } }),
  ])], { nameQuery: 'lightning bolt', setCode: 'mh2', collectorNumber: '999' })
  assert.equal(decision.kind, 'uncertain')
  assert.equal(decision.reason, 'printing-evidence-conflict')
}

// A tied best agreement (for example rarity-only evidence) requires an explicit
// printing choice.
{
  const first = edition({
    scanScore: 10050,
    scanMatches: { name: 'exact', set: null, collector: null, rarity: true },
  })
  const second = edition({
    scryfall_id: 'id-m10-146',
    set_code: 'm10',
    collector_number: '146',
    scanScore: 10050,
    scanMatches: { name: 'exact', set: null, collector: null, rarity: true },
  })
  const decision = routeScannerMatch([group([first, second])], {
    nameQuery: 'lightning bolt',
    rarity: 'common',
  })
  assert.equal(decision.kind, 'uncertain')
  assert.equal(decision.reason, 'printing-tie')
  assert.equal(decision.candidates.length, 2)
}

// ─── Real UAT bug: a confidently-identified card's printing list must not
// leak unrelated cards pulled into the pool by OCR-tolerant fuzzy retrieval ─
//
// Scanning a real "Saruman of Many Colors" (Championship edition) card
// correctly matched the name, but had no usable set/collector evidence to
// pick a printing. The broad name-search pool also pulled in "Merchant of
// Many Hats" and "Riku of Many Paths" -- real, unrelated catalog cards that
// share the phrase "of Many ___". Once the name is confidently identified,
// the printing-selection candidates must be narrowed to that one card.

const sarumanEdition = (overrides = {}) => edition({
  scryfall_id: 'id-hoc-35',
  set_code: 'hoc',
  set_name: 'The Hobbit Eternal',
  collector_number: '35',
  scanScore: 9500,
  scanMatches: { name: 'exact', set: null, collector: null, rarity: null },
  ...overrides,
})

const sarumanGroup = (editions, overrides = {}) => group(editions, {
  name: 'Saruman of Many Colors',
  ...overrides,
})

const merchantGroup = (overrides = {}) => group([
  edition({
    scryfall_id: 'id-tla-110',
    set_code: 'tla',
    set_name: 'Avatar: The Last Airbender',
    collector_number: '110',
    scanScore: 9800,
    scanMatches: { name: 'fuzzy', set: null, collector: null, rarity: null },
  }),
], { name: 'Merchant of Many Hats', ...overrides })

const rikuGroup = (overrides = {}) => group([
  edition({
    scryfall_id: 'id-otj-227',
    set_code: 'otj',
    set_name: 'Outlaws of Thunder Junction',
    collector_number: '227',
    scanScore: 9700,
    scanMatches: { name: 'fuzzy', set: null, collector: null, rarity: null },
  }),
], { name: 'Riku of Many Paths', ...overrides })

// With no usable printing evidence, the 'printing-evidence-required' result
// must list ONLY Saruman's own editions -- never Merchant or Riku.
{
  const saruman1 = sarumanEdition()
  const saruman2 = sarumanEdition({ scryfall_id: 'id-lea-2', set_code: 'lea', collector_number: '2', scanScore: 9200 })
  const decision = routeScannerMatch([
    sarumanGroup([saruman1, saruman2]),
    merchantGroup(),
    rikuGroup(),
  ], { nameQuery: 'saruman of many colors' })

  assert.equal(decision.kind, 'uncertain')
  assert.equal(decision.reason, 'printing-evidence-required')
  assert.deepEqual(
    decision.candidates.map(c => c.cardName),
    ['Saruman of Many Colors', 'Saruman of Many Colors'],
    'unrelated cards pulled in by fuzzy retrieval must not appear in the printing list once the name is confidently identified',
  )
  // Relative scanScore order among the identified card's own editions is
  // preserved, not re-sorted.
  assert.deepEqual(
    decision.candidates.map(c => c.edition.scryfall_id),
    ['id-hoc-35', 'id-lea-2'],
  )
}

// A set/collector conflict against the identified card must also narrow to
// that card alone.
{
  const saruman1 = sarumanEdition({ scanMatches: { name: 'exact', set: false, collector: null, rarity: null } })
  const decision = routeScannerMatch([
    sarumanGroup([saruman1]),
    merchantGroup(),
    rikuGroup(),
  ], { nameQuery: 'saruman of many colors', setCode: 'xyz' })

  assert.equal(decision.kind, 'uncertain')
  assert.equal(decision.reason, 'printing-evidence-conflict')
  assert.deepEqual(decision.candidates.map(c => c.cardName), ['Saruman of Many Colors'])
}

// A genuine same-card printing-score tie still reports 'printing-tie', and
// the narrowed candidate list excludes the unrelated groups.
{
  const saruman1 = sarumanEdition({
    scanScore: 9500,
    scanMatches: { name: 'exact', set: null, collector: null, rarity: true },
  })
  const saruman2 = sarumanEdition({
    scryfall_id: 'id-lea-2',
    set_code: 'lea',
    collector_number: '2',
    scanScore: 9500,
    scanMatches: { name: 'exact', set: null, collector: null, rarity: true },
  })
  const decision = routeScannerMatch([
    sarumanGroup([saruman1, saruman2]),
    merchantGroup(),
    rikuGroup(),
  ], { nameQuery: 'saruman of many colors', rarity: 'rare' })

  assert.equal(decision.kind, 'uncertain')
  assert.equal(decision.reason, 'printing-tie')
  assert.deepEqual(decision.candidates.map(c => c.cardName), ['Saruman of Many Colors', 'Saruman of Many Colors'])
}

// CORRECTED (adversarial-review risk 2): an identified card's lone edition
// tying in raw score with a DIFFERENT card's edition in the pool IS a real
// ambiguity, not incidental score overlap. A tied top-of-pool score across two
// different card names is exactly the signal a same-card printing tie gives --
// it means rankScannerResults' stable, alphabetical-by-name sort silently
// decided the winner. This replaces a prior version of this test that
// asserted the opposite ('direct') on the premise that a cross-card score tie
// could never be a real printing ambiguity; that premise was wrong (see the
// dedicated cross-card-tie test below for the realistic OCR scenario -- a
// shared-prefix name read -- that makes this concrete), so the safer behavior
// is to always stop on a top-of-pool cross-card score tie rather than try to
// distinguish "meaningful" ties from "incidental" ones.
{
  const saruman1 = sarumanEdition({
    scanScore: 9800,
    scanMatches: { name: 'exact', set: true, collector: true, rarity: null },
  })
  const decision = routeScannerMatch([
    sarumanGroup([saruman1]),
    merchantGroup({ scanScore: 9800 }), // same raw score as Saruman's lone edition, but a different card
    rikuGroup(),
  ], { nameQuery: 'saruman of many colors', setCode: 'hoc', collectorNumber: '35' })

  assert.equal(decision.kind, 'uncertain')
  assert.equal(decision.reason, 'card-name-tie')
  // Defect S2: the tied OTHER card must be visible. Hiding it leaves the user
  // choosing printings of whichever card the stable sort happened to put
  // first -- exactly the guess this branch refuses to make for them. Riku
  // (9700) is not tied, so it stays out.
  assert.deepEqual(
    decision.candidates.map(c => c.cardName),
    ['Saruman of Many Colors', 'Merchant of Many Hats'],
    'a cross-card tie must show every card tied at the top score, not only the one that sorted first',
  )
  assert.deepEqual(decision.candidates.map(c => c.edition.scanScore), [9800, 9800])
}

// A cross-card score that does NOT tie the top score is not an ambiguity --
// the cross-card guard must stay narrow and not block every scan that merely
// shares its pool with another card.
{
  const saruman1 = sarumanEdition({
    scanScore: 9800,
    scanMatches: { name: 'exact', set: true, collector: true, rarity: null },
  })
  const differentScoreMerchant = group([
    edition({
      scryfall_id: 'id-tla-110',
      set_code: 'tla',
      set_name: 'Avatar: The Last Airbender',
      collector_number: '110',
      scanScore: 9700, // different from Saruman's 9800 -- no tie
      scanMatches: { name: 'fuzzy', set: null, collector: null, rarity: null },
    }),
  ], { name: 'Merchant of Many Hats' })
  const decision = routeScannerMatch([
    sarumanGroup([saruman1]),
    differentScoreMerchant,
    rikuGroup(),
  ], { nameQuery: 'saruman of many colors', setCode: 'hoc', collectorNumber: '35' })

  assert.equal(decision.kind, 'direct')
  assert.equal(decision.candidate.edition.scryfall_id, 'id-hoc-35')
}

// ─── Risk 2: a cross-card score tie must block auto-add, not silently decide
// by the ranker's alphabetical stable-sort tiebreak ─────────────────────────
//
// A realistic OCR failure mode: a glare/crop truncates the printed name to a
// shared prefix of two different real cards ("Saruman" prefixes both "Saruman
// of Many Colors" and "Saruman, the White Hand"), so both score a 'prefix'
// name match. When they also tie in overall score and the identified top
// card has exactly one edition in the swept pool, the pre-fix same-card tie
// check could never see this (sameCard.length === 1, so secondScore was
// -Infinity) and silently fell through to 'direct' -- auto-adding whichever
// of the two tied cards the stable sort happened to place first.
{
  const sarumanWhiteHandGroup = group([
    edition({
      scryfall_id: 'id-whitehand-2',
      set_code: 'xyz',
      set_name: 'Some Other Set',
      collector_number: '2',
      scanScore: 9500,
      scanMatches: { name: 'prefix', set: null, collector: null, rarity: null },
    }),
  ], { name: 'Saruman, the White Hand' })

  const saruman1 = sarumanEdition({
    scanScore: 9500,
    scanMatches: { name: 'prefix', set: true, collector: true, rarity: null },
  })
  const decision = routeScannerMatch([
    sarumanGroup([saruman1]),
    sarumanWhiteHandGroup,
  ], { nameQuery: 'saruman', setCode: 'hoc', collectorNumber: '35' })

  assert.equal(decision.kind, 'uncertain')
  assert.equal(decision.reason, 'card-name-tie')
  // Defect S2: "Saruman, the White Hand" may well be the card actually
  // scanned. Blocking the auto-add but then showing only the other card's
  // printings gives the user no way to pick the right one and no hint that
  // two different card names matched, so both tied cards must be listed.
  assert.deepEqual(
    decision.candidates.map(c => c.cardName),
    ['Saruman of Many Colors', 'Saruman, the White Hand'],
    'a shared-prefix cross-card tie must list both tied cards',
  )
  assert.deepEqual(
    decision.candidates.map(c => c.edition.scryfall_id),
    ['id-hoc-35', 'id-whitehand-2'],
  )
}

// A cross-card tie widens the candidate list only to the cards actually tied
// at the top score: a third card sitting lower in the same pool stays out, and
// the tied cards' own lower-scoring editions stay out too.
{
  const tiedTop = sarumanEdition({
    scanScore: 9500,
    scanMatches: { name: 'prefix', set: true, collector: true, rarity: null },
  })
  const sarumanLower = sarumanEdition({
    scryfall_id: 'id-lea-2',
    set_code: 'lea',
    collector_number: '2',
    scanScore: 9100,
    scanMatches: { name: 'prefix', set: true, collector: true, rarity: null },
  })
  const whiteHand = group([
    edition({
      scryfall_id: 'id-whitehand-2',
      set_code: 'xyz',
      collector_number: '2',
      scanScore: 9500,
      scanMatches: { name: 'prefix', set: null, collector: null, rarity: null },
    }),
  ], { name: 'Saruman, the White Hand' })

  const decision = routeScannerMatch([
    sarumanGroup([tiedTop, sarumanLower]),
    whiteHand,
    rikuGroup(), // 9700 top-of-group, but its edition is not at the tied score
  ], { nameQuery: 'saruman', setCode: 'hoc', collectorNumber: '35' })

  assert.equal(decision.reason, 'card-name-tie')
  assert.deepEqual(
    decision.candidates.map(c => c.edition.scryfall_id),
    ['id-hoc-35', 'id-whitehand-2'],
  )
}

// ─── Coverage gap: a 'prefix' top (not just 'exact') must route the same way
// through every printing-evidence-required/conflict/tie/direct path, and must
// never throw. `top` always satisfies its own sameCard filter (cardName
// equality is reflexive), so sameCard always contains at least `top` itself --
// `sameCard[0]` can never read off an empty array, regardless of match kind. ──
{
  const prefixTop = edition({ scanMatches: { name: 'prefix', set: null, collector: null, rarity: null } })
  const decision = routeScannerMatch([group([prefixTop])], { nameQuery: 'lightning' })
  assert.equal(decision.kind, 'uncertain')
  assert.equal(decision.reason, 'printing-evidence-required')
  assert.equal(decision.candidates.length, 1)
}
{
  const prefixTop = edition({ scanMatches: { name: 'prefix', set: false, collector: null, rarity: null } })
  const decision = routeScannerMatch([group([prefixTop])], { nameQuery: 'lightning', setCode: 'zzz' })
  assert.equal(decision.kind, 'uncertain')
  assert.equal(decision.reason, 'printing-evidence-conflict')
}
{
  const first = edition({ scanScore: 9000, scanMatches: { name: 'prefix', set: true, collector: null, rarity: null } })
  const second = edition({
    scryfall_id: 'id-second',
    set_code: 'm10',
    collector_number: '2',
    scanScore: 9000,
    scanMatches: { name: 'prefix', set: true, collector: null, rarity: null },
  })
  const decision = routeScannerMatch([group([first, second])], { nameQuery: 'lightning', setCode: 'mh2' })
  assert.equal(decision.kind, 'uncertain')
  assert.equal(decision.reason, 'printing-tie')
}
{
  const decision = routeScannerMatch([group([
    edition({ scanMatches: { name: 'prefix', set: true, collector: true, rarity: null } }),
  ])], { nameQuery: 'lightning', setCode: 'mh2', collectorNumber: '123' })
  assert.equal(decision.kind, 'direct')
}

// ─── Defect 1 guarantee: the sameCard narrowing survives a widened (paginated)
// pool. "Load more printings" merges another catalog page into the pool and
// must route the result through the SAME decision function used for the
// initial scan -- this proves the library-level guarantee the AddCardModal.js
// call-site fix depends on: calling routeScannerMatch again, with the same
// evidence, over a pool widened by a later page still narrows to the
// identified card's own editions only. ──────────────────────────────────────
{
  const evidence = { nameQuery: 'saruman of many colors' }
  const initialDecision = routeScannerMatch([
    sarumanGroup([sarumanEdition()]),
  ], evidence)
  assert.equal(initialDecision.kind, 'uncertain')
  assert.equal(initialDecision.reason, 'printing-evidence-required')
  assert.deepEqual(initialDecision.candidates.map(c => c.cardName), ['Saruman of Many Colors'])

  // Page 2 arrives and widens the pool with unrelated same-phrase cards.
  const widenedDecision = routeScannerMatch([
    sarumanGroup([sarumanEdition()]),
    merchantGroup(),
    rikuGroup(),
  ], evidence)
  assert.equal(widenedDecision.kind, 'uncertain')
  assert.equal(widenedDecision.reason, 'printing-evidence-required')
  assert.deepEqual(
    widenedDecision.candidates.map(c => c.cardName),
    ['Saruman of Many Colors'],
    '"Load more printings" widening the pool must stay narrowed to the identified card, not reintroduce unrelated cards',
  )
}

// ─── Defect S1: "Load more printings" must never leave the picker inert ────
//
// The append branch re-derives the decision over the widened pool and shows
// `decision.candidates`. When the newly-loaded page is the one holding the
// printing that was actually scanned, that re-derived decision flips from
// uncertain to 'direct' -- and a 'direct' result used to carry no candidates
// at all, so the picker kept showing the OLD, narrower list and the printing
// the user had just loaded was unreachable in scanner mode. The page load must
// not auto-add (that gate lives at the call site and stays), but every
// decision kind has to carry the identified card's narrowed printing list so
// the user can always reach it by hand.
{
  const evidence = extractScanEvidence('Saruman of Many Colors\nHOC • EN 35/301 R')
  assert.equal(evidence.setCode, 'hoc')
  assert.equal(evidence.collectorNumber, '35')

  const sarumanLea = {
    scryfall_id: 'id-lea-2',
    set_code: 'lea',
    set_name: 'Limited Edition Alpha',
    collector_number: '2',
    rarity: 'rare',
    finishes: ['nonfoil'],
  }
  const sarumanHoc = {
    scryfall_id: 'id-hoc-35',
    set_code: 'hoc',
    set_name: 'The Hobbit Eternal',
    collector_number: '35',
    rarity: 'rare',
    finishes: ['nonfoil'],
  }

  // Page 1 of the swept pool does not hold the scanned printing yet, so the
  // printing clues conflict with the only edition retrieved.
  const scanTime = routeScannerMatch(rankScannerResults([
    sarumanGroup([sarumanLea]),
    merchantGroup(),
  ], evidence), evidence)
  assert.equal(scanTime.kind, 'uncertain')
  assert.equal(scanTime.reason, 'printing-evidence-conflict')
  assert.deepEqual(scanTime.candidates.map(c => c.edition.scryfall_id), ['id-lea-2'])

  // "Load more printings" brings the real printing in, which makes the SAME
  // evidence unambiguous.
  const appended = routeScannerMatch(rankScannerResults([
    sarumanGroup([sarumanLea, sarumanHoc]),
    merchantGroup(),
  ], evidence), evidence)
  assert.equal(appended.kind, 'direct')
  assert.equal(appended.candidate.edition.scryfall_id, 'id-hoc-35')

  // The picker the append branch renders from must stay usable.
  assert.ok(Array.isArray(appended.candidates), 'a direct decision must still carry a candidate list for the picker')
  assert.ok(appended.candidates.length > 0, 'the picker must not go empty when the decision becomes confident')
  assert.deepEqual(
    [...new Set(appended.candidates.map(c => c.cardName))],
    ['Saruman of Many Colors'],
    'the widened picker stays narrowed to the identified card',
  )
  assert.ok(
    appended.candidates.some(c => c.edition.scryfall_id === 'id-hoc-35'),
    'the printing the user just loaded must be reachable in the picker, not only auto-addable',
  )
  // And it is a real widening, not the same list the scan already showed.
  assert.notDeepEqual(
    appended.candidates.map(c => c.edition.scryfall_id),
    scanTime.candidates.map(c => c.edition.scryfall_id),
  )
}

// Every narrowed decision kind carries the same list, so the append branch
// needs no kind-specific special case to keep the picker populated.
{
  const evidence = { nameQuery: 'lightning bolt', setCode: 'mh2', collectorNumber: '123' }
  const direct = routeScannerMatch([group([
    edition({ scanMatches: { name: 'exact', set: true, collector: true, rarity: null } }),
    edition({
      scryfall_id: 'id-lea-161',
      set_code: 'lea',
      collector_number: '161',
      scanScore: 9750,
      scanMatches: { name: 'exact', set: false, collector: false, rarity: null },
    }),
  ]), merchantGroup()], evidence)
  assert.equal(direct.kind, 'direct')
  assert.deepEqual(direct.candidates.map(c => c.edition.scryfall_id), ['id-mh2-123', 'id-lea-161'])
  assert.deepEqual([...new Set(direct.candidates.map(c => c.cardName))], ['Lightning Bolt'])
  // The auto-add target is still named separately and is unchanged.
  assert.equal(direct.candidate.edition.scryfall_id, 'id-mh2-123')
}

// ─── Minor: "evidence present" must mean the same thing to printingFields as
// it does to rankScannerResults ─────────────────────────────────────────────
//
// rankScannerResults only scores a set code / collector number that parses as
// one (SET_CODE_RE / COLLECTOR_RE), so a garbage read gets no match/miss delta
// and leaves scanMatches.set / .collector null. printingFields used a bare
// non-empty-string check, so it counted that same garbage read as present
// evidence, found `matches[field] !== true`, and reported
// 'printing-evidence-conflict' -- a mislabeled reason (it fails safe, but
// tells the user a printing clue disagreed when none was ever usable).
{
  for (const unusable of [
    { nameQuery: 'lightning bolt', setCode: 'toolongsetcode' },
    { nameQuery: 'lightning bolt', setCode: 'x' },
    { nameQuery: 'lightning bolt', collectorNumber: '12345678' },
    { nameQuery: 'lightning bolt', collectorNumber: 'abc' },
  ]) {
    const ranked = rankScannerResults([{
      name: 'Lightning Bolt',
      editions: [{ scryfall_id: 'id-mh2-123', set_code: 'mh2', collector_number: '123', rarity: 'uncommon' }],
    }], unusable)
    // The ranker treats the unusable field as absent, not as a mismatch.
    assert.equal(ranked[0].editions[0].scanMatches.set, null)
    assert.equal(ranked[0].editions[0].scanMatches.collector, null)

    const decision = routeScannerMatch(ranked, unusable)
    assert.equal(decision.kind, 'uncertain')
    assert.equal(
      decision.reason,
      'printing-evidence-required',
      `an unusable printing read (${JSON.stringify(unusable)}) is absent evidence, not conflicting evidence`,
    )
  }

  // A usable-but-wrong read is still a real conflict, unchanged.
  {
    const evidence = { nameQuery: 'lightning bolt', setCode: 'zzz' }
    const ranked = rankScannerResults([{
      name: 'Lightning Bolt',
      editions: [{ scryfall_id: 'id-mh2-123', set_code: 'mh2', collector_number: '123', rarity: 'uncommon' }],
    }], evidence)
    assert.equal(ranked[0].editions[0].scanMatches.set, false)
    assert.equal(routeScannerMatch(ranked, evidence).reason, 'printing-evidence-conflict')
  }

  // Rarity keeps its existing non-empty-string notion of "present", because
  // that is exactly what rankScannerResults uses for rarity too.
  {
    const evidence = { nameQuery: 'lightning bolt', rarity: 'rare' }
    const ranked = rankScannerResults([{
      name: 'Lightning Bolt',
      editions: [{ scryfall_id: 'id-mh2-123', set_code: 'mh2', collector_number: '123', rarity: 'uncommon' }],
    }], evidence)
    assert.equal(ranked[0].editions[0].scanMatches.rarity, false)
    assert.equal(routeScannerMatch(ranked, evidence).reason, 'printing-evidence-conflict')
  }
}

// 'no-candidates' and 'strong-name-required' fire before a card name has
// been confidently identified, so they must keep showing the FULL,
// unfiltered pool -- unchanged, existing behavior.
{
  const decision = routeScannerMatch([], { nameQuery: 'saruman of many colors' })
  assert.equal(decision.kind, 'uncertain')
  assert.equal(decision.reason, 'no-candidates')
  assert.deepEqual(decision.candidates, [])
}
{
  const weakSaruman = sarumanEdition({ scanMatches: { name: 'fuzzy', set: null, collector: null, rarity: null } })
  const decision = routeScannerMatch([
    sarumanGroup([weakSaruman]),
    merchantGroup(),
    rikuGroup(),
  ], { nameQuery: 'saruman of many colours' })

  assert.equal(decision.kind, 'uncertain')
  assert.equal(decision.reason, 'strong-name-required')
  assert.deepEqual(
    decision.candidates.map(c => c.cardName),
    ['Saruman of Many Colors', 'Merchant of Many Hats', 'Riku of Many Paths'],
    'the full unfiltered pool must still show when the scanner is not yet sure which card this is',
  )
}

// ─── Round 5: a top-score tie across DISTINCT cards must be detected before the
// evidence-required / evidence-conflict early returns. Real ranker, real OCR
// read "saruman" (a shared prefix of two card names). ───────────────────────
{
  const rawEdition = (id, setCode, collector, rarity = 'rare') => ({
    scryfall_id: id,
    set_code: setCode,
    set_name: `Set ${setCode.toUpperCase()}`,
    collector_number: collector,
    rarity,
    finishes: ['nonfoil'],
  })
  const pool = () => [
    { name: 'Saruman of Many Colors', editions: [rawEdition('id-hoc-35', 'hoc', '35'), rawEdition('id-lea-2', 'lea', '2')] },
    { name: 'Saruman, the White Hand', editions: [rawEdition('id-wh-9', 'ltr', '9')] },
    { name: 'Riku of Many Paths', editions: [rawEdition('id-otj-227', 'otj', '227')] },
  ]
  const route = evidence => {
    const ranked = rankScannerResults(pool(), evidence)
    return { ranked, decision: routeScannerMatch(ranked, evidence) }
  }
  const names = decision => decision.candidates.map(c => c.cardName)
  const ids = decision => decision.candidates.map(c => c.edition.scryfall_id)

  // Name-only: both cards prefix-match and tie; both must be offered, with every
  // edition tied at the top score and nothing lower.
  {
    const { ranked, decision } = route({ nameQuery: 'saruman' })
    const topScores = ranked.flatMap(g => g.editions.map(e => e.scanScore))
    assert.equal(ranked[0].editions[0].scanScore, ranked[1].editions[0].scanScore, 'fixture must be a real cross-card tie')
    assert.equal(Math.max(...topScores), ranked[0].editions[0].scanScore)
    assert.equal(decision.kind, 'uncertain')
    assert.equal(decision.reason, 'card-name-tie')
    assert.deepEqual([...new Set(names(decision))].sort(), ['Saruman of Many Colors', 'Saruman, the White Hand'])
    assert.ok(ids(decision).includes('id-wh-9'), 'the alternate card must not be hidden')
    assert.ok(!ids(decision).includes('id-otj-227'), 'lower-scoring cards stay excluded')
    assert.ok(decision.candidates.every(c => c.edition.scanScore === ranked[0].editions[0].scanScore))
  }

  // Conflicting printing evidence (usable set code that matches nothing).
  {
    const { decision } = route({ nameQuery: 'saruman', setCode: 'zzz' })
    assert.equal(decision.kind, 'uncertain')
    assert.equal(decision.reason, 'card-name-tie')
    assert.ok(ids(decision).includes('id-wh-9'))
    assert.ok(!ids(decision).includes('id-otj-227'))
  }

  // Malformed / unusable printing evidence is absent evidence, still a card tie.
  for (const unusable of [
    { nameQuery: 'saruman', setCode: 'toolongsetcode' },
    { nameQuery: 'saruman', collectorNumber: 'abc' },
  ]) {
    const { decision } = route(unusable)
    assert.equal(decision.kind, 'uncertain')
    assert.equal(decision.reason, 'card-name-tie', JSON.stringify(unusable))
    assert.ok(ids(decision).includes('id-wh-9'))
  }

  // Matching printing evidence that makes only one card's edition best is NOT a
  // card tie: the matching edition outscores the other card.
  {
    const { decision } = route({ nameQuery: 'saruman', setCode: 'hoc', collectorNumber: '35' })
    assert.equal(decision.kind, 'direct')
    assert.equal(decision.candidate.edition.scryfall_id, 'id-hoc-35')
    assert.deepEqual([...new Set(names(decision))], ['Saruman of Many Colors'])
  }

  // Matching evidence tying across both cards still lists both (no auto-add).
  {
    const tiedPool = [
      { name: 'Saruman of Many Colors', editions: [rawEdition('id-hoc-35', 'hoc', '35')] },
      { name: 'Saruman, the White Hand', editions: [rawEdition('id-wh-35', 'hoc', '35')] },
    ]
    const evidence = { nameQuery: 'saruman', setCode: 'hoc', collectorNumber: '35' }
    const decision = routeScannerMatch(rankScannerResults(tiedPool, evidence), evidence)
    assert.equal(decision.kind, 'uncertain')
    assert.equal(decision.reason, 'card-name-tie')
    assert.deepEqual(names(decision), ['Saruman of Many Colors', 'Saruman, the White Hand'])
  }

  // Within-card tie keeps the printing-tie reason and stays narrowed.
  {
    const evidence = { nameQuery: 'lightning bolt', rarity: 'rare' }
    const ranked = rankScannerResults([
      { name: 'Lightning Bolt', editions: [rawEdition('a', 'mh2', '1'), rawEdition('b', 'm10', '2')] },
      { name: 'Lightning Helix', editions: [rawEdition('c', 'rav', '3', 'common')] },
    ], evidence)
    const decision = routeScannerMatch(ranked, evidence)
    assert.equal(decision.reason, 'printing-tie')
    assert.deepEqual([...ids(decision)].sort(), ['a', 'b'])
  }

  // Non-tied cross-card candidate: the single-card narrowing is preserved.
  {
    const evidence = { nameQuery: 'saruman of many colors' }
    const ranked = rankScannerResults(pool(), evidence)
    const decision = routeScannerMatch(ranked, evidence)
    assert.equal(decision.reason, 'printing-evidence-required')
    assert.deepEqual([...new Set(names(decision))], ['Saruman of Many Colors'])
  }

  // Load more: the decision is re-derived and no step auto-adds. A widened pool
  // that dissolves the tie yields a direct decision, which carries candidates
  // for manual selection; the call site only auto-adds on !append.
  {
    const evidence = { nameQuery: 'saruman', setCode: 'hoc', collectorNumber: '35' }
    const page1 = [
      { name: 'Saruman of Many Colors', editions: [rawEdition('id-lea-2', 'lea', '2')] },
      { name: 'Saruman, the White Hand', editions: [rawEdition('id-wh-9', 'ltr', '9')] },
    ]
    const before = routeScannerMatch(rankScannerResults(page1, evidence), evidence)
    assert.equal(before.reason, 'card-name-tie')
    const page2 = [
      { name: 'Saruman of Many Colors', editions: [rawEdition('id-lea-2', 'lea', '2'), rawEdition('id-hoc-35', 'hoc', '35')] },
      page1[1],
    ]
    const after = routeScannerMatch(rankScannerResults(page2, evidence), evidence)
    assert.equal(after.kind, 'direct')
    assert.ok(Array.isArray(after.candidates) && after.candidates.length > 0)
  }

  // The modal's append branch must refresh the reason too, not only candidates,
  // and must still never auto-add on append.
  const modalSource = readFileSync(new URL('../src/components/AddCardModal.js', import.meta.url), 'utf8')
  assert.match(modalSource, /reason:\s*scannerSelectionReason\(decision\)/)
  assert.match(modalSource, /!append && decision\.kind === 'direct'/)
}

// Shelf creation is scanner-only; manual catalog selections cannot enter it.
{
  const manual = addScannerShelfItem([], {
    source: 'manual',
    cardName: 'Lightning Bolt',
    edition: edition(),
  })
  assert.deepEqual(manual, [])
}

// Opening the scanner closes the ordinary add-form route. A scan candidate can
// enter only the scanner shelf; manual add returns only after explicit exit.
{
  assert.equal(routeCatalogSelection({ scannerOpen: true, hasScanEvidence: false }), 'blocked')
  assert.equal(routeCatalogSelection({ scannerOpen: true, hasScanEvidence: true }), 'scanner-shelf')
  assert.equal(routeCatalogSelection({ scannerOpen: false, hasScanEvidence: false }), 'manual-add')
}

let shelf = addScannerShelfItem([], {
  source: 'scanner-direct',
  cardName: 'Lightning Bolt',
  edition: edition(),
})
assert.equal(shelf.length, 1)
assert.equal(shelf[0].quantity, 1)
assert.equal(shelf[0].finish, 'nonfoil')
assert.equal(shelf[0].selected, true)
// Shelf identity is printing + finish, so the key names both.
assert.equal(shelf[0].shelfId, 'id-mh2-123:nonfoil')

// Shelf rows can be deselected without being deleted. Batch confirmation must
// include only rows the user has explicitly left selected.
{
  const second = addScannerShelfItem(shelf, {
    source: 'scanner-confirmed',
    cardName: 'Counterspell',
    edition: edition({
      scryfall_id: 'id-mh2-267',
      collector_number: '267',
    }),
  })
  const reviewed = editScannerShelfItem(second, 'id-mh2-123:nonfoil', { selected: false })
  assert.equal(reviewed.length, 2)
  assert.equal(reviewed[0].selected, false)
  assert.equal(reviewed[1].selected, true)
  assert.deepEqual(buildScannerBatchPayload(reviewed, {
    binderId: 'binder-1',
    condition: 'NM',
  }), {
    binder_id: 'binder-1',
    cards: [{
      scryfall_id: 'id-mh2-267',
      quantity: 1,
      foil: 'normal',
      condition: 'NM',
    }],
  })
}

// Repeated scans of the same printing AND finish compact into quantity.
shelf = addScannerShelfItem(shelf, {
  source: 'scanner-confirmed',
  cardName: 'Lightning Bolt',
  edition: edition(),
})
assert.equal(shelf.length, 1)
assert.equal(shelf[0].quantity, 2)

// Quantity and supported finish are editable; unsupported finishes are ignored.
// Editing the finish re-keys the row, because finish is part of its identity.
shelf = editScannerShelfItem(shelf, 'id-mh2-123:nonfoil', { quantity: 4, finish: 'foil' })
assert.equal(shelf[0].quantity, 4)
assert.equal(shelf[0].finish, 'foil')
assert.equal(shelf[0].shelfId, 'id-mh2-123:foil')
shelf = editScannerShelfItem(shelf, 'id-mh2-123:foil', { quantity: 0, finish: 'etched' })
assert.equal(shelf[0].quantity, 1)
assert.equal(shelf[0].finish, 'foil')
assert.equal(shelf[0].shelfId, 'id-mh2-123:foil')

// Re-scanning a printing whose shelf row is now foil opens a separate nonfoil
// row: one Scryfall printing can sit on the shelf once per finish.
shelf = addScannerShelfItem(shelf, {
  source: 'scanner-direct',
  cardName: 'Lightning Bolt',
  edition: edition(),
})
assert.equal(shelf.length, 2)
assert.deepEqual(shelf.map(item => [item.shelfId, item.finish, item.quantity]), [
  ['id-mh2-123:foil', 'foil', 1],
  ['id-mh2-123:nonfoil', 'nonfoil', 1],
])

// A further nonfoil scan increments only the nonfoil row.
shelf = addScannerShelfItem(shelf, {
  source: 'scanner-confirmed',
  cardName: 'Lightning Bolt',
  edition: edition(),
})
assert.equal(shelf.length, 2)
assert.deepEqual(shelf.map(item => item.quantity), [1, 2])

// A2: finish collisions merge quantities atomically; the old shelf is Undo.
{
  const collided = editScannerShelfItem(shelf, 'id-mh2-123:nonfoil', { finish: 'foil' })
  assert.equal(collided.length, 1)
  assert.deepEqual(collided.map(item => [item.shelfId, item.finish, item.quantity]), [
    ['id-mh2-123:foil', 'foil', 3],
  ])
  assert.deepEqual(shelf.map(item => item.quantity), [1, 2], 'Undo snapshot is unchanged')
}

// Batch payload maps catalog nonfoil to the existing API's `normal` value, emits
// one line per finish, and excludes any forged/manual shelf rows. The binder is
// named once for the whole request, because the batch lands in one binder.
{
  const payload = buildScannerBatchPayload([
    ...shelf,
    { ...shelf[0], shelfId: 'forged', source: 'manual', scryfallId: 'manual-id' },
  ], { binderId: 'binder-1', condition: 'LP' })
  assert.deepEqual(payload, {
    binder_id: 'binder-1',
    cards: [
      {
        scryfall_id: 'id-mh2-123',
        quantity: 1,
        foil: 'foil',
        condition: 'LP',
      },
      {
        scryfall_id: 'id-mh2-123',
        quantity: 2,
        foil: 'normal',
        condition: 'LP',
      },
    ],
  })
}

// Without a binder, or with nothing selected, there is no request to send at
// all — the caller gets null rather than an empty batch the server would reject.
{
  assert.equal(buildScannerBatchPayload(shelf, { condition: 'NM' }), null)
  assert.equal(buildScannerBatchPayload(shelf, { binderId: '  ', condition: 'NM' }), null)
  assert.equal(buildScannerBatchPayload([], { binderId: 'binder-1', condition: 'NM' }), null)
  assert.equal(buildScannerBatchPayload(null, { binderId: 'binder-1', condition: 'NM' }), null)
  assert.equal(buildScannerBatchPayload(
    shelf.map(item => ({ ...item, selected: false })),
    { binderId: 'binder-1', condition: 'NM' },
  ), null)
}

// Etched is a first-class shelf finish alongside nonfoil and foil.
{
  const etchedEdition = edition({ finishes: ['nonfoil', 'foil', 'etched'] })
  let etchedShelf = addScannerShelfItem([], {
    source: 'scanner-direct',
    cardName: 'Lightning Bolt',
    edition: etchedEdition,
  })
  etchedShelf = editScannerShelfItem(etchedShelf, 'id-mh2-123:nonfoil', { finish: 'etched' })
  assert.equal(etchedShelf[0].shelfId, 'id-mh2-123:etched')
  etchedShelf = addScannerShelfItem(etchedShelf, {
    source: 'scanner-direct',
    cardName: 'Lightning Bolt',
    edition: etchedEdition,
  })
  assert.deepEqual(etchedShelf.map(item => [item.shelfId, item.finish]), [
    ['id-mh2-123:etched', 'etched'],
    ['id-mh2-123:nonfoil', 'nonfoil'],
  ])
  assert.deepEqual(buildScannerBatchPayload(etchedShelf, {
    binderId: 'binder-1',
    condition: 'NM',
  }).cards.map(row => row.foil), ['etched', 'normal'])
}

shelf = removeScannerShelfItem(shelf, 'id-mh2-123:foil')
shelf = removeScannerShelfItem(shelf, 'id-mh2-123:nonfoil')
assert.deepEqual(shelf, [])

// The shelf UI exposes selection separately from deletion and computes batch
// confirmation from selected rows only.
{
  const panelSource = readFileSync(new URL('../src/components/CardScannerPanel.js', import.meta.url), 'utf8')
  assert.match(panelSource, /type="checkbox"[\s\S]*checked=\{item\.selected\}[\s\S]*selected: event\.target\.checked/)
  assert.match(panelSource, /selectedQuantity[\s\S]*disabled=\{confirming \|\| recovery \|\| !binderId \|\| selectedQuantity === 0\}/)
}

// ─── Candidate pool beyond the first catalog page ─────────────────────────

// The candidate list the scanner shows is derivable from ranked groups alone,
// so an appended page can refresh it without re-deciding the match.
{
  const candidates = listScannerCandidates([
    group([edition()]),
    group([edition({ scryfall_id: 'id-lea-161', set_code: 'lea' })], { name: 'Bolt Two' }),
    null,
    { name: 'No editions', editions: null },
    group([edition({ scryfall_id: null })], { name: 'Unusable' }),
  ])
  assert.deepEqual(candidates.map(candidate => candidate.edition.scryfall_id), ['id-mh2-123', 'id-lea-161'])
  assert.deepEqual(candidates.map(candidate => candidate.cardName), ['Lightning Bolt', 'Bolt Two'])
  assert.deepEqual(listScannerCandidates(null), [])
}

// A scan whose printing is not in the first page of catalog rows must be able to
// reach it: the pool sweeps more pages, bounded, while the match stays uncertain.
{
  const evidence = { nameQuery: 'lightning bolt', setCode: 'mh2', collectorNumber: '123' }
  const uncertain = { kind: 'uncertain', reason: 'printing-evidence-conflict' }

  assert.equal(shouldSweepAnotherScanPage({ pagesFetched: 1, hasMore: true, decision: uncertain, evidence }), true)
  assert.equal(shouldSweepAnotherScanPage({
    pagesFetched: 1,
    hasMore: true,
    decision: { kind: 'uncertain', reason: 'strong-name-required' },
    evidence,
  }), true)

  // The sweep is bounded: it never runs past the page cap, past the last page,
  // or after the pool has already produced a confident printing.
  assert.equal(SCAN_POOL_MAX_PAGES, 3)
  assert.equal(shouldSweepAnotherScanPage({ pagesFetched: SCAN_POOL_MAX_PAGES, hasMore: true, decision: uncertain, evidence }), false)
  assert.equal(shouldSweepAnotherScanPage({ pagesFetched: 1, hasMore: false, decision: uncertain, evidence }), false)
  assert.equal(shouldSweepAnotherScanPage({
    pagesFetched: 1,
    hasMore: true,
    decision: { kind: 'direct', candidate: { edition: edition() } },
    evidence,
  }), false)

  // The primary metric is name-group top-five, so name-only scans sweep the same
  // bounded pool even though they can never auto-select a printing.
  assert.equal(shouldSweepAnotherScanPage({
    pagesFetched: 1,
    hasMore: true,
    decision: uncertain,
    evidence: { nameQuery: 'lightning bolt' },
  }), true)
  assert.equal(shouldSweepAnotherScanPage({
    pagesFetched: 1,
    hasMore: true,
    decision: uncertain,
    evidence: { nameQuery: 'lightning bolt', rarity: 'rare' },
  }), true)

  // Malformed input is an expected scanner state, never a crash.
  assert.equal(shouldSweepAnotherScanPage(), false)
  assert.equal(shouldSweepAnotherScanPage({ pagesFetched: 0, hasMore: true, decision: uncertain, evidence }), false)
}

// While the scanner is open, the ordinary search/filter/results controls are
// not rendered and edition clicks cannot route into the ordinary add form.
{
  const modalSource = readFileSync(new URL('../src/components/AddCardModal.js', import.meta.url), 'utf8')
  assert.match(modalSource, /routeCatalogSelection\(\{\s*scannerOpen: showScanner,\s*hasScanEvidence: Boolean\(scanEvidence\),\s*\}\)/)
  assert.match(modalSource, /\{!showScanner && \(\s*<>\s*\{\/\* Search input/)
  assert.match(modalSource, /const handleAdd = async \(payload\) => \{\s*if \(showScanner\) return/)

  // Scanner retrieval asks for the scan-gated name matching, sweeps a bounded
  // number of pages into one pool, and decides once over that pool.
  assert.match(modalSource, /params\.set\('scan', '1'\)/)
  assert.match(modalSource, /shouldSweepAnotherScanPage\(/)
  assert.match(modalSource, /mergeSearchGroups\(pool, data\.groups \|\| \[\]\)/)

  // A user-triggered page load only widens the choice list. Auto-add stays tied
  // to the scan-time decision, so pagination can never add a card by itself.
  assert.match(modalSource, /if \(!append && .*kind === 'direct'\)/)

  // Adversarial-review blocking defect: "Load more printings" must route the
  // widened pool through the SAME routeScannerMatch decision as the initial
  // scan and reuse its already-narrowed candidates -- not a raw, unfiltered
  // flatten of the whole widened pool (listScannerCandidates(ranked)), which
  // would reintroduce unrelated cards the initial narrowing had excluded (the
  // real "Saruman of Many Colors" UAT bug, reintroduced specifically by
  // clicking "Load more").
  assert.match(
    modalSource,
    /\.\.\.current, reason: scannerSelectionReason\(decision\), candidates: decision\.candidates/,
    'the append branch must reuse the already-narrowed decision.candidates from routeScannerMatch',
  )
  assert.doesNotMatch(
    modalSource,
    /candidates: listScannerCandidates\(ranked\)/,
    'the append branch must not substitute the raw unfiltered pool for the narrowed decision',
  )

  // Defect S1: the append branch must not skip the update when the widened
  // pool makes the decision 'direct' -- that is precisely the case where the
  // user just loaded the printing they were looking for, and leaving the old
  // narrower list on screen makes it unreachable. Only the auto-add gate is
  // allowed to care about the kind here.
  const appendBranch = modalSource.match(/if \(append\) \{[\s\S]*?\n        \} else \{/)?.[0]
  assert.ok(appendBranch, 'the append branch of doSearch not found')
  assert.doesNotMatch(
    appendBranch,
    /decision\.kind/,
    'a page load must widen the picker for every decision kind, including direct',
  )

  // The candidate list itself is reachable past page one from the scanner panel.
  // The control lives in the printing-selection panel; the modal supplies the
  // pool tail and the loader it drives.
  assert.match(modalSource, /<PrintingSelectionPanel[\s\S]*?onLoadMore=\{handleLoadMore\}/)
  const selectionSource = readFileSync(new URL('../src/components/ScannerPrintingSelection.js', import.meta.url), 'utf8')
  assert.match(selectionSource, /Load more printings/)

  // Confirming the shelf is one all-or-nothing request, not a per-row loop: a
  // mid-loop failure used to leave part of a scan session in the library with
  // no record of which rows landed.
  const batchStart = modalSource.indexOf('  const handleScannerBatchAdd = async (')
  const batchEnd = modalSource.indexOf('  const acknowledgeScannerLibraryCheck', batchStart)
  assert.ok(batchStart >= 0 && batchEnd > batchStart)
  const batchAdd = modalSource.slice(batchStart, batchEnd)
  assert.ok(batchAdd, 'handleScannerBatchAdd not found')
  assert.match(batchAdd, /fetch\('\/api\/library\/add\/batch'/)
  assert.equal(batchAdd.match(/await fetch\(/g)?.length, 1)
  assert.doesNotMatch(batchAdd, /for\s*\(|\.map\([\s\S]*fetch|Promise\.all/)
  assert.match(batchAdd, /body: JSON\.stringify\(\{ \.\.\.request.snapshot, batchId: request.batchId \}\)/)

  // Ordinary manual adds keep using the existing single-card route.
  assert.match(modalSource, /const handleAdd = async \(payload\) => \{[\s\S]*?fetch\('\/api\/library\/add'/)
}

// ─── Leaving the scanner with a non-empty shelf ───────────────────────────

const pending = (overrides = {}) => ({
  shelfId: 'id-mh2-123:nonfoil',
  source: 'scanner-direct',
  scryfallId: 'id-mh2-123',
  finish: 'nonfoil',
  quantity: 1,
  selected: true,
  ...overrides,
});

// Submitting takes synchronous ownership; uncertain failure is never retry consent.
{
  const lifecycle = createScannerBatchLifecycle()
  const payload = buildScannerBatchPayload([pending()], { binderId: 'binder-1' })
  const request = lifecycle.begin(payload)
  assert.ok(request)
  assert.equal(lifecycle.canMutate(), false)
  assert.equal(lifecycle.begin(payload), null)
  assert.equal(Object.isFrozen(request.snapshot), true)
  assert.equal(Object.isFrozen(request.snapshot.cards), true)
  assert.equal(Object.isFrozen(request.snapshot.cards[0]), true)
  assert.notEqual(request.snapshot.cards[0], payload.cards[0])
  let shelfQuantity = 2
  if (lifecycle.canMutate()) shelfQuantity = 9
  assert.equal(shelfQuantity, 2)
  assert.equal(lifecycle.fail(request), true)
  assert.equal(lifecycle.canMutate(), false, 'uncertain failure keeps the shelf frozen')
  assert.equal(lifecycle.begin(payload), null)
  assert.equal(lifecycle.commit(request), false, 'unknown outcome cannot become a late success')
  assert.deepEqual(lifecycle.unknownSnapshot(), payload)
  assert.equal(lifecycle.continueAfterCheck(), true)
  assert.equal(lifecycle.canMutate(), true)
}

// Known acknowledgement and local settlement release ownership exactly once.
{
  const lifecycle = createScannerBatchLifecycle()
  const request = lifecycle.begin()
  assert.equal(lifecycle.commit(request), true)
  assert.equal(lifecycle.canMutate(), true)
  assert.equal(lifecycle.commit(request), false)
}

// Unmount invalidates continuations, not the fact that a request was submitted.
{
  const lifecycle = createScannerBatchLifecycle()
  const request = lifecycle.begin()
  lifecycle.invalidate()
  assert.equal(lifecycle.isMounted(), false)
  assert.equal(lifecycle.commit(request), false)
  assert.equal(lifecycle.fail(request), false)
  lifecycle.arm()
  assert.equal(lifecycle.isMounted(), true)
  assert.equal(lifecycle.canMutate(), false, 'StrictMode rearm retains the freeze')
  assert.equal(lifecycle.begin(), null)
  assert.equal(lifecycle.commit(request), false, 'old generation remains inert after rearm')
  const idle = createScannerBatchLifecycle()
  idle.invalidate(); idle.arm()
  assert.equal(idle.canMutate(), true, 'idle StrictMode rearm stays usable')
  assert.ok(idle.begin())
}

// HTTP status alone is not a usable acknowledgement. Match the existing contract.
{
  const data = { ok: true, inserted: 2, merged: 1, requested: 3, rows: 3 }
  assert.equal(classifyBatchResponse({ ok: true, data, requested: 3 }), 'commit')
  assert.equal(classifyBatchResponse({ ok: true }), 'unknown')
  assert.equal(classifyBatchResponse({ ok: false, data, requested: 3 }), 'unknown')
  for (const patch of [{ ok: false }, { requested: 2 }, { rows: 2 }, { inserted: -1 },
    { merged: '1' }, { inserted: 1 }, { inserted: 1.5 }]) {
    assert.equal(classifyBatchResponse({ ok: true, data: { ...data, ...patch }, requested: 3 }), 'unknown')
  }
  assert.deepEqual(await parseBatchResponseBody({ json: async () => data }), data)
  const truncated = { ok: true, json: () => Promise.reject(new Error('Unexpected end of JSON input')) }
  const unreadable = await parseBatchResponseBody(truncated)
  assert.deepEqual(unreadable, {})
  assert.equal(classifyBatchResponse({ ok: truncated.ok, data: unreadable, requested: 3 }), 'unknown')
}

// Once the transactional batch write starts, every destructive modal exit is
// blocked — including an already-open prompt's explicit discard action. The
// shelf remains owned by the mounted modal until the request settles.
{
  const resolveScannerBatchExit = scannerSession.resolveScannerBatchExit
  assert.equal(typeof resolveScannerBatchExit, 'function', 'scanner batch exit guard must exist')
  const shelf = [pending({ quantity: 2 })]
  assert.deepEqual(resolveScannerBatchExit({ exit: 'close', shelf, batchPending: true }), {
    kind: 'blocked',
    rows: 1,
    quantity: 2,
  })
  assert.deepEqual(resolveScannerBatchExit({
    exit: 'close',
    shelf,
    discardConfirmed: true,
    batchPending: true,
  }), {
    kind: 'blocked',
    rows: 1,
    quantity: 2,
  })
  assert.equal(resolveScannerBatchExit({ exit: 'close', shelf }).kind, 'confirm')
}

// What is at stake is counted in both rows and cards, because one row can be
// nine cards. Deselected rows still count: they are scanned, just not chosen.
{
  assert.deepEqual(pendingShelfSummary([]), { rows: 0, quantity: 0 })
  assert.deepEqual(pendingShelfSummary(null), { rows: 0, quantity: 0 })
  assert.deepEqual(pendingShelfSummary([
    pending({ quantity: 2 }),
    pending({ shelfId: 'id-mh2-123:foil', finish: 'foil', quantity: 3, selected: false }),
  ]), { rows: 2, quantity: 5 })
  // Quantities are clamped the same way the shelf clamps them, so a corrupted
  // row cannot inflate or NaN the warning the user reads.
  assert.deepEqual(pendingShelfSummary([pending({ quantity: 0 })]), { rows: 1, quantity: 1 })
  assert.deepEqual(pendingShelfSummary([pending({ quantity: 99999 })]), { rows: 1, quantity: 9999 })
  assert.deepEqual(pendingShelfSummary([pending({ quantity: 'x' })]), { rows: 1, quantity: 1 })
  // Only scanner-originated rows are the scanner's to warn about.
  assert.deepEqual(pendingShelfSummary([pending({ source: 'manual' })]), { rows: 0, quantity: 0 })
  assert.deepEqual(pendingShelfSummary([pending({ scryfallId: '' })]), { rows: 0, quantity: 0 })
}

// An empty shelf never interrupts any exit.
{
  for (const exit of ['close', 'manual', 'clear', 'batch-confirmed']) {
    assert.deepEqual(resolveScannerExit({ exit, shelf: [] }), { kind: 'proceed', rows: 0, quantity: 0 })
  }
  assert.deepEqual(resolveScannerExit(), { kind: 'proceed', rows: 0, quantity: 0 })
}

// Closing the modal destroys the shelf, so it must be confirmed first — and only
// an explicit confirmation turns into an actual discard.
{
  const shelf = [pending({ quantity: 2 }), pending({ shelfId: 'b:nonfoil', scryfallId: 'b', quantity: 3 })]
  assert.deepEqual(resolveScannerExit({ exit: 'close', shelf }), { kind: 'confirm', rows: 2, quantity: 5 })
  assert.deepEqual(resolveScannerExit({ exit: 'close', shelf, discardConfirmed: true }), {
    kind: 'discard',
    rows: 2,
    quantity: 5,
  })
  // Confirmation is a boolean decision, not any truthy leftover (an event object
  // reaching this argument must not read as consent).
  assert.equal(resolveScannerExit({ exit: 'close', shelf, discardConfirmed: 'yes' }).kind, 'confirm')
  assert.equal(resolveScannerExit({ exit: 'close', shelf, discardConfirmed: {} }).kind, 'confirm')

  // Leaving scanner mode is not losing the shelf: it is held for resuming.
  assert.deepEqual(resolveScannerExit({ exit: 'manual', shelf }), { kind: 'preserve', rows: 2, quantity: 5 })
  assert.deepEqual(resolveScannerExit({ exit: 'clear', shelf }), { kind: 'preserve', rows: 2, quantity: 5 })
  // Confirming the batch already wrote these rows, so closing is not a loss.
  assert.deepEqual(resolveScannerExit({ exit: 'batch-confirmed', shelf }), { kind: 'proceed', rows: 2, quantity: 5 })

  // An exit this module does not recognise is treated as destructive. A new exit
  // path added upstream must fail closed, never silently drop pending scans.
  assert.equal(resolveScannerExit({ exit: 'teleport', shelf }).kind, 'confirm')
  assert.equal(resolveScannerExit({ shelf }).kind, 'confirm')
}

// The modal routes every exit through the guard.
{
  const modalSource = readFileSync(new URL('../src/components/AddCardModal.js', import.meta.url), 'utf8')

  // handleClose asks the guard and stops short of onClose when it says confirm
  // or when the transactional batch request still owns the session.
  const handleClose = modalSource.match(/const handleClose = useCallback\(\(\) => \{[\s\S]*?\n  \}, \[[^\]]*\]\)/)?.[0]
  assert.ok(handleClose, 'handleClose not found')
  assert.match(handleClose, /resolveScannerBatchExit\(\{[\s\S]*batchPending: scannerBatchPendingRef\.current[\s\S]*exit: 'close'[\s\S]*shelf: scannerShelfRef\.current/)
  assert.match(handleClose, /=== 'confirm'/)
  assert.match(handleClose, /=== 'blocked'/)
  assert.doesNotMatch(handleClose, /onClose\(\)/)

  // Explicit discard is guarded by the same synchronous request-ownership ref,
  // so a stale prompt click cannot clear the shelf before React re-renders.
  const confirmDiscard = modalSource.match(/const confirmScannerDiscard = useCallback\(\(\) => \{[\s\S]*?\n  \}, \[[^\]]*\]\)/)?.[0]
  assert.ok(confirmDiscard, 'confirmScannerDiscard not found')
  assert.match(confirmDiscard, /resolveScannerBatchExit\(\{[\s\S]*batchPending: scannerBatchPendingRef\.current[\s\S]*discardConfirmed: true/)
  assert.match(confirmDiscard, /=== 'blocked'/)

  // Escape and the backdrop share that guarded path rather than a raw close.
  assert.match(modalSource, /useFocusTrap\(sheetRef, closeBtnRef, handleClose,/)
  assert.match(modalSource, /if \(e\.target === e\.currentTarget\) handleClose\(\)/)

  // Only the unguarded closeNow ends the modal, and the batch path reaches it
  // after the shelf it just wrote is emptied.
  const closeNow = modalSource.match(/const closeNow = useCallback\(\(\) => \{[\s\S]*?\n  \}, \[[^\]]*\]\)/)?.[0]
  assert.ok(closeNow, 'closeNow not found')
  assert.match(closeNow, /onClose\(\)/)
  assert.match(closeNow, /terminateScannerWorker\(\)/)
  assert.match(closeNow, /searchGenRef\.current\+\+/)
  assert.match(modalSource, /setScannerShelf\(\[\]\)\s*\n\s*closeNow\(\)/)

  const batchStart = modalSource.indexOf('  const handleScannerBatchAdd = async (')
  const batchEnd = modalSource.indexOf('  const acknowledgeScannerLibraryCheck', batchStart)
  assert.ok(batchStart >= 0 && batchEnd > batchStart)
  const batchAdd = modalSource.slice(batchStart, batchEnd)
  assert.ok(batchAdd, 'handleScannerBatchAdd not found')
  assert.match(batchAdd, /if \(retry !== true && !scannerSessionMutable\(\)\) return/, 'normal confirmation must reject duplicate activation synchronously')
  assert.match(batchAdd, /scannerBatchPendingRef\.current = true[\s\S]*setPendingExit\(null\)[\s\S]*await fetch/)
  assert.match(batchAdd, /catch \(e\) \{[\s\S]*scannerBatchPendingRef\.current = false[\s\S]*setError/)

  // Transport failures retain ownership as unknown; no status-only unlock.
  const catchBlock = batchAdd.match(/catch \(e\) \{[\s\S]*?\n    \}/)?.[0]
  assert.ok(catchBlock, 'handleScannerBatchAdd catch block not found')
  assert.match(catchBlock, /scannerBatchLifecycleRef\.current\.fail\(request\)/)
  assert.match(catchBlock, /setScannerRecovery\(true\)/)
  assert.match(catchBlock, /Inventory may already have changed/)
  assert.doesNotMatch(catchBlock, /\.commit\(/)
  assert.match(batchAdd, /const request = retry === true \? scannerBatchLifecycleRef\.current\.retry\(\) : scannerBatchLifecycleRef\.current\.begin\(payload\)/)
  assert.match(batchAdd, /if \(!request\) return/)
  assert.match(batchAdd, /buildScannerBatchPayload\(scannerShelfRef\.current/)
  const postCatch = batchAdd.slice(batchAdd.indexOf(catchBlock) + catchBlock.length)
  assert.match(postCatch, /isCurrent\(request\)[\s\S]*await parseBatchResponseBody\(res\)[\s\S]*isCurrent\(request\)/)
  assert.match(postCatch, /classifyBatchResponse\(\{ ok: res\.ok, data, requested: payload\.cards\.length \}\) !== 'commit'/)
  const parseIndex = postCatch.indexOf('await parseBatchResponseBody')
  const classifyIndex = postCatch.indexOf('classifyBatchResponse')
  const settleIndex = postCatch.indexOf('removeSubmittedScannerRows')
  const callbackIndex = postCatch.indexOf('onAdded?.(')
  const commitIndex = postCatch.indexOf('commit(request)')
  assert.ok(parseIndex >= 0 && parseIndex < classifyIndex && classifyIndex < settleIndex &&
    settleIndex < callbackIndex && callbackIndex < commitIndex,
  'ownership must span parsing, contract validation, selected-only settlement, and callback')
  assert.match(postCatch, /removeSubmittedScannerRows\(current, request\.snapshot\)/)
  assert.match(postCatch, /try \{[\s\S]*onAdded\?\.\([\s\S]*\} catch/)
  assert.doesNotMatch(postCatch, /closeNow\(|setScannerShelf\(\[\]\)/, 'success must not drop unchecked rows or close their modal')
  assert.doesNotMatch(postCatch.slice(commitIndex), /setError\(/, 'callback failure must never claim the write failed')
  assert.doesNotMatch(postCatch, /scannerBatchPendingRef\.current = true/, 'settlement cannot re-arm a retry')

  // Every path that can alter the submitted scanner session shares the same
  // synchronous lifecycle guard; disabling controls alone is not enough because
  // a queued event or late scan continuation can run before the next render.
  assert.match(modalSource, /const scannerSessionMutable = useCallback\(\(\) => scannerBatchLifecycleRef\.current\.canMutate\(\), \[\]\)/)
  for (const handler of [
    'resumeScanner',
    'leaveScannerMode',
    'acceptScannerCandidate',
    'handleLoadMore',
    'handleClear',
    'handleScanEvidence',
    'handleManualFallback',
    'handleSelectEdition',
    'openScanner',
    'editScannerShelf',
    'removeScannerShelf',
    'changeScannerBinder',
    'changeScannerCondition',
  ]) {
    const start = modalSource.indexOf(`const ${handler}`)
    assert.notEqual(start, -1, `${handler} not found`)
    const snippet = modalSource.slice(start, start + 500)
    assert.match(snippet, /if \(!scannerSessionMutable\(\)\) return/, `${handler} must freeze during batch confirmation`)
  }
  assert.match(modalSource, /<PrintingSelectionPanel[\s\S]*disabled=\{adding \|\| scannerRecovery\}/)
  assert.match(modalSource, /<EditionRow[\s\S]*disabled=\{adding \|\| scannerRecovery\}/)

  // The old "nothing written" discard prompt must not remain visible after a
  // write starts, even during the render where the pending state is changing.
  assert.match(modalSource, /\{pendingExit && !adding && !scannerRecovery && \(/)

  // Manual fallback and Clear leave scanner mode; neither may drop the shelf.
  const manualFallback = modalSource.match(/const handleManualFallback = \([\s\S]*?\n  \}/)?.[0]
  assert.ok(manualFallback, 'handleManualFallback not found')
  assert.doesNotMatch(manualFallback, /setScannerShelf/)
  const handleClear = modalSource.match(/const handleClear = \(\) => \{[\s\S]*?\n  \}/)?.[0]
  assert.ok(handleClear, 'handleClear not found')
  assert.doesNotMatch(handleClear, /setScannerShelf/)

  // Terminating the OCR worker belongs to a close that actually happens; a
  // blocked close must not tear down the worker the next scan reuses.
  assert.equal(modalSource.match(/terminateScannerWorker\(\)/g).length, 2)

  // Unmount also invalidates non-fetch async work such as the local visual
  // comparison, whose promise is not cancelled by AbortController.
  //
  // React StrictMode double-invokes this effect (mount -> cleanup -> mount)
  // in dev, and the lifecycle lives in a useRef that survives that, so the
  // effect body (the setup side, not just the cleanup side) must re-arm the
  // same lifecycle instance on every mount -- otherwise the simulated
  // unmount's invalidate() leaves it permanently unmounted after the second
  // mount.
  const unmountEffectStart = modalSource.indexOf('// ─── Cleanup on unmount')
  assert.notEqual(unmountEffectStart, -1, 'unmount cleanup comment not found')
  const unmountCleanup = modalSource.slice(unmountEffectStart).match(/useEffect\(\(\) => \{[\s\S]*?\n  \}, \[\]\)/)?.[0]
  assert.ok(unmountCleanup, 'modal unmount cleanup not found')
  assert.match(
    unmountCleanup,
    /useEffect\(\(\) => \{[\s\S]*?scannerBatchLifecycleRef\.current\.arm\(\)[\s\S]*return \(\) => \{/,
    'the effect body (setup side) must call scannerBatchLifecycleRef.current.arm() before the teardown, so a StrictMode remount re-arms the lifecycle'
  )
  assert.match(unmountCleanup, /searchGenRef\.current\+\+/)
  assert.match(unmountCleanup, /terminateScannerWorker\(\)/)

  // An unmount while the batch fetch is in flight must invalidate the
  // lifecycle, so the eventual response (success or failure) cannot call
  // onAdded, setScannerShelf, setError, setAdding, or closeNow/onClose.
  assert.match(unmountCleanup, /scannerBatchLifecycleRef\.current\.invalidate\(\)/)
}

const regressionSource = readFileSync(new URL('./regression-suite.mjs', import.meta.url), 'utf8')
assert.match(regressionSource, /node scripts\/test-card-scanner-session\.mjs/)

// A non-English/unreadable title can still seed assisted catalog retrieval from
// BOTH Roman printing clues. It must never create a direct/name-confirmed match.
{
  assert.equal(typeof scannerSession.scannerRetrievalSeed, 'function')
  const ev = { nameQuery: '', setCode: 'sta', collectorNumber: '117' }
  assert.deepEqual(scannerSession.scannerRetrievalSeed(ev), { query: '', set: 'sta' })
  assert.equal(scannerSession.scannerRetrievalSeed({ nameQuery: '', setCode: 'sta' }), null)
  assert.equal(scannerSession.scannerRetrievalSeed({ nameQuery: '', collectorNumber: '117' }), null)
  assert.deepEqual(scannerSession.scannerRetrievalSeed({ ...ev, nameQuery: 'natural order' }), { query: 'natural order', set: '' }, 'English names keep broad retrieval; OCR clues are not hard filters')
  const pool = [
    { name: 'Natural Order', editions: [edition({ scryfall_id: 'sta-117', set_code: 'sta', collector_number: '117' }), edition({ scryfall_id: 'sta-54', set_code: 'sta', collector_number: '54' })] },
    { name: 'Unrelated Card', editions: [edition({ scryfall_id: 'sta-12', set_code: 'sta', collector_number: '12' })] },
  ]
  const decision = routeScannerMatch(rankScannerResults(pool, ev), ev)
  assert.equal(decision.kind, 'uncertain')
  assert.equal(decision.reason, 'printing-only')
  assert.deepEqual(decision.candidates.map(c => c.edition.scryfall_id), ['sta-117'])
  assert.equal(shouldSweepAnotherScanPage({ pagesFetched: 1, hasMore: true, decision, evidence: ev }), true)
  const missing = routeScannerMatch(rankScannerResults([pool[1]], ev), ev)
  assert.deepEqual(missing.candidates, [], 'unmatched printing-only pool must not show unrelated set rows')
  const tied = routeScannerMatch(rankScannerResults([
    pool[0], { name: 'Another Name', editions: [edition({ scryfall_id: 'collision', set_code: 'sta', collector_number: '117' })] },
  ], ev), ev)
  assert.equal(tied.kind, 'uncertain')
  assert.deepEqual(new Set(tied.candidates.map(c => c.cardName)), new Set(['Natural Order', 'Another Name']), 'metadata collision must ask the user about all matching names')
}

console.log('CARD_SCANNER_SESSION_PASS')
