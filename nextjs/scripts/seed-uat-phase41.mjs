/**
 * Build the purpose-made Phase 41 UAT instance.
 *
 * Safe default: dry-run.  Mutations require --apply and are hard-scoped to
 * the exact test account below.  This script intentionally uses the service
 * role because it must create >1,000 library rows and Bazaar listings. The
 * database still enforces the merchant-profile trigger, so this harness uses
 * a clearly synthetic payment profile for the dedicated test account.
 *
 * Usage:
 *   node scripts/seed-uat-phase41.mjs                 # inspect only
 *   node scripts/seed-uat-phase41.mjs --apply         # wipe + seed + manifest
 *   node scripts/seed-uat-phase41.mjs --wipe --apply # remove the fixture
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { ensurePriceCache, lookupPrice, sellPrice } from '../src/lib/pricingCache.js'

const TARGET_EMAIL = 'test@dbb.local'
const TARGET_EMAIL_NORMALIZED = TARGET_EMAIL.toLowerCase()
const WORKTREE_ROOT = path.resolve(new URL('..', import.meta.url).pathname, '..')
const MANIFEST_PATH = path.join(WORKTREE_ROOT, 'uat-fixture-manifest.md')
const PAGE_SIZE = 1000
const INSERT_BATCH_SIZE = 500
const BULK_LIBRARY_COUNT = 1200
const BAZAAR_BULK_COUNT = 1042
const FIXED_CREATED_AT = '2026-07-18T00:00:00.000Z'
const RARITY_RANK = { common: 1, uncommon: 2, rare: 3, mythic: 4 }
const UAT_PROFILE_MARKER = 'DBB Phase 41 UAT synthetic profile'

const args = new Set(process.argv.slice(2))
const apply = args.has('--apply')
const wipeOnly = args.has('--wipe') && !args.has('--seed')
const dryRun = !apply

function env(name) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name}; load nextjs/.env.local before running this script`)
  return value
}

function makeClient() {
  return createClient(env('NEXT_PUBLIC_SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

function deterministicUuid(label) {
  const digest = crypto.createHash('sha256').update(`phase41-uat:${label}`).digest('hex')
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`
}

function assertExactTarget(user) {
  if (!user || user.email?.toLowerCase() !== TARGET_EMAIL_NORMALIZED) {
    throw new Error(`Refusing to continue: resolved user is not exactly ${TARGET_EMAIL}`)
  }
}

async function resolveTargetUser(db) {
  const matches = []
  for (let page = 1; ; page += 1) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 })
    if (error) throw error
    for (const user of data.users || []) {
      if (user.email?.toLowerCase() === TARGET_EMAIL_NORMALIZED) matches.push(user)
    }
    if (!data.users || data.users.length < 1000) break
  }
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${TARGET_EMAIL} auth user; found ${matches.length}`)
  }
  assertExactTarget(matches[0])
  return matches[0]
}

async function fetchCatalog(db, { rarity, colors, nameLike, limit = PAGE_SIZE, exclude = new Set() } = {}) {
  const rows = []
  for (let offset = 0; rows.length < limit; offset += PAGE_SIZE) {
    let query = db
      .from('card_index')
      .select('scryfall_id, name, set_code, set_name, collector_number, rarity, colors, type_line, cmc, mana_cost')
      .order('name', { ascending: true })
      .order('set_code', { ascending: true })
      .order('collector_number', { ascending: true })
      .order('scryfall_id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1)
    if (rarity) query = query.eq('rarity', rarity)
    if (colors) query = query.contains('colors', [colors])
    if (nameLike) query = query.ilike('name', `%${nameLike}%`)
    const { data, error } = await query
    if (error) throw error
    const page = (data || []).filter(row => !exclude.has(row.scryfall_id))
    rows.push(...page)
    if (!data || data.length < PAGE_SIZE) break
  }
  return rows.slice(0, limit)
}

function chooseMixedCards(candidates, dragon) {
  const desired = { mythic: 1, rare: 2, uncommon: 2, common: 3 }
  const chosen = []
  const used = new Set()
  const add = card => {
    if (!card || used.has(card.scryfall_id)) return false
    used.add(card.scryfall_id)
    chosen.push(card)
    return true
  }

  add(dragon)
  const counts = chosen.reduce((map, card) => {
    map[card.rarity] = (map[card.rarity] || 0) + 1
    return map
  }, {})
  for (const rarity of Object.keys(desired)) {
    for (const card of candidates.filter(item => item.rarity === rarity)) {
      if ((counts[rarity] || 0) >= desired[rarity]) break
      if (add(card)) counts[rarity] = (counts[rarity] || 0) + 1
    }
  }
  if (chosen.length !== 8 || Object.entries(desired).some(([rarity, count]) => (counts[rarity] || 0) !== count)) {
    throw new Error(`Could not construct the 8-card mixed fixture; got ${JSON.stringify(counts)}`)
  }

  // Prefer a deterministic same-CMC pair so the UAT exercises tie-breakers.
  const byCmc = new Map()
  for (const card of chosen) {
    if (card.cmc == null) continue
    const key = String(card.cmc)
    if (!byCmc.has(key)) byCmc.set(key, [])
    byCmc.get(key).push(card)
  }
  if (![...byCmc.values()].some(group => group.length >= 2)) {
    throw new Error('Could not construct UAT-A with a deliberate mana-value tie')
  }
  return chosen
}

async function buildFixture(db, userId) {
  await ensurePriceCache()
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  const dragonCandidates = await fetchCatalog(db, { nameLike: 'Dragon', limit: 20 })
  const broadCandidates = []
  for (const rarity of ['mythic', 'rare', 'uncommon', 'common']) {
    broadCandidates.push(...await fetchCatalog(db, { rarity, limit: 40 }))
  }
  const dragon = dragonCandidates[0]
  if (!dragon) throw new Error('Catalog has no card matching Dragon; cannot build the defined select-all test')
  const mixed = chooseMixedCards(broadCandidates, dragon)
  const used = new Set(mixed.map(card => card.scryfall_id))

  const bulkCandidates = await fetchCatalog(db, { colors: 'R', limit: BULK_LIBRARY_COUNT + 1400, exclude: used })
  const pricedBulk = bulkCandidates.filter(card => lookupPrice(card.scryfall_id, 'normal') != null)
  let bulk = pricedBulk
  if (bulk.length < BULK_LIBRARY_COUNT) {
    // Keep the fixture useful on a reduced catalog: fill the remainder from
    // any non-overlapping, priced printings while retaining the explicit R sample.
    const usedBulk = new Set([...used, ...bulkCandidates.map(card => card.scryfall_id)])
    const fallbackCandidates = await fetchCatalog(db, { limit: BULK_LIBRARY_COUNT + 1400, exclude: usedBulk })
    bulk = [...bulk, ...fallbackCandidates.filter(card => lookupPrice(card.scryfall_id, 'normal') != null)]
  }
  if (bulk.length < BULK_LIBRARY_COUNT) {
    throw new Error(`Catalog has only ${bulk.length} priced bulk printings; need ${BULK_LIBRARY_COUNT} for the >1,000 listing UAT`)
  }
  bulk = bulk.slice(0, BULK_LIBRARY_COUNT)

  const binders = {
    mixed: deterministicUuid(`${userId}:binder:uat-a-mixed`),
    bulk: deterministicUuid(`${userId}:binder:uat-b-bulk`),
    pairs: deterministicUuid(`${userId}:binder:uat-c-price-pairs`),
  }
  const mixedRows = mixed.map((card, index) => ({
    id: deterministicUuid(`${userId}:mixed:${card.scryfall_id}`),
    user_id: userId,
    binder_id: binders.mixed,
    scryfall_id: card.scryfall_id,
    quantity: 1,
    foil: 'normal',
    condition: 'NM',
    language: 'en',
    starred: false,
    date_added: FIXED_CREATED_AT,
    purchase_price: index + 1,
    purchase_currency: 'MYR',
  }))
  const bulkRows = bulk.map((card, index) => ({
    id: deterministicUuid(`${userId}:bulk:${card.scryfall_id}`),
    user_id: userId,
    binder_id: binders.bulk,
    scryfall_id: card.scryfall_id,
    quantity: 1,
    foil: 'normal',
    condition: 'NM',
    language: 'en',
    starred: false,
    date_added: FIXED_CREATED_AT,
    purchase_price: 1 + (index % 25),
    purchase_currency: 'MYR',
  }))
  const pairCards = mixed.slice(0, 4)
  const pairRows = pairCards.flatMap(card => ['NM', 'LP'].map(condition => ({
    id: deterministicUuid(`${userId}:pair:${card.scryfall_id}:${condition}`),
    user_id: userId,
    binder_id: binders.pairs,
    scryfall_id: card.scryfall_id,
    quantity: 1,
    foil: 'normal',
    condition,
    language: 'en',
    starred: false,
    date_added: FIXED_CREATED_AT,
    purchase_price: 10,
    purchase_currency: 'MYR',
  })))

  const markerRows = mixedRows.map(row => ({
    id: deterministicUuid(`${userId}:listing:marker:${row.id}`),
    user_id: userId,
    library_card_id: row.id,
    multiplier: 2.8,
    quantity: 1,
    status: 'active',
    created_at: FIXED_CREATED_AT,
    expires_at: expiresAt,
  }))
  const bulkListingRows = bulkRows.slice(0, BAZAAR_BULK_COUNT).map((row, index) => ({
    id: deterministicUuid(`${userId}:listing:bulk:${row.id}`),
    user_id: userId,
    library_card_id: row.id,
    multiplier: [2.5, 2.8, 3.0][index % 3],
    quantity: 1,
    status: 'active',
    created_at: FIXED_CREATED_AT,
    expires_at: expiresAt,
  }))
  const pairListingRows = pairRows.map((row, index) => ({
    id: deterministicUuid(`${userId}:listing:pair:${row.id}`),
    user_id: userId,
    library_card_id: row.id,
    multiplier: index % 2 === 0 ? 2.5 : 3.0,
    quantity: 1,
    status: 'active',
    created_at: FIXED_CREATED_AT,
    expires_at: expiresAt,
  }))

  return {
    binders,
    mixed,
    bulk,
    mixedRows,
    bulkRows,
    pairRows,
    listings: [...markerRows, ...bulkListingRows, ...pairListingRows],
  }
}

async function insertBatches(db, table, rows) {
  for (let offset = 0; offset < rows.length; offset += INSERT_BATCH_SIZE) {
    const batch = rows.slice(offset, offset + INSERT_BATCH_SIZE)
    const { error } = await db.from(table).insert(batch)
    if (error) throw new Error(`${table} insert failed at ${offset}: ${error.message}`)
  }
}

async function wipeTarget(db, userId) {
  // Explicit order makes the scope obvious even though library-card FKs
  // cascade listings and binder FKs cascade library cards.
  for (const [table, column] of [
    ['listings', 'user_id'],
    ['library_cards', 'user_id'],
    ['binders', 'user_id'],
  ]) {
    const { error } = await db.from(table).delete().eq(column, userId)
    if (error) throw new Error(`${table} wipe failed: ${error.message}`)
  }
}

async function ensureUatMerchantProfile(db, userId) {
  const { data: profile, error: readError } = await db
    .from('profiles')
    .select('merchant_bank_name, merchant_account_name, merchant_account_number, merchant_duitnow_id, merchant_payment_instructions, merchant_profile_completed_at')
    .eq('id', userId)
    .single()
  if (readError) throw readError

  const complete = profile.merchant_profile_completed_at &&
    profile.merchant_bank_name?.trim() &&
    profile.merchant_account_name?.trim() &&
    (profile.merchant_account_number?.trim() || profile.merchant_duitnow_id?.trim())
  if (complete) return false

  const { error } = await db.from('profiles').update({
    merchant_bank_name: UAT_PROFILE_MARKER,
    merchant_account_name: 'UAT Seller',
    merchant_account_number: '0000000000',
    merchant_duitnow_id: null,
    merchant_payment_instructions: 'Disposable UAT fixture; not real payment details.',
    merchant_profile_completed_at: new Date().toISOString(),
  }).eq('id', userId)
  if (error) throw error
  return true
}

async function removeSyntheticMerchantProfile(db, userId) {
  const { data: profile, error: readError } = await db
    .from('profiles')
    .select('merchant_bank_name')
    .eq('id', userId)
    .single()
  if (readError) throw readError
  if (profile.merchant_bank_name !== UAT_PROFILE_MARKER) return

  const { error } = await db.from('profiles').update({
    merchant_bank_name: null,
    merchant_account_name: null,
    merchant_account_number: null,
    merchant_duitnow_id: null,
    merchant_payment_instructions: null,
    merchant_profile_completed_at: null,
  }).eq('id', userId)
  if (error) throw error
}

function compareForCmc(a, b, direction = 1) {
  const av = a.cmc == null ? Number.POSITIVE_INFINITY : Number(a.cmc)
  const bv = b.cmc == null ? Number.POSITIVE_INFINITY : Number(b.cmc)
  return (av - bv) * direction || a.name.localeCompare(b.name) || a.set_code.localeCompare(b.set_code) || a.collector_number.localeCompare(b.collector_number) || a.scryfall_id.localeCompare(b.scryfall_id)
}

function compareForRarity(a, b, direction = 1) {
  const av = RARITY_RANK[a.rarity] || Number.POSITIVE_INFINITY
  const bv = RARITY_RANK[b.rarity] || Number.POSITIVE_INFINITY
  return (av - bv) * direction || a.name.localeCompare(b.name) || a.set_code.localeCompare(b.set_code) || a.collector_number.localeCompare(b.collector_number) || a.scryfall_id.localeCompare(b.scryfall_id)
}

async function writeManifest(db, fixture) {
  let priceReady = false
  try {
    await ensurePriceCache()
    priceReady = true
  } catch (error) {
    console.warn(`Price cache unavailable while writing manifest: ${error.message}`)
  }
  const cardByLibraryId = new Map([
    ...fixture.mixedRows.map(row => [row.id, fixture.mixed.find(card => card.scryfall_id === row.scryfall_id)]),
    ...fixture.bulkRows.map(row => [row.id, fixture.bulk.find(card => card.scryfall_id === row.scryfall_id)]),
    ...fixture.pairRows.map(row => [row.id, fixture.mixed.find(card => card.scryfall_id === row.scryfall_id)]),
  ])
  const pricedListings = fixture.listings.map(listing => {
    const card = cardByLibraryId.get(listing.library_card_id)
    const ckd = priceReady && card ? lookupPrice(card.scryfall_id, 'normal') : null
    return { listing, card, myr: ckd == null ? null : sellPrice(ckd, Number(listing.multiplier)) }
  })
  const known = pricedListings.map(item => item.myr).filter(value => value != null)
  const bandMax = known.length ? Math.max(...known) : null
  const bandCount = bandMax == null ? 0 : pricedListings.filter(item => item.myr != null && item.myr <= bandMax).length
  const { count: liveActiveCount, error: liveCountError } = await db
    .from('listings')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'active')
    .gt('expires_at', new Date().toISOString())
  if (liveCountError) throw liveCountError
  const mixedCmcLow = [...fixture.mixed].sort((a, b) => compareForCmc(a, b, 1))
  const mixedRarityHigh = [...fixture.mixed].sort((a, b) => compareForRarity(a, b, -1))
  const pairIds = new Set(fixture.pairRows.map(row => row.id))
  const lines = [
    '# DBB Phase 41 UAT fixture manifest',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Target account: ${TARGET_EMAIL}`,
    '',
    '## Fixture sizes',
    '',
    `- UAT-A Mixed: ${fixture.mixedRows.length} cards`,
    `- UAT-B Bulk: ${fixture.bulkRows.length} cards`,
    `- UAT-C active Bazaar listings: ${fixture.listings.length}`,
    `- Expected live active Bazaar listings at generation: ${liveActiveCount}`,
    `- Pre-existing active listings outside this fixture: ${Math.max(0, (liveActiveCount || 0) - fixture.listings.length)}`,
    `- UAT-B cards matching **Dragon**: ${fixture.bulk.filter(card => card.name.toLowerCase().includes('dragon')).length}`,
    '',
    '## UAT-A expected orders',
    '',
    '### Mana value: Low → High',
    '',
    ...mixedCmcLow.map((card, index) => `${index + 1}. ${card.name} — MV ${card.cmc ?? '—'} (${card.set_code} ${card.collector_number})`),
    '',
    '### Rarity: Mythic → Common',
    '',
    ...mixedRarityHigh.map((card, index) => `${index + 1}. ${card.name} — ${card.rarity} (${card.set_code} ${card.collector_number})`),
    '',
    '## UAT-C price band',
    '',
    `- Computed from the app price cache: ${priceReady ? 'yes' : 'no'}`,
    `- Broad band: RM 0 → RM ${bandMax ?? 'unavailable'}`,
    `- Listings in band: ${bandCount}`,
    `- Price test is valid only when this count is >1,000.`,
    '',
    '## UAT-C multiplier-pair anchors',
    '',
    ...pricedListings
      .filter(item => pairIds.has(item.listing.library_card_id) && item.card)
      .map(item => `- ${item.card.name} (${item.card.set_code} ${item.card.collector_number}), ${item.listing.multiplier}× → RM ${item.myr ?? 'unavailable'}`),
    '',
    '## Safety',
    '',
    'This fixture is disposable. Run `node scripts/seed-uat-phase41.mjs --wipe --apply` immediately after UAT to remove the test account rows.',
    '',
  ]
  await fs.writeFile(MANIFEST_PATH, lines.join('\n'))
  return { bandMax, bandCount }
}

async function main() {
  if (args.has('--help')) {
    console.log('Use --apply to mutate only test@dbb.local; --wipe --apply removes its fixture; default is dry-run.')
    return
  }
  const db = makeClient()
  const user = await resolveTargetUser(db)
  assertExactTarget(user)
  console.log(`${dryRun ? 'DRY-RUN' : 'APPLY'} target: ${user.email} (${user.id})`)

  if (wipeOnly) {
    if (dryRun) {
      console.log('Would delete listings, library_cards, and binders scoped to this exact user id.')
      return
    }
    await wipeTarget(db, user.id)
    await removeSyntheticMerchantProfile(db, user.id)
    console.log('Fixture wiped.')
    return
  }

  const fixture = await buildFixture(db, user.id)
  console.log(`Prepared UAT-A=${fixture.mixed.length}, UAT-B=${fixture.bulk.length}, UAT-C=${fixture.listings.length} listings.`)
  if (dryRun) {
    console.log('No rows written. Re-run with --apply to wipe and seed this exact test account.')
    return
  }

  let syntheticProfile = false
  try {
    syntheticProfile = await ensureUatMerchantProfile(db, user.id)
    await wipeTarget(db, user.id)
    await insertBatches(db, 'binders', Object.entries(fixture.binders).map(([key, id]) => ({
      id,
      user_id: user.id,
      name: key === 'mixed' ? 'UAT-A Mixed' : key === 'bulk' ? 'UAT-B Bulk' : 'UAT-C Price Pairs',
      description: 'Disposable DBB Phase 41 UAT fixture',
      is_default: false,
      created_at: FIXED_CREATED_AT,
    })))
    await insertBatches(db, 'library_cards', [...fixture.mixedRows, ...fixture.bulkRows, ...fixture.pairRows])
    await insertBatches(db, 'listings', fixture.listings)
    const priceInfo = await writeManifest(db, fixture)
    console.log(`Seed complete. Manifest: ${MANIFEST_PATH}`)
    if (priceInfo.bandCount <= 1000) throw new Error(`Computed price-band count is ${priceInfo.bandCount}; Test 5 needs >1,000 priced rows.`)
  } catch (error) {
    try { await wipeTarget(db, user.id) } catch (cleanupError) { console.error(`fixture cleanup failed: ${cleanupError.message}`) }
    if (syntheticProfile) {
      try { await removeSyntheticMerchantProfile(db, user.id) } catch (cleanupError) { console.error(`profile cleanup failed: ${cleanupError.message}`) }
    }
    throw error
  }
}

main().catch(error => {
  console.error(`seed-uat-phase41 failed: ${error.message}`)
  process.exitCode = 1
})
