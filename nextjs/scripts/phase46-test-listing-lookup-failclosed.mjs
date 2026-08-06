// Phase 46 — the owner-listing lookup and the two listing-create paths must
// fail closed.
//
// PR #8 made the card-detail modal render a *price* off the single-card listing
// lookup, and its review (F1/F2/F4) found three places where a failure still
// looked exactly like a success:
//   F1  GET /api/listings?library_card_id= answered 200 {listing:null} on real
//       database and auth failures, which the client reads as confirmed-absence.
//   F2  ClaimSaleForm parsed the 201 body outside any guard, so a malformed
//       body skipped the fail-closed onListingUncertain() path.
//   F4  ListingSection fired a success toast next to the error panel, and never
//       checked that the returned listing belonged to this card.
//
// The route block below is parsed structurally rather than grepped: the gate
// enumerates every response the single-card branch can emit and asserts that
// only the two genuine resolutions are 2xx. Re-adding a 200 null anywhere in
// that branch fails here regardless of how it is written.

import fs from 'node:fs'
import assert from 'node:assert/strict'

const routeSource = fs.readFileSync(new URL('../src/app/api/listings/route.js', import.meta.url), 'utf8')
const claimSaleSource = fs.readFileSync(new URL('../src/components/library-detail/ClaimSaleForm.js', import.meta.url), 'utf8')
const listingSource = fs.readFileSync(new URL('../src/components/library-detail/ListingSection.js', import.meta.url), 'utf8')
const modalSource = fs.readFileSync(new URL('../src/components/CardDetailModal.js', import.meta.url), 'utf8')

let failed = 0
function check(name, fn) {
  try {
    fn()
    console.log(`PASS ${name}`)
  } catch (err) {
    console.log(`FAIL ${name}\n     ${err.message}`)
    failed += 1
  }
}

// Returns the source of the balanced `{...}` block that starts at the first
// brace at or after `from`.
function balancedBlock(source, from) {
  const open = source.indexOf('{', from)
  assert.notEqual(open, -1, 'expected a block')
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  throw new Error('unbalanced block')
}

// The body of the `catch` guarding `data = await res.json()`. Brace-matched,
// because the fail-closed handlers themselves contain object literals.
function successBodyParseCatch(source) {
  const at = source.search(/try\s*\{\s*data\s*=\s*await res\.json\(\)\s*\}\s*catch\s*\{/)
  if (at === -1) return null
  return balancedBlock(source, source.indexOf('catch', at))
}

// Every `NextResponse.json(<body>, <init>)` call in a region, with its
// arguments captured by brace matching (arguments contain commas and braces,
// so a regex alone cannot split them).
function responses(region) {
  const out = []
  const marker = 'NextResponse.json('
  for (let idx = region.indexOf(marker); idx !== -1; idx = region.indexOf(marker, idx + 1)) {
    let depth = 0
    let end = idx + marker.length
    for (; end < region.length; end += 1) {
      const c = region[end]
      if (c === '(' || c === '{' || c === '[') depth += 1
      else if (c === ')' && depth === 0) break
      else if (c === ')' || c === '}' || c === ']') depth -= 1
    }
    out.push(region.slice(idx + marker.length, end).trim())
  }
  return out
}

const singleCardBranch = balancedBlock(routeSource, routeSource.indexOf('if (library_card_id)'))

check('F1 — the single-card branch is reached and parsed', () => {
  assert.ok(singleCardBranch.includes('library_card_id'), 'failed to isolate the single-card lookup branch')
  assert.ok(!singleCardBranch.includes('Bazaar browsing'), 'branch extraction leaked into the browse path')
})

check('F1 — only a resolved lookup answers 2xx; every failure carries a non-2xx status', () => {
  const emitted = responses(singleCardBranch)
  assert.ok(emitted.length >= 3, `expected the branch to emit several responses, found ${emitted.length}`)

  const resolved = []
  const errors = []
  for (const call of emitted) {
    const statusMatch = call.match(/status:\s*(\d{3})/)
    if (statusMatch) errors.push({ call, status: Number(statusMatch[1]) })
    else resolved.push(call)
  }

  // The two genuine resolutions: primary select and the pre-migration fallback
  // select. Both answer `{listing: data || null}` at an implicit 200.
  assert.equal(
    resolved.length, 2,
    `exactly two responses in the single-card branch may omit an explicit status ` +
    `(the primary and fallback resolved lookups); found ${resolved.length}:\n  ${resolved.join('\n  ')}`
  )
  for (const call of resolved) {
    assert.match(
      call, /\{\s*listing:\s*data\s*\|\|\s*null\s*\}/,
      `a 2xx response in this branch must be a resolved lookup, not "${call}"`
    )
  }

  assert.ok(errors.length >= 1, 'the branch must emit at least one explicit failure status')
  for (const { call, status } of errors) {
    assert.ok(status >= 400, `failure responses must be 4xx/5xx, found ${status}`)
    // The client treats an explicit `listing` key as authoritative state.
    // A failure response must not carry one under any status.
    assert.ok(
      !/\blisting:/.test(call),
      `a ${status} response must not carry a "listing" key — that is the ` +
      `confirmed-absence signal the card-detail modal prices off: ${call}`
    )
    assert.match(call, /code:\s*'[A-Z_]+'/, `failure response ${status} must carry a stable public code`)
  }
  console.log(`       resolved 2xx: ${resolved.length}; explicit failures: ${errors.map(e => e.status).join(', ')}`)
})

check('F1 — raw database text stays server-side', () => {
  assert.match(
    singleCardBranch, /console\.error\(\s*'\[GET \/api\/listings single\]'/,
    'lookup failures must be logged server-side'
  )
  const emitted = responses(singleCardBranch).join('\n')
  for (const leak of ['err.message', 'error.message', 'err?.message', 'String(err']) {
    assert.ok(!emitted.includes(leak), `response bodies must not embed raw error text (${leak})`)
  }
})

check('F1 — the client still treats non-2xx as an error rather than absence', () => {
  assert.match(
    modalSource, /r\.ok\s*\?\s*r\.json\(\)\s*:\s*Promise\.reject/,
    'the modal must reject non-2xx listing responses instead of parsing them'
  )
  assert.ok(
    modalSource.includes("hasOwnProperty.call(data, 'listing')"),
    'a 2xx body without an explicit listing key must still be an error'
  )
})

check('F2 — ClaimSaleForm fails closed when a successful create body cannot be parsed', () => {
  const parse = successBodyParseCatch(claimSaleSource)
  assert.ok(parse, 'the 201 body parse must sit inside its own try/catch')
  assert.match(
    parse, /onListingUncertain\?\.\(\)/,
    'a parse failure on an already-created claim sale must invalidate confirmed-none state, ' +
    'not fall through to the generic catch'
  )
  assert.ok(
    !/const data = await res\.json\(\)/.test(claimSaleSource),
    'no unguarded parse of the success body may remain'
  )
})

check('F2/F4 — a create that cannot be confirmed never reports success', () => {
  for (const [label, source, successToast] of [
    ['ClaimSaleForm', claimSaleSource, "toast('Claim sale created on Bazaar', 'success')"],
    ['ListingSection', listingSource, "toast('Card listed on Bazaar', 'success')"],
  ]) {
    const at = source.indexOf(successToast)
    assert.notEqual(at, -1, `${label} must still confirm success on the happy path`)
    const confirmed = source.lastIndexOf('nextListing)', at)
    assert.ok(
      confirmed !== -1 && confirmed < at,
      `${label} must propagate the confirmed listing before toasting success`
    )
    assert.equal(
      source.split(successToast).length - 1, 1,
      `${label} must have exactly one success toast so no failure path can also reach it`
    )
  }
})

check('F4 — ListingSection validates the returned listing the same way ClaimSaleForm does', () => {
  const handleList = balancedBlock(listingSource, listingSource.indexOf('const handleList = async ()'))
  assert.ok(handleList.includes("fetch('/api/listings'"), 'failed to isolate handleList')
  assert.match(
    handleList, /listing\.library_card_id === libraryRow\.id/,
    'the returned listing must be matched to this card, as ClaimSaleForm already does'
  )
  assert.match(handleList, /listing\.status === 'active'/, 'the returned listing must be active')
  assert.match(handleList, /listing\?\.id/, 'the returned listing must be persisted')
  const parse = successBodyParseCatch(handleList)
  assert.ok(parse, 'the success body parse must sit inside its own try/catch')
  assert.match(
    parse, /onListingChange\(\s*\{\s*multiplier,\s*status:\s*'active'\s*\}\s*\)/,
    'an unparseable success body must drive the modal into its id-less (error) listing state'
  )
  // The id-less fallback object is what the modal maps to ERROR; it must never
  // be paired with a success toast (that was the contradictory F4 pairing).
  const fallbackAt = handleList.indexOf("onListingChange({ multiplier, status: 'active' })")
  const toastAt = handleList.indexOf("toast('Card listed on Bazaar', 'success')")
  assert.ok(fallbackAt !== -1 && toastAt !== -1, 'expected both the fallback state and the success toast')
  assert.ok(
    handleList.slice(fallbackAt, toastAt).includes('throw new Error('),
    'the unconfirmed-listing path must throw before the success toast is reached'
  )
})

check('F5 — the dead listing prop is gone from PhotoSection', () => {
  const photoSource = fs.readFileSync(new URL('../src/components/library-detail/PhotoSection.js', import.meta.url), 'utf8')
  assert.ok(
    !/function PhotoSection\(\{[^}]*\blisting\b/.test(photoSource),
    'PhotoSection must not accept a listing prop it never reads'
  )
  assert.ok(
    !/listing=\{currentListing\}/.test(modalSource),
    'the modal must not pass a listing prop PhotoSection does not accept'
  )
  assert.ok(!modalSource.includes('const currentListing'), 'the now-unused currentListing binding must be removed')
})

if (failed) {
  console.error(`\n${failed} check(s) failed.`)
  process.exit(1)
}
console.log('\nAll listing fail-closed checks passed.')
