// Focused checks for the Phase 45C Claim Sales UAT repairs:
//   1. dedicated /claim-sales page thumbnail data + rendering
//   2. buyer-visible unavailable/depleted explanation in the inspector
//   3. offered quantity is listings.quantity, never library_cards.quantity
// Behavioural assertions run against the shared pure helpers; the rest are
// source-contract checks on the surfaces that consume them.
import fs from 'node:fs'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  pickStoredImageUri,
  indexClaimSaleListings,
  resolveFeaturedImageUri,
} from '../src/lib/claimSaleThumbnails.mjs'
import {
  AVAILABILITY,
  resolveListingAvailability,
} from '../src/lib/claimSaleAvailability.mjs'
import {
  buildPriceCacheMerge,
  assertPriceCachePreserved,
  isPlainObject,
  hasOwn,
  ownValue,
  requireNestedCacheGroup,
} from './lib/price-cache-merge.mjs'
import backendGuard from '../tests/helpers/local-backend-guard.js'

const read = path => fs.readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const dedicatedPage = read('nextjs/src/app/claim-sales/page.js')
const list = read('nextjs/src/components/ClaimSaleList.js')
const browse = read('nextjs/src/components/ClaimSalesBrowse.js')
const browseApi = read('nextjs/src/app/api/claim-sales/route.js')
const detailPage = read('nextjs/src/app/claim-sales/[id]/page.js')
const view = read('nextjs/src/components/ClaimSaleView.js')
const card = read('nextjs/src/components/ClaimSaleCard.js')
const inspector = read('nextjs/src/components/ClaimSaleInspector.js')
const seeder = read('nextjs/scripts/seed-phase45c-clickthrough.mjs')
const priceCacheMerge = read('nextjs/scripts/lib/price-cache-merge.mjs')
const uatSpec = read('nextjs/tests/phase45c-claim-sale-uat.spec.js')
const defaultConfig = read('nextjs/playwright.config.js')
const claimSaleConfig = read('nextjs/playwright.claim-sale.config.js')
const guardHelper = read('nextjs/tests/helpers/local-backend-guard.js')
const cleanupHelper = read('nextjs/tests/helpers/phase45c-fixture-cleanup.js')
const isolatedBuildGuard = read('nextjs/scripts/phase45c-build-isolated-candidate.mjs')

const results = []
function check(description, fn) {
  const returned = fn()
  // A synchronous runner handed an async body prints PASS before the first
  // assertion has resolved, and a later rejection arrives detached from the
  // check it belongs to. Refuse rather than report a pass that was never earned.
  if (returned && typeof returned.then === 'function') {
    throw new Error(
      `check "${description}" returned a promise; use \`await checkAsync(...)\` so a rejected `
      + 'assertion cannot be reported as a pass')
  }
  results.push(description)
  console.log(`PASS: ${description}`)
}

async function checkAsync(description, fn) {
  await fn()
  results.push(description)
  console.log(`PASS: ${description}`)
}

// --- 0. Comment-aware source inspection --------------------------------------
// Every assertion below that claims an admission guard *runs* is a source
// match, and a source match cannot tell a call from a call that has been
// commented out. Both comment forms have to be handled: `// guard()` and
// `/* guard() */` are equally easy to leave behind, and a gate that only knew
// about one of them would sign off on a disabled guard.
//
// Stripping comments correctly needs to know where a `/` starts a comment and
// where it starts a regex literal or lives inside a string — `'http://x'` and
// `/\/api\/cart\//` are both in these sources, and mistaking either for a
// comment would delete real code and make the gate lie in the other direction.
// So this is a small scanner over strings, template literals, regex literals
// and comments rather than a line-wise regex.

// Characters after which a `/` begins a regex literal rather than a division.
const REGEX_ALLOWED_AFTER = new Set(
  ['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^'])
const REGEX_ALLOWED_KEYWORDS = new Set(
  ['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case', 'do', 'else',
    'yield', 'await', 'throw'])

function stripComments(source) {
  const text = String(source)
  let out = ''
  let i = 0
  let prev = ''      // last significant character emitted
  let prevWord = ''  // identifier ending at that character, if any

  const emit = (chunk) => {
    out += chunk
    for (const c of chunk) {
      if (/\s/.test(c)) continue
      prevWord = /[A-Za-z0-9_$]/.test(c) && /[A-Za-z0-9_$]/.test(prev) ? prevWord + c
        : (/[A-Za-z_$]/.test(c) ? c : '')
      prev = c
    }
  }
  const regexAllowedHere = () =>
    prev === '' || REGEX_ALLOWED_AFTER.has(prev) || REGEX_ALLOWED_KEYWORDS.has(prevWord)

  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]

    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      // Newlines are preserved so line-anchored assertions and offsets stay
      // meaningful, and a space is emitted so `a/*x*/b` does not fuse into `ab`.
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '\n') out += '\n'
        i++
      }
      i += 2
      out += ' '
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      emit(ch)
      i++
      while (i < text.length) {
        if (text[i] === '\\') { emit(text.slice(i, i + 2)); i += 2; continue }
        const c = text[i]
        emit(c)
        i++
        if (c === ch) break
      }
      continue
    }
    if (ch === '/' && regexAllowedHere()) {
      emit('/')
      i++
      let inClass = false
      while (i < text.length) {
        if (text[i] === '\\') { emit(text.slice(i, i + 2)); i += 2; continue }
        const c = text[i]
        if (c === '\n') break // unterminated: bail out rather than eat the file
        emit(c)
        i++
        if (c === '[') inClass = true
        else if (c === ']') inClass = false
        else if (c === '/' && !inClass) break
      }
      while (i < text.length && /[a-z]/.test(text[i])) { emit(text[i]); i++ }
      continue
    }
    emit(ch)
    i++
  }
  return out
}

check('comment stripping removes both comment forms without damaging code', () => {
  assert.equal(stripComments('a // gone\nb').replace(/[ \t]+/g, ''), 'a\nb')
  assert.equal(stripComments('a /* gone */ b').replace(/\s+/g, ' ').trim(), 'a b')
  assert.equal(stripComments('a /* gone\nstill gone */ b').split('\n').length, 2,
    'a multi-line block comment keeps its newlines so offsets stay meaningful')
  // Strings and template literals are code, not comments.
  assert.match(stripComments("const u = 'http://127.0.0.1:54321' // note"), /http:\/\/127\.0\.0\.1:54321/)
  assert.match(stripComments('const u = `http://localhost:${p}` /* note */'), /http:\/\/localhost:\$\{p\}/)
  // Regex literals containing escaped slashes must survive intact, together
  // with everything after them on the same line.
  const withRegex = 'const ok = /\\/api\\/cart\\//.test(u) // note\nconst after = 1'
  const strippedRegex = stripComments(withRegex)
  assert.match(strippedRegex, /\/\\\/api\\\/cart\\\/\/\.test\(u\)/)
  assert.match(strippedRegex, /const after = 1/)
  // The real shapes these gated sources contain: a character class holding both
  // quote characters, and a slash inside a class.
  const hard = 'const R = /["\'](https?:\\/\\/[^"\'\\s]+?)["\']/g // note\nconst tail = 2'
  assert.ok(!/note/.test(stripComments(hard)), 'a comment after a quote-bearing regex is stripped')
  assert.match(stripComments(hard), /const tail = 2/, 'and the code after it survives')
  const src = 'const S = /<script[^>]+src="([^"]+)"/g\n// gone\nconst tail = 3'
  assert.ok(!/gone/.test(stripComments(src)))
  assert.match(stripComments(src), /const tail = 3/)
  // Division is not mistaken for a regex.
  assert.match(stripComments('const half = total / 2 // note'), /const half = total \/ 2/)
  // A commented-out call must not survive as a match.
  assert.ok(!/guard\(\)/.test(stripComments('  // guard()\n')))
  assert.ok(!/guard\(\)/.test(stripComments('  /* guard() */\n')))
})

// Mutation harness. A presence assertion is only worth something if a source
// with that guard disabled is proven to fail it, so every executable-guard
// contract below is pointed at deliberately broken variants of its own source.
function expectContractRejects(contract, original, mutations) {
  for (const [label, mutated] of mutations) {
    assert.notEqual(mutated, original, `mutation "${label}" did not apply`)
    assert.throws(() => contract(mutated), undefined, `the gate must reject: ${label}`)
  }
}

// Execute a candidate copy of the CommonJS guard without loading its dotenv
// file or touching the real process environment. This lets mutation controls
// prove the helper's exported behaviour, rather than merely prove that a
// preferred source spelling is still present.
function loadGuardHelperFromSource(source) {
  const candidateModule = { exports: {} }
  const isolatedRequire = (specifier) => {
    if (specifier === 'node:path') return { resolve: (...parts) => parts.join('/') }
    if (specifier === 'dotenv') return { config: () => ({ parsed: {} }) }
    throw new Error(`unexpected require in isolated guard probe: ${specifier}`)
  }
  const evaluate = new Function(
    'require', 'module', 'exports', '__dirname', 'process',
    `${source}\nreturn module.exports`)
  return evaluate(
    isolatedRequire,
    candidateModule,
    candidateModule.exports,
    '/isolated/nextjs/tests/helpers',
    { env: { PW_LOCAL_SUPABASE_URL: LOOPBACK_SUPABASE } },
  )
}

// The two ways a call is disabled without being deleted. `line` is a whole
// source line including its indentation and trailing newline.
function commentedOutForms(source, line) {
  const occurrences = source.split(line).length - 1
  assert.equal(occurrences, 1, `mutation target must appear exactly once: ${JSON.stringify(line)}`)
  const indent = /^[ \t]*/.exec(line)[0]
  const code = line.trim()
  return [
    [`line-commented \`${code}\``, source.replace(line, `${indent}// ${code}\n`)],
    [`block-commented \`${code}\``, source.replace(line, `${indent}/* ${code} */\n`)],
  ]
}

// The same two forms for a multi-line declaration — a whole function body, say.
// A definition is disabled either by prefixing every line or by wrapping the
// block once, and a gate that lifts code out of a source has to treat both as
// absent. `block` is the complete text including its trailing newline.
function commentedOutBlockForms(source, block) {
  const occurrences = source.split(block).length - 1
  assert.equal(occurrences, 1,
    `mutation target must appear exactly once: ${JSON.stringify(block.slice(0, 60))}`)
  assert.ok(!block.includes('*/'),
    'a block already containing a comment closer cannot be wrapped in one')
  const first = block.split('\n')[0].trim()
  return [
    [`line-commented block \`${first}…\``,
      source.replace(block, block.replace(/^(?!$)/gm, '// '))],
    [`block-commented block \`${first}…\``, source.replace(block, `/*\n${block}*/\n`)],
  ]
}

// --- 1. Thumbnail resolution -----------------------------------------------

const SALE = 'cs-1'
const ART = 'https://img.test/art_crop.jpg'
const NORMAL = 'https://img.test/normal.jpg'
const SMALL = 'https://img.test/small.jpg'

const row = (id, image_uris, claim_sale_id = SALE) => ({
  id, claim_sale_id, library_cards: { card_index: { image_uris } },
})

check('stored image prefers art_crop, then normal, then small', () => {
  assert.equal(pickStoredImageUri({ art_crop: ART, normal: NORMAL, small: SMALL }), ART)
  assert.equal(pickStoredImageUri({ normal: NORMAL, small: SMALL }), NORMAL)
  assert.equal(pickStoredImageUri({ small: SMALL }), SMALL)
  assert.equal(pickStoredImageUri(null), null)
  assert.equal(pickStoredImageUri({}), null)
})

check('featured listing supplies the thumbnail when it is an imaged active child', () => {
  const index = indexClaimSaleListings([row('l-1', { normal: NORMAL }), row('l-2', { art_crop: ART })])
  assert.equal(resolveFeaturedImageUri(index, SALE, 'l-2'), ART)
})

check('an unimaged or inactive featured listing falls back to an active child listing', () => {
  // 'l-9' is not in the active-listing rows at all (unlisted/reserved/sold);
  // 'l-1' has no stored image. The first active child that does have one wins.
  const index = indexClaimSaleListings([row('l-1', null), row('l-2', { normal: NORMAL })])
  assert.equal(resolveFeaturedImageUri(index, SALE, 'l-9'), NORMAL)
  assert.equal(resolveFeaturedImageUri(index, SALE, null), NORMAL)
})

check('a featured listing belonging to another sale is never borrowed', () => {
  const index = indexClaimSaleListings([
    row('l-1', { normal: NORMAL }),
    row('l-other', { art_crop: ART }, 'cs-2'),
  ])
  assert.equal(resolveFeaturedImageUri(index, SALE, 'l-other'), NORMAL)
})

check('a sale with no imaged active listing resolves to null, not a broken URL', () => {
  const index = indexClaimSaleListings([row('l-1', null)])
  assert.equal(resolveFeaturedImageUri(index, SALE, 'l-1'), null)
  assert.equal(resolveFeaturedImageUri(indexClaimSaleListings([]), SALE, null), null)
})

check('card counts come from the same active-listing pass as the thumbnail', () => {
  const index = indexClaimSaleListings([row('l-1', null), row('l-2', { normal: NORMAL })])
  assert.equal(index.cardCount[SALE], 2)
  assert.equal(index.cardCount['cs-missing'], undefined)
})

check('dedicated /claim-sales page requests the thumbnail data it needs', () => {
  assert.match(dedicatedPage, /featured_listing_id/, 'selects featured_listing_id')
  assert.match(dedicatedPage, /card_index!inner\(image_uris\)/, 'joins stored image_uris')
  assert.match(dedicatedPage, /resolveFeaturedImageUri\(thumbIndex, cs\.id, featuredListingId\)/)
  assert.match(dedicatedPage, /featured_image_uri:/, 'passes featured_image_uri to the list')
  assert.ok(!/api\.scryfall\.com/.test(dedicatedPage), 'no Scryfall dependency for synthetic ids')
})

check('dedicated /claim-sales list renders the thumbnail with failure + a11y safety', () => {
  assert.match(list, /data-testid="claim-sale-thumbnail"/)
  assert.match(list, /src=\{src\}/)
  assert.match(list, /alt=""/, 'decorative image beside the sale title')
  assert.match(list, /onError=\{\(\) => setFailed\(true\)\}/, 'broken image collapses the block')
  assert.match(list, /if \(!src \|\| failed\) return null/)
})

check('browse tile and dedicated page share one thumbnail resolution', () => {
  assert.match(browseApi, /resolveFeaturedImageUri\(thumbIndex, cs\.id, cs\.featured_listing_id\)/)
  assert.match(browseApi, /resolveFeaturedImageUri\(thumbIndex, cs\.id, featuredListingId\)/)
  assert.ok(!/art_crop \|\| /.test(browseApi), 'no duplicated inline image-uri precedence')
  assert.match(browse, /onError=\{\(\) => setThumbFailed\(true\)\}/)
})

// --- 2. Availability explanation -------------------------------------------

const NOW = Date.parse('2026-07-29T00:00:00.000Z')
const FUTURE = '2099-12-31T23:59:59.000Z'
const PAST = '2026-07-28T00:00:00.000Z'
const activeListing = { id: 'l-1', status: 'active', quantity: 1, multiplier: 2.5, expires_at: FUTURE }
const base = {
  claimSaleStatus: 'active', claimSaleExpiresAt: FUTURE,
  isOwner: false, isSignedIn: true, now: NOW,
}

check('an active offered listing is purchasable for a signed-in non-owner', () => {
  const result = resolveListingAvailability({ ...base, listing: activeListing })
  assert.equal(result.code, AVAILABILITY.PURCHASABLE)
  assert.equal(result.purchasable, true)
  assert.equal(result.offeredQuantity, 1)
})

check('a listing reserved by a pending order explains itself instead of vanishing', () => {
  // The exact local Counterspell state: checkout drained the offered quantity
  // and left an awaiting_payment order holding the card.
  const result = resolveListingAvailability({
    ...base,
    listing: { ...activeListing, status: 'reserved', quantity: 0, multiplier: 2.8 },
  })
  assert.equal(result.code, AVAILABILITY.RESERVED)
  assert.equal(result.purchasable, false)
  assert.equal(result.offeredQuantity, 0)
  assert.match(result.title, /Reserved/)
  assert.match(result.detail, /pending|open/i)
  assert.match(result.detail, /cancelled/)
})

check('a depleted but still-active listing reads as sold out, not reserved', () => {
  const result = resolveListingAvailability({ ...base, listing: { ...activeListing, quantity: 0 } })
  assert.equal(result.code, AVAILABILITY.SOLD_OUT)
  assert.equal(result.purchasable, false)
})

check('ended listings and ended sales are named separately', () => {
  assert.equal(
    resolveListingAvailability({ ...base, listing: { ...activeListing, status: 'expired' } }).code,
    AVAILABILITY.LISTING_ENDED)
  assert.equal(
    resolveListingAvailability({ ...base, listing: { ...activeListing, expires_at: PAST } }).code,
    AVAILABILITY.LISTING_ENDED)
  assert.equal(
    resolveListingAvailability({ ...base, listing: activeListing, claimSaleStatus: 'cancelled' }).code,
    AVAILABILITY.SALE_ENDED)
  assert.equal(
    resolveListingAvailability({ ...base, listing: activeListing, claimSaleExpiresAt: PAST }).code,
    AVAILABILITY.SALE_ENDED)
})

check('owner and signed-out buyers get their own explanation, never a failing button', () => {
  const owner = resolveListingAvailability({ ...base, listing: activeListing, isOwner: true })
  assert.equal(owner.code, AVAILABILITY.OWNER)
  assert.equal(owner.purchasable, false)
  const guest = resolveListingAvailability({ ...base, listing: activeListing, isSignedIn: false })
  assert.equal(guest.code, AVAILABILITY.SIGNED_OUT)
  assert.equal(guest.purchasable, false)
})

check('a missing listing never resolves purchasable', () => {
  const result = resolveListingAvailability({ ...base, listing: null })
  assert.equal(result.code, AVAILABILITY.MISSING)
  assert.equal(result.purchasable, false)
  assert.equal(result.offeredQuantity, null)
})

check('availability is strictly narrower than the previous inline purchase gate', () => {
  // Every state the old gate allowed must still be allowed, and nothing more.
  const legacyEligible = l => !base.isOwner && l.status === 'active' &&
    Number(l.quantity) > 0 && !!l.expires_at && new Date(l.expires_at).getTime() > NOW
  const cases = [
    activeListing,
    { ...activeListing, quantity: 0 },
    { ...activeListing, quantity: 3 },
    { ...activeListing, status: 'reserved' },
    { ...activeListing, status: 'expired' },
    { ...activeListing, expires_at: PAST },
    { ...activeListing, expires_at: null },
  ]
  for (const listing of cases) {
    const resolved = resolveListingAvailability({ ...base, listing })
    if (resolved.purchasable) assert.ok(legacyEligible(listing), `loosened gate for ${JSON.stringify(listing)}`)
  }
  assert.equal(resolveListingAvailability({ ...base, listing: cases[0] }).purchasable, true)
})

check('inspector renders the named reason and gates purchase on it', () => {
  assert.match(inspector, /const purchasable = !!availability\?\.purchasable/)
  assert.match(inspector, /\{purchasable && myrPrice != null && \(/, 'purchase controls require purchasable')
  assert.match(inspector, /data-testid="claim-sale-unavailable"/)
  assert.match(inspector, /data-availability=\{availability\.code\}/)
  assert.match(inspector, /\{availability\.title\}/)
  assert.match(inspector, /\{availability\.detail\}/)
  assert.match(inspector, /data-availability="price_unavailable"/, 'unpriceable card is explained too')
  assert.ok(!/purchaseEligible/.test(inspector), 'legacy opaque eligibility flag is gone')
})

check('detail view resolves availability from listing + claim sale state', () => {
  assert.match(view, /resolveListingAvailability\(\{/)
  assert.match(view, /claimSaleStatus: claimSale\?\.status/)
  assert.match(view, /claimSaleExpiresAt: claimSale\?\.expires_at/)
  assert.match(view, /isSignedIn: !!userId/)
  assert.ok(!/purchaseEligible/.test(view), 'legacy inline gate removed')
})

function assertCardInspectorControl(source) {
  const code = stripComments(source)
  assert.match(code, /const handleInspect = \(\) => onClick\?\.\(\)/,
    'the card must call its supplied inspector callback through one named handler')
  assert.match(code, /<button\s+type="button"\s+data-testid="claim-sale-card-inspect"\s+aria-label=\{`Inspect \$\{cardName\}`\}\s+onClick=\{handleInspect\}/,
    'the full-card inspector action must be a native named button')
  assert.match(code, /<span className="sr-only">Inspect \{cardName\}<\/span>/,
    'the inspector action needs an accessible text fallback')
  assert.match(code, /focus-visible:ring-2\s+focus-visible:ring-inset\s+focus-visible:ring-dbb-accent/,
    'the native action must retain a visible in-card keyboard focus treatment')
  assert.match(code, /focus-within:ring-2\s+focus-within:ring-inset\s+focus-within:ring-dbb-accent/,
    'the clipped card wrapper must retain a visible in-card focus fallback')
  assert.doesNotMatch(code, /role="button"/,
    'do not fall back to a synthetic button role for the primary card action')
}

check('each Claim Sale card exposes one native named inspector action', () => {
  assertCardInspectorControl(card)
  const nativeInspectorAction = `<button
        type="button"
        data-testid="claim-sale-card-inspect"
        aria-label={\`Inspect \${cardName}\`}
        onClick={handleInspect}
        className="absolute inset-0 z-30 cursor-pointer rounded-dbb focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-dbb-accent"
      >
        <span className="sr-only">Inspect {cardName}</span>
      </button>`
  const withoutNativeInspectorAction = card.replace(nativeInspectorAction, '')
  assert.notEqual(withoutNativeInspectorAction, card,
    'the removal mutation must delete the complete native inspector action')
  expectContractRejects(assertCardInspectorControl, card, [
    ['remove native action', withoutNativeInspectorAction],
    ['disconnect callback', card.replace('onClick={handleInspect}', 'onClick={() => {}}')],
    ['restore synthetic role', card.replace('className="group relative', 'role="button"\n      className="group relative')],
  ])
})

// --- 3. Offered quantity semantics -----------------------------------------

check('inspector shows the listing offered quantity, including an explicit zero', () => {
  assert.match(inspector, /const offeredQty = listing\.quantity/)
  assert.match(inspector, /data-testid="claim-sale-offered-qty"/)
  assert.match(inspector, /0 — none available/)
  assert.ok(!/lc\?\.quantity|lc\.quantity/.test(inspector),
    'inspector must never read seller inventory (library_cards.quantity)')
})

check('detail page selects listings.quantity as its own column', () => {
  const listingSelect = detailPage.match(/from\('listings'\)[\s\S]*?`\)/)
  assert.ok(listingSelect, 'listings select block found')
  assert.match(listingSelect[0], /id, multiplier, quantity, status/,
    'listings.quantity is selected on the listing row')
})

check('fixture keeps offered supply below seller inventory so the two cannot be confused', () => {
  assert.match(seeder, /quantity: 3/, 'library_cards inventory is 3')
  assert.match(seeder, /multiplier: index === 0 \? 2\.5 : 2\.8, quantity: 1/, 'listings offer 1 at a decimal multiplier')
  assert.match(seeder, /Number\(card\.quantity\) !== 3/, 'inventory asserted after reset')
  assert.match(seeder, /Number\(listing\.quantity\) !== 1/, 'offered quantity asserted after reset')
})

// --- 4. Fixture reset determinism ------------------------------------------

check('fixture reset neutralises only fixture artifacts and asserts every step', () => {
  assert.match(seeder, /db\.from\('cart_items'\)\.delete\(\)\.in\('listing_id', listingIds\)/)
  assert.match(seeder, /fixture cart cleanup incomplete/, 'cart cleanup is verified, not assumed')
  assert.match(seeder, /db\.rpc\('transition_order'/, 'orders are cancelled through the production RPC')
  assert.match(seeder, /Refusing to touch order/, 'foreign seller aborts the reset')
  assert.match(seeder, /Refusing to cancel order/, 'foreign order lines abort the reset')
  assert.match(seeder, /cancelled\?\.status !== 'cancelled'/, 'cancellation result is asserted')
  assert.match(seeder, /fixture order cleanup incomplete/)
  assert.match(seeder, /fixture order reservations still hold/)
  assert.match(seeder, /reservations, expected exactly 1/, 'one listing reservation per fixture card')
  assert.match(seeder, /reservation\.source_kind !== 'listing'/)
  assert.match(seeder, /Dan still has \$\{danCart\.length\} cart row/)
})

// --- 5. Fixture isolation regressions ---------------------------------------
// These fail on the two shared-state defects the independent review blocked on:
// a blanket delete of every follow Dan holds, and a wholesale overwrite of the
// shared price-cache object.

check('fixture never deletes follows by follower alone', () => {
  // The blocked form was: db.from('follows').delete().eq('follower_id', dan.id)
  // with no target column, which destroys every unrelated follow Dan holds.
  const followDeletes = [...seeder.matchAll(/from\('follows'\)\s*\.delete\(\)((?:\s*\.[a-z]+\([^\n]*\))*)/g)]
  assert.ok(followDeletes.length > 0, 'fixture still resets follows')
  for (const [, chain] of followDeletes) {
    assert.match(chain, /\.eq\('follower_id'/, 'follow delete is scoped to the follower')
    assert.ok(
      /followee_id|claim_sale_id|auction_id/.test(chain),
      `unscoped follow delete would destroy unrelated follows: .delete()${chain}`,
    )
  }
})

check('fixture scopes its follow reset to the fixture seller and fixture sale only', () => {
  assert.match(seeder, /\.eq\('follower_id', dan\.id\)\.eq\('followee_id', seller\.id\)/,
    'the fixture seller follow is cleared by explicit target')
  assert.match(seeder, /\.eq\('follower_id', dan\.id\)\.eq\('claim_sale_id', claimSaleId\)/,
    'the fixture claim sale follow is cleared by explicit target')
  assert.match(seeder, /const danFollowsBefore = await select\('follows'/,
    'unrelated follows are snapshotted before the delete')
  assert.match(seeder, /fixture reset destroyed \$\{destroyed\.length\} unrelated follow row/,
    'surviving unrelated follows are re-asserted after the delete')
  assert.match(seeder, /fixture follow cleanup incomplete/,
    'the fixture follows are proven gone, not assumed')
})

check('fixture never replaces the shared price-cache object wholesale', () => {
  // The blocked form uploaded JSON.stringify(UAT_PRICES) — a complete
  // replacement that discarded every real Card Kingdom row in the bucket.
  assert.ok(!/UAT_PRICES/.test(seeder), 'the whole-object fixture payload is gone')
  const uploads = [...seeder.matchAll(/\.upload\(\s*([^,]+),\s*Buffer\.from\(JSON\.stringify\(([A-Za-z_$][\w$]*)\)\)/g)]
  assert.equal(uploads.length, 1, 'exactly one price-cache write')
  const [, , payload] = uploads[0]
  assert.equal(payload, 'merged', `price-cache upload must write the merged object, got ${payload}`)
})

// The merge/verification rules moved into scripts/lib/price-cache-merge.mjs so
// they can be exercised directly; the gate follows them to the helper that owns
// them and separately proves the seeder still delegates there.
check('fixture merges its synthetic price keys and re-asserts the unrelated ones', () => {
  assert.match(seeder, /const existing = await readPriceCache\(\)/, 'existing cache is read first')
  assert.match(seeder, /buildPriceCacheMerge\(\{/, 'the seeder delegates the merge to the helper')
  assert.match(seeder, /assertPriceCachePreserved\(\{/, 'the seeder delegates the re-assert to the helper')
  assert.match(priceCacheMerge, /prices: \{ \.\.\.basePrices, \.\.\.fixturePrices \}/, 'ids are merged, not replaced')
  assert.match(priceCacheMerge, /names: \{ \.\.\.baseNames, \.\.\.fixtureNames \}/, 'names are merged, not replaced')
  assert.match(priceCacheMerge, /price-cache fixture clobbered unrelated \$\{group\} key/,
    'every pre-existing prices/names key is re-asserted after the write')
  assert.match(priceCacheMerge, /price-cache fixture clobbered unrelated top-level key/,
    'top-level keys such as _meta survive the fixture write')
  assert.match(priceCacheMerge, /price-cache fixture id \$\{id\} did not land/, 'fixture ids are proven present')
  assert.match(priceCacheMerge, /price-cache fixture name \$\{name\} did not land/, 'fixture names are proven present')
})

// --- 5b. Malformed nested cache shapes abort before the upload ---------------
// The blocked form was `(existing?.prices && typeof existing.prices === 'object')
// ? existing.prices : {}`, which accepts arrays and silently substitutes `{}`
// for null/scalars — then writes that empty object over the real bucket.

check('a nested price-cache group that is not a plain object aborts the merge', () => {
  for (const bad of [null, [], ['x'], 'prices', 42, true]) {
    assert.throws(
      () => buildPriceCacheMerge({ existing: { prices: bad }, fixturePrices: {}, fixtureNames: {} }),
      /price-cache prices is (null|array|string|number|boolean), not a JSON object/,
      `prices: ${JSON.stringify(bad)} must abort, not be coerced to {}`)
    assert.throws(
      () => buildPriceCacheMerge({ existing: { names: bad }, fixturePrices: {}, fixtureNames: {} }),
      /price-cache names is (null|array|string|number|boolean), not a JSON object/,
      `names: ${JSON.stringify(bad)} must abort, not be coerced to {}`)
  }
  // The old permissive test would have accepted an array and merged into it.
  assert.equal(typeof [] === 'object', true, 'typeof alone cannot reject an array')
  assert.equal(isPlainObject([]), false)
  assert.equal(isPlainObject(null), false)
  assert.equal(isPlainObject({}), true)
})

check('an absent nested group is still a legal empty cache, not an abort', () => {
  assert.deepEqual(requireNestedCacheGroup({}, 'prices'), {})
  assert.deepEqual(requireNestedCacheGroup(null, 'prices'), {})
  const { merged } = buildPriceCacheMerge({
    existing: null, fixturePrices: { a: { n: 1 } }, fixtureNames: { b: { n: 2 } },
  })
  assert.deepEqual(merged, { prices: { a: { n: 1 } }, names: { b: { n: 2 } } })
})

check('a malformed nested group is rejected before any merged object exists', () => {
  // Nothing may be produced for upload when the shape is wrong: the caller
  // destructures `merged`, so a throw is the only thing that can stop the write.
  let produced = null
  assert.throws(() => {
    produced = buildPriceCacheMerge({
      existing: { prices: null, names: { real: { n: 9 } } }, fixturePrices: {}, fixtureNames: {},
    })
  })
  assert.equal(produced, null, 'no upload payload is produced from a malformed cache')
})

check('a non-object cache root is rejected as well', () => {
  for (const bad of [[], 'x', 7]) {
    assert.throws(
      () => buildPriceCacheMerge({ existing: bad, fixturePrices: {}, fixtureNames: {} }),
      /price-cache is not a JSON object/)
  }
})

// --- 5c. Inherited names are real cache rows, not fixture keys ---------------
// A genuine Card Kingdom row can be named `constructor`, `toString`, `valueOf`
// or `hasOwnProperty`. `key in FIXTURE_PRICE_IDS` is true for every one of them,
// which dropped those rows out of the preserved set so nothing checked that
// they survived — and `after.prices[key]` resolved them to Object.prototype
// members instead of reporting them missing.

// Names that resolve through Object.prototype. `__proto__` is deliberately not
// here: assigning it on an object literal mutates the prototype instead of
// creating a key, so it cannot model a real cache row.
const INHERITED_NAMES = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf']
const FIXTURE_IDS = { 'd2000000-0000-4000-8000-000000000001': { n: 0.25, f: 0.75 } }
const FIXTURE_NAMES = { 'uat lightning bolt': { n: 0.25, f: 0.75 } }

function cacheWithInheritedNames() {
  const prices = {}
  const names = {}
  for (const [index, name] of INHERITED_NAMES.entries()) {
    prices[name] = { n: index + 1, f: null, e: null, b: null }
    names[name] = { n: index + 10, f: null, e: null, b: null }
  }
  prices['d2000000-0000-4000-8000-000000000001'] = { n: 999, f: 999 } // stale fixture row
  return { prices, names, _meta: { source: 'cardkingdom' } }
}

check('cache rows named like Object.prototype members stay in the preserved set', () => {
  const existing = cacheWithInheritedNames()
  const { preserved } = buildPriceCacheMerge({
    existing, fixturePrices: FIXTURE_IDS, fixtureNames: FIXTURE_NAMES,
  })
  for (const name of INHERITED_NAMES) {
    assert.ok(hasOwn(preserved.prices, name), `prices.${name} must be preserved and guarded`)
    assert.ok(hasOwn(preserved.names, name), `names.${name} must be preserved and guarded`)
  }
  // The real fixture key is the only prices entry that is excluded.
  assert.ok(!hasOwn(preserved.prices, 'd2000000-0000-4000-8000-000000000001'))
  assert.deepEqual(preserved.other, { _meta: { source: 'cardkingdom' } })
})

check('the rejected `in` form would have discarded those rows — this is the regression', () => {
  // Reproduces the blocked implementation to prove the two disagree.
  const existing = cacheWithInheritedNames()
  const legacyPreserved = Object.fromEntries(
    Object.entries(existing.prices).filter(([id]) => !(id in FIXTURE_IDS)))
  for (const name of INHERITED_NAMES) {
    assert.ok(!Object.prototype.hasOwnProperty.call(legacyPreserved, name),
      `the \`in\` form must be shown to drop ${name}`)
  }
  const { preserved } = buildPriceCacheMerge({
    existing, fixturePrices: FIXTURE_IDS, fixtureNames: FIXTURE_NAMES,
  })
  assert.ok(Object.keys(preserved.prices).length > Object.keys(legacyPreserved).length,
    'own-property exclusion preserves strictly more real rows than the `in` form')
})

check('inherited-named rows are re-asserted after the write and a clobber is caught', () => {
  const existing = cacheWithInheritedNames()
  const args = { existing, fixturePrices: FIXTURE_IDS, fixtureNames: FIXTURE_NAMES }
  const { preserved, merged } = buildPriceCacheMerge(args)

  // A faithful round-trip passes.
  const roundTripped = JSON.parse(JSON.stringify(merged))
  assertPriceCachePreserved({ after: roundTripped, preserved, ...args })

  // Dropping an inherited-named row must be reported, not resolved to
  // Object.prototype.toString and silently accepted.
  for (const name of ['constructor', 'toString', 'valueOf']) {
    const clobbered = JSON.parse(JSON.stringify(merged))
    delete clobbered.prices[name]
    assert.throws(
      () => assertPriceCachePreserved({ after: clobbered, preserved, ...args }),
      new RegExp(`clobbered unrelated prices key ${name}`),
      `a dropped ${name} row must be caught`)
  }
  const wholesale = { prices: { ...FIXTURE_IDS }, names: { ...FIXTURE_NAMES } }
  assert.throws(
    () => assertPriceCachePreserved({ after: wholesale, preserved, ...args }),
    /clobbered unrelated/, 'a wholesale replacement is still caught')
})

check('the merged payload keeps every inherited-named row and the fixture values win', () => {
  const existing = cacheWithInheritedNames()
  const { merged } = buildPriceCacheMerge({
    existing, fixturePrices: FIXTURE_IDS, fixtureNames: FIXTURE_NAMES,
  })
  const serialised = JSON.parse(JSON.stringify(merged))
  for (const name of INHERITED_NAMES) {
    assert.ok(Object.prototype.hasOwnProperty.call(serialised.prices, name))
  }
  assert.deepEqual(
    ownValue(serialised.prices, 'd2000000-0000-4000-8000-000000000001'),
    { n: 0.25, f: 0.75 }, 'the stale fixture row is refreshed, not left at 999')
  assert.deepEqual(serialised._meta, { source: 'cardkingdom' })
})

check('fixture price keys stay inside a synthetic namespace that cannot collide', () => {
  const ids = [...seeder.matchAll(/'(d2000000-0000-4000-8000-[0-9a-f]{12})'/g)].map(m => m[1])
  assert.ok(ids.length >= 2, 'synthetic scryfall ids only')
  const names = [...seeder.matchAll(/'(uat [a-z ]+)':\s*\{ n:/g)].map(m => m[1])
  assert.equal(names.length, 2, 'both fixture price names are uat-prefixed')
})

check('rendered spec proves the re-add and leaves the fixture cart clean', () => {
  const spec = read('nextjs/tests/phase45c-claim-sale-uat.spec.js')
  const readd = spec.match(/test\('available card can be added, removed from cart, and added again'[\s\S]*?\n\}\)/)
  assert.ok(readd, 're-add test found')
  const body = readd[0]
  assert.equal((body.match(/name: 'Add to cart' \}\)\.click\(\)/g) || []).length, 2,
    'Add to cart is clicked twice — the second add is exercised, not just offered')
  assert.match(body, /name: 'Added to cart' \}\)\)\.toBeVisible\(\)/,
    'the second add is confirmed by the button state, not only by the offered button')
  assert.match(body, /Available now: 1/, 'the re-added row is proven present in the cart itself')
  assert.equal((body.match(/await removeFromCart\(page\)/g) || []).length, 2,
    'both adds are removed again so the fixture is left clean')
  assert.match(spec, /button\[title="Remove from cart"\]/, 'removal goes through the product control')
  assert.match(spec, /cart delete rejected/, 'the removal HTTP result is asserted, not assumed')
  assert.match(spec, /await expect\(page\.getByText\(CARD\)\)\.toHaveCount\(0\)/,
    'removal is verified by absence before the fixture is considered clean')
})

check('cart deletion is not allowed to disturb listing availability', () => {
  const cartDelete = read('nextjs/src/app/api/cart/[id]/route.js')
  assert.match(cartDelete, /phase45c_cart_delete/)
  assert.ok(!/from\('listings'\)[\s\S]{0,200}\.update\(/.test(cartDelete),
    'cart item deletion must not mutate listings')
})

// --- 6. Rendered-UAT backend admission --------------------------------------
// `baseURL: http://localhost:3000` proves the frontend is local and nothing
// more. .env.local points NEXT_PUBLIC_SUPABASE_URL at the phone-facing
// Tailscale address, so a default build serves a client wired to a non-loopback
// Supabase — and these tests mutate rows. Admission is loopback-only.

const TAILSCALE_SUPABASE = 'http://100.94.130.7:54321' // the real .env.local value
const LOOPBACK_SUPABASE = 'http://127.0.0.1:54321'
// Structurally-shaped but entirely fake JWT prefix; only its `eyJ…` shape is
// what the bundle scanner keys on.
const FAKE_ANON = 'eyJhbGciOiJIUzI1NiJ9.ZmFrZQ.ZmFrZQ'

check('only loopback origins are an approved backend', () => {
  for (const good of [
    LOOPBACK_SUPABASE, 'http://localhost:54321', 'http://[::1]:54321', 'http://127.0.0.2:54321',
  ]) {
    assert.equal(backendGuard.isApprovedLocalSupabaseUrl(good), true, `${good} must be approved`)
  }
  for (const bad of [
    TAILSCALE_SUPABASE, 'http://100.75.162.20:54321', 'http://192.168.1.10:54321',
    'https://abcdefg.supabase.co', 'http://dbb.local:54321', '', null, 'not a url',
  ]) {
    assert.equal(backendGuard.isApprovedLocalSupabaseUrl(bad), false, `${bad} must be refused`)
  }
  assert.equal(backendGuard.isTailscaleHost('100.94.130.7'), true)
  assert.equal(backendGuard.isTailscaleHost('100.63.0.1'), false, 'CGNAT starts at 100.64')
  assert.equal(backendGuard.isTailscaleHost('100.128.0.1'), false, 'CGNAT ends at 100.127')
  assert.match(backendGuard.describeBackendRejection(TAILSCALE_SUPABASE), /Tailscale/)
  assert.ok(backendGuard.isApprovedLocalSupabaseUrl(backendGuard.APPROVED_BACKEND_ORIGIN),
    'the run-time approved origin is itself loopback')
})

check('the candidate bundle scanner reads the backend origin the app was built with', () => {
  // Shape taken from a real minified Next.js chunk: createClient(url, anonKey).
  const tailscaleChunk = `function n(){return(0,a.A)("${TAILSCALE_SUPABASE}","${FAKE_ANON}")}`
  assert.deepEqual(
    backendGuard.extractSupabaseOriginsFromSource(tailscaleChunk), [TAILSCALE_SUPABASE],
    'a Tailscale-wired build is detected, not missed')
  assert.deepEqual(
    backendGuard.extractSupabaseOriginsFromSource(
      `(0,a.A)('${LOOPBACK_SUPABASE}','${FAKE_ANON}')`), [LOOPBACK_SUPABASE])
  // Unrelated absolute URLs are not mistaken for a backend.
  assert.deepEqual(backendGuard.extractSupabaseOriginsFromSource(
    'src="https://cards.scryfall.io/normal/front/7/6/x.jpg"'), [])
  // Nothing found means the candidate is unidentified, which the caller treats
  // as a refusal rather than a pass.
  assert.deepEqual(backendGuard.extractSupabaseOriginsFromSource(''), [])
})

check('supabase-shaped requests off loopback are classified as blocked', () => {
  const appOrigin = 'http://localhost:3100'
  const c = (url) => backendGuard.classifyRequest(url, { appOrigin })

  assert.equal(c(`${LOOPBACK_SUPABASE}/auth/v1/token?grant_type=password`), 'approved-backend')
  assert.equal(c(`${LOOPBACK_SUPABASE}/rest/v1/cart_items`), 'approved-backend')

  assert.equal(c(`${TAILSCALE_SUPABASE}/auth/v1/token?grant_type=password`), 'blocked-backend')
  assert.equal(c(`${TAILSCALE_SUPABASE}/rest/v1/listings`), 'blocked-backend')
  assert.equal(c('https://abcdefg.supabase.co/rest/v1/orders'), 'blocked-backend')
  assert.equal(c('http://100.94.130.7:3000/api/cart'), 'blocked-backend',
    'any Tailscale host is refused, including a frontend one')
  assert.equal(c('http://192.168.1.10:54321/'), 'blocked-backend', 'the Supabase port alone is enough')

  assert.equal(c(`${appOrigin}/api/cart`), 'app', 'the app own API is server-side and allowed')
  assert.equal(c(`${appOrigin}/claim-sales`), 'app')
  assert.equal(c('https://cards.scryfall.io/normal/front/7/6/x.jpg'), 'third-party',
    'the fixture card artwork CDN must not be blocked')
})

// The backend is not the only thing a build is wired to. src/middleware.js
// builds every auth redirect from NEXT_PUBLIC_SITE_URL, and the real .env.local
// value is http://100.94.130.7:3000 — the phone-facing shared server. A
// candidate that pins only the Supabase URL therefore answers the first
// protected navigation by sending the browser, fixture session cookies and all,
// to another application instance. Classifying a non-Supabase host as
// "third-party" and waving it through is what let that happen; only the
// Tailscale form happened to be caught, and by the backend rule at that.
const LAN_APP = 'http://192.168.1.10:3000'
const STAGING_APP = 'https://staging.dbb.example'
const PROD_APP = 'https://dbb.lovelikenotomorrow.com' // .env.example's site URL

check('a request that addresses another application is refused, whatever its host looks like', () => {
  const appOrigin = 'http://localhost:3100'
  const nav = url => backendGuard.classifyRequest(url, { appOrigin, isNavigation: true })
  const sub = url => backendGuard.classifyRequest(url, { appOrigin })
  const refused = (verdict) => backendGuard.BLOCKED_VERDICTS.includes(verdict)

  // Tailscale: the real .env.local site origin. Already named by the backend
  // rule, which is why only this one form was ever caught — it must stay caught.
  assert.ok(refused(nav('http://100.94.130.7:3000/library')),
    'the phone-facing shared app is refused as a navigation target')
  assert.ok(refused(sub('http://100.94.130.7:3000/api/cart')))

  // LAN: an app origin the backend rule has nothing to say about.
  assert.equal(nav(`${LAN_APP}/login`), 'blocked-app')
  assert.equal(sub(`${LAN_APP}/api/checkout`), 'blocked-app', 'an app API path off-origin')
  assert.equal(sub(`${LAN_APP}/_next/static/chunks/main.js`), 'blocked-app', 'another build output')
  assert.equal(sub(`${LAN_APP}/logo.png`), 'blocked-app',
    'and any asset served from a private-network origin, which cannot be a CDN')
  for (const lan of ['http://10.0.0.5:3000', 'http://172.16.4.4:3000', 'http://169.254.9.9:3000',
    'http://dbb.local:3000', 'http://dan-mac.tail1234.ts.net', 'http://dbb:3000']) {
    assert.equal(nav(`${lan}/library`), 'blocked-app', `${lan} is a private-network app origin`)
  }

  // Staging/production: an ordinary public hostname, indistinguishable from a
  // CDN by host alone. The navigation and the app-shaped path are what name it.
  assert.equal(nav(`${STAGING_APP}/claim-sales`), 'blocked-app')
  assert.equal(nav(`${PROD_APP}/login`), 'blocked-app')
  assert.equal(sub(`${STAGING_APP}/api/cart`), 'blocked-app')
  assert.equal(sub(`${STAGING_APP}/_next/static/chunks/main.js`), 'blocked-app')
  assert.equal(sub(`${STAGING_APP}/claim-sales?_rsc=1a2b3`), 'blocked-app',
    'an RSC prefetch of another deployment is that deployment being driven')

  // Another loopback app is still another app: the port is the identity.
  assert.equal(nav('http://localhost:3000/login'), 'blocked-app',
    'Dan long-lived server is refused even though it is loopback')
  assert.equal(sub('http://127.0.0.1:3000/api/cart'), 'blocked-app')

  // The isolated app itself, under the two names the IPv4-only server command
  // owns. Blocking its own redirect would be a false violation.
  for (const own of ['http://localhost:3100', 'http://127.0.0.1:3100']) {
    assert.equal(nav(`${own}/login`), 'app', `${own} is this run own server`)
    assert.equal(sub(`${own}/_next/static/chunks/main.js`), 'app')
  }
  assert.equal(nav('http://[::1]:3100/login'), 'blocked-app',
    '[::1] is loopback but not this run server because the child binds only 127.0.0.1')
  assert.equal(sub('http://[::1]:3100/api/cart'), 'blocked-app')

  // Third-party resources are not application traffic and stay allowed. This is
  // the direction the repair must not break: the fixture cards render from
  // Scryfall, and over-blocking would make a rendered pass impossible.
  for (const asset of [
    'https://cards.scryfall.io/normal/front/7/6/x.jpg',
    'https://c1.scryfall.com/file/scryfall-card-backs/normal.jpg',
    'https://fonts.gstatic.com/s/inter/v13/x.woff2',
    'https://fonts.googleapis.com/css2?family=Inter',
    'https://cdn.jsdelivr.net/npm/pkg/dist/pkg.min.js',
    'https://docs.example.com/guide/page.html',
    'data:image/png;base64,iVBORw0KGgo=',
  ]) {
    assert.equal(sub(asset), 'third-party', `${asset} must not be blocked`)
  }
})

check('the host predicate separates private-network origins from public ones', () => {
  for (const host of [
    'localhost', '127.0.0.1', '::1', '[::1]', '100.94.130.7', '10.0.0.5', '172.16.4.4',
    '172.31.255.255', '192.168.1.10', '169.254.1.1', 'fd00::1', 'fe80::1', 'dbb.local',
    'dan-mac.tail1234.ts.net', 'dbb',
  ]) {
    assert.equal(backendGuard.isPrivateNetworkHost(host), true, `${host} is private-network`)
  }
  for (const host of [
    'cards.scryfall.io', 'fonts.gstatic.com', 'staging.dbb.example',
    'dbb.lovelikenotomorrow.com', 'abcdefg.supabase.co', '172.32.0.1', '172.15.0.1',
    '11.0.0.1', '192.169.1.1', '100.128.0.1', '100.63.0.1', '',
  ]) {
    assert.equal(backendGuard.isPrivateNetworkHost(host), false, `${host} is a public host`)
  }
})

// The cart add and the checkout are not browser writes. `/api/cart` and
// `/api/checkout` build their Supabase clients server-side from
// NEXT_PUBLIC_SUPABASE_URL read at request time, so a `.next` built against
// loopback and served by a process started from `.env.local` passes the bundle
// scan and the browser guard while every mutation lands on Tailscale. The
// harness environment is the only observable that pins the server side.
check('the server-side cart/checkout backend is pinned by the harness environment', () => {
  const env = value => (value === undefined ? {} : { NEXT_PUBLIC_SUPABASE_URL: value })

  assert.equal(
    backendGuard.assertHarnessBackendEnv({ env: env(LOOPBACK_SUPABASE) }), LOOPBACK_SUPABASE,
    'the documented loopback run is admitted')
  assert.equal(
    backendGuard.assertHarnessBackendEnv({ env: env(`${LOOPBACK_SUPABASE}/`) }), LOOPBACK_SUPABASE,
    'a trailing slash is the same origin, not a refusal')

  assert.throws(() => backendGuard.assertHarnessBackendEnv({ env: env(TAILSCALE_SUPABASE) }),
    /server-side cart\/checkout writes[\s\S]*Tailscale/,
    'the real .env.local value is refused and the hazard is named')
  assert.throws(() => backendGuard.assertHarnessBackendEnv({ env: env(undefined) }),
    /unset in the test process/, 'an unset backend is unidentified, which is a refusal')
  for (const bad of ['', 'not a url', 'https://abcdefg.supabase.co', 'http://192.168.1.10:54321']) {
    assert.throws(() => backendGuard.assertHarnessBackendEnv({ env: env(bad) }),
      'a non-approved backend must never be admitted: ' + bad)
  }
  // A *different* loopback origin is still a refusal: teardown asserts the
  // approved origin, so a server writing elsewhere would report a fixture it
  // never restored.
  assert.throws(() => backendGuard.assertHarnessBackendEnv({ env: env('http://127.0.0.1:54322') }),
    /pinned to the approved backend/,
    'the harness backend must equal the one teardown verifies, not merely be loopback')
})

// Every source contract below runs against comment-stripped source, so a guard
// that has been commented out — in either form — reads as absent, which is what
// it is. The mutation cases beside each one prove that.
function beforeEachBody(spec) {
  const block = stripComments(spec).match(/test\.beforeEach\(async \(\{[\s\S]*?\n\}\)/)
  assert.ok(block, 'beforeEach block found')
  return block[0]
}

function assertSpecBackendPinContract(spec) {
  const body = beforeEachBody(spec)
  assert.match(body, /assertHarnessBackendEnv\(\)/, 'the spec pins the server-side backend')
  assert.ok(
    body.indexOf('assertHarnessBackendEnv()') < body.indexOf('admittedBackend'),
    'the server-side pin runs before the cached bundle admission, not after it')
  assert.ok(!/if \(!admittedBackend\)[\s\S]*?assertHarnessBackendEnv/.test(body),
    'the server-side pin is re-run for every test rather than cached once per worker')
}

check('the spec pins the server-side backend before anything is cached', () => {
  assertSpecBackendPinContract(uatSpec)
})

check('a disabled server-side backend pin is rejected in either comment form', () => {
  expectContractRejects(assertSpecBackendPinContract, uatSpec, [
    ...commentedOutForms(uatSpec, '  assertHarnessBackendEnv()\n'),
    ['pin cached once per worker instead of re-run',
      uatSpec.replace('  assertHarnessBackendEnv()\n  if (!admittedBackend) {\n',
        '  if (!admittedBackend) {\n    assertHarnessBackendEnv()\n')],
  ])
})

function assertSpecRequestGuardContract(spec) {
  const source = stripComments(spec)
  assert.match(source, /test\.beforeEach\(/, 'admission runs before each test body')
  assert.match(source, /assertCandidateBackendIsLocal\(\{ request, baseURL \}\)/,
    'the candidate Supabase URL is resolved, not assumed from baseURL')
  assert.match(source, /assertLocalBackendReachable\(\{ request \}\)/,
    'the approved local backend is proven up')
  assert.match(source, /installBackendOriginGuard\(page, \{ baseURL \}\)/,
    'browser requests are intercepted for the whole test')
  assert.match(source, /guard\.assertNoViolations\(\)/,
    'a request that left loopback fails the test')
  // Naming the hazard in a comment is fine; targeting it in code is not — which
  // is exactly the distinction comment stripping makes available here.
  assert.ok(!/\b100\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|[\w-]+\.ts\.net/i.test(source),
    'the spec never targets a Tailscale or remote backend address')
}

check('the rendered spec admits its backend before any mutation and guards every request', () => {
  assertSpecRequestGuardContract(uatSpec)
  // Documentation, deliberately read from the raw source: this one lives in a
  // comment on purpose.
  assert.match(uatSpec, /NEXT_PUBLIC_SUPABASE_URL=http:\/\/127\.0\.0\.1:54321/,
    'the documented run command builds and serves against loopback')
})

check('a disabled request guard or a hard-coded remote backend is rejected', () => {
  expectContractRejects(assertSpecRequestGuardContract, uatSpec, [
    ...commentedOutForms(uatSpec, '    if (guard) guard.assertNoViolations()\n'),
    ...commentedOutForms(uatSpec, '  activeGuard = await installBackendOriginGuard(page, { baseURL })\n'),
    ['candidate bundle admission removed',
      uatSpec.replace('assertCandidateBackendIsLocal({ request, baseURL })', 'baseURL')],
    ['a Tailscale backend targeted in code',
      uatSpec.replace("const DAN_EMAIL = 'dan@dbb.test'",
        "const BACKEND = 'http://100.94.130.7:54321'\nconst DAN_EMAIL = 'dan@dbb.test'")],
  ])
  // The same address named in a comment is not a violation, in either form.
  for (const commented of [
    uatSpec.replace("const DAN_EMAIL = 'dan@dbb.test'",
      "// the hazard is http://100.94.130.7:54321\nconst DAN_EMAIL = 'dan@dbb.test'"),
    uatSpec.replace("const DAN_EMAIL = 'dan@dbb.test'",
      "/* the hazard is http://100.94.130.7:54321 */\nconst DAN_EMAIL = 'dan@dbb.test'"),
  ]) {
    assert.notEqual(commented, uatSpec)
    assertSpecRequestGuardContract(commented)
  }
})

function assertGuardHelperContract(helper) {
  const source = stripComments(helper)
  assert.match(source, /route\.abort\('blockedbyclient'\)/,
    'a misdirected mutation is stopped, not just recorded')
  assert.match(source, /state\.violations\.push\(requestUrl\)/)
  assert.match(source, /throw new Error\(\s*\n?\s*`backend admission: could not resolve/,
    'an unidentified candidate is a refusal, not a pass')
  assert.ok(!/reject.*unless.*localhost.*only/i.test(source))
}

check('the guard aborts non-loopback backend traffic instead of merely observing it', () => {
  assertGuardHelperContract(guardHelper)
})

check('a guard that only observes, in either comment form, is rejected', () => {
  expectContractRejects(assertGuardHelperContract, guardHelper, [
    ...commentedOutForms(guardHelper, "      return route.abort('blockedbyclient')\n"),
    ...commentedOutForms(guardHelper, '      state.violations.push(requestUrl)\n'),
  ])
})

// The app-origin half of the same guard. Its failure mode is the opposite of a
// missing abort: the request is classified, allowed, and nothing is recorded,
// because a non-Supabase host reads as "third-party" and third-party traffic is
// deliberately untouched. So the contract is about the classification, not only
// about the abort.
function assertAppOriginGuardContract(helper) {
  const source = stripComments(helper)
  const ownedHostAssignments = Array.from(
    source.matchAll(/\bconst LOOPBACK_APP_HOSTNAMES\s*=\s*(\[[^\n]*\])/g),
    match => match[1].trim())
  assert.deepEqual(ownedHostAssignments, ["['localhost', '127.0.0.1']"],
    'the app allowlist is assigned exactly once as the aliases served by the IPv4-only child; '
    + '[::1] is loopback but is not owned by a server bound to 127.0.0.1')
  assert.match(source,
    /if \(url\.protocol !== 'http:' \|\| !LOOPBACK_APP_HOSTNAMES\.includes\(url\.hostname\)\) return \[\]/,
    'the caller-supplied base origin is itself admitted only when it is one of the IPv4-owned '
    + 'aliases; an arbitrary loopback origin cannot claim ownership')
  assert.match(source,
    /return LOOPBACK_APP_HOSTNAMES\.map\(host => `http:\/\/\$\{host\}\$\{port\}`\)/,
    'owned origins are derived solely from the approved aliases at the supplied exact port, '
    + 'rather than seeded from the caller-supplied origin')
  assert.match(source, /if \(isApplicationRequest\(url, \{ isNavigation \}\)\) return 'blocked-app'/,
    'a cross-origin request that addresses an application is classified as blocked, not waved '
    + 'through as third-party because its host is not Supabase-shaped')
  assert.match(source, /if \(isNavigation\) return true/,
    'every cross-origin navigation counts: a staging redirect target is an ordinary public '
    + 'hostname, so the host alone cannot tell it from a CDN')
  assert.match(source, /return isPrivateNetworkHost\(url\.hostname\)/,
    'and a sub-resource from LAN/Tailscale/mDNS space is an app instance, not a CDN')
  assert.match(source, /const isNavigation = request\.isNavigationRequest\(\)/,
    'navigations are identified from the intercepted request rather than assumed')
  assert.match(source, /if \(BLOCKED_VERDICTS\.includes\(verdict\)\) \{/,
    'both blocked verdicts abort through the same branch')
  assert.match(source, /const BLOCKED_VERDICTS = \['blocked-backend', 'blocked-app'\]/,
    'and that set names the app verdict, so it cannot be aborted for backends alone')
  assert.match(source, /if \(verdict === 'blocked-app'\) state\.appViolations\.push\(requestUrl\)/,
    'an off-app request is recorded separately so the failure names the real cause')
  assert.match(source, /Refusing to run unguarded/,
    'a guard installed without an app origin cannot tell this app from another one, which is a '
    + 'refusal rather than a guard that allows everything')
  assert.ok(/APP_PATH_PREFIXES = \['\/api\/', '\/_next\/'\]/.test(source),
    'the app-shaped paths are named, so a foreign /api/ or /_next/ is caught without a navigation')
}

check('the guard refuses traffic aimed at a second application, not just a second backend', () => {
  assertAppOriginGuardContract(guardHelper)
})

check('a guard that lets a cross-origin app navigation through is rejected', () => {
  expectContractRejects(assertAppOriginGuardContract, guardHelper, [
    // The defect itself, restored: the classification falls back to
    // "third-party", which the route handler allows.
    ['a cross-origin app request re-classified as third-party',
      guardHelper.replace("  if (isApplicationRequest(url, { isNavigation })) return 'blocked-app'\n",
        '')],
    ...commentedOutForms(guardHelper,
      "  if (isApplicationRequest(url, { isNavigation })) return 'blocked-app'\n"),
    ...commentedOutForms(guardHelper, '  if (isNavigation) return true\n'),
    ...commentedOutForms(guardHelper, '  return isPrivateNetworkHost(url.hostname)\n'),
    ...commentedOutForms(guardHelper,
      "      if (verdict === 'blocked-app') state.appViolations.push(requestUrl)\n"),
    ['the abort branch narrowed back to backends only',
      guardHelper.replace('if (BLOCKED_VERDICTS.includes(verdict)) {',
        "if (verdict === 'blocked-backend') {")],
    ['the blocked set narrowed back to backends only',
      guardHelper.replace("const BLOCKED_VERDICTS = ['blocked-backend', 'blocked-app']",
        "const BLOCKED_VERDICTS = ['blocked-backend']")],
    ['navigations no longer identified',
      guardHelper.replace('const isNavigation = request.isNavigationRequest()',
        'const isNavigation = false && request.wasNavigation()')],
    ['a guard installed without an app origin allowed to run',
      guardHelper.replace(
        "      + '(baseURL) to tell this application apart from another one. Refusing to run unguarded.')",
        "      + '(baseURL) to tell this application apart from another one.')")],
    ['the app-shaped path list emptied',
      guardHelper.replace("const APP_PATH_PREFIXES = ['/api/', '/_next/']",
        'const APP_PATH_PREFIXES = []')],
    ['the unbound IPv6 loopback origin added to the owned app aliases',
      guardHelper.replace("const LOOPBACK_APP_HOSTNAMES = ['localhost', '127.0.0.1']",
        "const LOOPBACK_APP_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]']")],
    ['an arbitrary loopback base origin is allowed to seed the owned app set',
      guardHelper.replace(
        "if (url.protocol !== 'http:' || !LOOPBACK_APP_HOSTNAMES.includes(url.hostname)) return []",
        "if (url.protocol !== 'http:') return []")],
  ])
})

// The installed guard, driven directly. Presence of an abort in the source says
// nothing about which requests reach it, and the whole defect was a
// classification that never got there. A stub page is enough: page.route is a
// handler registration, so the routing decision can be exercised without a
// browser, a server or a database.
function driveGuard(requests, { baseURL = 'http://localhost:3100' } = {}) {
  let handler = null
  const page = { route: async (_pattern, fn) => { handler = fn } }
  return backendGuard.installBackendOriginGuard(page, { baseURL }).then(async (state) => {
    const outcomes = []
    for (const { url, navigation = false } of requests) {
      await handler({
        request: () => ({
          url: () => url,
          isNavigationRequest: () => navigation,
          resourceType: () => (navigation ? 'document' : 'fetch'),
        }),
        abort: (reason) => { outcomes.push(`abort:${reason}`) },
        continue: () => { outcomes.push('continue') },
      })
    }
    return { state, outcomes }
  })
}

await checkAsync('the installed guard aborts and records off-app traffic and passes everything else', async () => {
  const { state, outcomes } = await driveGuard([
    { url: 'http://localhost:3100/login', navigation: true },      // the isolated app
    { url: 'http://127.0.0.1:3100/api/cart' },                     // its loopback alias
    { url: `${LOOPBACK_SUPABASE}/rest/v1/listings` },              // the approved backend
    { url: 'https://cards.scryfall.io/normal/front/7/6/x.jpg' },   // fixture artwork
    { url: `${PROD_APP}/login`, navigation: true },                // the middleware redirect
    { url: `${LAN_APP}/api/checkout` },                            // a LAN app instance
    { url: `${TAILSCALE_SUPABASE}/rest/v1/orders` },               // the backend hazard
  ])
  assert.deepEqual(outcomes, [
    'continue', 'continue', 'continue', 'continue',
    'abort:blockedbyclient', 'abort:blockedbyclient', 'abort:blockedbyclient',
  ], 'exactly the three off-limits requests are stopped')
  assert.deepEqual(state.appViolations, [`${PROD_APP}/login`, `${LAN_APP}/api/checkout`],
    'both off-app requests are recorded as such')
  assert.equal(state.violations.length, 3)
  assert.deepEqual([...state.contacted], [LOOPBACK_SUPABASE], 'the approved backend was reached')
  assert.throws(() => state.assertNoViolations(), /left the approved local backend or the isolated app/)
  assert.throws(() => state.assertNoViolations(),
    /NEXT_PUBLIC_SITE_URL[\s\S]*inlined at build time/,
    'and the failure names the cause an operator has to fix, including the rebuild')
})

await checkAsync('a clean run reports no violations, so the guard is not failing everything', async () => {
  const { state, outcomes } = await driveGuard([
    { url: 'http://localhost:3100/claim-sales', navigation: true },
    { url: 'http://localhost:3100/_next/static/chunks/main.js' },
    { url: `${LOOPBACK_SUPABASE}/auth/v1/token?grant_type=password` },
    { url: 'https://cards.scryfall.io/normal/front/7/6/x.jpg' },
    { url: 'https://fonts.gstatic.com/s/inter/v13/x.woff2' },
  ])
  assert.deepEqual(outcomes, ['continue', 'continue', 'continue', 'continue', 'continue'])
  assert.deepEqual(state.violations, [])
  state.assertNoViolations()
})

await checkAsync('an IPv6 baseURL cannot claim or install an unowned application origin', async () => {
  const ipv6Origin = 'http://[::1]:3100'
  const expectedOwned = ['http://localhost:3100', 'http://127.0.0.1:3100']
  for (const approvedBase of ['http://localhost:3100', 'http://127.0.0.1:3100']) {
    assert.deepEqual(backendGuard.isolatedAppOrigins(approvedBase), expectedOwned,
      `ownership is derived from the two IPv4 aliases at the base origin's exact port: ${approvedBase}`)
  }
  for (const unapprovedBase of [
    ipv6Origin,
    'http://127.0.0.2:3100',
    'http://100.94.130.7:3100',
    'https://localhost:3100',
    'ftp://localhost:3100',
    'not a url',
    undefined,
  ]) {
    assert.deepEqual(backendGuard.isolatedAppOrigins(unapprovedBase), [],
      `an unapproved base origin owns nothing: ${String(unapprovedBase)}`)
  }
  assert.equal(
    backendGuard.classifyRequest('http://localhost:3101/login',
      { appOrigin: 'http://localhost:3100', isNavigation: true }),
    'blocked-app', 'even an approved hostname is not owned on a different port')
  assert.equal(
    backendGuard.classifyRequest(`${ipv6Origin}/login`, { appOrigin: ipv6Origin, isNavigation: true }),
    'blocked-app', '[::1] is not upgraded to app merely because it is the supplied baseURL')
  assert.equal(
    backendGuard.classifyRequest(`${ipv6Origin}/api/cart`, { appOrigin: ipv6Origin }),
    'blocked-app', 'an IPv6 app-shaped request remains refused under the same bad baseURL')
  await assert.rejects(() => driveGuard([{ url: `${ipv6Origin}/login`, navigation: true }],
    { baseURL: ipv6Origin }), /approved isolated IPv4 app origin/,
  'the installed runtime guard refuses the unowned IPv6 baseURL before registering routes')
})

function assertIsolatedAppOriginsBehaviourContract(helperSource) {
  const candidate = loadGuardHelperFromSource(helperSource)
  const expectedOwned = ['http://localhost:3100', 'http://127.0.0.1:3100']
  for (const approvedBase of ['http://localhost:3100', 'http://127.0.0.1:3100']) {
    assert.deepEqual(candidate.isolatedAppOrigins(approvedBase), expectedOwned)
  }
  for (const unapprovedBase of [
    'http://[::1]:3100',
    'http://127.0.0.2:3100',
    'http://100.94.130.7:3100',
    'https://localhost:3100',
    'not a url',
  ]) {
    assert.deepEqual(candidate.isolatedAppOrigins(unapprovedBase), [],
      `mutated helper let an unapproved base own origins: ${unapprovedBase}`)
  }
  assert.equal(
    candidate.classifyRequest('http://[::1]:3100/api/cart',
      { appOrigin: 'http://[::1]:3100' }),
    'blocked-app',
    'a supplied IPv6 base origin must not make IPv6 application traffic approved')
}

check('behavioural mutation control rejects a relaxed base-origin ownership check', () => {
  assertIsolatedAppOriginsBehaviourContract(guardHelper)
  expectContractRejects(assertIsolatedAppOriginsBehaviourContract, guardHelper, [
    ['the base-origin hostname admission removed',
      guardHelper.replace(
        "if (url.protocol !== 'http:' || !LOOPBACK_APP_HOSTNAMES.includes(url.hostname)) return []",
        "if (url.protocol !== 'http:') return []")],
    ['the caller-supplied IPv6 origin seeded into the owned set',
      guardHelper.replace(
        'return LOOPBACK_APP_HOSTNAMES.map(host => `http://${host}${port}`)',
        'return [url.origin, ...LOOPBACK_APP_HOSTNAMES.map(host => `http://${host}${port}`)]')],
  ])
})

await checkAsync('the guard refuses to install without an app origin to compare against', async () => {
  const page = { route: async () => {} }
  await assert.rejects(() => backendGuard.installBackendOriginGuard(page, {}),
    /Refusing to run unguarded/,
    'without baseURL every origin would look foreign or none would; neither is a usable guard')
  await assert.rejects(() => backendGuard.installBackendOriginGuard(page),
    /Refusing to run unguarded/)
})

// --- 7. Per-test fixture teardown -------------------------------------------
// The reserved-state test deliberately creates an unpaid order. It is allowed
// to only because teardown cancels it in the same test and proves the offered
// copy came back.

function assertSpecTeardownContract(spec) {
  const source = stripComments(spec)
  assert.match(source, /test\.afterEach\(/, 'teardown is registered, not left to the last test')
  assert.match(source, /await restoreFixture\(CLAIM_SALE_ID\)/)
  // Both halves must run: a throwing teardown may not hide a guard violation
  // and a guard violation may not skip the restore.
  const afterEach = source.match(/test\.afterEach\(async \(\) => \{[\s\S]*?\n\}\)/)
  assert.ok(afterEach, 'afterEach block found')
  assert.match(afterEach[0], /guard\.assertNoViolations\(\)/, 'the guard verdict is consumed')
  assert.equal((afterEach[0].match(/try \{/g) || []).length, 2,
    'the guard check and the restore are independently caught')
  assert.match(afterEach[0], /problems\.push\(error\.message\)/)
  assert.match(afterEach[0], /if \(problems\.length > 0\) throw/,
    'a failed teardown fails the test rather than passing silently')
}

check('every test ends by restoring the fixture, even when the body failed', () => {
  assertSpecTeardownContract(uatSpec)
})

check('a disabled teardown or guard verdict is rejected in either comment form', () => {
  expectContractRejects(assertSpecTeardownContract, uatSpec, [
    ...commentedOutForms(uatSpec, '    await restoreFixture(CLAIM_SALE_ID)\n'),
    ...commentedOutForms(uatSpec, '    if (guard) guard.assertNoViolations()\n'),
    ...commentedOutForms(uatSpec, '  if (problems.length > 0) throw new Error(problems.join(\'\\n\'))\n'),
  ])
})

function assertCleanupHelperContract(helper) {
  const source = stripComments(helper)
  assert.match(source, /fixture cart not empty: buyer still holds/,
    'the buyer cart is proven empty, not just the fixture rows deleted')
  assert.match(source, /fixture cart cleanup incomplete/)
  assert.match(source, /fixture order cleanup incomplete/)
  assert.match(source, /fixture order reservations still hold/,
    'no order-sourced hold may survive teardown')
  assert.match(source, /expected its own listing/,
    'each fixture card is back under its own listing reservation')
  assert.match(source, /reserved_quantity/, 'the restored hold quantity is asserted')
  assert.match(source, /expected active/, 'both listings are offered again')

  assert.match(source, /db\.from\('cart_items'\)\.delete\(\)\.in\('listing_id', fixture\.listingIds\)/,
    'cart deletion is scoped to the fixture listings')
  assert.match(source, /db\.rpc\('transition_order'/,
    'orders are cancelled through the production RPC, not by editing rows')
  assert.match(source, /Refusing to touch order/, 'a foreign seller aborts teardown')
  assert.match(source, /Refusing to cancel order/, 'a foreign order line aborts teardown')
  assert.ok(!/from\('(orders|order_items|listings|marketplace_card_reservations|library_cards)'\)\s*\.delete\(/
    .test(source), 'teardown never deletes orders, listings, reservations or cards')
  assert.match(source, /createClient\(APPROVED_BACKEND_ORIGIN, serviceKey/,
    'the teardown client is bound to the approved loopback origin, never to NEXT_PUBLIC_SUPABASE_URL')

  assert.match(source, /for \(const step of \[clearFixtureCart, cancelFixtureOrders\]\)/)
  assert.match(source, /problems\.push\(error\.message\)/)
  assert.match(source, /throw new Error\(`fixture teardown failed:/,
    'all teardown failures are reported together')
  // The restoration proof runs even when an earlier cleanup step threw.
  const restore = source.match(/async function restoreFixture\([\s\S]*?\n\}/)
  assert.ok(restore, 'restoreFixture found')
  assert.match(restore[0], /await assertFixtureRestored\(db, fixture\)/)
  assert.ok(restore[0].indexOf('assertFixtureRestored') > restore[0].indexOf('problems.push'),
    'restoration is verified after the cleanup steps, not instead of them')
}

check('teardown proves cart, order and reservation state and stays in scope', () => {
  assertCleanupHelperContract(cleanupHelper)
})

check('a disabled restoration proof or an out-of-scope delete is rejected', () => {
  expectContractRejects(assertCleanupHelperContract, cleanupHelper, [
    ...commentedOutForms(cleanupHelper, '      await assertFixtureRestored(db, fixture)\n'),
    ['a wholesale order delete added to teardown',
      cleanupHelper.replace('async function restoreFixture(',
        "async function wipe(db) { await db.from('orders').delete().eq('x', 1) }\n"
        + 'async function restoreFixture(')],
    ['the teardown client bound to the ambient env instead of the approved origin',
      cleanupHelper.replace('createClient(APPROVED_BACKEND_ORIGIN, serviceKey',
        'createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, serviceKey')],
  ])
})

// --- 8. Isolated server admission -------------------------------------------
// The harness environment pin (section 6) only describes a server *this run
// started*. The former single config defaulted to port 3000 and reused whatever
// was already listening there — Dan's long-lived server, whose server-side
// NEXT_PUBLIC_SUPABASE_URL this run never set. A server built against loopback
// but started from `.env.local` passes the bundle scan and the browser guard
// while every cart/checkout/order write leaves loopback.
//
// The repair is structural rather than argv-shaped. Scope is now a property of
// which config was selected:
//   * playwright.config.js excludes the mutating suite through `testIgnore`,
//     which Playwright applies itself to every candidate file after positional
//     filters have run, so no selection form re-admits it;
//   * playwright.claim-sale.config.js is the only route that can run it, and it
//     requires an explicit numeric non-3000 PW_PORT and never reuses a listener.
//
// Neither config parses process.argv. A hand-written flag parser has to model
// every present and future Playwright flag correctly, and any gap in it
// silently re-admits the mutating suite onto the shared server — the failure
// direction that matters here.

function assertNoArgvScopeParser(source, label) {
  assert.ok(!/process\.argv/.test(source),
    `${label} must not decide scope by parsing argv; scope is which config was selected`)
}

// The contracts, expressed once so the same assertions can be pointed at
// deliberately broken variants of each config below.
function assertDefaultConfigContract(config) {
  const source = stripComments(config)
  assertNoArgvScopeParser(source, 'playwright.config.js')
  assert.match(source, /const MUTATING_SUITE_IGNORE = '\*\*\/phase45c-claim-sale-uat\.spec\.js'/,
    'the mutating suite is named as an ignore glob that matches at any path depth')
  assert.match(source, /testIgnore: MUTATING_SUITE_IGNORE,/,
    'the default config cannot collect the mutating suite at all')
  assert.ok(!/testMatch/.test(source),
    'the default config excludes by ignore rather than by an allowlist that could be widened')
}

// Every `reuseExistingServer` assignment in a comment-stripped source, as the
// exact assigned text. The value is extracted and compared rather than probed
// with a negative lookahead: a lookahead placed after a quantifier that can give
// ground backtracks, so `/reuseExistingServer:\s*(?!false)/` matched the correct
// `reuseExistingServer: false` — `\s*` surrendered the space it had matched and
// `(?!false)` then read ` false`. That made the gate reject the one literal it
// exists to require. Extraction has no such failure mode, and returning every
// occurrence also catches a second assignment that overrides the first, which a
// presence match cannot see.
function reuseExistingServerValues(source) {
  return Array.from(source.matchAll(/\breuseExistingServer\s*:\s*([^,;}]*)/g),
    match => match[1].trim())
}

// Every `KEY: value` assignment in a comment-stripped source, as the exact
// assigned text — the same extraction shape as reuseExistingServerValues, and
// for the same reason: a presence match cannot see a second assignment that
// overrides the first, and cannot tell `ISOLATED_APP_ORIGIN` from
// `process.env.NEXT_PUBLIC_SITE_URL`.
function assignedValues(source, key) {
  // Read a complete quoted/template literal before applying the ordinary
  // object-value delimiters. In particular, the `}` in `${PORT}` belongs to
  // the command's template literal and must not truncate the extracted value.
  const assignment = new RegExp(
    '\\b' + key + '\\s*:\\s*('
    + '`(?:\\\\.|[^`])*`'
    + "|'(?:\\\\.|[^'])*'"
    + '|"(?:\\\\.|[^"])*"'
    + '|[^,;}\\n]*)',
    'g')
  return Array.from(source.matchAll(assignment),
    match => match[1].trim())
}

function assertMutatingConfigContract(config) {
  const source = stripComments(config)
  assertNoArgvScopeParser(source, 'playwright.claim-sale.config.js')
  assert.match(source,
    /const \{ assertIsolatedBuildReceipt \} = require\('\.\/tests\/helpers\/isolated-build-receipt'\);/,
    'the dedicated config imports the receipt validator rather than merely documenting the wrapper')
  assert.ok(!/const PORT = process\.env\.PW_PORT \|\| '3000'/.test(source),
    'an unconditional default-3000 fallback must not decide the mutating suite port')
  assert.ok(!/process\.env\.PW_PORT \|\|/.test(source),
    'there is no fallback port at all: an unset PW_PORT is a refusal, not a default')
  assert.match(source, /const PORT = resolveIsolatedPort\(process\.env\)/,
    'the port comes from the fail-closed resolver, unconditionally')
  assert.match(source, /if \(!\/\^\\d\+\$\/\.test\(raw\)\)/,
    'PW_PORT must be numeric, so a hostname or a partly-numeric value cannot slip through')
  assert.match(source, /Number\(raw\) === Number\(SHARED_PORT\)/,
    'the shared port is rejected numerically, not by string equality alone')
  assert.match(source, /reuseExistingServer: false,/,
    'an existing listener is never reused for this suite')
  assert.ok(!/reuseExistingServer: !process\.env\.CI/.test(source),
    'the former conditional reuse must be gone')
  assert.deepEqual(reuseExistingServerValues(source), ['false'],
    'reuse is assigned exactly once, as the literal false, never true and never an '
    + 'expression that could evaluate true')
  assert.deepEqual(
    assignedValues(source, 'testMatch'), ["'**/phase45c-claim-sale-uat.spec.js'"],
    'testMatch is assigned exactly once as the literal mutating-suite glob, so a later broad '
    + 'override cannot share this server with another suite')

  // The app origin, and both NEXT_PUBLIC_ values the isolated child is given.
  // NEXT_PUBLIC_SITE_URL is what src/middleware.js builds its auth redirects
  // from; left to `.env.local` it is the phone-facing shared server, so the
  // first protected navigation carries the fixture session off this app.
  assert.match(source, /const ISOLATED_APP_ORIGIN = `http:\/\/localhost:\$\{PORT\}`;/,
    'the isolated app origin is derived from the isolated port, so it cannot drift from the '
    + 'server this config starts')
  assert.match(source, /const ISOLATED_BACKEND_ORIGIN = assertHarnessBackendEnv\(\);/,
    'the backend handed to the child is resolved by the helper that owns the loopback contract, '
    + 'at config load, before a server exists')
  assert.deepEqual(assignedValues(source, 'baseURL'), ['ISOLATED_APP_ORIGIN'],
    'the browser drives the isolated origin and nothing else')
  assert.deepEqual(assignedValues(source, 'NEXT_PUBLIC_SITE_URL'), ['ISOLATED_APP_ORIGIN'],
    'the site origin handed to the child is the isolated one, assigned exactly once and never '
    + 'read back out of the ambient environment')
  assert.deepEqual(assignedValues(source, 'NEXT_PUBLIC_SUPABASE_URL'), ['ISOLATED_BACKEND_ORIGIN'],
    'and so is the backend')
  assert.deepEqual(assignedValues(source, 'env'), ['ISOLATED_SERVER_ENV'],
    'the child environment is that pair, passed to webServer so Playwright merges it over '
    + 'process.env rather than letting .env.local through')
  assert.deepEqual(assignedValues(source, 'url'), ['ISOLATED_APP_ORIGIN'],
    'and the server Playwright waits for is the same origin')
  assert.deepEqual(
    assignedValues(source, 'command'), ['`npm run start -- -p ${PORT} -H 127.0.0.1`'],
    'webServer.command is assigned exactly once as the literal IPv4-loopback-bound command; '
    + 'a later command cannot expose the fixture server or invalidate its owned-origin set')
  assert.match(source,
    /assertIsolatedBuildReceipt\(\{[\s\S]*?configRoot: __dirname,[\s\S]*?port: PORT,[\s\S]*?backendOrigin: ISOLATED_BACKEND_ORIGIN,[\s\S]*?appOrigin: ISOLATED_APP_ORIGIN,[\s\S]*?\}\);/,
    'config load requires a receipt bound to this candidate root, port, backend, and app origin')
}

// A gate that fails on its own correct source is as unusable as one that passes
// on a broken source, so the reuse contract is proven in both directions here:
// the shipped literal is accepted, and the ways it can be weakened are not.
check('the reuse contract accepts the literal false and rejects everything else', () => {
  const shipped = '  webServer: {\n    reuseExistingServer: false,\n    timeout: 120000,\n  },\n'
  assert.deepEqual(reuseExistingServerValues(shipped), ['false'],
    'the shipped assignment is read as the literal false')
  // The regression this replaced, kept executable: the old negative-lookahead
  // form matches the *correct* literal, which is why it failed the real config.
  assert.ok(/reuseExistingServer:\s*(?!false)/.test(shipped),
    'the superseded lookahead form backtracks and matches the correct literal, so an '
    + 'assertion built on its absence rejects a compliant config')

  // Layout and comment variants of the same literal are still that literal.
  for (const valid of [
    'reuseExistingServer:false,',
    'reuseExistingServer:   false,',
    'reuseExistingServer: false }',
    'reuseExistingServer: false\n}',
    'reuseExistingServer: false, // never reused',
    'reuseExistingServer: false, /* never reused */',
  ]) {
    assert.deepEqual(reuseExistingServerValues(stripComments(valid)), ['false'],
      `the literal false must be accepted: ${JSON.stringify(valid)}`)
  }

  // Anything that is not exactly that literal is refused, including values that
  // merely contain `false` and expressions that read as harmless.
  for (const invalid of [
    'reuseExistingServer: true,',
    'reuseExistingServer: !process.env.CI,',
    'reuseExistingServer: ISOLATED ? false : !process.env.CI,',
    'reuseExistingServer: false || !process.env.CI,',
    'reuseExistingServer: Boolean(process.env.REUSE),',
    "reuseExistingServer: 'false',",
    'reuseExistingServer: falsey,',
    'reuseExistingServer: (false),',
    'reuseExistingServer: undefined,',
    // A later assignment overrides the first; presence alone would miss it.
    'reuseExistingServer: false,\n    reuseExistingServer: true,',
  ]) {
    assert.notDeepEqual(reuseExistingServerValues(stripComments(invalid)), ['false'],
      `expected refusal: ${JSON.stringify(invalid)}`)
  }

  // A commented-out assignment is not an assignment, in either comment form.
  for (const disabled of [
    '  // reuseExistingServer: false,\n',
    '  /* reuseExistingServer: false, */\n',
  ]) {
    assert.deepEqual(reuseExistingServerValues(stripComments(disabled)), [],
      `a disabled assignment must not be read as one: ${JSON.stringify(disabled)}`)
  }
})

check('the default config excludes the mutating suite and parses no argv', () => {
  assertDefaultConfigContract(defaultConfig)
})

check('the dedicated config owns its own non-3000, non-reused server', () => {
  assertMutatingConfigContract(claimSaleConfig)
})

check('a weakened default config is rejected, including a commented-out ignore', () => {
  expectContractRejects(assertDefaultConfigContract, defaultConfig, [
    ...commentedOutForms(defaultConfig, '  testIgnore: MUTATING_SUITE_IGNORE,\n'),
    ['ignore narrowed to a bare filename that no longer matches at depth',
      defaultConfig.replace("'**/phase45c-claim-sale-uat.spec.js'",
        "'phase45c-claim-sale-uat.spec.js'")],
    ['an argv scope parser reintroduced',
      defaultConfig.replace("const PORT = process.env.PW_PORT || '3000';",
        "const ISOLATED = process.argv.includes('claim-sale');\n"
        + "const PORT = process.env.PW_PORT || '3000';")],
  ])
})

check('a weakened dedicated config is rejected, including the former bypasses', () => {
  // The reuse mutations target a whole indented line. The prose header of that
  // config also contains the text `reuseExistingServer: false,`, and a bare
  // String#replace rewrites that first occurrence — leaving the code compliant,
  // so the contract cannot reject it and the mutation proves nothing. While the
  // backtracking assertion above threw for every input, that looked like a pass.
  const REUSE_LINE = '    reuseExistingServer: false,\n'
  const COMMAND_LINE = '    command: `npm run start -- -p ${PORT} -H 127.0.0.1`,\n'
  const TEST_MATCH_LINE = "  testMatch: '**/phase45c-claim-sale-uat.spec.js',\n"
  const mutateReuse = (replacement) => {
    assert.equal(claimSaleConfig.split(REUSE_LINE).length - 1, 1,
      'the reuse assignment must be targeted as a unique whole line, not as loose text')
    return claimSaleConfig.replace(REUSE_LINE, `    ${replacement}\n`)
  }
  expectContractRejects(assertMutatingConfigContract, claimSaleConfig, [
    ...commentedOutForms(claimSaleConfig, 'const PORT = resolveIsolatedPort(process.env);\n'),
    ...commentedOutForms(claimSaleConfig,
      "const { assertIsolatedBuildReceipt } = require('./tests/helpers/isolated-build-receipt');\n"),
    ...commentedOutForms(claimSaleConfig, REUSE_LINE),
    ['reuse restored to !CI', mutateReuse('reuseExistingServer: !process.env.CI,')],
    ['reuse made conditional on an argv-derived flag',
      mutateReuse('reuseExistingServer: ISOLATED ? false : !process.env.CI,')],
    ['reuse flipped to the literal true', mutateReuse('reuseExistingServer: true,')],
    ['port fallback restored to 3000',
      claimSaleConfig.replace('const PORT = resolveIsolatedPort(process.env);',
        "const PORT = process.env.PW_PORT || '3000';")],
    ['numeric PW_PORT requirement dropped',
      claimSaleConfig.replace('if (!/^\\d+$/.test(raw)) {', 'if (false) {')],
    ['shared-port refusal dropped',
      claimSaleConfig.replace('Number(raw) === Number(SHARED_PORT)', 'false')],
    ...commentedOutForms(claimSaleConfig, COMMAND_LINE),
    ...commentedOutForms(claimSaleConfig, TEST_MATCH_LINE),
    ['server command rebound to every interface',
      claimSaleConfig.replace(COMMAND_LINE,
        '    command: `npm run start -- -p ${PORT} -H 0.0.0.0`,\n')],
    ['safe server command followed by an unsafe overriding command',
      claimSaleConfig.replace(COMMAND_LINE,
        COMMAND_LINE + '    command: `npm run start -- -p ${PORT} -H 0.0.0.0`,\n')],
    ['testMatch widened to every spec in the directory',
      claimSaleConfig.replace(TEST_MATCH_LINE, "  testMatch: '**/*.spec.js',\n")],
    ['safe testMatch followed by a later broad override',
      claimSaleConfig.replace(TEST_MATCH_LINE,
        TEST_MATCH_LINE + "  testMatch: '**/*.spec.js',\n")],
    ['an argv scope parser reintroduced',
      claimSaleConfig.replace('const PORT = resolveIsolatedPort(process.env);',
        'const PORT = process.argv.includes(MUTATING_SUITE)\n'
        + "  ? resolveIsolatedPort(process.env) : '3000';")],
    ['the receipt validator call removed',
      claimSaleConfig.replace(/assertIsolatedBuildReceipt\(\{[\s\S]*?\}\);\n/, '')],
  ])
  // The exact pre-repair configuration, verbatim.
  assert.throws(() => assertMutatingConfigContract(
    "const PORT = process.env.PW_PORT || '3000';\n"
    + '  webServer: { reuseExistingServer: !process.env.CI, },'))
})

check('a config that leaves the site origin to the environment is rejected', () => {
  // The defect this closes: the config pinned the backend and said nothing
  // about NEXT_PUBLIC_SITE_URL, so src/middleware.js kept building its auth
  // redirects from .env.local's phone-facing origin.
  expectContractRejects(assertMutatingConfigContract, claimSaleConfig, [
    ...commentedOutForms(claimSaleConfig,
      '  NEXT_PUBLIC_SITE_URL: ISOLATED_APP_ORIGIN,\n'),
    ...commentedOutForms(claimSaleConfig,
      '  NEXT_PUBLIC_SUPABASE_URL: ISOLATED_BACKEND_ORIGIN,\n'),
    ...commentedOutForms(claimSaleConfig,
      'const ISOLATED_APP_ORIGIN = `http://localhost:${PORT}`;\n'),
    ...commentedOutForms(claimSaleConfig,
      'const ISOLATED_BACKEND_ORIGIN = assertHarnessBackendEnv();\n'),
    ...commentedOutForms(claimSaleConfig, '    env: ISOLATED_SERVER_ENV,\n'),
    ['the site origin read back out of the ambient environment',
      claimSaleConfig.replace('  NEXT_PUBLIC_SITE_URL: ISOLATED_APP_ORIGIN,',
        '  NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,')],
    ['the site origin hard-coded to a deployment instead of the isolated server',
      claimSaleConfig.replace('  NEXT_PUBLIC_SITE_URL: ISOLATED_APP_ORIGIN,',
        "  NEXT_PUBLIC_SITE_URL: 'https://dbb.lovelikenotomorrow.com',")],
    ['the site origin overridden by a second assignment',
      claimSaleConfig.replace('  NEXT_PUBLIC_SITE_URL: ISOLATED_APP_ORIGIN,',
        '  NEXT_PUBLIC_SITE_URL: ISOLATED_APP_ORIGIN,\n'
        + '  NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,')],
    ['the app origin decoupled from the isolated port',
      claimSaleConfig.replace('const ISOLATED_APP_ORIGIN = `http://localhost:${PORT}`;',
        "const ISOLATED_APP_ORIGIN = 'http://localhost:3000';")],
    ['the backend pin replaced by whatever the harness happened to export',
      claimSaleConfig.replace('const ISOLATED_BACKEND_ORIGIN = assertHarnessBackendEnv();',
        'const ISOLATED_BACKEND_ORIGIN = process.env.NEXT_PUBLIC_SUPABASE_URL;')],
    ['baseURL pointed somewhere other than the isolated origin',
      claimSaleConfig.replace('    baseURL: ISOLATED_APP_ORIGIN,',
        "    baseURL: 'http://localhost:3000',")],
  ])
})

// Behavioural half, part one: load each real config in a child process with a
// controlled argv and environment. Loading a Playwright config starts nothing —
// this is a pure resolution check, no server and no browser.
const DEFAULT_CONFIG_PATH = fileURLToPath(new URL('../playwright.config.js', import.meta.url))
const MUTATING_CONFIG_PATH =
  fileURLToPath(new URL('../playwright.claim-sale.config.js', import.meta.url))
const PROBE = `
  const configPath = process.argv[1]
  try {
    const config = require(configPath)
    console.log(JSON.stringify({
      ok: true,
      baseURL: config.use.baseURL,
      serverUrl: config.webServer.url,
      serverCommand: config.webServer.command,
      reuse: config.webServer.reuseExistingServer,
      serverEnv: config.webServer.env === undefined ? null : config.webServer.env,
      testIgnore: config.testIgnore === undefined ? null : config.testIgnore,
      testMatch: config.testMatch === undefined ? null : config.testMatch,
    }))
  } catch (error) {
    console.log(JSON.stringify({ ok: false, message: String(error && error.message) }))
  }
`

function loadConfig(configPath, { env = {}, argv = [] } = {}) {
  const effectiveEnv = { ...env }
  if (configPath === MUTATING_CONFIG_PATH
    && effectiveEnv.PW_PORT
    && !Object.hasOwn(effectiveEnv, 'PHASE45C_ISOLATED_BUILD_RECEIPT')) {
    effectiveEnv.PHASE45C_ISOLATED_BUILD_RECEIPT = makeConfigReceipt({
      port: String(effectiveEnv.PW_PORT).trim(),
      backend: effectiveEnv.NEXT_PUBLIC_SUPABASE_URL || LOOPBACK_SUPABASE,
    })
  }
  const result = spawnSync(process.execPath, ['-e', PROBE, configPath, ...argv], {
    encoding: 'utf8',
    // Deliberately not inherited: PW_PORT/CI from this shell must not decide the
    // outcome of a case that is about their absence.
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...effectiveEnv },
  })
  assert.equal(result.status, 0, `config probe crashed: ${result.stderr}`)
  return JSON.parse(result.stdout)
}

const MUTATING = 'tests/phase45c-claim-sale-uat.spec.js'
const READ_ONLY = 'tests/mobile-alignment-uat.spec.js'
const CONFIG_RECEIPT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dbb-phase45c-config-receipt-'))
const CONFIG_RECEIPT_SOURCE = path.join(CONFIG_RECEIPT_ROOT, 'source')
const CONFIG_RECEIPT_CANDIDATE_ROOT = fileURLToPath(new URL('..', import.meta.url))
fs.mkdirSync(path.join(CONFIG_RECEIPT_SOURCE, '.next'), { recursive: true })
fs.writeFileSync(path.join(CONFIG_RECEIPT_SOURCE, 'package.json'), '{"name":"receipt-source"}\n')
fs.writeFileSync(path.join(CONFIG_RECEIPT_SOURCE, '.next', 'BUILD_ID'), 'receipt-source-build\n')
const hashFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const CONFIG_RECEIPT_SOURCE_HASH = hashFile(path.join(CONFIG_RECEIPT_SOURCE, '.next', 'BUILD_ID'))
const CONFIG_RECEIPT_CANDIDATE_HASH = hashFile(path.join(CONFIG_RECEIPT_CANDIDATE_ROOT, '.next', 'BUILD_ID'))
process.on('exit', () => fs.rmSync(CONFIG_RECEIPT_ROOT, { recursive: true, force: true }))

function makeConfigReceipt({ port, backend = LOOPBACK_SUPABASE, overrides = {} }) {
  const receiptPath = path.join(CONFIG_RECEIPT_ROOT, `receipt-${String(port).replace(/[^0-9]/g, '_')}-${crypto.randomUUID()}.json`)
  fs.writeFileSync(receiptPath, `${JSON.stringify({
    version: 1,
    sourceRoot: CONFIG_RECEIPT_SOURCE,
    candidateRoot: CONFIG_RECEIPT_CANDIDATE_ROOT,
    sourceBuildIdHashBefore: CONFIG_RECEIPT_SOURCE_HASH,
    sourceBuildIdHashAfter: CONFIG_RECEIPT_SOURCE_HASH,
    candidateBuildIdHash: CONFIG_RECEIPT_CANDIDATE_HASH,
    backendOrigin: backend,
    appOrigin: `http://localhost:${port}`,
    port: String(port),
    ...overrides,
  })}\n`)
  return receiptPath
}
// The dedicated config now resolves its child's backend at load through the
// guard helper, so an admission case has to supply the documented value. The
// helper loads .env.local with override:false, which is why omitting the key
// does not model "unset": the phone-facing value would fill it in. An explicit
// empty string is what an unidentified backend looks like to a child process.
const ISOLATED_ENV = {
  PW_PORT: '3100',
  NEXT_PUBLIC_SUPABASE_URL: LOOPBACK_SUPABASE,
  PHASE45C_ISOLATED_BUILD_RECEIPT: makeConfigReceipt({ port: '3100' }),
}

check('the dedicated config refuses to resolve at all without an explicit PW_PORT', () => {
  const refused = loadConfig(MUTATING_CONFIG_PATH)
  assert.equal(refused.ok, false, 'a bare mutating run must not resolve a config at all')
  assert.match(refused.message, /PW_PORT is unset/)
  assert.match(refused.message, /3000/, 'the message names the shared server it refuses')
  assert.match(refused.message, /PW_PORT=3100/, 'the message quotes a usable re-run')
})

check('that refusal does not depend on how the dedicated config was invoked', () => {
  // Nothing is parsed out of the command line, so every argv — including ones
  // that name only a read-only spec, or none at all — gets the same refusal.
  // This is the property the removed argv parser could not offer.
  for (const argv of [
    [], ['test'], [READ_ONLY], ['--reporter', 'list'], ['--project=chromium'], ['('],
    ['--grep', 'thumbnail'], [READ_ONLY, MUTATING],
  ]) {
    const refused = loadConfig(MUTATING_CONFIG_PATH, { argv })
    assert.equal(refused.ok, false,
      `argv ${JSON.stringify(argv)} must not admit an unset PW_PORT`)
    assert.match(refused.message, /PW_PORT is unset/)
  }
})

check('the shared 3000 server is refused even when PW_PORT names it explicitly', () => {
  for (const port of ['3000', ' 3000 ', '03000']) {
    const refused = loadConfig(MUTATING_CONFIG_PATH, { env: { PW_PORT: port } })
    assert.equal(refused.ok, false, `PW_PORT=${JSON.stringify(port)} must be refused`)
    assert.match(refused.message, /shared long-lived server port/)
  }
  for (const bad of ['abc', '3100abc', 'localhost:3100', '-1', '31 00']) {
    const garbage = loadConfig(MUTATING_CONFIG_PATH, { env: { PW_PORT: bad } })
    assert.equal(garbage.ok, false, `PW_PORT=${JSON.stringify(bad)} must be refused`)
    assert.match(garbage.message, /not a port number/)
  }
})

check('an explicit non-3000 PW_PORT admits the suite onto a server it starts itself', () => {
  const admitted = loadConfig(MUTATING_CONFIG_PATH, { env: ISOLATED_ENV })
  assert.equal(admitted.ok, true, `expected admission, got ${admitted.message}`)
  assert.equal(admitted.baseURL, 'http://localhost:3100')
  assert.equal(admitted.serverUrl, 'http://localhost:3100')
  assert.equal(admitted.serverCommand, 'npm run start -- -p 3100 -H 127.0.0.1',
    'the loaded config starts the owned IPv4-loopback listener and exposes no other interface')
  assert.equal(admitted.reuse, false, 'an existing listener is never reused for this suite')
  assert.equal(admitted.testMatch, '**/phase45c-claim-sale-uat.spec.js',
    'and the isolated server it starts is not shared with any other suite')
})

check('the dedicated config refuses absent, forged, or source-bound build receipts at load', () => {
  const absent = loadConfig(MUTATING_CONFIG_PATH, {
    env: { ...ISOLATED_ENV, PHASE45C_ISOLATED_BUILD_RECEIPT: '' },
  })
  assert.equal(absent.ok, false, 'a documented wrapper without its receipt must not admit a server')
  assert.match(absent.message, /receipt/)

  const forged = makeConfigReceipt({
    port: '3100', overrides: { candidateBuildIdHash: 'forged' },
  })
  const forgedResult = loadConfig(MUTATING_CONFIG_PATH, {
    env: { ...ISOLATED_ENV, PHASE45C_ISOLATED_BUILD_RECEIPT: forged },
  })
  assert.equal(forgedResult.ok, false, 'a receipt that lies about the candidate build must be refused')
  assert.match(forgedResult.message, /candidate BUILD_ID hash/)

  const sourceBound = makeConfigReceipt({
    port: '3100', overrides: { sourceRoot: CONFIG_RECEIPT_CANDIDATE_ROOT },
  })
  const sourceBoundResult = loadConfig(MUTATING_CONFIG_PATH, {
    env: { ...ISOLATED_ENV, PHASE45C_ISOLATED_BUILD_RECEIPT: sourceBound },
  })
  assert.equal(sourceBoundResult.ok, false, 'a receipt that names the source as candidate/source must be refused')
  assert.match(sourceBoundResult.message, /separate, non-nested/)
})

check('the isolated child is handed the isolated site origin and the loopback backend', () => {
  // Resolved from the real config in a child process, so this is the object
  // Playwright would merge over process.env — not a source match.
  const admitted = loadConfig(MUTATING_CONFIG_PATH, { env: ISOLATED_ENV })
  assert.equal(admitted.ok, true, `expected admission, got ${admitted.message}`)
  assert.deepEqual(admitted.serverEnv, {
    NEXT_PUBLIC_SUPABASE_URL: LOOPBACK_SUPABASE,
    NEXT_PUBLIC_SITE_URL: 'http://localhost:3100',
  }, 'both NEXT_PUBLIC_ values are pinned; neither is inherited from .env.local')
  assert.equal(admitted.serverEnv.NEXT_PUBLIC_SITE_URL, admitted.baseURL,
    'the origin middleware redirects to is the origin the browser drives')

  // The site origin follows PW_PORT, so a different isolated port cannot leave
  // the middleware redirecting at the previous one.
  const other = loadConfig(MUTATING_CONFIG_PATH,
    { env: {
      ...ISOLATED_ENV,
      PW_PORT: '3210',
      PHASE45C_ISOLATED_BUILD_RECEIPT: makeConfigReceipt({ port: '3210' }),
    } })
  assert.equal(other.ok, true, `expected admission, got ${other.message}`)
  assert.equal(other.serverEnv.NEXT_PUBLIC_SITE_URL, 'http://localhost:3210')
  assert.equal(other.baseURL, 'http://localhost:3210')

  // The real .env.local value must never be what the child receives.
  assert.notEqual(admitted.serverEnv.NEXT_PUBLIC_SITE_URL, 'http://100.94.130.7:3000')
})

check('the dedicated config refuses at load when the backend is wrong or unidentified', () => {
  // The port is resolved first, so these are genuinely backend refusals rather
  // than the PW_PORT refusal wearing a different message.
  const tailscale = loadConfig(MUTATING_CONFIG_PATH,
    { env: { PW_PORT: '3100', NEXT_PUBLIC_SUPABASE_URL: TAILSCALE_SUPABASE } })
  assert.equal(tailscale.ok, false, 'a Tailscale backend must not start an isolated server')
  assert.match(tailscale.message, /Tailscale/)

  const unset = loadConfig(MUTATING_CONFIG_PATH,
    { env: { PW_PORT: '3100', NEXT_PUBLIC_SUPABASE_URL: '' } })
  assert.equal(unset.ok, false, 'an unidentified backend is a refusal, at config load')
  assert.match(unset.message, /unset in the test process/)

  for (const bad of ['https://abcdefg.supabase.co', 'http://192.168.1.10:54321',
    'http://127.0.0.1:54322']) {
    const refused = loadConfig(MUTATING_CONFIG_PATH,
      { env: { PW_PORT: '3100', NEXT_PUBLIC_SUPABASE_URL: bad } })
    assert.equal(refused.ok, false, `${bad} must be refused before a server is started`)
  }
})

check('the default config stays read-only and argv-independent', () => {
  const readOnly = loadConfig(DEFAULT_CONFIG_PATH)
  assert.equal(readOnly.ok, true, `expected the default config to resolve: ${readOnly.message}`)
  assert.equal(readOnly.baseURL, 'http://localhost:3000', 'the shared default is preserved')
  assert.equal(readOnly.reuse, true, 'reuse still applies where nothing is mutated')
  assert.equal(readOnly.testIgnore, '**/phase45c-claim-sale-uat.spec.js',
    'the mutating suite is not part of this config universe')
  assert.equal(readOnly.testMatch, null, 'nothing else is narrowed')
  const ported = loadConfig(DEFAULT_CONFIG_PATH, { env: { PW_PORT: '3100' } })
  assert.equal(ported.ok, true)
  assert.equal(ported.baseURL, 'http://localhost:3100', 'PW_PORT still overrides for other suites')
  // Naming the mutating suite on the command line changes nothing about this
  // config: it neither raises the port nor disables reuse, because it cannot
  // run that suite in the first place.
  for (const argv of [[MUTATING], ['claim-sale'], ['--project=chromium', MUTATING]]) {
    const named = loadConfig(DEFAULT_CONFIG_PATH, { argv })
    assert.equal(named.ok, true)
    assert.equal(named.baseURL, 'http://localhost:3000')
    assert.equal(named.reuse, true)
  }
})

// Behavioural half, part two: ask Playwright itself which files each config
// would collect. `--list` runs Playwright's own selection — testDir, testIgnore,
// testMatch and positional filters, in the same order a real run uses — then
// prints and exits. It starts no web server, launches no browser and touches no
// database, so it is the strongest evidence available short of a run.
const PLAYWRIGHT_CLI =
  fileURLToPath(new URL('../node_modules/@playwright/test/cli.js', import.meta.url))
const NEXT_DIR = fileURLToPath(new URL('..', import.meta.url))
const MUTATING_FILE = 'phase45c-claim-sale-uat.spec.js'
const READ_ONLY_FILE = 'mobile-alignment-uat.spec.js'
const MUTATING_ABSOLUTE = fileURLToPath(new URL(`../tests/${MUTATING_FILE}`, import.meta.url))
const READ_ONLY_ABSOLUTE = fileURLToPath(new URL(`../tests/${READ_ONLY_FILE}`, import.meta.url))

function listTests(configPath, { args = [], env = {} } = {}) {
  const result = spawnSync(
    process.execPath, [PLAYWRIGHT_CLI, 'test', '--list', '--config', configPath, ...args],
    { cwd: NEXT_DIR, encoding: 'utf8', env: { ...process.env, PW_PORT: '', ...env } })
  return `${result.stdout}\n${result.stderr}`
}

// A listing line is `file.spec.js:<line>:<col> › title`; positional filters are
// not echoed back, so this only matches a file that was actually collected.
const collected = (output, file) => new RegExp(`${file.replace(/\./g, '\\.')}:\\d+`).test(output)

check('no selection form can run the mutating suite under the default config', () => {
  const baseline = listTests(DEFAULT_CONFIG_PATH)
  assert.match(baseline, /Total: \d+ tests in \d+ files/,
    'the read-only listing itself succeeds, so an absence below is meaningful')
  assert.ok(collected(baseline, READ_ONLY_FILE), 'read-only suites are still collected')
  assert.ok(!collected(baseline, MUTATING_FILE),
    'a bare default run does not collect the mutating suite')

  for (const args of [
    [MUTATING_FILE],                       // bare filename
    [`tests/${MUTATING_FILE}`],            // directory-prefixed
    [`./tests/${MUTATING_FILE}`],          // ./-prefixed
    [MUTATING_ABSOLUTE],                   // absolute path
    [`tests/${MUTATING_FILE}:177`],        // file:line form
    ['claim-sale'],                        // Playwright filters are regexes
    ['phase45c'],
    ['tests/'],                            // whole directory
    ['.*'],                                // match-everything regex
    ['--grep', 'unpaid order'],            // title filter
    ['--project=chromium', MUTATING_ABSOLUTE],
    [READ_ONLY_FILE, MUTATING_ABSOLUTE],   // mixed selection
  ]) {
    const listed = listTests(DEFAULT_CONFIG_PATH, { args })
    assert.ok(!collected(listed, MUTATING_FILE),
      `the default config collected the mutating suite for args ${JSON.stringify(args)}`)
  }
})

check('the dedicated config collects the mutating suite and refuses to host others', () => {
  const listed = listTests(MUTATING_CONFIG_PATH, { env: ISOLATED_ENV })
  assert.ok(collected(listed, MUTATING_FILE), `expected the mutating suite to be collected: ${listed}`)
  assert.match(listed, /Total: \d+ tests in 1 file/, 'and nothing else is collected with it')

  for (const args of [
    [READ_ONLY_FILE], [`tests/${READ_ONLY_FILE}`], [`./tests/${READ_ONLY_FILE}`],
    [READ_ONLY_ABSOLUTE], ['tests/'], ['.*'],
  ]) {
    const other = listTests(MUTATING_CONFIG_PATH, { args, env: ISOLATED_ENV })
    assert.ok(!collected(other, READ_ONLY_FILE),
      `the isolated server must not host other suites; args ${JSON.stringify(args)}`)
  }
})

check('the dedicated config collects nothing when PW_PORT is missing or shared', () => {
  for (const env of [{}, { PW_PORT: '3000' }, { PW_PORT: 'abc' }]) {
    const refused = listTests(MUTATING_CONFIG_PATH,
      { env: { NEXT_PUBLIC_SUPABASE_URL: LOOPBACK_SUPABASE, ...env } })
    assert.ok(!collected(refused, MUTATING_FILE),
      `PW_PORT=${JSON.stringify(env.PW_PORT)} must collect nothing`)
    assert.match(refused, /playwright\.claim-sale\.config\.js:/,
      'the refusal names the config that refused, at config load')
  }
})

check('the dedicated config collects nothing when the backend is not the approved loopback', () => {
  // Selection is downstream of config load, so a backend refusal has to stop
  // collection too — otherwise a run could reach a server start.
  for (const backend of [TAILSCALE_SUPABASE, 'https://abcdefg.supabase.co', '']) {
    const refused = listTests(MUTATING_CONFIG_PATH,
      { env: { PW_PORT: '3100', NEXT_PUBLIC_SUPABASE_URL: backend } })
    assert.ok(!collected(refused, MUTATING_FILE),
      `NEXT_PUBLIC_SUPABASE_URL=${JSON.stringify(backend)} must collect nothing`)
    assert.match(refused, /playwright\.claim-sale\.config\.js:/,
      'the refusal names the config that refused, at config load')
  }
})

function assertSpecServerAdmissionContract(spec) {
  const source = stripComments(spec)
  assert.match(source, /function assertIsolatedServer\(baseURL\)/,
    'the suite carries its own server-isolation admission')
  assert.match(source, /const SHARED_SERVER_PORT = '3000'/)
  assert.match(source, /Number\(port\) === Number\(SHARED_SERVER_PORT\)/,
    'the shared port is refused inside the suite too')
  // The invariant is that baseURL must describe a loopback origin on the isolated
  // port; it is not that the guard is spelled with any particular local variable.
  // The shipped guard compares the whole parsed origin against an approved set
  // built from PW_PORT, which is strictly stronger than the superseded
  // port-only `servedPort !== port` comparison this assertion used to require by
  // name — so requiring that removed string failed a compliant, stronger guard.
  assert.match(source,
    /const ISOLATED_APP_HOSTNAMES = \['localhost', '127\.0\.0\.1'\]/,
    'the owned hosts are exactly the aliases served by the IPv4-only child, never [::1]')
  assert.match(source, /new URL\(String\(baseURL\)\)\.origin/,
    'the origin is parsed out of baseURL rather than pattern-matched out of it')
  assert.match(source, /ISOLATED_APP_HOSTNAMES\.map\(host => `http:\/\/\$\{host\}:\$\{port\}`\)/,
    'the approved origins are built from the isolated port, pinning scheme, host and port together')
  assert.match(source, /!approvedOrigins\.includes\(servedOrigin\)/,
    'baseURL must actually serve the isolated port on loopback, not merely be a matching port')
  // Comments are stripped first, by the same scanner the rest of section 6 uses:
  // a call that has been commented out is not a call, and a line-comment-only
  // strip accepted `/* assertIsolatedServer(baseURL) */` as one.
  const body = beforeEachBody(spec)
  assert.match(body, /assertIsolatedServer\(baseURL\)/,
    'server admission runs before every test body')
  assert.ok(
    body.indexOf('assertIsolatedServer(baseURL)') < body.indexOf('assertHarnessBackendEnv()'),
    'which server is decided before which backend: an admitted backend on a foreign server '
    + 'proves nothing about where its mutations land')
  assert.ok(!/if \(!admittedBackend\)[\s\S]*?assertIsolatedServer/.test(body),
    'the server pin is re-run for every test rather than cached once per worker')
}

check('the spec refuses the shared server itself, independently of the config', () => {
  assertSpecServerAdmissionContract(uatSpec)
})

// The mutation targets for the guard's own source. The definition is lifted and
// driven below, so both the call site and the definition/constants it closes
// over have to read as absent when they are commented out.
const GUARD_CALL_LINE = '  assertIsolatedServer(baseURL)\n'
const GUARD_SHARED_PORT_LINE = "const SHARED_SERVER_PORT = '3000'\n"
const GUARD_HOSTS_LINE = "const ISOLATED_APP_HOSTNAMES = ['localhost', '127.0.0.1']\n"
const GUARD_DEFINITION = (() => {
  const block = uatSpec.match(/function assertIsolatedServer\(baseURL\) \{[\s\S]*?\n\}\n/)
  assert.ok(block, 'the guard definition must be locatable as a whole block to mutate')
  return block[0]
})()

check('a disabled server-admission call is rejected in either comment form', () => {
  expectContractRejects(assertSpecServerAdmissionContract, uatSpec, [
    ...commentedOutForms(uatSpec, GUARD_CALL_LINE),
    ...commentedOutBlockForms(uatSpec, GUARD_DEFINITION),
    ...commentedOutForms(uatSpec, GUARD_SHARED_PORT_LINE),
    ...commentedOutForms(uatSpec, GUARD_HOSTS_LINE),
    ['the server pin cached once per worker instead of re-run',
      uatSpec.replace('  assertIsolatedServer(baseURL)\n',
        '  if (!admittedBackend) assertIsolatedServer(baseURL)\n')],
  ])
})

// The suite's own guard runs inside Playwright, where exercising it would mean
// starting a server. Lift the function out of the spec source and drive it
// directly instead, so its behaviour — not just its presence — is gated.
function assertSuiteGuardBehaviourContract(spec) {
  // Lifted from comment-stripped source for the same reason the call contract
  // above reads it: a commented-out definition is not a definition, and lifting
  // it out of the raw text would drive a guard the suite no longer runs — every
  // behavioural case below would pass while the shipped spec had no admission
  // at all.
  const stripped = stripComments(spec)
  const source = stripped.match(/function assertIsolatedServer\(baseURL\) \{[\s\S]*?\n\}/)
  const shared = stripped.match(/const SHARED_SERVER_PORT = '3000'/)
  // Every constant the lifted function closes over has to come with it, or the
  // guard throws a ReferenceError and the cases below would "pass" for the wrong
  // reason while the admission case fails. Match the whole single-line
  // declaration so any extra alias is part of the value this probe drives.
  const hosts = stripped.match(/const ISOLATED_APP_HOSTNAMES = \[.*\]/)
  assert.ok(source, 'assertIsolatedServer source found')
  assert.ok(shared, 'the suite names 3000 as the shared port it refuses')
  assert.ok(hosts, 'the suite names the loopback hosts it approves')
  for (const host of ['localhost', '127.0.0.1']) {
    assert.ok(hosts[0].includes(`'${host}'`),
      `the lifted host list must be complete, missing ${host}: ${hosts[0]}`)
  }
  assert.ok(!hosts[0].includes("'[::1]'"),
    'the IPv4-only child does not own [::1], even though it is a loopback host')
  // Built with the spec's own constants so the behaviour under test is the
  // shipped one, not a re-implementation.
  const build = env => new Function(
    'process', `${shared[0]}\n${hosts[0]}\n${source[0]}\nreturn assertIsolatedServer`)({ env })
  const assertIsolatedServer = build({})
  const withPort = port => build({ PW_PORT: port })

  assert.throws(() => assertIsolatedServer('http://localhost:3100'), /PW_PORT is unset/,
    'no PW_PORT is a refusal even if the baseURL looks isolated')
  assert.throws(() => withPort('3000')('http://localhost:3000'), /shared 3000 server/)
  assert.throws(() => withPort('abc')('http://localhost:3100'), /server admission/)
  assert.throws(() => withPort('3100')('http://localhost:3000'),
    /not one of the approved isolated origins/,
    'a config that resolved 3000 while PW_PORT says 3100 is caught in the suite too')
  // The port alone is not an identity, which is what the origin comparison buys.
  assert.throws(() => withPort('3100')('http://100.94.130.7:3100'),
    /not one of the approved isolated origins/,
    'a phone-facing host carrying the isolated port is still a server this run did not start')
  assert.throws(() => withPort('3100')('https://localhost:3100'),
    /not one of the approved isolated origins/, 'and the scheme is pinned with the host')
  assert.throws(() => withPort('3100')('http://[::1]:3100'),
    /not one of the approved isolated origins/,
    'IPv6 loopback is refused because the server command binds only 127.0.0.1')
  assert.throws(() => withPort('3100')(undefined), /server admission/)
  for (const admitted of ['http://localhost:3100', 'http://127.0.0.1:3100']) {
    assert.equal(withPort('3100')(admitted), '3100',
      `the documented isolated run is admitted: ${admitted}`)
  }
}

check('the suite guard admits only a baseURL that serves the isolated port', () => {
  assertSuiteGuardBehaviourContract(uatSpec)
})

check('a commented-out guard definition or constant cannot be lifted and driven', () => {
  // Without this the behavioural half was the weaker half: it read the raw
  // source, so a spec whose guard had been commented out still yielded a
  // function to drive, and every case above passed against code the suite would
  // never execute.
  expectContractRejects(assertSuiteGuardBehaviourContract, uatSpec, [
    ...commentedOutBlockForms(uatSpec, GUARD_DEFINITION),
    ...commentedOutForms(uatSpec, GUARD_SHARED_PORT_LINE),
    ...commentedOutForms(uatSpec, GUARD_HOSTS_LINE),
    ['the approved host list widened to the unbound IPv6 loopback literal',
      uatSpec.replace(GUARD_HOSTS_LINE,
        "const ISOLATED_APP_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]']\n")],
  ])
  // Proof that this is a real distinction rather than a restatement: the raw
  // source the superseded form read still hands back a drivable guard for both
  // commented forms, so nothing downstream of that lift could have caught it.
  for (const [label, mutated] of commentedOutBlockForms(uatSpec, GUARD_DEFINITION)) {
    assert.ok(/function assertIsolatedServer\(baseURL\) \{[\s\S]*?\n\}/.test(mutated),
      `the raw source still yields a definition for ${label} — comment stripping is what rejects it`)
    assert.ok(!/function assertIsolatedServer\(baseURL\) \{[\s\S]*?\n\}/
      .test(stripComments(mutated)), `and comment-stripped source does not: ${label}`)
  }
  // The same for the call site under a line-comment-only strip, which is what
  // this section used to apply: it removes the line-commented form but admits
  // the block-commented one, and that gap is the defect being closed.
  const rawBeforeEach = spec => spec.match(/test\.beforeEach\(async \(\{[\s\S]*?\n\}\)/)[0]
  const lineCommentsOnly = text => text.replace(/^[ \t]*\/\/.*$/gm, '')
  const [[lineLabel, lineForm], [blockLabel, blockForm]] =
    commentedOutForms(uatSpec, GUARD_CALL_LINE)
  assert.ok(!/assertIsolatedServer\(baseURL\)/.test(lineCommentsOnly(rawBeforeEach(lineForm))),
    `${lineLabel} was already caught by the superseded strip`)
  assert.ok(/assertIsolatedServer\(baseURL\)/.test(lineCommentsOnly(rawBeforeEach(blockForm))),
    `the superseded strip admits ${blockLabel}, which is the defect`)
  assert.ok(!/assertIsolatedServer\(baseURL\)/.test(beforeEachBody(blockForm)),
    'and stripComments rejects it')
})

check('the documented run command supplies the isolated port and the only config that can run it', () => {
  // The documented invocation changed with the dedicated-config repair: a bare
  // `npx playwright test tests/phase45c-claim-sale-uat.spec.js` now collects
  // nothing at all, because the default config ignores this suite and no
  // positional filter can re-admit it. Requiring that superseded form by name
  // pinned the documentation to a command that cannot work.
  assert.match(uatSpec,
    /PW_PORT=3100 \\\n\/\/\s+PHASE45C_ISOLATED_BUILD_RECEIPT=.*\\\n\/\/\s+npx playwright test --config playwright\.claim-sale\.config\.js/,
    'the header run instructions pass an explicit non-3000 port plus the required build receipt to the dedicated config')
  assert.ok(!/npx playwright test tests\/phase45c-claim-sale-uat\.spec\.js/.test(uatSpec),
    'and never document the bare-path form, which the default config cannot select')
})

check('the documented build supplies both NEXT_PUBLIC_ values, because the build inlines them', () => {
  // The config can hand the server process a site origin, but src/middleware.js
  // reads NEXT_PUBLIC_SITE_URL from a value Next.js inlined at build time. A
  // build made without it redirects to whatever .env.local said — the
  // phone-facing shared server — however the run is invoked. So the build
  // command is part of the contract, not a convenience, and it must name the
  // same port the run uses.
  for (const [label, doc] of [['the spec header', uatSpec], ['the dedicated config', claimSaleConfig]]) {
    assert.match(doc,
      /NEXT_PUBLIC_SUPABASE_URL=http:\/\/127\.0\.0\.1:54321 \\\n\/\/\s+NEXT_PUBLIC_SITE_URL=http:\/\/localhost:3100 \\\n\/\/\s+node scripts\/phase45c-build-isolated-candidate\.mjs/,
      `${label} documents the guarded build that pins both the backend and the isolated site origin`)
    // The phrase may wrap across comment lines, so the separator is allowed to
    // be whitespace and comment markers rather than a single space.
    assert.match(doc, /inlines?(?:\s|\/\/)+NEXT_PUBLIC_\* at build time/,
      `${label} says why the build command carries them, not just that it does`)
    assert.match(doc, /PW_PORT=3100/, `${label} runs on the port its documented build was made for`)
  }
  assert.ok(!/NEXT_PUBLIC_SITE_URL=http:\/\/100\./.test(uatSpec + claimSaleConfig),
    'and neither documents the phone-facing origin as a value to build with')
})

check('the executable candidate-build guard rejects a wrong CWD before any build', () => {
  assert.match(isolatedBuildGuard, /current directory .* is not the declared candidate/,
    'the guard names the exact CWD/candidate mismatch rather than relying on a prose instruction')
  assert.match(isolatedBuildGuard, /sourceHashAfter !== sourceHashBefore/,
    'the guard checks the protected source build identity after candidate build completion')
  assert.match(isolatedBuildGuard, /spawnSync\('npm', \['run', 'build'\]/,
    'the guard, not a caller, owns the build subprocess and pins its cwd')
  const guardTest = fileURLToPath(new URL('./phase45c-test-isolated-build-guard.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [guardTest], { cwd: NEXT_DIR, encoding: 'utf8' })
  assert.equal(result.status, 0, `build-guard regression probe failed: ${result.stderr}`)
  assert.match(result.stdout, /4 isolated candidate build-guard checks passed/,
    'the executable probe proves wrong-CWD rejection, normal preflight, app-port matching, and port-3000 rejection')
})

console.log(`\n${results.length} checks passed`)
