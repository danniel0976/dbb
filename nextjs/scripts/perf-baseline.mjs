#!/usr/bin/env node
/**
 * DBB performance baseline — calls Supabase directly (no Next.js server needed).
 * Usage: node scripts/perf-baseline.mjs [--email user@example.com] [--n 10]
 *
 * Reports p50 and p95 latency for the key library endpoints.
 * Budget: p95 < 500ms for all list endpoints.
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dir = dirname(fileURLToPath(import.meta.url))

// Parse .env.local
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

// Parse args
const args = process.argv.slice(2)
const emailArg = args[args.indexOf('--email') + 1] || 'danielhairiemir@gmail.com'
const nArg = parseInt(args[args.indexOf('--n') + 1]) || 10
const N = Math.max(1, nArg)

// Resolve test user
const { data: { users }, error: listErr } = await supabase.auth.admin.listUsers({ perPage: 1000 })
if (listErr) { console.error('Failed to list users:', listErr.message); process.exit(1) }
const testUser = users?.find(u => u.email === emailArg)
if (!testUser) {
  console.error(`User ${emailArg} not found. Available emails: ${users?.map(u => u.email).join(', ')}`)
  process.exit(1)
}
const userId = testUser.id
console.log(`Testing with user: ${emailArg} (${userId})`)
console.log(`Runs per query: ${N}\n`)

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
    // Surface any Supabase errors on first run
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

results.push(await measure('GET /library page 1 (all cards)', () =>
  supabase
    .from('library_cards')
    .select('*, card_index!inner(*)', { count: 'exact' })
    .eq('user_id', userId)
    .order('date_added', { ascending: false })
    .range(0, 47)
))

results.push(await measure('GET /binders (with card counts)', () =>
  supabase
    .from('binders')
    .select('id, name, is_default, created_at, library_cards(count)')
    .eq('user_id', userId)
    .order('created_at')
))

results.push(await measure('Advanced search (rarity=rare/mythic, type=Instant)', () =>
  supabase
    .from('library_cards')
    .select('*, card_index!inner(*)', { count: 'exact' })
    .eq('user_id', userId)
    .in('card_index.rarity', ['rare', 'mythic'])
    .ilike('card_index.type_line', '%Instant%')
    .order('date_added', { ascending: false })
    .range(0, 47)
))

results.push(await measure('GET /api/profile/value (all cards scryfall_id+foil)', () =>
  supabase
    .from('library_cards')
    .select('scryfall_id, foil, quantity')
    .eq('user_id', userId)
))

// Get first binder for binder-scoped query
const { data: bindersCheck } = await supabase
  .from('binders')
  .select('id')
  .eq('user_id', userId)
  .limit(1)

if (bindersCheck?.[0]) {
  const binderId = bindersCheck[0].id
  results.push(await measure(`GET /library page 1 (binder=${binderId.slice(0, 8)}…)`, () =>
    supabase
      .from('library_cards')
      .select('*, card_index!inner(*)', { count: 'exact' })
      .eq('user_id', userId)
      .eq('binder_id', binderId)
      .order('date_added', { ascending: false })
      .range(0, 47)
  ))
}

// ── Phase 13 additions ────────────────────────────────────────────────────────

console.log('\n--- Phase 13: catalog search, cart, bazaar, import ---\n')

// Catalog search — budget is 300ms per Phase 13 spec (tighter than library)
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

// Cart query — full join (same 500ms budget as other list endpoints)
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
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
))

// Bazaar listings query — page 1, newest sort
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

// Bazaar name-search (tests ILIKE on joined table through PostgREST)
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

// Import: card_index batch-check (simulates the "which IDs already exist?" step)
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

// Import: RPC import_library_cards (10 rows all-merge — idempotent, won't change data)
const { data: libSample } = await supabase
  .from('library_cards')
  .select('scryfall_id, foil, condition, language, quantity, purchase_price, purchase_currency, date_added, binder_id')
  .eq('user_id', userId)
  .limit(10)

if (libSample?.[0] && bindersCheck?.[0]) {
  const rpcBatch = libSample.map(c => ({
    scryfall_id: c.scryfall_id,
    quantity: c.quantity,
    foil: c.foil,
    condition: c.condition,
    language: c.language || 'en',
    purchase_price: c.purchase_price,
    purchase_currency: c.purchase_currency,
    date_added: c.date_added,
  }))
  results.push(await measure('Import: RPC import_library_cards (10 rows, merge path)', () =>
    supabase.rpc('import_library_cards', {
      p_user_id: userId,
      p_binder_id: bindersCheck[0].id,
      p_rows: rpcBatch,
    })
  ))
}

// Import: larger RPC chunk (100 rows) to gauge throughput
if (libSample && libSample.length >= 10) {
  const { data: libLarge } = await supabase
    .from('library_cards')
    .select('scryfall_id, foil, condition, language, quantity, purchase_price, purchase_currency, date_added')
    .eq('user_id', userId)
    .limit(100)

  if (libLarge?.length >= 20 && bindersCheck?.[0]) {
    const largeBatch = libLarge.map(c => ({
      scryfall_id: c.scryfall_id,
      quantity: c.quantity,
      foil: c.foil,
      condition: c.condition,
      language: c.language || 'en',
      purchase_price: c.purchase_price,
      purchase_currency: c.purchase_currency,
      date_added: c.date_added,
    }))
    results.push(await measure('Import: RPC import_library_cards (100 rows, merge path)', () =>
      supabase.rpc('import_library_cards', {
        p_user_id: userId,
        p_binder_id: bindersCheck[0].id,
        p_rows: largeBatch,
      })
    ))
  }
}

console.log('\n=== Summary ===')
const passed = results.filter(r => r.ok).length
const failed = results.filter(r => !r.ok).length
console.log(`Passed: ${passed}/${results.length}  Failed: ${failed}/${results.length}`)
if (failed > 0) {
  console.log('\nSlow queries (p95 >= budget):')
  results.filter(r => !r.ok).forEach(r => console.log(`  - ${r.label}: p95=${r.p95.toFixed(0)}ms  budget=${r.budget}ms`))
}
