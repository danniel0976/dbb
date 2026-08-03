#!/usr/bin/env node

// Disposable authenticated runtime matrix for Phase 45C. This script is
// intentionally local-only and is followed by a full db reset + UAT seed.
//
// S4 (barrier-backed concurrency matrix) contract:
//   * Holder acquisition is proven by an explicit newline-delimited psql
//     BARRIER_ACQUIRED sentinel emitted after FOR UPDATE. Fixed sleeps and
//     elapsed-time assertions are never the acquisition proof.
//   * Overlap is proven positively by observing ungranted locks in the server
//     while participants are in flight, not inferred from wall-clock timing.
//   * A case may ask the barrier transaction to carry one extra statement, so a
//     state change (an expiry) becomes visible to an already-blocked
//     participant at the exact moment the barrier commits. The statement is
//     sanitised to a single terminated SQL line and is emitted on its own line
//     between FOR UPDATE and the sentinel; it can neither release the barrier
//     early nor merge into the psql meta-command line.
//   * Every case ends in one shared post-race invariant helper.
//   * Every cleanup asserts both the HTTP/RPC result and row/state absence.
//   * The static contract below fails if any of that silently degrades. Run it
//     alone with `node phase45c-runtime-cart-uat.mjs --static-only` (no
//     database, no app, no fixture mutation).
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { config } from 'dotenv'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'

const SOURCE_PATH = new URL(import.meta.url).pathname
const SOURCE = readFileSync(SOURCE_PATH, 'utf8')
const BARRIER_TOKEN = 'BARRIER_ACQUIRED'
// The exact psql input line the barrier must emit, kept as one constant so the
// contract rules and the barrier script can never drift apart.
const SENTINEL_LINE = '\\\\echo ' + BARRIER_TOKEN
const DB_CONTAINER = process.env.PHASE45C_DB_CONTAINER || 'supabase_db_dbb-uat'
const BARRIER_MAX_HOLD_MS = 60000
const OBSERVE_ATTEMPTS = 200
const OVERLAP_DEADLINE_MS = 20000

// Every barrier-backed case is registered here. The static contract requires a
// runHeldListingOverlap call and an assertPostRaceInvariants call for each key,
// so a case cannot be quietly downgraded to an unbarriered race or lose its
// invariant sweep without failing before any database work happens.
const OVERLAP_CASES = Object.freeze({
  finalUnit: 'case 1 final unit, two buyers',
  overDemand: 'case 2 stock 3, two buyers requesting 2',
  exactSplit: 'case 3 exact split 2 + 3 against stock 5',
  reverseOrder: 'case 4 two shared listings in reverse client order',
  replayConcurrent: 'case 5 concurrent identical idempotency replay',
  changedPayload: 'case 6 concurrent same key, changed payload',
  sellerEdit: 'case 7a checkout versus seller quantity edit',
  sellerUnlist: 'case 7b checkout versus seller unlist',
  claimExpiry: 'case 8a checkout versus Claim Sale expiry',
  singlesExpiry: 'case 8b checkout versus Singles expiry',
  orderCompletion: 'case 9 checkout versus order completion',
  heldExpirySweep: 'held listing versus expiry sweep',
  claimCancelCheckout: 'Claim Sale cancellation versus checkout',
  cartAddCheckout: 'cart add versus checkout',
  orderCancelCheckout: 'checkout versus order cancellation',
})

// ---------------------------------------------------------------------------
// Static barrier contract.  These are deterministic assertions over this file's
// own source.  Each rule is paired with a deliberate miswiring below; if a rule
// cannot fail, the meta-test fails and the run stops.
// ---------------------------------------------------------------------------

function region(source, name) {
  const start = source.indexOf(`// ${name}-BEGIN`)
  const end = source.indexOf(`// ${name}-END`)
  return start >= 0 && end > start ? source.slice(start, end) : null
}

function barrierContractViolations(source) {
  const violations = []
  const script = region(source, 'BARRIER-SCRIPT')
  const helper = region(source, 'BARRIER-HELPER')
  const overlap = region(source, 'BARRIER-OVERLAP')
  if (!script) violations.push('barrier-script-region-missing')
  if (!helper) violations.push('barrier-helper-region-missing')
  if (!overlap) violations.push('barrier-overlap-region-missing')

  if (script) {
    const lines = script.split('\n')
    const echoLines = lines.filter(line => line.includes(SENTINEL_LINE))
    const exactEcho = lines.filter(line => line.trim() === SENTINEL_LINE)
    if (echoLines.length !== 1) violations.push('barrier-sentinel-line-count')
    // A psql meta-command consumes the rest of its line. SQL sharing the \echo
    // line would release the lock immediately and fabricate overlap.
    if (exactEcho.length !== 1) violations.push('barrier-sentinel-line-not-isolated')
    const echoIndex = lines.findIndex(line => line.includes(SENTINEL_LINE))
    const forUpdateIndex = lines.findIndex(line => line.includes('FOR UPDATE'))
    const holdIndex = lines.findIndex(line => line.trim().startsWith('SELECT pg_sleep('))
    const commitIndex = lines.findIndex(line => line.trim() === 'COMMIT;')
    if (forUpdateIndex < 0 || echoIndex < 0 || forUpdateIndex > echoIndex) violations.push('barrier-sentinel-before-for-update')
    if (holdIndex < 0 || holdIndex < echoIndex) violations.push('barrier-hold-statement-missing')
    if (commitIndex < 0 || commitIndex <= holdIndex) violations.push('barrier-commit-line-missing')
    // The optional in-barrier statement occupies its own interpolated line,
    // strictly after the rows are locked and strictly before the sentinel. Any
    // other placement would either run outside the lock or merge into the psql
    // meta-command line and release the barrier before the participants start.
    const extraIndex = lines.findIndex(line => line.trim() === '${extra}')
    if (extraIndex < 0 || extraIndex <= forUpdateIndex || extraIndex >= echoIndex) violations.push('barrier-extra-statement-misplaced')
  }

  if (helper) {
    const lines = helper.split('\n')
    const guardIndex = lines.findIndex(line => line.includes(`stdout.includes(BARRIER_TOKEN)`))
    const resolveIndexes = lines.reduce((all, line, index) => line.includes('acquiredResolve()') ? [...all, index] : all, [])
    if (guardIndex < 0) violations.push('barrier-acquire-not-bound-to-stdout-token')
    // Exactly one resolve site, and it must sit inside the stdout guard.
    if (resolveIndexes.length !== 1) violations.push('barrier-acquire-resolve-site-count')
    else if (resolveIndexes[0] <= guardIndex || resolveIndexes[0] - guardIndex > 3) violations.push('barrier-acquire-resolve-outside-stdout-guard')
    // The caller-supplied statement must reach the barrier script only through
    // the sanitiser, never as raw text.
    if (!helper.includes('barrierStatement(withinTransactionSql)')) violations.push('barrier-extra-statement-not-sanitised')
  }

  if (overlap) {
    const acquiredIndex = overlap.indexOf('await holder.acquired')
    const startIndex = overlap.indexOf('startOperations()')
    if (acquiredIndex < 0) violations.push('overlap-does-not-await-acquired')
    if (startIndex < 0) violations.push('overlap-does-not-start-operations')
    if (acquiredIndex >= 0 && startIndex >= 0 && acquiredIndex > startIndex) violations.push('overlap-starts-before-acquired')
    const preStart = startIndex >= 0 ? overlap.slice(0, startIndex) : overlap
    // A timer in front of participant launch is exactly the probabilistic
    // barrier this slice exists to remove.
    if (/await wait\(/.test(preStart) || /setTimeout\(/.test(preStart)) violations.push('overlap-uses-timer-for-acquisition')
    if (!overlap.includes('await observeLockContention(')) violations.push('overlap-does-not-observe-contention')
    if (!overlap.includes('expect(waiters >= 1,')) violations.push('overlap-does-not-assert-contention')
    if (!overlap.includes('expect(settleTimes.some(')) violations.push('overlap-does-not-assert-post-release-settle')
  }

  // Rules below inspect the runtime half of the file only: the contract table
  // above deliberately contains violating snippets as mutation payloads.
  const runtime = source.slice(source.lastIndexOf('// STATIC-CONTRACT-END'))

  for (const key of Object.keys(OVERLAP_CASES)) {
    const call = new RegExp(`runHeldListingOverlap\\(\\s*[A-Za-z0-9_.,\\[\\]\\s]*,\\s*OVERLAP_CASES\\.${key}\\b`)
    if (!call.test(runtime)) violations.push(`overlap-case-not-barrier-backed:${key}`)
    const invariant = new RegExp(`assertPostRaceInvariants\\(\\s*OVERLAP_CASES\\.${key}\\b`)
    if (!invariant.test(runtime)) violations.push(`overlap-case-missing-invariants:${key}`)
  }

  // No checkout may be launched from a bare Promise.all array literal. The
  // array is scanned to its matching bracket so an unrelated Promise.all
  // elsewhere in the file cannot produce a false hit or hide a real one.
  let cursor = runtime.indexOf('Promise.all([')
  while (cursor >= 0) {
    const open = runtime.indexOf('[', cursor)
    let depth = 0
    let end = open
    while (end < runtime.length) {
      if (runtime[end] === '[') depth += 1
      else if (runtime[end] === ']') { depth -= 1; if (depth === 0) break }
      end += 1
    }
    if (runtime.slice(open, end).includes('/api/checkout')) { violations.push('checkout-launched-from-bare-promise-all'); break }
    cursor = runtime.indexOf('Promise.all([', cursor + 1)
  }

  // One DELETE primitive, used only by the two asserted wrappers.
  const deleteLiterals = runtime.split(`method: 'DELETE'`).length - 1
  if (deleteLiterals !== 1) violations.push('delete-primitive-not-unique')
  const deleteCalls = runtime.split('requestDelete(').length - 1
  if (deleteCalls !== 3) violations.push('delete-primitive-call-sites')
  if (!runtime.includes('async function deleteCartItemChecked(')) violations.push('cart-delete-not-asserted')
  if (!runtime.includes('await assertRowAbsent(')) violations.push('cleanup-does-not-assert-row-absence')

  return violations
}

// Mutations are applied to the runtime half only. The rule needles themselves
// live above the marker, so a mutation can never rewrite the rule that is
// meant to catch it.
function mutateRuntime(source, from, to) {
  const at = source.lastIndexOf('// STATIC-CONTRACT-END')
  const head = source.slice(0, at)
  const tail = source.slice(at)
  return tail.includes(from) ? head + tail.replace(from, to) : source
}

// Each miswiring must break at least one rule. A contract that cannot fail is
// not a contract, so the run refuses to continue if any mutation passes.
const BARRIER_MISWIRINGS = [
  ['sql-on-sentinel-line', s => mutateRuntime(s, `${SENTINEL_LINE}\n`, `${SENTINEL_LINE} SELECT 1;\n`)],
  ['fixed-sleep-acquisition', s => mutateRuntime(s, 'await holder.acquired', 'await wait(250)')],
  ['timer-bound-acquisition', s => mutateRuntime(s, 'stdout.includes(BARRIER_TOKEN)', 'Date.now() > 0')],
  ['case-downgraded-to-plain-label', s => mutateRuntime(s, 'OVERLAP_CASES.finalUnit,', `'final unit',`)],
  ['invariants-dropped', s => mutateRuntime(s, 'assertPostRaceInvariants(OVERLAP_CASES.overDemand', 'skipInvariants(OVERLAP_CASES.overDemand')],
  ['checkout-in-bare-promise-all', s => `${s}\nPromise.all([request(a, '/api/checkout', {}), request(b, '/api/checkout', {})])\n`],
  ['unasserted-raw-delete', s => `${s}\nawait request(session, '/api/cart/x', { method: 'DELETE' })\n`],
  ['contention-observation-dropped', s => mutateRuntime(s, 'expect(waiters >= 1,', 'void (waiters,')],
  ['extra-statement-merged-into-sentinel', s => mutateRuntime(s, '${extra}\n' + SENTINEL_LINE, '${extra}' + SENTINEL_LINE)],
  ['extra-statement-unsanitised', s => mutateRuntime(s, 'barrierStatement(withinTransactionSql)', "(withinTransactionSql || '')")],
]

// The sanitiser is a runtime gate rather than a source rule, so it is exercised
// directly: a statement that could end the barrier transaction, escape into a
// psql meta-command, or trail an unterminated fragment into the sentinel line
// must be rejected before any database work happens.
const REJECTED_BARRIER_STATEMENTS = [
  ['a multi-line statement', "UPDATE public.listings SET quantity = 1;\nCOMMIT;"],
  ['a psql meta-command', "\\q;"],
  ['transaction control', 'COMMIT;'],
  ['an unterminated statement', 'UPDATE public.listings SET quantity = 1'],
]

// STATIC-CONTRACT-END

function runStaticBarrierContract() {
  const results = []
  const live = barrierContractViolations(SOURCE)
  if (live.length) {
    throw new Error(`barrier source contract failed: ${live.join(', ')}`)
  }
  results.push(`PASS: barrier source contract holds (${Object.keys(OVERLAP_CASES).length} registered overlap cases)`)
  for (const [name, mutate] of BARRIER_MISWIRINGS) {
    const mutated = mutate(SOURCE)
    if (mutated === SOURCE) throw new Error(`barrier miswiring "${name}" did not change the source; the meta-test is vacuous`)
    const violations = barrierContractViolations(mutated)
    if (!violations.length) throw new Error(`barrier miswiring "${name}" passed the contract; the contract cannot fail`)
    results.push(`PASS: miswiring "${name}" is rejected (${violations[0]})`)
  }
  if (barrierStatement(null) !== '') throw new Error('barrier statement sanitiser must yield an empty line when a case asks for no statement')
  results.push('PASS: barrier statement sanitiser yields an empty line when unused')
  for (const [name, statement] of REJECTED_BARRIER_STATEMENTS) {
    let rejected = false
    try { barrierStatement(statement) } catch { rejected = true }
    if (!rejected) throw new Error(`barrier statement sanitiser accepted ${name}; the barrier could be released or hijacked from inside a case`)
    results.push(`PASS: barrier statement sanitiser rejects ${name}`)
  }
  return results
}

const STATIC_ONLY = process.argv.includes('--static-only') || process.env.PHASE45C_STATIC_ONLY === '1'
const staticResults = runStaticBarrierContract()
if (STATIC_ONLY) {
  for (const line of staticResults) console.log(line)
  console.log(JSON.stringify({ result: 'PHASE45C_STATIC_CONTRACT_PASS', checks: staticResults.length }))
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Runtime environment.  Nothing above this line touches the network, the
// database, or any fixture.
// ---------------------------------------------------------------------------

config({ path: path.resolve(new URL('../.env.local', import.meta.url).pathname), override: false })

const appUrl = process.env.PHASE45C_APP_URL || 'http://127.0.0.1:3000'
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const appSupabaseUrl = process.env.PHASE45C_AUTH_SUPABASE_URL || supabaseUrl
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!supabaseUrl || !anonKey || !serviceKey) throw new Error('Missing local Supabase environment')
const host = new URL(supabaseUrl).hostname
if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) throw new Error(`Refusing non-local Supabase host: ${host}`)
const appSupabaseHost = new URL(appSupabaseUrl).hostname
if (!['127.0.0.1', 'localhost', '[::1]', '100.94.130.7'].includes(appSupabaseHost)) throw new Error(`Refusing app auth host: ${appSupabaseHost}`)

const service = createServiceClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
const PASSWORD = 'password1234'
const SELLER_EMAIL = 'seller_uat@dbb.test'
const DAN_EMAIL = 'dan@dbb.test'
const BUYER_TWO_EMAIL = 'buyer_two_45c@dbb.test'
const FIXTURE_DATE = '2026-07-26T00:00:00.000Z'
const FAR_FUTURE = '2099-12-31T23:59:59.000Z'
const PAST = '2020-01-01T00:00:00.000Z'
const CONDITIONS = ['NM', 'LP', 'MP', 'HP', 'DMG']
const LANGUAGES = ['en', 'ja', 'ko', 'de', 'fr', 'it', 'es', 'pt', 'ru', 'zhs', 'zht']
const RAW_DB_TEXT = /ERROR:|SQLSTATE|pg_[a-z_]+|relation "|function .* does not exist|violates|duplicate key/i
const checks = []
const observations = []

function pass(name) { checks.push(`PASS: ${name}`) }
function note(message) { observations.push(message) }
function fail(message) { throw new Error(message) }
function expect(value, message) { if (!value) fail(message) }
function expectEqual(actual, expected, message) { if (actual !== expected) fail(`${message}: expected ${expected}, got ${actual}`) }
function uuid() { return crypto.randomUUID() }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

function expectSafeBody(label, data) {
  const body = JSON.stringify(data || {})
  expect(!RAW_DB_TEXT.test(body), `${label}: response body carries raw database text: ${body}`)
}

async function existingUser(email) {
  const { data, error } = await service.auth.admin.listUsers({ page: 1, perPage: 1000 })
  if (error) throw error
  return (data.users || []).find(user => user.email?.toLowerCase() === email.toLowerCase()) || null
}

async function ensureUser(email, metadata) {
  let user = await existingUser(email)
  if (!user) {
    const result = await service.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true, user_metadata: metadata })
    if (result.error) throw result.error
    user = result.data.user
  }
  expect(user?.id, `could not resolve ${email}`)
  return user
}

async function authSession(email) {
  const jar = new Map()
  const auth = createServerClient(appSupabaseUrl, anonKey, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: values => values.forEach(({ name, value }) => jar.set(name, value)),
    },
  })
  const { data, error } = await auth.auth.signInWithPassword({ email, password: PASSWORD })
  if (error) throw error
  expect(data.user?.id, `login failed for ${email}`)
  return { user: data.user, cookies: [...jar].map(([name, value]) => `${name}=${value}`).join('; ') }
}

async function directAuthClient(email) {
  const client = createServiceClient(appSupabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD })
  if (error) throw error
  return client
}

async function request(session, route, init = {}) {
  const headers = new Headers(init.headers || {})
  headers.set('Cookie', session.cookies)
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const response = await fetch(`${appUrl}${route}`, { ...init, headers })
  const data = await response.json().catch(() => ({}))
  return { response, data }
}

// The single DELETE primitive. Both asserted wrappers below route through it so
// the static contract can prove no unchecked deletion exists anywhere.
async function requestDelete(session, route) {
  return request(session, route, { method: 'DELETE' })
}

function psqlQuery(sql) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['exec', '-i', DB_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-t', '-A'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', chunk => { out += chunk.toString() })
    child.stderr.on('data', chunk => { err += chunk.toString() })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolve({ out, err }) : reject(new Error(`psql exited ${code}: ${err}`)))
    child.stdin.end(sql)
  })
}

// Positive overlap evidence: while the barrier is held, at least one backend in
// this database must be waiting on an ungranted lock. Elapsed time cannot
// distinguish a blocked participant from a slow one; an ungranted lock can.
async function observeLockContention(label) {
  const { err } = await psqlQuery(`DO $$
DECLARE v_waiters integer := 0; i integer;
BEGIN
  FOR i IN 1..${OBSERVE_ATTEMPTS} LOOP
    SELECT count(*) INTO v_waiters FROM pg_locks bl
      JOIN pg_stat_activity a ON a.pid = bl.pid
      WHERE NOT bl.granted AND a.datname = current_database() AND a.pid <> pg_backend_pid();
    EXIT WHEN v_waiters > 0;
    PERFORM pg_sleep(0.05);
  END LOOP;
  RAISE NOTICE 'BARRIER_WAITERS=%', v_waiters;
END $$;
`)
  const match = /BARRIER_WAITERS=(\d+)/.exec(err)
  expect(match, `${label}: lock-contention probe returned no BARRIER_WAITERS line`)
  return Number(match[1])
}

// A case may hand the barrier one extra statement to run inside its
// transaction, after the rows are locked. Its effect is invisible to every
// other session until the barrier commits, which is how a case makes a
// condition become true underneath a participant that is already blocked on the
// held row. The statement is reduced to a single terminated SQL line: a
// newline, a backslash, or transaction control would let it release or hijack
// the barrier before the participants have even started.
function barrierStatement(sql) {
  if (sql === null || sql === undefined) return ''
  if (typeof sql !== 'string' || !sql.trim()) throw new Error('barrier statement must be a non-empty string')
  const statement = sql.trim()
  if (statement.includes('\n') || statement.includes('\r')) throw new Error('barrier statement must be a single line')
  if (statement.includes('\\')) throw new Error('barrier statement must not contain a psql meta-command escape')
  if (!statement.endsWith(';')) throw new Error('barrier statement must be terminated')
  if (/\b(begin|commit|rollback|savepoint|end)\b/i.test(statement)) throw new Error('barrier statement must not contain transaction control')
  return statement
}

// BARRIER-HELPER-BEGIN
// Hold one or more listing rows in a separate psql session. Acquisition is
// signalled by an explicit sentinel on stdout after FOR UPDATE; release is
// driven by this process, never by a timer that could expire mid-case. Listing
// rows are locked in id order so the barrier itself obeys the global hierarchy.
function holdListingLocks(listingIds, { withinTransactionSql = null } = {}) {
  const ids = [...listingIds].sort()
  expect(ids.length >= 1, 'barrier requires at least one listing id')
  const extra = barrierStatement(withinTransactionSql)
  const child = spawn('docker', ['exec', '-i', DB_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  let stdout = ''
  let barrierSeen = false
  let released = false
  const state = { autoReleased: false }
  let acquiredResolve
  let acquiredReject
  const acquired = new Promise((resolve, reject) => {
    acquiredResolve = resolve
    acquiredReject = reject
  })
  child.stderr.on('data', chunk => { stderr += chunk.toString() })
  child.stdout.on('data', chunk => {
    stdout += chunk.toString()
    if (!barrierSeen && stdout.includes(BARRIER_TOKEN)) {
      barrierSeen = true
      acquiredResolve()
    }
  })
  const done = new Promise((resolve, reject) => {
    child.on('error', error => { acquiredReject(error); reject(error) })
    child.on('exit', code => {
      if (code === 0) {
        if (!barrierSeen) acquiredReject(new Error('barrier psql exited without BARRIER_ACQUIRED'))
        resolve()
      } else {
        const error = new Error(`barrier psql exited ${code}: ${stderr}`)
        acquiredReject(error)
        reject(error)
      }
    })
  })
  // BARRIER-SCRIPT-BEGIN
  // The lock is taken here; the optional case statement runs behind that lock
  // on its own line, and the sentinel is the next input line and carries no SQL
  // of its own, so psql cannot consume a statement into the meta-command.
  child.stdin.write(`BEGIN;
DO $$ BEGIN
  IF (SELECT count(*) FROM public.listings WHERE id = ANY(ARRAY[${ids.map(id => `'${id}'::uuid`).join(',')}])) <> ${ids.length} THEN
    RAISE EXCEPTION 'BARRIER_LISTING_NOT_FOUND';
  END IF;
  PERFORM 1 FROM public.listings WHERE id = ANY(ARRAY[${ids.map(id => `'${id}'::uuid`).join(',')}]) ORDER BY id FOR UPDATE;
END $$;
${extra}
\\echo BARRIER_ACQUIRED
`)
  const release = () => {
    if (released) return
    released = true
    clearTimeout(watchdog)
    child.stdin.end(`
SELECT pg_sleep(0.05);
COMMIT;
`)
  }
  // BARRIER-SCRIPT-END
  const watchdog = setTimeout(() => { state.autoReleased = true; release() }, BARRIER_MAX_HOLD_MS)
  return { acquired, done, release, state }
}
// BARRIER-HELPER-END

// BARRIER-OVERLAP-BEGIN
// Run participants while the listing rows are held. Acquisition is awaited on
// the sentinel, contention is observed positively, release is explicit, and the
// holder is released and drained on every failure path so a deadlock cannot
// leave a dangling request behind this process.
async function runHeldListingOverlap(listingIds, label, startOperations, barrierOptions = {}) {
  const holder = holdListingLocks(listingIds, barrierOptions)
  const settleTimes = []
  let tracked = []
  let releasedAt = 0
  let outcome
  let timeout
  try {
    await holder.acquired
    tracked = startOperations().map(operation => Promise.resolve(operation).then(
      value => { settleTimes.push(Date.now()); return value },
      error => { settleTimes.push(Date.now()); throw error },
    ))
    const waiters = await observeLockContention(label)
    expect(waiters >= 1, `${label}: no backend was waiting on a lock while the barrier was held; participants did not overlap`)
    releasedAt = Date.now()
    holder.release()
    outcome = await Promise.race([
      Promise.all(tracked),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`${label} overlap timed out`)), OVERLAP_DEADLINE_MS) }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
    holder.release()
    await holder.done
    await Promise.allSettled(tracked)
  }
  expect(!holder.state.autoReleased, `${label}: barrier watchdog fired; the case did not complete inside the hold window`)
  expect(settleTimes.some(settled => settled >= releasedAt), `${label}: every participant finished before the barrier was released`)
  return outcome
}
// BARRIER-OVERLAP-END

// ---------------------------------------------------------------------------
// Cleanup gates.  A silent cleanup failure poisons the next case's full-cart
// snapshot, so every cleanup asserts the HTTP/RPC result and then proves the
// row is actually gone through an independent service read.
// ---------------------------------------------------------------------------

async function assertRowAbsent(table, column, value, label) {
  const result = await service.from(table).select(column).eq(column, value)
  if (result.error) throw result.error
  expectEqual(result.data.length, 0, `${label}: ${table} rows remain after cleanup`)
}

async function deleteCartItemChecked(session, itemId, label) {
  const result = await requestDelete(session, `/api/cart/${itemId}`)
  expectEqual(result.response.status, 200, `${label}: cart delete HTTP ${JSON.stringify(result.data)}`)
  expectSafeBody(`${label} cart delete`, result.data)
  await assertRowAbsent('cart_items', 'id', itemId, `${label} cart delete`)
}

async function unlistListingRequest(session, listingId) {
  return requestDelete(session, `/api/listings/${listingId}`)
}

async function emptyCartChecked(session, label) {
  const cart = await request(session, '/api/cart')
  expectEqual(cart.response.status, 200, `${label}: cart read before clearing`)
  for (const item of cart.data.items || []) {
    await deleteCartItemChecked(session, item.id, `${label} pre-case clear`)
  }
  const after = await request(session, '/api/cart')
  expectEqual(after.data.items?.length || 0, 0, `${label}: cart is not empty after clearing`)
}

async function serviceInsertChecked(table, row, label) {
  const result = await service.from(table).insert(row)
  if (result.error) throw new Error(`${label}: ${table} insert failed: ${result.error.message}`)
  return row.id
}

async function serviceUpdateChecked(table, id, patch, label) {
  const result = await service.from(table).update(patch).eq('id', id)
  if (result.error) throw new Error(`${label}: ${table} update failed: ${result.error.message}`)
}

async function serviceOne(table, query) {
  const result = await query
  if (result.error) throw result.error
  return result.data
}

async function listingRow(id) {
  const result = await service.from('listings').select('id,quantity,status,expires_at,library_card_id,user_id,claim_sale_id').eq('id', id).maybeSingle()
  if (result.error) throw result.error
  return result.data
}

async function acceptedUnitsForListing(listingId) {
  const items = await service.from('order_items').select('quantity,order_id').eq('listing_id', listingId)
  if (items.error) throw items.error
  if (!items.data.length) return 0
  const orders = await service.from('orders').select('id,status').in('id', [...new Set(items.data.map(item => item.order_id))])
  if (orders.error) throw orders.error
  const statusById = new Map(orders.data.map(order => [order.id, order.status]))
  return items.data
    .filter(item => statusById.get(item.order_id) !== 'cancelled')
    .reduce((sum, item) => sum + item.quantity, 0)
}

// ---------------------------------------------------------------------------
// One shared post-race invariant sweep, invoked after every barrier case.
// ---------------------------------------------------------------------------

async function assertPostRaceInvariants(label, context) {
  // 1. Accepted demand and listing stock accounting.
  for (const spec of context.listings || []) {
    const listing = await listingRow(spec.id)
    if (spec.expectDeleted) {
      expect(!listing, `${label}: listing ${spec.id} should have been unlisted`)
      await assertRowAbsent('marketplace_card_reservations', 'source_id', spec.id, `${label} deleted listing reservation`)
      continue
    }
    expect(listing, `${label}: listing ${spec.id} is missing`)
    const accepted = await acceptedUnitsForListing(spec.id)
    if (spec.expectedAccepted !== undefined && spec.expectedAccepted !== null) {
      expectEqual(accepted, spec.expectedAccepted, `${label}: accepted order demand for listing ${spec.id}`)
    }
    if (spec.expectedQuantity !== undefined && spec.expectedQuantity !== null) {
      expectEqual(listing.quantity, spec.expectedQuantity, `${label}: listing ${spec.id} quantity`)
    } else if (spec.initialQuantity !== undefined) {
      expectEqual(listing.quantity, spec.initialQuantity - accepted, `${label}: listing ${spec.id} quantity does not equal initial minus accepted`)
    }
    if (spec.expectedStatus) {
      expect(spec.expectedStatus.includes(listing.status), `${label}: listing ${spec.id} status ${listing.status} not in ${spec.expectedStatus.join('/')}`)
    }
    // Scoped temporal check: a tracked listing that is no longer sellable must
    // not still hold a listing reservation.
    if (spec.expectNoReservation) {
      await assertRowAbsent('marketplace_card_reservations', 'source_id', spec.id, `${label} stale listing reservation`)
    }
  }

  // 2. Orders named by the case exist with the expected shape.
  for (const spec of context.orders || []) {
    const order = await service.from('orders').select('id,status').eq('id', spec.id).maybeSingle()
    if (order.error) throw order.error
    expect(order.data, `${label}: order ${spec.id} is missing`)
    if (spec.expectedStatus) expectEqual(order.data.status, spec.expectedStatus, `${label}: order ${spec.id} status`)
    if (spec.expectedItems !== undefined) {
      const items = await service.from('order_items').select('id,quantity').eq('order_id', spec.id)
      if (items.error) throw items.error
      expectEqual(items.data.length, spec.expectedItems, `${label}: order ${spec.id} item count`)
      if (spec.expectedUnits !== undefined) {
        expectEqual(items.data.reduce((sum, item) => sum + item.quantity, 0), spec.expectedUnits, `${label}: order ${spec.id} unit total`)
      }
    }
  }

  // 3. Global reservation ledger: never over-reserved, never attached to a
  // listing that is no longer active, never negative.
  const reservations = await service.from('marketplace_card_reservations').select('library_card_id,source_kind,source_id,reserved_quantity').limit(5000)
  if (reservations.error) throw reservations.error
  const byCard = new Map()
  for (const row of reservations.data) {
    expect(row.reserved_quantity > 0, `${label}: non-positive reservation on card ${row.library_card_id}`)
    byCard.set(row.library_card_id, (byCard.get(row.library_card_id) || 0) + row.reserved_quantity)
  }
  const cardIds = [...byCard.keys()]
  for (let index = 0; index < cardIds.length; index += 150) {
    const slice = cardIds.slice(index, index + 150)
    const cards = await service.from('library_cards').select('id,quantity').in('id', slice)
    if (cards.error) throw cards.error
    const quantityById = new Map(cards.data.map(card => [card.id, card.quantity]))
    for (const cardId of slice) {
      const owned = quantityById.get(cardId)
      expect(owned !== undefined, `${label}: reservation references missing library card ${cardId}`)
      expect(byCard.get(cardId) <= owned, `${label}: card ${cardId} reserved ${byCard.get(cardId)} of ${owned} owned`)
    }
  }
  const listingSourceIds = [...new Set(reservations.data.filter(row => row.source_kind === 'listing').map(row => row.source_id))]
  for (let index = 0; index < listingSourceIds.length; index += 150) {
    const slice = listingSourceIds.slice(index, index + 150)
    const rows = await service.from('listings').select('id,status').in('id', slice)
    if (rows.error) throw rows.error
    const statusById = new Map(rows.data.map(row => [row.id, row.status]))
    for (const sourceId of slice) {
      const status = statusById.get(sourceId)
      expect(status !== undefined, `${label}: listing reservation ${sourceId} has no listing row`)
      expectEqual(status, 'active', `${label}: listing reservation ${sourceId} survives a non-active listing`)
    }
  }
  const orderSourceIds = [...new Set(reservations.data.filter(row => row.source_kind === 'order').map(row => row.source_id))]
  for (let index = 0; index < orderSourceIds.length; index += 150) {
    const slice = orderSourceIds.slice(index, index + 150)
    const rows = await service.from('orders').select('id,status').in('id', slice)
    if (rows.error) throw rows.error
    const statusById = new Map(rows.data.map(row => [row.id, row.status]))
    for (const sourceId of slice) {
      const status = statusById.get(sourceId)
      expect(status !== undefined, `${label}: order reservation ${sourceId} has no order row`)
      expect(!['cancelled', 'order_completed'].includes(status), `${label}: order reservation ${sourceId} survives terminal order ${status}`)
    }
  }

  // 4. Losing/winning cart retention exactly as the case declares.
  for (const spec of context.carts || []) {
    const cart = await request(spec.session, '/api/cart')
    expectEqual(cart.response.status, 200, `${label}: cart read for ${spec.label}`)
    const held = (cart.data.items || []).map(item => item.listing_id).sort()
    const expected = [...(spec.expectListingIds || [])].sort()
    expectEqual(JSON.stringify(held), JSON.stringify(expected), `${label}: ${spec.label} cart retention`)
  }

  // 5. No orphan checkout request: every recorded row is terminal and resolves
  // to real orders.
  for (const buyerId of context.buyerIds || []) {
    const rows = await service.from('checkout_requests').select('id,status,order_ids').eq('buyer_id', buyerId)
    if (rows.error) throw rows.error
    for (const row of rows.data) {
      expectEqual(row.status, 'completed', `${label}: checkout request ${row.id} is not terminal`)
      expect((row.order_ids || []).length > 0, `${label}: completed checkout request ${row.id} has no orders`)
      const orders = await service.from('orders').select('id').in('id', row.order_ids)
      if (orders.error) throw orders.error
      expectEqual(orders.data.length, row.order_ids.length, `${label}: checkout request ${row.id} references missing orders`)
    }
  }

  // 6. No listing may point at a library card owned by someone else.
  const allListings = await service.from('listings').select('id,user_id,library_card_id').limit(5000)
  if (allListings.error) throw allListings.error
  const ownerCardIds = [...new Set(allListings.data.map(row => row.library_card_id).filter(Boolean))]
  const ownerById = new Map()
  for (let index = 0; index < ownerCardIds.length; index += 150) {
    const slice = ownerCardIds.slice(index, index + 150)
    const cards = await service.from('library_cards').select('id,user_id').in('id', slice)
    if (cards.error) throw cards.error
    for (const card of cards.data) ownerById.set(card.id, card.user_id)
  }
  for (const row of allListings.data) {
    if (!row.library_card_id) continue
    const owner = ownerById.get(row.library_card_id)
    expect(owner !== undefined, `${label}: listing ${row.id} references missing library card`)
    expectEqual(owner, row.user_id, `${label}: listing ${row.id} seller does not own its library card`)
  }
}

const seller = await ensureUser(SELLER_EMAIL, { username: 'seller_uat' })
const dan = await ensureUser(DAN_EMAIL, { username: 'dan_uat' })
const buyerTwo = await ensureUser(BUYER_TWO_EMAIL, { username: 'buyer_two_45c' })
const sellerProfile = await serviceOne('profiles', service.from('profiles').select('id').eq('id', seller.id).single())
expect(sellerProfile?.id, 'seller profile missing')

const claimListings = await serviceOne('listings', service.from('listings')
  .select('id,user_id,library_card_id,claim_sale_id,multiplier,quantity,status,expires_at,claim_sales!listings_claim_sale_id_fkey(id,title,status,expires_at),library_cards(id,scryfall_id,quantity,foil,condition,binder_id)')
  .eq('user_id', seller.id).not('claim_sale_id', 'is', null).order('created_at', { ascending: true }))
expect(claimListings.length >= 2, 'expected two Claim Sale fixture listings')
const claimSale = claimListings[0].claim_sales
const claimOne = claimListings[0]
const claimTwo = claimListings[1]
const binderId = claimOne.library_cards.binder_id

// Only catalog/foil pairs proven priceable by the seeded Claim Sale listings are
// used for new fixtures; a card without a price cannot reach checkout at all.
const CATALOGS = [
  { scryfallId: claimOne.library_cards.scryfall_id, foil: claimOne.library_cards.foil || 'normal' },
  { scryfallId: claimTwo.library_cards.scryfall_id, foil: claimTwo.library_cards.foil || 'normal' },
]
const usedVariants = new Set()

// library_cards is unique on (user_id, binder_id, scryfall_id, foil, condition,
// language). Every disposable fixture card must therefore claim a free variant
// rather than assume one; the database is consulted, not guessed.
async function makeCard(label, quantity, catalogIndex = 0) {
  const catalog = CATALOGS[catalogIndex % CATALOGS.length]
  for (const condition of CONDITIONS) {
    for (const language of LANGUAGES) {
      const key = [catalog.scryfallId, catalog.foil, condition, language].join('|')
      if (usedVariants.has(key)) continue
      usedVariants.add(key)
      const existing = await service.from('library_cards').select('id')
        .eq('user_id', seller.id).eq('binder_id', binderId).eq('scryfall_id', catalog.scryfallId)
        .eq('foil', catalog.foil).eq('condition', condition).eq('language', language).limit(1)
      if (existing.error) throw existing.error
      if (existing.data.length) continue
      const id = uuid()
      await serviceInsertChecked('library_cards', {
        id, user_id: seller.id, binder_id: binderId, scryfall_id: catalog.scryfallId,
        quantity, foil: catalog.foil, condition, language, starred: false, date_added: FIXTURE_DATE,
      }, `${label} card`)
      return id
    }
  }
  return fail(`${label}: no free library_cards variant remains`)
}

async function makeListing(label, { cardId, quantity, claimSaleId = null, expiresAt = FAR_FUTURE }) {
  const id = uuid()
  await serviceInsertChecked('listings', {
    id, user_id: seller.id, library_card_id: cardId, multiplier: 2.5, quantity,
    status: 'active', created_at: FIXTURE_DATE, expires_at: expiresAt, claim_sale_id: claimSaleId,
  }, `${label} listing`)
  // The reservation trigger is part of the fixture contract: without it the
  // checkout RPC would fail closed on RESERVATION_DRIFT for unrelated reasons.
  const reservation = await service.from('marketplace_card_reservations')
    .select('reserved_quantity').eq('source_kind', 'listing').eq('source_id', id)
  if (reservation.error) throw reservation.error
  expectEqual(reservation.data.length, 1, `${label}: listing reservation was not created`)
  expectEqual(reservation.data[0].reserved_quantity, quantity, `${label}: listing reservation quantity`)
  return id
}

async function makeClaimSale(label, { expiresAt = FAR_FUTURE } = {}) {
  const id = uuid()
  await serviceInsertChecked('claim_sales', {
    id, user_id: seller.id, title: `45C ${label}`, description: 'Disposable test', set_code: 'uat',
    duration_hours: 24, expires_at: expiresAt, status: 'active', delivery_option: 'pickup', created_at: FIXTURE_DATE,
  }, `${label} claim sale`)
  return id
}

async function addToCartChecked(session, listingId, quantity, label) {
  const added = await request(session, '/api/cart', { method: 'POST', body: JSON.stringify({ listing_id: listingId, quantity }) })
  expectEqual(added.response.status, 201, `${label}: cart add ${JSON.stringify(added.data)}`)
  const cart = await request(session, '/api/cart')
  const item = (cart.data.items || []).find(row => row.listing_id === listingId)
  expect(item, `${label}: cart line missing after add`)
  expectEqual(item.requested_quantity, quantity, `${label}: cart line quantity`)
  return item
}

function checkoutBodyFor(items, pickupId, key = uuid()) {
  return { idempotency_key: key, pickup_location_id: pickupId, items }
}

function checkoutRequest(session, body) {
  return request(session, '/api/checkout', { method: 'POST', body: JSON.stringify(body) })
}

await service.from('listings').update({ quantity: 3, status: 'active' }).in('id', [claimOne.id, claimTwo.id])

const staleCardId = uuid()
const staleListingId = uuid()
const staleCardInsert = await service.from('library_cards').insert({
  id: staleCardId, user_id: seller.id, binder_id: binderId, scryfall_id: claimOne.library_cards.scryfall_id,
  // Keep the disposable stale-cart card distinct from the seeded Claim Sale
  // card's composite identity (user, binder, card, foil, condition, language).
  quantity: 2, foil: 'normal', condition: 'HP', language: 'en', starred: false, date_added: FIXTURE_DATE,
})
if (staleCardInsert.error) throw staleCardInsert.error
usedVariants.add([claimOne.library_cards.scryfall_id, 'normal', 'HP', 'en'].join('|'))
const staleListingInsert = await service.from('listings').insert({
  id: staleListingId, user_id: seller.id, library_card_id: staleCardId, multiplier: 2.5, quantity: 2,
  status: 'active', created_at: FIXTURE_DATE, expires_at: FAR_FUTURE, claim_sale_id: claimSale.id,
})
if (staleListingInsert.error) throw staleListingInsert.error

const singleCardId = uuid()
const singleListingId = uuid()
await service.from('library_cards').insert({
  id: singleCardId, user_id: seller.id, binder_id: binderId, scryfall_id: claimOne.library_cards.scryfall_id,
  quantity: 3, foil: 'normal', condition: 'LP', language: 'en', starred: false, date_added: FIXTURE_DATE,
})
usedVariants.add([claimOne.library_cards.scryfall_id, 'normal', 'LP', 'en'].join('|'))
await service.from('listings').insert({
  id: singleListingId, user_id: seller.id, library_card_id: singleCardId, multiplier: 2.5, quantity: 3,
  status: 'active', created_at: FIXTURE_DATE, expires_at: FAR_FUTURE, claim_sale_id: null,
})

const danBinder = await service.from('binders').select('id').eq('user_id', dan.id).limit(1).maybeSingle()
expect(danBinder.data?.id, 'unrelated buyer binder missing for ownership fixture')
const victimCardId = uuid()
const victimCardInsert = await service.from('library_cards').insert({
  id: victimCardId, user_id: dan.id, binder_id: danBinder.data.id, scryfall_id: claimTwo.library_cards.scryfall_id,
  // Dan's deterministic seed already owns the etched/NM and foil/LP variants
  // for this catalog card; use a distinct identity for the victim fixture.
  quantity: 2, foil: 'etched', condition: 'HP', language: 'en', starred: false, date_added: FIXTURE_DATE,
})
if (victimCardInsert.error) throw victimCardInsert.error
const beforeRetarget = await service.from('marketplace_card_reservations').select('library_card_id,source_id,reserved_quantity').eq('source_id', singleListingId)
if (beforeRetarget.error) throw beforeRetarget.error
const retargetCardId = uuid()
const retargetCardInsert = await service.from('library_cards').insert({
  id: retargetCardId, user_id: seller.id, binder_id: binderId, scryfall_id: claimTwo.library_cards.scryfall_id,
  quantity: 4, foil: 'etched', condition: 'HP', language: 'en', starred: false, date_added: FIXTURE_DATE,
})
if (retargetCardInsert.error) throw retargetCardInsert.error
let sameOwnerRetarget = await service.from('listings').update({ library_card_id: retargetCardId, quantity: 4 }).eq('id', singleListingId)
if (sameOwnerRetarget.error) throw sameOwnerRetarget.error
let retargetReservation = await service.from('marketplace_card_reservations').select('library_card_id,reserved_quantity').eq('source_id', singleListingId)
if (retargetReservation.error) throw retargetReservation.error
expectEqual(retargetReservation.data.length, 1, 'same-owner retarget left duplicate reservations')
expectEqual(retargetReservation.data[0].library_card_id, retargetCardId, 'retarget reservation kept old card key')
expectEqual(retargetReservation.data[0].reserved_quantity, 4, 'retarget reservation quantity drifted')
sameOwnerRetarget = await service.from('listings').update({ library_card_id: singleCardId, quantity: 3 }).eq('id', singleListingId)
if (sameOwnerRetarget.error) throw sameOwnerRetarget.error
const maliciousRetarget = await service.from('listings').update({ library_card_id: victimCardId }).eq('id', singleListingId)
expect(Boolean(maliciousRetarget.error), 'cross-owner listing retarget was accepted')
const afterRetarget = await service.from('listings').select('library_card_id,user_id').eq('id', singleListingId).single()
if (afterRetarget.error) throw afterRetarget.error
expectEqual(afterRetarget.data.library_card_id, singleCardId, 'victim retarget changed listing key')
const victimAfterRetarget = await service.from('library_cards').select('quantity').eq('id', victimCardId).single()
if (victimAfterRetarget.error) throw victimAfterRetarget.error
expectEqual(victimAfterRetarget.data.quantity, 2, 'victim inventory changed on malicious retarget')
const afterRetargetReservations = await service.from('marketplace_card_reservations').select('library_card_id,source_id,reserved_quantity').eq('source_id', singleListingId)
if (afterRetargetReservations.error) throw afterRetargetReservations.error
expectEqual(JSON.stringify(afterRetargetReservations.data), JSON.stringify(beforeRetarget.data), 'malicious retarget changed reservation')
pass('cross-owner listing retarget is rejected without victim or reservation mutation')

// Authenticated direct stock attacks must be denied by RLS/ownership guards,
// not merely by the service-role harness. Keep before/after rows explicit so a
// silent zero-row UPDATE cannot be mistaken for authorization evidence.
const danDirect = await directAuthClient(DAN_EMAIL)
const beforeAttackListing = await service.from('listings').select('id,user_id,library_card_id,quantity').eq('id', singleListingId).single()
const beforeAttackReservations = await service.from('marketplace_card_reservations').select('library_card_id,source_id,reserved_quantity').eq('source_id', singleListingId)
const directInsertAttack = await danDirect.from('listings').insert({
  id: uuid(), user_id: dan.id, library_card_id: singleCardId, multiplier: 2.5, quantity: 1,
  status: 'active', expires_at: FAR_FUTURE, claim_sale_id: null,
})
expect(Boolean(directInsertAttack.error), 'authenticated cross-owner listing insert was accepted')
const directUpdateAttack = await danDirect.from('listings').update({ library_card_id: victimCardId, quantity: 1 }).eq('id', singleListingId)
expect(!directUpdateAttack.error, 'authenticated cross-owner update returned unexpected transport error')
const afterAttackListing = await service.from('listings').select('id,user_id,library_card_id,quantity').eq('id', singleListingId).single()
const afterAttackReservations = await service.from('marketplace_card_reservations').select('library_card_id,source_id,reserved_quantity').eq('source_id', singleListingId)
expectEqual(JSON.stringify(afterAttackListing.data), JSON.stringify(beforeAttackListing.data), 'authenticated attack changed victim listing')
expectEqual(JSON.stringify(afterAttackReservations.data), JSON.stringify(beforeAttackReservations.data), 'authenticated attack changed victim reservation')
pass('authenticated direct insert/update attacks leave victim listing and reservation unchanged')

// Claim Sale parents are presentation containers. Direct authenticated parent
// DML must be closed for both an owner's own sale (privilege boundary) and a
// victim's sale (privilege plus RLS boundary); lifecycle RPCs remain the only
// state-transition path.
const ownClaimSaleId = uuid()
const ownClaimInsert = await service.from('claim_sales').insert({
  id: ownClaimSaleId, user_id: dan.id, title: '45C own parent privilege fixture',
  description: 'Disposable test', set_code: 'uat', duration_hours: 24,
  expires_at: FAR_FUTURE, status: 'active', delivery_option: 'pickup',
  created_at: '2026-07-27T00:00:00.000Z',
})
if (ownClaimInsert.error) throw ownClaimInsert.error
const victimClaimBefore = await service.from('claim_sales').select('id,status,user_id').eq('id', claimSale.id).single()
const victimClaimListingsBefore = await service.from('listings').select('id,status,claim_sale_id').eq('claim_sale_id', claimSale.id)
const victimClaimReservationsBefore = await service.from('marketplace_card_reservations').select('source_id,library_card_id,reserved_quantity').in('source_id', (victimClaimListingsBefore.data || []).map(row => row.id))
const ownClaimBefore = await service.from('claim_sales').select('id,status,user_id').eq('id', ownClaimSaleId).single()
if (victimClaimBefore.error || victimClaimListingsBefore.error || victimClaimReservationsBefore.error || ownClaimBefore.error) {
  throw victimClaimBefore.error || victimClaimListingsBefore.error || victimClaimReservationsBefore.error || ownClaimBefore.error
}
const claimSaleDirectAttempts = [
  ['victim status update', danDirect.from('claim_sales').update({ status: 'cancelled' }).eq('id', claimSale.id)],
  ['victim delete', danDirect.from('claim_sales').delete().eq('id', claimSale.id)],
  ['own status update', danDirect.from('claim_sales').update({ status: 'cancelled' }).eq('id', ownClaimSaleId)],
  ['own delete', danDirect.from('claim_sales').delete().eq('id', ownClaimSaleId)],
]
for (const [label, attempt] of claimSaleDirectAttempts) {
  const result = await attempt
  expect(Boolean(result.error), `authenticated Claim Sale ${label} was accepted`)
}
const victimClaimAfter = await service.from('claim_sales').select('id,status,user_id').eq('id', claimSale.id).single()
const victimClaimListingsAfter = await service.from('listings').select('id,status,claim_sale_id').eq('claim_sale_id', claimSale.id)
const victimClaimReservationsAfter = await service.from('marketplace_card_reservations').select('source_id,library_card_id,reserved_quantity').in('source_id', (victimClaimListingsBefore.data || []).map(row => row.id))
const ownClaimAfter = await service.from('claim_sales').select('id,status,user_id').eq('id', ownClaimSaleId).single()
if (victimClaimAfter.error || victimClaimListingsAfter.error || victimClaimReservationsAfter.error || ownClaimAfter.error) {
  throw victimClaimAfter.error || victimClaimListingsAfter.error || victimClaimReservationsAfter.error || ownClaimAfter.error
}
expectEqual(JSON.stringify(victimClaimAfter.data), JSON.stringify(victimClaimBefore.data), 'authenticated Claim Sale attack changed victim parent')
expectEqual(JSON.stringify(victimClaimListingsAfter.data), JSON.stringify(victimClaimListingsBefore.data), 'authenticated Claim Sale attack changed victim listings')
expectEqual(JSON.stringify(victimClaimReservationsAfter.data), JSON.stringify(victimClaimReservationsBefore.data), 'authenticated Claim Sale attack changed victim reservations')
expectEqual(JSON.stringify(ownClaimAfter.data), JSON.stringify(ownClaimBefore.data), 'authenticated Claim Sale attack changed own parent')
const ownClaimCleanup = await service.from('claim_sales').delete().eq('id', ownClaimSaleId)
if (ownClaimCleanup.error) throw ownClaimCleanup.error
await assertRowAbsent('claim_sales', 'id', ownClaimSaleId, 'own Claim Sale privilege fixture cleanup')
pass('authenticated Claim Sale parent DML is denied without changing parent, listings, or reservations')

const cancelSaleId = await makeClaimSale('cancellation race fixture')
const cancelCardId = await makeCard('cancellation race', 2, 1)
const cancelListingId = await makeListing('cancellation race', { cardId: cancelCardId, quantity: 2, claimSaleId: cancelSaleId })

const danSession = await authSession(DAN_EMAIL)
const secondSession = await authSession(BUYER_TWO_EMAIL)
const sellerSession = await authSession(SELLER_EMAIL)
const empty = await request(danSession, '/api/cart')
expectEqual(empty.response.status, 200, 'authenticated empty cart')
expectEqual(empty.data.items?.length, 0, 'fixture starts with empty cart')
pass('authenticated cart read')

let added = await request(danSession, '/api/cart', { method: 'POST', body: JSON.stringify({ listing_id: claimOne.id, quantity: 2 }) })
expectEqual(added.response.status, 201, 'Claim Sale card add')
let cart = await request(danSession, '/api/cart')
expectEqual(cart.response.status, 200, 'Claim Sale cart read')
let firstItem = cart.data.items.find(item => item.listing_id === claimOne.id)
expect(firstItem?.claim_sale?.id === claimSale.id, 'Claim Sale context missing from cart')
expectEqual(firstItem.requested_quantity, 2, 'multi-quantity Claim Sale cart add')
pass('Claim Sale card is independently cartable with quantity')

const duplicate = await request(danSession, '/api/cart', { method: 'POST', body: JSON.stringify({ listing_id: claimOne.id, quantity: 1 }) })
expectEqual(duplicate.response.status, 200, 'duplicate Claim Sale add response')
expectEqual(duplicate.data.code, 'ALREADY_IN_CART', 'duplicate Claim Sale add code')
pass('duplicate add is idempotent and does not inflate quantity')

let patch = await request(danSession, `/api/cart/${firstItem.id}`, { method: 'PATCH', body: JSON.stringify({ quantity: 3, expected_version: firstItem.cart_version }) })
expectEqual(patch.response.status, 200, 'quantity update')
const stalePatch = await request(danSession, `/api/cart/${firstItem.id}`, { method: 'PATCH', body: JSON.stringify({ quantity: 2, expected_version: firstItem.cart_version }) })
expectEqual(stalePatch.response.status, 409, 'stale quantity update')
expectEqual(stalePatch.data.code, 'CART_ITEM_CHANGED', 'stale quantity update code')
pass('quantity update is compare-and-set and stale writes fail')

patch = await request(danSession, `/api/cart/${firstItem.id}`, { method: 'PATCH', body: JSON.stringify({ quantity: 2, expected_version: patch.data.item.version }) })
expectEqual(patch.response.status, 200, 'quantity correction')
added = await request(danSession, '/api/cart', { method: 'POST', body: JSON.stringify({ listing_id: claimTwo.id, quantity: 1 }) })
expectEqual(added.response.status, 201, 'second Claim Sale card add')
cart = await request(danSession, '/api/cart')
expectEqual(cart.data.items.length, 2, 'combined Claim Sale cart')
expect(cart.data.items.every(item => item.claim_sale?.id === claimSale.id), 'combined cart lost Claim Sale context')
pass('multiple cards from one Claim Sale combine in one cart')

const locations = await request(danSession, '/api/checkout')
expectEqual(locations.response.status, 200, 'pickup locations')
const pickup = locations.data.locations?.[0]?.id
expect(pickup, 'no pickup location for checkout')
const checkoutBody = checkoutBodyFor(cart.data.items.map(item => ({ cart_item_id: item.id, quantity: item.requested_quantity })), pickup)
let checkout = await checkoutRequest(danSession, checkoutBody)
expectEqual(checkout.response.status, 201, `bundled checkout: ${JSON.stringify({ response: checkout.data, cart: cart.data, body: checkoutBody })}`)
expectEqual(checkout.data.orders?.[0]?.order_items?.length, 2, 'bundled checkout order item count')
expect(checkout.data.orders[0].order_items.every(item => item.quantity >= 1), 'bundled checkout quantities missing')
const replay = await checkoutRequest(danSession, checkoutBody)
expect([200, 201].includes(replay.response.status), 'checkout replay response: ' + replay.response.status)
expectEqual(replay.data.idempotent_replay, true, 'checkout replay marker')
pass('bundled checkout is atomic, quantity-aware, and idempotent')

added = await request(danSession, '/api/cart', { method: 'POST', body: JSON.stringify({ listing_id: staleListingId, quantity: 2 }) })
expectEqual(added.response.status, 201, 'stale-cart fixture add')
await service.from('listings').update({ quantity: 1 }).eq('id', staleListingId)
cart = await request(danSession, '/api/cart')
const reduced = cart.data.items.find(item => item.listing_id === staleListingId)
expectEqual(reduced.availability_state, 'reduced', 'reduced cart state')
expectEqual(reduced.is_available, false, 'reduced cart eligibility')
pass('stale/reduced cart state is explicit and not checkout-eligible')
const repaired = await request(danSession, `/api/cart/${reduced.id}`, {
  method: 'PATCH', body: JSON.stringify({ quantity: 1, expected_version: reduced.cart_version }),
})
expectEqual(repaired.response.status, 200, 'Update to available succeeds')
expectEqual(repaired.data.item.quantity, 1, 'Update response carries new requested quantity')
expectEqual(repaired.data.available_quantity, 1, 'Update response carries current available quantity')
cart = await request(danSession, '/api/cart')
const repairedLine = cart.data.items.find(item => item.listing_id === staleListingId)
expectEqual(repairedLine.availability_state, 'available', 'updated stale line becomes available')
expectEqual(repairedLine.is_available, true, 'updated stale line becomes checkout eligible')
expectEqual(repairedLine.line_myr, Math.round(repairedLine.unit_myr * 100) / 100, 'updated stale line total is recomputed')
pass('Update to available resolves quantity, availability, line total, and checkout eligibility')
await deleteCartItemChecked(danSession, reduced.id, 'stale-cart fixture')
await service.from('listings').update({ quantity: 3 }).eq('id', claimOne.id)

added = await request(danSession, '/api/cart', { method: 'POST', body: JSON.stringify({ listing_id: singleListingId, quantity: 2 }) })
expectEqual(added.response.status, 201, 'Singles add')
const singleCart = await request(danSession, '/api/cart')
const singleItem = singleCart.data.items.find(item => item.listing_id === singleListingId)
expect(singleItem && !singleItem.claim_sale, 'Singles line incorrectly has Claim Sale context')
const singleDuplicate = await request(danSession, '/api/cart', { method: 'POST', body: JSON.stringify({ listing_id: singleListingId, quantity: 1 }) })
expectEqual(singleDuplicate.data.code, 'ALREADY_IN_CART', 'Singles duplicate add parity')
pass('Singles use the same quantity-aware cart path')
await deleteCartItemChecked(danSession, singleItem.id, 'Singles parity fixture')

const cancelItem = await addToCartChecked(danSession, cancelListingId, 1, 'Claim Sale cancellation fixture')
const cancelResult = await service.rpc('phase45c_cancel_claim_sale', { p_claim_sale_id: cancelSaleId, p_actor_id: seller.id })
if (cancelResult.error) throw cancelResult.error
const cancelCart = await request(danSession, '/api/cart')
const cancelLine = cancelCart.data.items.find(item => item.listing_id === cancelListingId)
expectEqual(cancelLine.availability_state, 'claim_sale_ended', 'cancelled Claim Sale cart state')
const cancelCheckout = await checkoutRequest(danSession, checkoutBodyFor([{ cart_item_id: cancelItem.id, quantity: 1 }], pickup))
expectEqual(cancelCheckout.response.status, 409, 'cancelled Claim Sale checkout rejection')
expectSafeBody('cancelled Claim Sale checkout', cancelCheckout.data)
pass('Claim Sale cancellation makes linked cards unavailable to checkout')
await deleteCartItemChecked(danSession, cancelItem.id, 'cancelled Claim Sale cleanup')

// Natural expiry must clean both a standalone Single and a still-active Claim
// Sale parent even when no buyer reads a cart first.
const sweepSingleCardId = await makeCard('natural expiry single', 1, 0)
const sweepClaimCardId = await makeCard('natural expiry claim', 1, 1)
const sweepClaimId = await makeClaimSale('natural expiry fixture')
const sweepSingleListingId = await makeListing('natural expiry single', { cardId: sweepSingleCardId, quantity: 1 })
const sweepClaimListingId = await makeListing('natural expiry claim', { cardId: sweepClaimCardId, quantity: 1, claimSaleId: sweepClaimId })
await serviceUpdateChecked('listings', sweepSingleListingId, { expires_at: PAST }, 'natural expiry single')
await serviceUpdateChecked('claim_sales', sweepClaimId, { expires_at: PAST }, 'natural expiry claim')
const sweep = await service.rpc('phase45c_reconcile_expired_listings', { p_limit: 200 })
if (sweep.error) throw sweep.error
const [sweepSingles, sweepClaim, sweepReservations] = await Promise.all([
  service.from('listings').select('status').in('id', [sweepSingleListingId, sweepClaimListingId]),
  service.from('claim_sales').select('status').eq('id', sweepClaimId).single(),
  service.from('marketplace_card_reservations').select('source_id').in('source_id', [sweepSingleListingId, sweepClaimListingId]),
])
if (sweepSingles.error || sweepClaim.error || sweepReservations.error) throw sweepSingles.error || sweepClaim.error || sweepReservations.error
expect(sweepSingles.data.every(row => row.status === 'expired'), 'natural expiry did not expire Singles and Claim Sale listing')
expectEqual(sweepClaim.data.status, 'expired', 'natural Claim Sale expiry persisted parent state')
expectEqual(sweepReservations.data.length, 0, 'natural expiry left listing reservations')
pass('hourly expiry RPC cleans natural Singles and Claim Sale commitments')

const buyerIds = [dan.id, buyerTwo.id]

// ---------------------------------------------------------------------------
// Barrier-backed overlap matrix.  Every case below holds the contended listing
// rows in a separate session, starts its participants only after the explicit
// BARRIER_ACQUIRED sentinel, proves contention by observing ungranted locks,
// releases deterministically, and ends in the shared invariant sweep.
// ---------------------------------------------------------------------------

// Held listing versus the expiry sweep: the sweep's Claim Sale path takes child
// listings before the parent, so it must block on the barrier rather than
// deadlock against it.
const heldExpirySaleId = await makeClaimSale('forced overlap expiry')
const heldExpiryCardId = await makeCard('forced overlap expiry', 1, 1)
const heldExpiryListingId = await makeListing('forced overlap expiry', { cardId: heldExpiryCardId, quantity: 1, claimSaleId: heldExpirySaleId })
await serviceUpdateChecked('claim_sales', heldExpirySaleId, { expires_at: PAST }, 'forced overlap expiry')
const heldExpiryListings = [heldExpiryListingId]
const [heldExpirySweep] = await runHeldListingOverlap(heldExpiryListings, OVERLAP_CASES.heldExpirySweep, () => [
  (async () => service.rpc('phase45c_reconcile_expired_listings', { p_limit: 200 }))(),
])
if (heldExpirySweep.error) throw heldExpirySweep.error
const heldExpiryParent = await service.from('claim_sales').select('status').eq('id', heldExpirySaleId).single()
if (heldExpiryParent.error) throw heldExpiryParent.error
expectEqual(heldExpiryParent.data.status, 'expired', 'forced-overlap parent was not expired')
await assertPostRaceInvariants(OVERLAP_CASES.heldExpirySweep, {
  listings: [{ id: heldExpiryListingId, initialQuantity: 1, expectedAccepted: 0, expectedQuantity: 1, expectedStatus: ['expired'], expectNoReservation: true }],
  carts: [{ session: danSession, label: 'buyer A', expectListingIds: [] }],
  buyerIds,
})
pass('barrier-backed expiry sweep waits on the held child listing and preserves lifecycle invariants')

// Claim Sale cancellation versus checkout on the same child listing.
await emptyCartChecked(danSession, OVERLAP_CASES.claimCancelCheckout)
const cancelOverlapSaleId = await makeClaimSale('cancel checkout overlap')
const cancelOverlapCardId = await makeCard('cancel checkout overlap', 1, 1)
const cancelOverlapListingId = await makeListing('cancel checkout overlap', { cardId: cancelOverlapCardId, quantity: 1, claimSaleId: cancelOverlapSaleId })
const cancelOverlapItem = await addToCartChecked(danSession, cancelOverlapListingId, 1, OVERLAP_CASES.claimCancelCheckout)
const cancelOverlapListings = [cancelOverlapListingId]
const [cancelOverlapCheckout, cancelOverlapCancel] = await runHeldListingOverlap(
  cancelOverlapListings,
  OVERLAP_CASES.claimCancelCheckout,
  () => [
    checkoutRequest(danSession, checkoutBodyFor([{ cart_item_id: cancelOverlapItem.id, quantity: 1 }], pickup)),
    request(sellerSession, `/api/claim-sales/${cancelOverlapSaleId}/cancel`, { method: 'POST' }),
  ],
)
expect([201, 409].includes(cancelOverlapCheckout.response.status), `cancel/checkout checkout result: ${cancelOverlapCheckout.response.status}`)
expect([200, 409].includes(cancelOverlapCancel.response.status), `cancel/checkout cancellation result: ${cancelOverlapCancel.response.status}`)
expectSafeBody('cancel/checkout checkout', cancelOverlapCheckout.data)
expectSafeBody('cancel/checkout cancellation', cancelOverlapCancel.data)
const cancelOverlapAccepted = cancelOverlapCheckout.response.status === 201 ? 1 : 0
const cancelOverlapState = await service.from('claim_sales').select('status').eq('id', cancelOverlapSaleId).single()
if (cancelOverlapState.error) throw cancelOverlapState.error
expectEqual(cancelOverlapState.data.status, 'cancelled', 'Claim Sale cancellation/checkout overlap parent state')
await assertPostRaceInvariants(OVERLAP_CASES.claimCancelCheckout, {
  listings: [{
    id: cancelOverlapListingId, initialQuantity: 1, expectedAccepted: cancelOverlapAccepted,
    expectedStatus: ['expired'], expectNoReservation: true,
  }],
  carts: [{ session: danSession, label: 'buyer A', expectListingIds: cancelOverlapAccepted ? [] : [cancelOverlapListingId] }],
  buyerIds,
})
pass('barrier-backed Claim Sale cancellation versus checkout completes without deadlock')
await emptyCartChecked(danSession, `${OVERLAP_CASES.claimCancelCheckout} cleanup`)

// A second buyer adding the remaining unit races the first buyer's checkout.
await emptyCartChecked(secondSession, OVERLAP_CASES.cartAddCheckout)
const addCheckoutCardId = await makeCard('cart add versus checkout', 2, 0)
const addCheckoutListingId = await makeListing('cart add versus checkout', { cardId: addCheckoutCardId, quantity: 2 })
const addCheckoutItemA = await addToCartChecked(danSession, addCheckoutListingId, 1, OVERLAP_CASES.cartAddCheckout)
const addCheckoutListings = [addCheckoutListingId]
const [addCheckoutAddB, addCheckoutCheckout] = await runHeldListingOverlap(
  addCheckoutListings,
  OVERLAP_CASES.cartAddCheckout,
  () => [
    request(secondSession, '/api/cart', { method: 'POST', body: JSON.stringify({ listing_id: addCheckoutListingId, quantity: 1 }) }),
    checkoutRequest(danSession, checkoutBodyFor([{ cart_item_id: addCheckoutItemA.id, quantity: 1 }], pickup)),
  ],
)
expect([201, 200].includes(addCheckoutAddB.response.status), `cart add/checkout add result: ${addCheckoutAddB.response.status}`)
expectEqual(addCheckoutCheckout.response.status, 201, `cart add/checkout checkout result: ${JSON.stringify(addCheckoutCheckout.data)}`)
expectSafeBody('cart add/checkout add', addCheckoutAddB.data)
await assertPostRaceInvariants(OVERLAP_CASES.cartAddCheckout, {
  listings: [{ id: addCheckoutListingId, initialQuantity: 2, expectedAccepted: 1, expectedStatus: ['active'] }],
  carts: [
    { session: danSession, label: 'buyer A', expectListingIds: [] },
    { session: secondSession, label: 'buyer B', expectListingIds: [addCheckoutListingId] },
  ],
  buyerIds,
})
pass('barrier-backed cart add versus checkout preserves remaining stock and the second cart')
await emptyCartChecked(secondSession, `${OVERLAP_CASES.cartAddCheckout} cleanup`)

// Checkout versus seller-driven order cancellation on the same listing.
const orderCancelCardId = await makeCard('checkout versus order cancellation', 2, 1)
const orderCancelListingId = await makeListing('checkout versus order cancellation', { cardId: orderCancelCardId, quantity: 2 })
const orderCancelSeedItem = await addToCartChecked(danSession, orderCancelListingId, 1, `${OVERLAP_CASES.orderCancelCheckout} seed`)
const orderCancelSeed = await checkoutRequest(danSession, checkoutBodyFor([{ cart_item_id: orderCancelSeedItem.id, quantity: 1 }], pickup))
expectEqual(orderCancelSeed.response.status, 201, `order cancellation overlap seed checkout: ${JSON.stringify(orderCancelSeed.data)}`)
const orderCancelOrderId = orderCancelSeed.data.orders?.[0]?.id
expect(orderCancelOrderId, 'order cancellation overlap order id missing')
const orderCancelItemB = await addToCartChecked(secondSession, orderCancelListingId, 1, OVERLAP_CASES.orderCancelCheckout)
const orderCancelListings = [orderCancelListingId]
const [orderCancelCheckout, orderCancelCancel] = await runHeldListingOverlap(
  orderCancelListings,
  OVERLAP_CASES.orderCancelCheckout,
  () => [
    checkoutRequest(secondSession, checkoutBodyFor([{ cart_item_id: orderCancelItemB.id, quantity: 1 }], pickup)),
    request(sellerSession, `/api/orders/${orderCancelOrderId}/transition`, { method: 'POST', body: JSON.stringify({ action: 'cancel', reason: '45C overlap test' }) }),
  ],
)
expect([201, 409].includes(orderCancelCheckout.response.status), `order cancellation/checkout checkout result: ${orderCancelCheckout.response.status}`)
expect([200, 409].includes(orderCancelCancel.response.status), `order cancellation/checkout cancellation result: ${orderCancelCancel.response.status}`)
expectSafeBody('order cancellation/checkout checkout', orderCancelCheckout.data)
expectSafeBody('order cancellation/checkout cancellation', orderCancelCancel.data)
const orderCancelAccepted = orderCancelCheckout.response.status === 201 ? 1 : 0
await assertPostRaceInvariants(OVERLAP_CASES.orderCancelCheckout, {
  listings: [{ id: orderCancelListingId, initialQuantity: 2, expectedAccepted: orderCancelAccepted, expectedStatus: ['active', 'reserved'] }],
  orders: [{ id: orderCancelOrderId, expectedStatus: 'cancelled', expectedItems: 1, expectedUnits: 1 }],
  carts: [
    { session: danSession, label: 'buyer A', expectListingIds: [] },
    { session: secondSession, label: 'buyer B', expectListingIds: orderCancelAccepted ? [] : [orderCancelListingId] },
  ],
  buyerIds,
})
pass('barrier-backed checkout versus order cancellation completes and restores exact stock')
await emptyCartChecked(secondSession, `${OVERLAP_CASES.orderCancelCheckout} cleanup`)

function expectStockConflict(label, result) {
  expectEqual(result.response.status, 409, `${label}: losing checkout status ${JSON.stringify(result.data)}`)
  expectSafeBody(label, result.data)
  const isStock = ['INSUFFICIENT_STOCK', 'LISTING_UNAVAILABLE'].includes(result.data?.code) || Array.isArray(result.data?.conflicts)
  expect(isStock, `${label}: losing checkout is not a stock conflict: ${JSON.stringify(result.data)}`)
}

function racePair(label, first, second) {
  const results = [first, second]
  for (const result of results) expectSafeBody(label, result.data)
  const winners = results.filter(result => result.response.status === 201)
  const losers = results.filter(result => result.response.status !== 201)
  return { winners, losers }
}

// Case 1 — the final unit, two buyers, both fully in flight behind the barrier.
await emptyCartChecked(danSession, OVERLAP_CASES.finalUnit)
await emptyCartChecked(secondSession, OVERLAP_CASES.finalUnit)
const finalUnitCardId = await makeCard('final unit', 1, 0)
const finalUnitListingId = await makeListing('final unit', { cardId: finalUnitCardId, quantity: 1 })
const finalUnitItemA = await addToCartChecked(danSession, finalUnitListingId, 1, `${OVERLAP_CASES.finalUnit} buyer A`)
const finalUnitItemB = await addToCartChecked(secondSession, finalUnitListingId, 1, `${OVERLAP_CASES.finalUnit} buyer B`)
const finalUnitListings = [finalUnitListingId]
const [finalUnitA, finalUnitB] = await runHeldListingOverlap(finalUnitListings, OVERLAP_CASES.finalUnit, () => [
  checkoutRequest(danSession, checkoutBodyFor([{ cart_item_id: finalUnitItemA.id, quantity: 1 }], pickup)),
  checkoutRequest(secondSession, checkoutBodyFor([{ cart_item_id: finalUnitItemB.id, quantity: 1 }], pickup)),
])
const finalUnitRace = racePair(OVERLAP_CASES.finalUnit, finalUnitA, finalUnitB)
expectEqual(finalUnitRace.winners.length, 1, `${OVERLAP_CASES.finalUnit}: winner count`)
expectStockConflict(OVERLAP_CASES.finalUnit, finalUnitRace.losers[0])
await assertPostRaceInvariants(OVERLAP_CASES.finalUnit, {
  listings: [{ id: finalUnitListingId, initialQuantity: 1, expectedAccepted: 1, expectedStatus: ['reserved'] }],
  carts: [
    { session: danSession, label: 'buyer A', expectListingIds: finalUnitA.response.status === 201 ? [] : [finalUnitListingId] },
    { session: secondSession, label: 'buyer B', expectListingIds: finalUnitB.response.status === 201 ? [] : [finalUnitListingId] },
  ],
  buyerIds,
})
pass('case 1: two buyers cannot oversell the final unit under a real barrier')
await emptyCartChecked(danSession, `${OVERLAP_CASES.finalUnit} cleanup`)
await emptyCartChecked(secondSession, `${OVERLAP_CASES.finalUnit} cleanup`)

// Case 2 — over-demand: stock 3, two buyers requesting 2 each.
const overDemandCardId = await makeCard('over demand', 3, 1)
const overDemandListingId = await makeListing('over demand', { cardId: overDemandCardId, quantity: 3 })
const overDemandItemA = await addToCartChecked(danSession, overDemandListingId, 2, `${OVERLAP_CASES.overDemand} buyer A`)
const overDemandItemB = await addToCartChecked(secondSession, overDemandListingId, 2, `${OVERLAP_CASES.overDemand} buyer B`)
const overDemandListings = [overDemandListingId]
const [overDemandA, overDemandB] = await runHeldListingOverlap(overDemandListings, OVERLAP_CASES.overDemand, () => [
  checkoutRequest(danSession, checkoutBodyFor([{ cart_item_id: overDemandItemA.id, quantity: 2 }], pickup)),
  checkoutRequest(secondSession, checkoutBodyFor([{ cart_item_id: overDemandItemB.id, quantity: 2 }], pickup)),
])
const overDemandRace = racePair(OVERLAP_CASES.overDemand, overDemandA, overDemandB)
expectEqual(overDemandRace.winners.length, 1, `${OVERLAP_CASES.overDemand}: winner count`)
expectStockConflict(OVERLAP_CASES.overDemand, overDemandRace.losers[0])
await assertPostRaceInvariants(OVERLAP_CASES.overDemand, {
  listings: [{ id: overDemandListingId, initialQuantity: 3, expectedAccepted: 2, expectedStatus: ['active'] }],
  carts: [
    { session: danSession, label: 'buyer A', expectListingIds: overDemandA.response.status === 201 ? [] : [overDemandListingId] },
    { session: secondSession, label: 'buyer B', expectListingIds: overDemandB.response.status === 201 ? [] : [overDemandListingId] },
  ],
  buyerIds,
})
pass('case 2: over-demand admits exactly one buyer and never oversells')
await emptyCartChecked(danSession, `${OVERLAP_CASES.overDemand} cleanup`)
await emptyCartChecked(secondSession, `${OVERLAP_CASES.overDemand} cleanup`)

// Case 3 — exact split: 2 + 3 against stock 5. Both buyers must succeed.
const exactSplitCardId = await makeCard('exact split', 5, 0)
const exactSplitListingId = await makeListing('exact split', { cardId: exactSplitCardId, quantity: 5 })
const exactSplitItemA = await addToCartChecked(danSession, exactSplitListingId, 2, `${OVERLAP_CASES.exactSplit} buyer A`)
const exactSplitItemB = await addToCartChecked(secondSession, exactSplitListingId, 3, `${OVERLAP_CASES.exactSplit} buyer B`)
const exactSplitListings = [exactSplitListingId]
const [exactSplitA, exactSplitB] = await runHeldListingOverlap(exactSplitListings, OVERLAP_CASES.exactSplit, () => [
  checkoutRequest(danSession, checkoutBodyFor([{ cart_item_id: exactSplitItemA.id, quantity: 2 }], pickup)),
  checkoutRequest(secondSession, checkoutBodyFor([{ cart_item_id: exactSplitItemB.id, quantity: 3 }], pickup)),
])
expectEqual(exactSplitA.response.status, 201, `${OVERLAP_CASES.exactSplit}: buyer A ${JSON.stringify(exactSplitA.data)}`)
expectEqual(exactSplitB.response.status, 201, `${OVERLAP_CASES.exactSplit}: buyer B ${JSON.stringify(exactSplitB.data)}`)
await assertPostRaceInvariants(OVERLAP_CASES.exactSplit, {
  listings: [{ id: exactSplitListingId, initialQuantity: 5, expectedAccepted: 5, expectedStatus: ['reserved'] }],
  carts: [
    { session: danSession, label: 'buyer A', expectListingIds: [] },
    { session: secondSession, label: 'buyer B', expectListingIds: [] },
  ],
  buyerIds,
})
pass('case 3: an exact split is never under-delivered')

// Case 4 — two shared listings submitted in opposite client order. The RPC
// normalises acquisition order, so neither buyer may deadlock.
await emptyCartChecked(danSession, OVERLAP_CASES.reverseOrder)
await emptyCartChecked(secondSession, OVERLAP_CASES.reverseOrder)
const reverseCardOne = await makeCard('reverse order one', 2, 0)
const reverseCardTwo = await makeCard('reverse order two', 2, 1)
const reverseListingOne = await makeListing('reverse order one', { cardId: reverseCardOne, quantity: 2 })
const reverseListingTwo = await makeListing('reverse order two', { cardId: reverseCardTwo, quantity: 2 })
const reverseOrdered = [reverseListingOne, reverseListingTwo].sort()
const reverseItemsA = []
const reverseItemsB = []
for (const listingId of reverseOrdered) {
  reverseItemsA.push(await addToCartChecked(danSession, listingId, 1, `${OVERLAP_CASES.reverseOrder} buyer A`))
  reverseItemsB.push(await addToCartChecked(secondSession, listingId, 1, `${OVERLAP_CASES.reverseOrder} buyer B`))
}
const reverseBodyA = checkoutBodyFor(reverseItemsA.map(item => ({ cart_item_id: item.id, quantity: 1 })), pickup)
const reverseBodyB = checkoutBodyFor([...reverseItemsB].reverse().map(item => ({ cart_item_id: item.id, quantity: 1 })), pickup)
const reverseListings = reverseOrdered
const [reverseA, reverseB] = await runHeldListingOverlap(reverseListings, OVERLAP_CASES.reverseOrder, () => [
  checkoutRequest(danSession, reverseBodyA),
  checkoutRequest(secondSession, reverseBodyB),
])
expectEqual(reverseA.response.status, 201, `${OVERLAP_CASES.reverseOrder}: buyer A ${JSON.stringify(reverseA.data)}`)
expectEqual(reverseB.response.status, 201, `${OVERLAP_CASES.reverseOrder}: buyer B ${JSON.stringify(reverseB.data)}`)
await assertPostRaceInvariants(OVERLAP_CASES.reverseOrder, {
  listings: reverseOrdered.map(id => ({ id, initialQuantity: 2, expectedAccepted: 2, expectedStatus: ['reserved'] })),
  carts: [
    { session: danSession, label: 'buyer A', expectListingIds: [] },
    { session: secondSession, label: 'buyer B', expectListingIds: [] },
  ],
  buyerIds,
})
pass('case 4: opposite client ordering over two shared listings completes without deadlock')

// Case 5 — concurrent identical replay. One order set, one replay marker.
await emptyCartChecked(danSession, OVERLAP_CASES.replayConcurrent)
const replayCardId = await makeCard('concurrent replay', 2, 0)
const replayListingId = await makeListing('concurrent replay', { cardId: replayCardId, quantity: 2 })
const replayItem = await addToCartChecked(danSession, replayListingId, 1, OVERLAP_CASES.replayConcurrent)
const replayKey = uuid()
const replayBody = checkoutBodyFor([{ cart_item_id: replayItem.id, quantity: 1 }], pickup, replayKey)
const replayListings = [replayListingId]
const [replayOne, replayTwo] = await runHeldListingOverlap(replayListings, OVERLAP_CASES.replayConcurrent, () => [
  checkoutRequest(danSession, replayBody),
  checkoutRequest(danSession, replayBody),
])
for (const result of [replayOne, replayTwo]) {
  expect([200, 201].includes(result.response.status), `${OVERLAP_CASES.replayConcurrent}: status ${result.response.status} ${JSON.stringify(result.data)}`)
  expectSafeBody(OVERLAP_CASES.replayConcurrent, result.data)
}
const replayIdsOne = (replayOne.data.orders || []).map(order => order.id).sort()
const replayIdsTwo = (replayTwo.data.orders || []).map(order => order.id).sort()
expect(replayIdsOne.length === 1, `${OVERLAP_CASES.replayConcurrent}: expected one order set`)
expectEqual(JSON.stringify(replayIdsOne), JSON.stringify(replayIdsTwo), `${OVERLAP_CASES.replayConcurrent}: concurrent replay returned different order sets`)
expectEqual([replayOne, replayTwo].filter(result => result.data.idempotent_replay === true).length, 1,
  `${OVERLAP_CASES.replayConcurrent}: exactly one response must be marked as a replay`)
await assertPostRaceInvariants(OVERLAP_CASES.replayConcurrent, {
  listings: [{ id: replayListingId, initialQuantity: 2, expectedAccepted: 1, expectedStatus: ['active'] }],
  orders: [{ id: replayIdsOne[0], expectedStatus: 'awaiting_payment', expectedItems: 1, expectedUnits: 1 }],
  carts: [{ session: danSession, label: 'buyer A', expectListingIds: [] }],
  buyerIds,
})
pass('case 5: concurrent identical replay yields exactly one order set')

// Case 6 — same key, changed payload. The cart snapshot must stay valid for
// both requests, so the pickup location is the only field free to differ.
await emptyCartChecked(danSession, OVERLAP_CASES.changedPayload)
const alternatePickupSlug = 'phase45c-disposable-alternate-pickup'
let alternatePickupCreated = false
let alternatePickup = null
const activePickups = await service.from('pickup_locations').select('id,slug').eq('active', true).order('slug', { ascending: true })
if (activePickups.error) throw activePickups.error
alternatePickup = (activePickups.data || []).find(row => row.id !== pickup)?.id || null
if (!alternatePickup) {
  alternatePickup = uuid()
  await serviceInsertChecked('pickup_locations', {
    id: alternatePickup, slug: alternatePickupSlug, name: '45C disposable alternate pickup',
    address: 'Disposable fixture address', operating_notes: 'Disposable Phase 45C fixture',
    active: true, is_default: false,
  }, 'changed payload alternate pickup')
  alternatePickupCreated = true
}
const changedCardId = await makeCard('changed payload', 2, 1)
const changedListingId = await makeListing('changed payload', { cardId: changedCardId, quantity: 2 })
const changedItem = await addToCartChecked(danSession, changedListingId, 1, OVERLAP_CASES.changedPayload)
const changedKey = uuid()
const changedItems = [{ cart_item_id: changedItem.id, quantity: 1 }]
const changedListings = [changedListingId]
const [changedOne, changedTwo] = await runHeldListingOverlap(changedListings, OVERLAP_CASES.changedPayload, () => [
  checkoutRequest(danSession, checkoutBodyFor(changedItems, pickup, changedKey)),
  checkoutRequest(danSession, checkoutBodyFor(changedItems, alternatePickup, changedKey)),
])
const changedRace = racePair(OVERLAP_CASES.changedPayload, changedOne, changedTwo)
expectEqual(changedRace.winners.length, 1, `${OVERLAP_CASES.changedPayload}: winner count ${JSON.stringify([changedOne.data, changedTwo.data])}`)
expectEqual(changedRace.losers[0].response.status, 409, `${OVERLAP_CASES.changedPayload}: loser status`)
expectEqual(changedRace.losers[0].data.code, 'IDEMPOTENCY_KEY_REUSED', `${OVERLAP_CASES.changedPayload}: loser code ${JSON.stringify(changedRace.losers[0].data)}`)
await assertPostRaceInvariants(OVERLAP_CASES.changedPayload, {
  listings: [{ id: changedListingId, initialQuantity: 2, expectedAccepted: 1, expectedStatus: ['active'] }],
  carts: [{ session: danSession, label: 'buyer A', expectListingIds: [] }],
  buyerIds,
})
pass('case 6: a reused idempotency key with a changed payload is rejected exactly once')

// Case 7a — checkout versus a seller quantity edit. protect_reserved_listing
// closes direct seller DML once a non-terminal order exists, so exactly one of
// the two may win.
await emptyCartChecked(danSession, OVERLAP_CASES.sellerEdit)
const sellerEditCardId = await makeCard('seller quantity edit', 3, 0)
const sellerEditListingId = await makeListing('seller quantity edit', { cardId: sellerEditCardId, quantity: 3 })
const sellerEditItem = await addToCartChecked(danSession, sellerEditListingId, 2, OVERLAP_CASES.sellerEdit)
const sellerEditListings = [sellerEditListingId]
const [sellerEditCheckout, sellerEditPatch] = await runHeldListingOverlap(sellerEditListings, OVERLAP_CASES.sellerEdit, () => [
  checkoutRequest(danSession, checkoutBodyFor([{ cart_item_id: sellerEditItem.id, quantity: 2 }], pickup)),
  request(sellerSession, `/api/listings/${sellerEditListingId}`, { method: 'PATCH', body: JSON.stringify({ quantity: 1 }) }),
])
expectSafeBody(`${OVERLAP_CASES.sellerEdit} checkout`, sellerEditCheckout.data)
expectSafeBody(`${OVERLAP_CASES.sellerEdit} edit`, sellerEditPatch.data)
const sellerEditCheckoutWon = sellerEditCheckout.response.status === 201
const sellerEditPatchWon = sellerEditPatch.response.status === 200
expect(sellerEditCheckoutWon !== sellerEditPatchWon, `${OVERLAP_CASES.sellerEdit}: expected exactly one winner, got checkout ${sellerEditCheckout.response.status} and edit ${sellerEditPatch.response.status}`)
if (!sellerEditPatchWon && sellerEditPatch.response.status >= 500) {
  note(`${OVERLAP_CASES.sellerEdit}: a losing seller quantity edit returns HTTP ${sellerEditPatch.response.status} (${sellerEditPatch.data?.code}); a concurrent lifecycle conflict should map to a stable 409. Owned by the safe-error slice, not by S4.`)
}
await assertPostRaceInvariants(OVERLAP_CASES.sellerEdit, {
  listings: [{
    id: sellerEditListingId, initialQuantity: 3, expectedAccepted: sellerEditCheckoutWon ? 2 : 0,
    expectedQuantity: 1, expectedStatus: ['active'],
  }],
  carts: [{ session: danSession, label: 'buyer A', expectListingIds: sellerEditCheckoutWon ? [] : [sellerEditListingId] }],
  buyerIds,
})
pass('case 7a: checkout versus a seller quantity edit resolves to exactly one winner')
await emptyCartChecked(danSession, `${OVERLAP_CASES.sellerEdit} cleanup`)

// Case 7b — checkout versus unlist. Winner is decided by whether the listing
// row survives, not by the DELETE route's optimistic success body.
const sellerUnlistCardId = await makeCard('seller unlist', 2, 1)
const sellerUnlistListingId = await makeListing('seller unlist', { cardId: sellerUnlistCardId, quantity: 2 })
const sellerUnlistItem = await addToCartChecked(danSession, sellerUnlistListingId, 1, OVERLAP_CASES.sellerUnlist)
const sellerUnlistListings = [sellerUnlistListingId]
const [sellerUnlistCheckout, sellerUnlistDelete] = await runHeldListingOverlap(sellerUnlistListings, OVERLAP_CASES.sellerUnlist, () => [
  checkoutRequest(danSession, checkoutBodyFor([{ cart_item_id: sellerUnlistItem.id, quantity: 1 }], pickup)),
  unlistListingRequest(sellerSession, sellerUnlistListingId),
])
expectSafeBody(`${OVERLAP_CASES.sellerUnlist} checkout`, sellerUnlistCheckout.data)
expectSafeBody(`${OVERLAP_CASES.sellerUnlist} unlist`, sellerUnlistDelete.data)
const sellerUnlistRow = await listingRow(sellerUnlistListingId)
const sellerUnlistCheckoutWon = sellerUnlistCheckout.response.status === 201
expect(sellerUnlistCheckoutWon !== !sellerUnlistRow, `${OVERLAP_CASES.sellerUnlist}: checkout ${sellerUnlistCheckout.response.status}, unlist ${sellerUnlistDelete.response.status}, listing ${sellerUnlistRow ? 'present' : 'deleted'}`)
if (!sellerUnlistCheckoutWon) expect([400, 409].includes(sellerUnlistCheckout.response.status), `${OVERLAP_CASES.sellerUnlist}: losing checkout status ${sellerUnlistCheckout.response.status}`)
if (sellerUnlistCheckoutWon && sellerUnlistDelete.response.status >= 500) {
  note(`${OVERLAP_CASES.sellerUnlist}: a losing unlist returns HTTP ${sellerUnlistDelete.response.status} (${sellerUnlistDelete.data?.code}); a concurrent lifecycle conflict should map to a stable 409. Owned by the safe-error slice, not by S4.`)
}
await assertPostRaceInvariants(OVERLAP_CASES.sellerUnlist, {
  listings: [sellerUnlistRow
    ? { id: sellerUnlistListingId, initialQuantity: 2, expectedAccepted: 1, expectedStatus: ['active'] }
    : { id: sellerUnlistListingId, expectDeleted: true }],
  carts: [{ session: danSession, label: 'buyer A', expectListingIds: [] }],
  buyerIds,
})
pass('case 7b: checkout versus unlist resolves to exactly one winner and leaves no stale reservation')

// Case 8a — an in-flight checkout racing natural Claim Sale expiry.
await emptyCartChecked(danSession, OVERLAP_CASES.claimExpiry)
const claimExpirySaleId = await makeClaimSale('checkout versus claim expiry')
const claimExpiryCardId = await makeCard('checkout versus claim expiry', 1, 0)
const claimExpiryListingId = await makeListing('checkout versus claim expiry', { cardId: claimExpiryCardId, quantity: 1, claimSaleId: claimExpirySaleId })
const claimExpiryItem = await addToCartChecked(danSession, claimExpiryListingId, 1, OVERLAP_CASES.claimExpiry)
await serviceUpdateChecked('claim_sales', claimExpirySaleId, { expires_at: PAST }, OVERLAP_CASES.claimExpiry)
const claimExpiryListings = [claimExpiryListingId]
const [claimExpiryCheckout, claimExpirySweep] = await runHeldListingOverlap(claimExpiryListings, OVERLAP_CASES.claimExpiry, () => [
  checkoutRequest(danSession, checkoutBodyFor([{ cart_item_id: claimExpiryItem.id, quantity: 1 }], pickup)),
  (async () => service.rpc('phase45c_reconcile_expired_listings', { p_limit: 200 }))(),
])
if (claimExpirySweep.error) throw claimExpirySweep.error
expectEqual(claimExpiryCheckout.response.status, 409, `${OVERLAP_CASES.claimExpiry}: checkout ${JSON.stringify(claimExpiryCheckout.data)}`)
expectSafeBody(OVERLAP_CASES.claimExpiry, claimExpiryCheckout.data)
const claimExpiryParent = await service.from('claim_sales').select('status').eq('id', claimExpirySaleId).single()
if (claimExpiryParent.error) throw claimExpiryParent.error
expectEqual(claimExpiryParent.data.status, 'expired', `${OVERLAP_CASES.claimExpiry}: parent state`)
await assertPostRaceInvariants(OVERLAP_CASES.claimExpiry, {
  listings: [{ id: claimExpiryListingId, initialQuantity: 1, expectedAccepted: 0, expectedStatus: ['expired'], expectNoReservation: true }],
  carts: [{ session: danSession, label: 'buyer A', expectListingIds: [claimExpiryListingId] }],
  buyerIds,
})
pass('case 8a: checkout versus Claim Sale expiry ends expired, uncharged, and deadlock-free')
await emptyCartChecked(danSession, `${OVERLAP_CASES.claimExpiry} cleanup`)

// Case 8b — the same race for a standalone Single, against a real lock edge.
// Expiring the listing before the race would retire the case: /api/checkout
// rejects an already-expired listing from its pre-lock cart read, so the
// checkout would never reach checkout_orders, and the sweep uses FOR UPDATE
// SKIP LOCKED and steps over a held row, leaving nothing behind the barrier for
// either participant to wait on. The expiry is therefore carried by the barrier
// transaction itself. The listing is still sellable when the route reads it, so
// the checkout reaches the RPC and blocks on the held listing row; the expiry
// becomes visible at the instant the barrier commits, so the checkout fails
// closed in its post-lock revalidation. The asserted RPC code is what proves
// the rejection came from behind the lock and not from the route pre-flight.
const singlesExpiryCardId = await makeCard('checkout versus singles expiry', 1, 1)
const singlesExpiryListingId = await makeListing('checkout versus singles expiry', { cardId: singlesExpiryCardId, quantity: 1 })
const singlesExpiryItem = await addToCartChecked(danSession, singlesExpiryListingId, 1, OVERLAP_CASES.singlesExpiry)
const singlesExpiryListings = [singlesExpiryListingId]
const [singlesExpiryCheckout, singlesExpirySweep] = await runHeldListingOverlap(singlesExpiryListings, OVERLAP_CASES.singlesExpiry, () => [
  checkoutRequest(danSession, checkoutBodyFor([{ cart_item_id: singlesExpiryItem.id, quantity: 1 }], pickup)),
  (async () => service.rpc('phase45c_reconcile_expired_listings', { p_limit: 200 }))(),
], { withinTransactionSql: `UPDATE public.listings SET expires_at = '${PAST}'::timestamptz WHERE id = '${singlesExpiryListingId}'::uuid;` })
if (singlesExpirySweep.error) throw singlesExpirySweep.error
expectEqual(singlesExpiryCheckout.response.status, 409, `${OVERLAP_CASES.singlesExpiry}: checkout ${JSON.stringify(singlesExpiryCheckout.data)}`)
expectSafeBody(OVERLAP_CASES.singlesExpiry, singlesExpiryCheckout.data)
expectEqual(singlesExpiryCheckout.data?.code, 'LISTING_UNAVAILABLE', `${OVERLAP_CASES.singlesExpiry}: checkout must fail closed in the locked revalidation, not in the route's pre-lock cart read: ${JSON.stringify(singlesExpiryCheckout.data)}`)
const singlesExpiryDuringRace = await listingRow(singlesExpiryListingId)
expect(new Date(singlesExpiryDuringRace.expires_at).getTime() <= Date.now(), `${OVERLAP_CASES.singlesExpiry}: the barrier did not commit the expiry it was asked to carry`)
if (singlesExpiryDuringRace.status !== 'expired') {
  note(`${OVERLAP_CASES.singlesExpiry}: the in-race Singles sweep could not act on the barrier-held listing — the expiry only becomes visible when the barrier commits, and FOR UPDATE SKIP LOCKED steps over a held row — so it stayed '${singlesExpiryDuringRace.status}' with a past expiry until the next sweep. Checkout still fails closed.`)
}
const singlesExpiryFollowUp = await service.rpc('phase45c_reconcile_expired_listings', { p_limit: 200 })
if (singlesExpiryFollowUp.error) throw singlesExpiryFollowUp.error
await assertPostRaceInvariants(OVERLAP_CASES.singlesExpiry, {
  listings: [{ id: singlesExpiryListingId, initialQuantity: 1, expectedAccepted: 0, expectedStatus: ['expired'], expectNoReservation: true }],
  carts: [{ session: danSession, label: 'buyer A', expectListingIds: [singlesExpiryListingId] }],
  buyerIds,
})
pass('case 8b: checkout versus Singles expiry fails closed and reconciles without deadlock')
await emptyCartChecked(danSession, `${OVERLAP_CASES.singlesExpiry} cleanup`)

// Case 9 — checkout versus order completion. Completion removes the order
// reservation and decrements physical inventory while a second buyer commits.
await emptyCartChecked(danSession, OVERLAP_CASES.orderCompletion)
await emptyCartChecked(secondSession, OVERLAP_CASES.orderCompletion)
const completionCardId = await makeCard('checkout versus completion', 3, 0)
const completionListingId = await makeListing('checkout versus completion', { cardId: completionCardId, quantity: 3 })
const completionSeedItem = await addToCartChecked(danSession, completionListingId, 1, `${OVERLAP_CASES.orderCompletion} seed`)
const completionSeed = await checkoutRequest(danSession, checkoutBodyFor([{ cart_item_id: completionSeedItem.id, quantity: 1 }], pickup))
expectEqual(completionSeed.response.status, 201, `${OVERLAP_CASES.orderCompletion}: seed checkout ${JSON.stringify(completionSeed.data)}`)
const completionOrderId = completionSeed.data.orders?.[0]?.id
expect(completionOrderId, `${OVERLAP_CASES.orderCompletion}: seed order id missing`)
for (const action of ['preparing_order', 'payment_received', 'dropped_off']) {
  const step = await request(sellerSession, `/api/orders/${completionOrderId}/transition`, { method: 'POST', body: JSON.stringify({ action }) })
  expectEqual(step.response.status, 200, `${OVERLAP_CASES.orderCompletion}: ${action} ${JSON.stringify(step.data)}`)
}
const completionItemB = await addToCartChecked(secondSession, completionListingId, 1, `${OVERLAP_CASES.orderCompletion} buyer B`)
const completionListings = [completionListingId]
const [completionCheckout, completionTransition] = await runHeldListingOverlap(completionListings, OVERLAP_CASES.orderCompletion, () => [
  checkoutRequest(secondSession, checkoutBodyFor([{ cart_item_id: completionItemB.id, quantity: 1 }], pickup)),
  request(danSession, `/api/orders/${completionOrderId}/transition`, { method: 'POST', body: JSON.stringify({ action: 'order_completed' }) }),
])
expectSafeBody(`${OVERLAP_CASES.orderCompletion} checkout`, completionCheckout.data)
expectSafeBody(`${OVERLAP_CASES.orderCompletion} completion`, completionTransition.data)
expectEqual(completionTransition.response.status, 200, `${OVERLAP_CASES.orderCompletion}: completion ${JSON.stringify(completionTransition.data)}`)
expectEqual(completionCheckout.response.status, 201, `${OVERLAP_CASES.orderCompletion}: checkout ${JSON.stringify(completionCheckout.data)}`)
const completionCard = await service.from('library_cards').select('quantity').eq('id', completionCardId).single()
if (completionCard.error) throw completionCard.error
expectEqual(completionCard.data.quantity, 2, `${OVERLAP_CASES.orderCompletion}: completion did not decrement physical inventory exactly once`)
await assertPostRaceInvariants(OVERLAP_CASES.orderCompletion, {
  listings: [{ id: completionListingId, initialQuantity: 3, expectedAccepted: 2, expectedStatus: ['active'] }],
  orders: [{ id: completionOrderId, expectedStatus: 'order_completed', expectedItems: 1, expectedUnits: 1 }],
  carts: [
    { session: danSession, label: 'buyer A', expectListingIds: [] },
    { session: secondSession, label: 'buyer B', expectListingIds: [] },
  ],
  buyerIds,
})
pass('case 9: checkout versus order completion keeps reservations and inventory exact')

// Disposable pickup fixture: removed when unreferenced, otherwise deactivated.
// Either terminal state is asserted; neither is left to chance.
if (alternatePickupCreated) {
  const referencing = await service.from('orders').select('id').eq('pickup_location_id', alternatePickup).limit(1)
  if (referencing.error) throw referencing.error
  if (referencing.data.length) {
    await serviceUpdateChecked('pickup_locations', alternatePickup, { active: false }, 'alternate pickup cleanup')
    const deactivated = await service.from('pickup_locations').select('active').eq('id', alternatePickup).single()
    if (deactivated.error) throw deactivated.error
    expectEqual(deactivated.data.active, false, 'alternate pickup cleanup: fixture is still active')
  } else {
    const removed = await service.from('pickup_locations').delete().eq('id', alternatePickup)
    if (removed.error) throw removed.error
    await assertRowAbsent('pickup_locations', 'id', alternatePickup, 'alternate pickup cleanup')
  }
}

await emptyCartChecked(danSession, 'final cleanup')
await emptyCartChecked(secondSession, 'final cleanup')

for (const line of staticResults) console.log(line)
for (const line of checks) console.log(line)
for (const line of observations) console.log(`OBSERVATION: ${line}`)
console.log(JSON.stringify({
  result: 'PHASE45C_RUNTIME_PASS',
  checks: checks.length,
  static_checks: staticResults.length,
  overlap_cases: Object.keys(OVERLAP_CASES).length,
  observations,
  app: appUrl,
  supabase_host: host,
}))
