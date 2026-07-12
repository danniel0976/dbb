#!/usr/bin/env node
/**
 * DBB performance baseline — calls Supabase directly (no Next.js server needed).
 *
 * ISOLATION GUARANTEE (Phase 17):
 *   Mutating benchmarks (import RPC) run ONLY against the dedicated perf-test account
 *   (perf-test@dbb-internal.test). The script creates a temporary binder for each run,
 *   tears it down after, and asserts zero net rows remain. It HARD-REFUSES to mutate
 *   any other account.
 *
 * Usage:
 *   node scripts/perf-baseline.mjs [--email read@example.com] [--n 10]
 *
 *   --email   Optional: use this user's data for READ-ONLY benchmarks (bigger datasets =
 *             more realistic latencies). Mutating benchmarks still use perf-test.
 *   --n       Iterations per query (default 10).
 *
 * Reports p50 and p95 latency.
 * Budget: p95 < 500ms for list endpoints; < 300ms for catalog search.
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

// ── Constants ─────────────────────────────────────────────────────────────────
const PERF_TEST_EMAIL = 'perf-test@dbb-internal.test'

const __dir = dirname(fileURLToPath(import.meta.url))

// ── Env ───────────────────────────────────────────────────────────────────────
function parseEnv(src) {
  const env = {}
  for (const line of src.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return env
}

const env = parseEnv(readFileSync(join(__dir, '..', '.env.local'), 'utf8'))
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

// ── Args ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const emailIdx = args.indexOf('--email')
const readEmailArg = emailIdx !== -1 ? args[emailIdx + 1] : null
const nArg = parseInt(args[args.indexOf('--n') + 1]) || 10
const N = Math.max(1, nArg)

// Guard: never mutate a real account via CLI typo
if (readEmailArg && readEmailArg !== PERF_TEST_EMAIL) {
  console.warn(`⚠  --email ${readEmailArg} is a non-perf email.`)
  console.warn(`   Read-only benchmarks will use that user's data for realistic sizing.`)
  console.warn(`   Mutating benchmarks (import RPC) will STILL use ${PERF_TEST_EMAIL}.`)
  console.warn()
}

// ── User resolution ───────────────────────────────────────────────────────────
const { data: { users }, error: listErr } = await supabase.auth.admin.listUsers({ perPage: 1000 })
if (listErr) { console.error('Failed to list users:', listErr.message); process.exit(1) }

function findUser(email) {
  const u = users?.find(u => u.email === email)
  if (!u) {
    console.error(`User not found: ${email}`)
    console.error('Available:', users?.map(u => u.email).join(', '))
    process.exit(1)
  }
  return u
}

// Read user: --email arg or perf-test
const readEmail = readEmailArg || PERF_TEST_EMAIL
const readUser = findUser(readEmail)
const readUserId = readUser.id

// Write user: always perf-test, no exceptions
const perfUser = findUser(PERF_TEST_EMAIL)
const perfUserId = perfUser.id

console.log(`Read benchmarks:  ${readEmail} (${readUserId})`)
console.log(`Write benchmarks: ${PERF_TEST_EMAIL} (${perfUserId}) — always`)
console.log(`Iterations per query: ${N}\n`)

// ── Helpers ───────────────────────────────────────────────────────────────────
function percentile(sorted, p) {
  const idx = Math.min(Math.floor(sorted.length * p), sorted.length - 1)
  return sorted[idx]
}

async function measure(label, fn, budget = 500) {
  const times = []
  for (let i = 0; i < N; i++) {
    const t0 = performance.now()
    const result = await fn()
    const elapsed = performance.now() - t0
    if (i === 0 && result?.error) {
      console.warn(`  [warn] ${label}: ${result.error.message}`)
    }
    times.push(elapsed)
  }
  times.sort((a, b) => a - b)
  const p50 = percentile(times, 0.5)
  const p95 = percentile(times, 0.95)
  const ok = p95 < budget
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  console.log(`  p50=${p50.toFixed(0)}ms  p95=${p95.toFixed(0)}ms  budget=${budget}ms`)
  return { label, p50, p95, budget, ok }
}

const results = []

// ── READ-ONLY benchmarks (use readUserId — safe for any account) ──────────────
results.push(await measure('GET /library page 1 (all cards)', () =>
  supabase
    .from('library_cards')
    .select('*, card_index!inner(*)', { count: 'exact' })
    .eq('user_id', readUserId)
    .order('date_added', { ascending: false })
    .range(0, 47)
))

results.push(await measure('GET /binders (with card counts)', () =>
  supabase
    .from('binders')
    .select('id, name, is_default, created_at, library_cards(count)')
    .eq('user_id', readUserId)
    .order('created_at')
))

results.push(await measure('Advanced search (rarity=rare/mythic, type=Instant)', () =>
  supabase
    .from('library_cards')
    .select('*, card_index!inner(*)', { count: 'exact' })
    .eq('user_id', readUserId)
    .in('card_index.rarity', ['rare', 'mythic'])
    .ilike('card_index.type_line', '%Instant%')
    .order('date_added', { ascending: false })
    .range(0, 47)
))

results.push(await measure('GET /api/profile/value (all cards scryfall_id+foil)', () =>
  supabase
    .from('library_cards')
    .select('scryfall_id, foil, quantity')
    .eq('user_id', readUserId)
))

// Binder-scoped query — uses first binder of the read user
const { data: readBinders } = await supabase
  .from('binders')
  .select('id')
  .eq('user_id', readUserId)
  .order('created_at')
  .limit(1)

if (readBinders?.[0]) {
  const binderId = readBinders[0].id
  results.push(await measure(`GET /library page 1 (binder=${binderId.slice(0, 8)}…)`, () =>
    supabase
      .from('library_cards')
      .select('*, card_index!inner(*)', { count: 'exact' })
      .eq('user_id', readUserId)
      .eq('binder_id', binderId)
      .order('date_added', { ascending: false })
      .range(0, 47)
  ))
}

// ── Phase 13 additions (read-only) ───────────────────────────────────────────
console.log('\n--- Phase 13: catalog search, cart, bazaar, import ---\n')

results.push(await measure('GET /api/catalog/search (name ILIKE "Lightning")', () =>
  supabase
    .from('card_index')
    .select('scryfall_id, name, set_code, set_name, collector_number, rarity, colors, type_line, cmc, mana_cost', { count: 'exact' })
    .ilike('name', '%Lightning%')
    .order('name').order('set_code').order('collector_number')
    .range(0, 19),
  300
))

results.push(await measure('GET /api/catalog/search (name ILIKE + rarity filter)', () =>
  supabase
    .from('card_index')
    .select('scryfall_id, name, set_code, set_name, collector_number, rarity, colors, type_line, cmc, mana_cost', { count: 'exact' })
    .ilike('name', '%Bolt%')
    .eq('rarity', 'common')
    .order('name').order('set_code').order('collector_number')
    .range(0, 19),
  300
))

// Cart query using readUserId (read-only)
results.push(await measure('GET /api/cart (full join, all items)', () =>
  supabase
    .from('cart_items')
    .select(`
      id, created_at,
      listings(
        id, user_id, multiplier, status,
        library_cards(
          id, scryfall_id, foil, condition,
          card_index(name, set_code, set_name, collector_number, rarity, type_line)
        )
      )
    `)
    .eq('user_id', readUserId)
    .order('created_at', { ascending: true })
))

// Bazaar listings (global — not user-specific)
results.push(await measure('GET /api/listings (bazaar active, page 1, newest)', () =>
  supabase
    .from('listings')
    .select(`
      id, user_id, multiplier, status, created_at,
      library_cards!inner(
        id, scryfall_id, foil, condition, quantity,
        card_index!inner(
          name, set_code, set_name, collector_number, rarity, type_line, colors, cmc
        )
      )
    `, { count: 'exact' })
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .range(0, 23)
))

results.push(await measure('GET /api/listings (bazaar, search="Lightning")', () =>
  supabase
    .from('listings')
    .select(`
      id, user_id, multiplier, status, created_at,
      library_cards!inner(
        id, scryfall_id, foil, condition, quantity,
        card_index!inner(
          name, set_code, set_name, collector_number, rarity, type_line, colors, cmc
        )
      )
    `, { count: 'exact' })
    .eq('status', 'active')
    .ilike('library_cards.card_index.name', '%Lightning%')
    .order('created_at', { ascending: false })
    .range(0, 23)
))

// card_index batch-check (read-only)
const { data: sampleCards } = await supabase
  .from('card_index')
  .select('scryfall_id')
  .limit(200)

const sampleIds = (sampleCards || []).map(c => c.scryfall_id)

if (sampleIds.length >= 100) {
  results.push(await measure('Import: card_index batch-check (200 IDs, IN clause)', () =>
    supabase
      .from('card_index')
      .select('scryfall_id')
      .in('scryfall_id', sampleIds)
  ))
}

// ── MUTATING benchmarks — PERF-TEST USER ONLY ────────────────────────────────
//
// These benchmarks call import_library_cards which inserts/updates rows.
// They MUST run against perf-test@dbb-internal.test with a temporary binder
// that is created and destroyed within this run. Zero net rows are allowed to
// remain after completion (asserted below).
//
// ⚠  DO NOT change perfUserId to readUserId or any other account.

console.log('\n--- Phase 17: mutating benchmarks (perf-test only) ---\n')

// Fetch sample cards from the perf-test user's permanent library for benchmark payloads
const { data: perfLibSample } = await supabase
  .from('library_cards')
  .select('scryfall_id, foil, condition, language, quantity, purchase_price, purchase_currency, date_added')
  .eq('user_id', perfUserId)
  .limit(100)

if (perfLibSample?.length >= 10) {
  // Record perf-user total row count before mutating benchmarks
  const { count: rowsBefore } = await supabase
    .from('library_cards')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', perfUserId)

  // Create a fresh temporary binder for this run only
  const tempBinderName = `perf-run-${Date.now()}`
  const { data: tempBinder, error: tempErr } = await supabase
    .from('binders')
    .insert({ user_id: perfUserId, name: tempBinderName })
    .select('id')
    .single()

  if (tempErr) {
    console.error('Could not create temp binder:', tempErr.message)
  } else {
    const tempBinderId = tempBinder.id
    console.log(`Temp binder: ${tempBinderName} (${tempBinderId})`)

    // 10-row batch
    const batch10 = perfLibSample.slice(0, 10).map(c => ({
      scryfall_id: c.scryfall_id,
      quantity: c.quantity,
      foil: c.foil,
      condition: c.condition,
      language: c.language || 'en',
      purchase_price: c.purchase_price,
      purchase_currency: c.purchase_currency,
      date_added: c.date_added,
    }))
    results.push(await measure('Import: RPC import_library_cards (10 rows, perf-test temp binder)', () =>
      supabase.rpc('import_library_cards', {
        p_user_id: perfUserId,
        p_binder_id: tempBinderId,
        p_rows: batch10,
      })
    ))

    // 100-row batch (if available)
    if (perfLibSample.length >= 20) {
      const batch100 = perfLibSample.map(c => ({
        scryfall_id: c.scryfall_id,
        quantity: c.quantity,
        foil: c.foil,
        condition: c.condition,
        language: c.language || 'en',
        purchase_price: c.purchase_price,
        purchase_currency: c.purchase_currency,
        date_added: c.date_added,
      }))
      results.push(await measure('Import: RPC import_library_cards (100 rows, perf-test temp binder)', () =>
        supabase.rpc('import_library_cards', {
          p_user_id: perfUserId,
          p_binder_id: tempBinderId,
          p_rows: batch100,
        })
      ))
    }

    // ── Teardown & isolation assertion ──────────────────────────────────────────
    console.log('\nTearing down temp binder...')
    await supabase.from('library_cards').delete().eq('user_id', perfUserId).eq('binder_id', tempBinderId)
    await supabase.from('binders').delete().eq('id', tempBinderId).eq('user_id', perfUserId)

    const { count: rowsAfter } = await supabase
      .from('library_cards')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', perfUserId)

    if (rowsAfter === rowsBefore) {
      console.log(`✓ Isolation check: perf-test row count unchanged (${rowsBefore} before, ${rowsAfter} after)`)
    } else {
      console.error(`✗ ISOLATION FAILURE: perf-test row count changed! before=${rowsBefore} after=${rowsAfter}`)
      console.error('  Manual cleanup required — inspect library_cards for user_id=' + perfUserId)
      process.exit(1)
    }
  }
} else {
  console.log(`Skipping import benchmarks: perf-test library has ${perfLibSample?.length ?? 0} rows (need ≥10).`)
  console.log('To seed: run scripts/seed-perf-user.mjs')
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n=== Summary ===')
const passed = results.filter(r => r.ok).length
const failed = results.filter(r => !r.ok).length
console.log(`Passed: ${passed}/${results.length}  Failed: ${failed}/${results.length}`)
if (failed > 0) {
  console.log('\nSlow queries (p95 >= budget):')
  results.filter(r => !r.ok).forEach(r => console.log(`  - ${r.label}: p95=${r.p95.toFixed(0)}ms  budget=${r.budget}ms`))
}
