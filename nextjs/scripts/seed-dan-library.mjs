/**
 * Seed dan@dbb.test with a realistic Phase 44 UAT library fixture.
 *
 * Safe default: dry-run.  Mutations require --apply and are hard-scoped to
 * dan@dbb.test exactly. Creates ONE binder with 6-8 real cards in a
 * deliberate mix of states (varied conditions, some listed, some unlisted)
 * so Dan can exercise the Library/Binders redesign C1+C2 test cases manually.
 *
 * Usage:
 *   node scripts/seed-dan-library.mjs                 # inspect only
 *   node scripts/seed-dan-library.mjs --apply         # wipe + seed + manifest
 *   node scripts/seed-dan-library.mjs --wipe --apply  # remove the fixture
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const TARGET_EMAIL = 'dan@dbb.test'
const TARGET_EMAIL_NORMALIZED = TARGET_EMAIL.toLowerCase()
const WORKTREE_ROOT = path.resolve(new URL('..', import.meta.url).pathname, '..')
const APP_ROOT = WORKTREE_ROOT
const DROPS_DIR = path.join(path.dirname(WORKTREE_ROOT), 'Drops')
const MANIFEST_PATH = path.join(DROPS_DIR, 'dan-library-uat-seed-20260722.md')
const PAGE_SIZE = 1000
const FIXED_CREATED_AT = '2026-07-22T00:00:00.000Z'
const UAT_PROFILE_MARKER = 'DBB Phase 44 UAT dan@dbb.test synthetic profile'

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
  const digest = crypto.createHash('sha256').update(`dan-library-uat:${label}`).digest('hex')
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
      .select('scryfall_id, name, set_code, set_name, collector_number, rarity, colors, type_line, cmc')
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

async function buildFixture(db, userId) {
  // Fetch 8 diverse cards from real catalog
  const candidates = await fetchCatalog(db, { limit: 100 })
  if (candidates.length < 8) {
    throw new Error(`Catalog has only ${candidates.length} cards; need at least 8`)
  }

  const selected = candidates.slice(0, 8)

  const binder = {
    id: deterministicUuid(`${userId}:binder:uat-test`),
    name: 'UAT Test Binder',
    description: 'Phase 44 UAT fixture for Library/Binders redesign',
  }

  // Build library cards with deliberate variation in condition, foil, quantity, starred
  const libraryCards = selected.map((card, index) => {
    const conditions = ['NM', 'LP', 'MP', 'HP']
    const foils = ['normal', 'foil']
    const condition = conditions[index % conditions.length]
    const foil = foils[index % foils.length]
    const quantity = 1 + (index % 3) // quantity 1-3 for variation
    const starred = index % 3 === 0 // some cards starred, some not

    return {
      id: deterministicUuid(`${userId}:card:${card.scryfall_id}`),
      user_id: userId,
      binder_id: binder.id,
      scryfall_id: card.scryfall_id,
      quantity,
      foil,
      condition,
      language: 'en',
      starred,
      date_added: FIXED_CREATED_AT,
      purchase_price: 5 + (index * 2),
      purchase_currency: 'USD',
    }
  })

  // Create listings for cards at indices 0, 1 (2 listed) and leave others unlisted
  // This ensures at least 2 unlisted and at least 1 listed
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  const listings = [
    {
      id: deterministicUuid(`${userId}:listing:${libraryCards[0].id}`),
      user_id: userId,
      library_card_id: libraryCards[0].id,
      multiplier: 2.5,
      quantity: libraryCards[0].quantity,
      status: 'active',
      created_at: FIXED_CREATED_AT,
      expires_at: expiresAt,
    },
    {
      id: deterministicUuid(`${userId}:listing:${libraryCards[1].id}`),
      user_id: userId,
      library_card_id: libraryCards[1].id,
      multiplier: 2.8,
      quantity: libraryCards[1].quantity,
      status: 'active',
      created_at: FIXED_CREATED_AT,
      expires_at: expiresAt,
    },
  ]

  return {
    binder,
    selected,
    libraryCards,
    listings,
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
    merchant_account_name: 'Dan UAT',
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

async function insertBatches(db, table, rows) {
  const batchSize = 500
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize)
    const { error } = await db.from(table).insert(batch)
    if (error) throw new Error(`${table} insert failed at ${offset}: ${error.message}`)
  }
}

async function writeManifest(fixture) {
  const lines = [
    '# Dan Library UAT Seed Manifest',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Target account: ${TARGET_EMAIL}`,
    `Binder: ${fixture.binder.name} (${fixture.binder.id})`,
    '',
    '## Fixture Overview',
    '',
    `- Library cards: ${fixture.libraryCards.length}`,
    `- Active listings: ${fixture.listings.length}`,
    `- Unlisted cards: ${fixture.libraryCards.length - fixture.listings.length}`,
    '',
    '## Cards Seeded',
    '',
    ...fixture.libraryCards.map((card, index) => {
      const listing = fixture.listings.find(l => l.library_card_id === card.id)
      const status = listing ? '✓ Listed' : '○ Unlisted'
      const cardName = fixture.selected[index]?.name || 'Unknown'
      return `${index + 1}. **${cardName}** — condition: ${card.condition}, foil: ${card.foil}, qty: ${card.quantity}, starred: ${card.starred} [${status}]`
    }),
    '',
    '## Merchant Profile',
    '',
    `Status: Completed (synthetic fixture)`,
    `Profile marker: ${UAT_PROFILE_MARKER}`,
    '',
    '## Test Case Coverage',
    '',
    '- **C1 Quantity/Condition/Foil/Starred Edit**: Cards 1–8 have varied condition, foil, quantity, and starred values for edit+Save testing',
    '- **C2 List for Sale**: Cards 3–8 are unlisted; Dan can exercise "List for sale" flow',
    '- **C2 Unlist**: Cards 1–2 are actively listed; Dan can exercise "Unlist" flow',
    '',
    '## Rollback',
    '',
    'To remove this fixture:',
    '```bash',
    'node scripts/seed-dan-library.mjs --wipe --apply',
    '```',
    '',
    '## Commands Used',
    '',
    '```bash',
    '# Dry-run inspect',
    'node scripts/seed-dan-library.mjs',
    '',
    '# Apply fixture',
    'node scripts/seed-dan-library.mjs --apply',
    '```',
    '',
  ]

  await fs.mkdir(DROPS_DIR, { recursive: true })
  await fs.writeFile(MANIFEST_PATH, lines.join('\n'))
  return MANIFEST_PATH
}

async function main() {
  if (args.has('--help')) {
    console.log('Use --apply to mutate only dan@dbb.test; --wipe --apply removes its fixture; default is dry-run.')
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
  console.log(`Prepared: 1 binder, ${fixture.libraryCards.length} library cards, ${fixture.listings.length} active listings.`)
  if (dryRun) {
    console.log('No rows written. Re-run with --apply to wipe and seed this exact test account.')
    return
  }

  let syntheticProfile = false
  try {
    syntheticProfile = await ensureUatMerchantProfile(db, user.id)
    if (syntheticProfile) console.log('  → Merchant profile completed.')
    await wipeTarget(db, user.id)
    console.log('  → Wiped existing fixture.')
    await insertBatches(db, 'binders', [{
      id: fixture.binder.id,
      user_id: user.id,
      name: fixture.binder.name,
      description: fixture.binder.description,
      is_default: false,
      created_at: FIXED_CREATED_AT,
    }])
    console.log('  → Binder created.')
    await insertBatches(db, 'library_cards', fixture.libraryCards)
    console.log('  → Library cards inserted.')
    await insertBatches(db, 'listings', fixture.listings)
    console.log('  → Listings created.')
    const manifestPath = await writeManifest(fixture)
    console.log(`Seed complete. Manifest: ${manifestPath}`)
  } catch (error) {
    try { await wipeTarget(db, user.id) } catch (cleanupError) { console.error(`fixture cleanup failed: ${cleanupError.message}`) }
    if (syntheticProfile) {
      try { await removeSyntheticMerchantProfile(db, user.id) } catch (cleanupError) { console.error(`profile cleanup failed: ${cleanupError.message}`) }
    }
    throw error
  }
}

main().catch(error => {
  console.error(`seed-dan-library failed: ${error.message}`)
  process.exitCode = 1
})
