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

async function measure(label, fn) {
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
  const budget = 500
  const ok = p95 < budget
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  console.log(`  p50=${p50.toFixed(0)}ms  p95=${p95.toFixed(0)}ms  budget=${budget}ms`)
  return { label, p50, p95, ok }
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

console.log('\n=== Summary ===')
const passed = results.filter(r => r.ok).length
const failed = results.filter(r => !r.ok).length
console.log(`Passed: ${passed}/${results.length}  Failed: ${failed}/${results.length}`)
if (failed > 0) {
  console.log('\nSlow queries (p95 >= 500ms):')
  results.filter(r => !r.ok).forEach(r => console.log(`  - ${r.label}: p95=${r.p95.toFixed(0)}ms`))
}
