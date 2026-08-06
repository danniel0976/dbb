// Phase 46 — GitHub Actions harness for the rendered UAT.
//
// The Mac harness (`phase42-uat-harness.mjs`) is deliberately host-locked: it
// refuses to run anywhere but Dan's machine, resolves the approved local
// Supabase project by absolute path, and tears its build candidate down into
// the logged-in user's Trash. Those guards exist because that stack is shared
// with real development data — so this file does NOT relax them. It is a
// separate, fail-closed CI-only entry point that reaches the same rendered
// spec through a GitHub-hosted runner, whose Postgres/storage/auth containers
// are created and destroyed by the job itself.
//
// What it keeps from the Mac path, deliberately:
//   • the same env-free isolated candidate — the app is built from a copy that
//     contains none of Next 14's four production env-source files, audited by
//     the *shared* auditNextEnvSources() from the Mac harness, so the resolved
//     Supabase credentials can only have come from `supabase status`;
//   • the same loopback origin pinning (app 127.0.0.1:34242, Supabase 54321);
//   • the same disposable fixture identities, and cleanup verified by re-read.
//
// What it drops, deliberately:
//   • Trash-based teardown (no ~/.Trash on a runner; the runner is the
//     disposable boundary), and the ambiguity-admission pass that protects
//     Dan's shared local rows — a per-job database has nothing to protect.

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

import {
  auditNextEnvSources,
  NEXT_PRODUCTION_ENV_SOURCE_NAMES,
  CRITICAL_ENV_KEYS,
  APP_PORT,
  APP_ORIGIN,
  APP_LISTEN_HOST,
  SUPABASE_ORIGIN,
  FIXTURE_EMAIL,
  FIXTURE_PASSWORD,
  FIXTURE_USERNAME,
  FIXTURE_CARD_NAME,
  FIXTURE_SCRYFALL_ID,
  FIXTURE_LIBRARY_CARD_ID,
  FIXTURE_BINDER_ID,
  FIXTURE_PHOTO_VERSION,
  FIXTURE_PROFILE_MARKER,
  FIXTURE_CARD_IMAGE,
} from './phase42-uat-harness.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const APP_ROOT = path.resolve(__dirname, '..')
const REPO_ROOT = path.resolve(APP_ROOT, '..')
const CANDIDATE_ROOT = path.join(os.tmpdir(), 'dbb-phase46-rendered-uat-ci-34242')
const CANDIDATE_INPUTS = Object.freeze([
  'src', 'public', 'jsconfig.json', 'next.config.js',
  'package.json', 'package-lock.json', 'postcss.config.js', 'tailwind.config.js',
])

// The Mac harness keeps this byte-identical constant private. It is a 1×1
// synthetic JPEG — the smallest thing the storage bucket's mime/type rules
// accept — and the fixture needs one because listing is photo-gated.
const FIXTURE_JPEG_BASE64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EH//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EH//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EH//2Q=='

// ── Fail closed outside GitHub Actions ─────────────────────────────────────
// Every destructive-capable path below runs only after this returns. A local
// invocation must use the Mac harness, which has the guards this one drops.
function assertGitHubActions() {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.CI !== 'true') {
    throw new Error(
      'phase46-uat-harness-ci is GitHub Actions only (GITHUB_ACTIONS=true CI=true). ' +
      'Use scripts/phase42-uat-harness.mjs for a local run.'
    )
  }
}

function parseStatusEnv(raw) {
  const values = new Map()
  const counts = new Map()
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/)
    if (!match) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    counts.set(match[1], (counts.get(match[1]) || 0) + 1)
    values.set(match[1], value)
  }
  for (const key of ['API_URL', 'ANON_KEY', 'SERVICE_ROLE_KEY']) {
    if (counts.get(key) !== 1 || !values.get(key)) {
      throw new Error(`Local Supabase status must resolve exactly one non-empty ${key}`)
    }
  }
  return Object.fromEntries(values)
}

function assertLoopbackUrl(label, value, exactOrigin) {
  let parsed
  try { parsed = new URL(value) } catch { throw new Error(`${label} is not a valid URL`) }
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost'
  if (parsed.origin !== exactOrigin || parsed.protocol !== 'http:' || !loopback) {
    throw new Error(`${label} must be exactly ${exactOrigin}; got ${parsed.origin}`)
  }
}

const fingerprint = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 12)

export function loadCiEnvironment(nextAppRoot = null) {
  assertGitHubActions()
  if (!fs.existsSync(path.join(REPO_ROOT, 'supabase', 'config.toml'))) {
    throw new Error('Repository Supabase project config is missing')
  }
  let raw
  try {
    raw = execFileSync('supabase', ['status', '-o', 'env'], {
      cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    throw new Error('Could not resolve the CI local Supabase status; is `supabase start` running?')
  }
  const local = parseStatusEnv(raw)
  assertLoopbackUrl('API_URL', local.API_URL, SUPABASE_ORIGIN)
  assertLoopbackUrl('NEXT_PUBLIC_SITE_URL', APP_ORIGIN, APP_ORIGIN)

  const envSourceAudit = nextAppRoot ? auditNextEnvSources(nextAppRoot) : {
    candidateNames: [...NEXT_PRODUCTION_ENV_SOURCE_NAMES], sourceNames: [], criticalSourceAssignmentCount: 0,
  }

  const resolved = {
    NEXT_PUBLIC_SITE_URL: APP_ORIGIN,
    NEXT_PUBLIC_SUPABASE_URL: local.API_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: local.ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: local.SERVICE_ROLE_KEY,
  }
  const environment = { ...process.env, ...resolved, NODE_ENV: 'production', PHASE46_UAT_CI: '1' }
  for (const key of CRITICAL_ENV_KEYS) {
    if (!environment[key] || environment[key] !== resolved[key]) {
      throw new Error(`Child process environment did not resolve exact ${key}`)
    }
  }
  environment.PHASE46_UAT_ENV_SOURCES = envSourceAudit.sourceNames.join(',')
  environment.PHASE46_UAT_ENV_SOURCE_ASSIGNMENT_COUNT = String(envSourceAudit.criticalSourceAssignmentCount)
  return environment
}

function serviceClient() {
  const env = loadCiEnvironment()
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

// ── Env-free isolated candidate ────────────────────────────────────────────
function assertCandidateRoot() {
  if (path.dirname(CANDIDATE_ROOT) !== os.tmpdir()
      || path.basename(CANDIDATE_ROOT) !== 'dbb-phase46-rendered-uat-ci-34242') {
    throw new Error('Refusing unsafe Phase 46 CI candidate path')
  }
}

function inputManifest(root) {
  const files = []
  const visit = (absolutePath, relativePath) => {
    const stat = fs.lstatSync(absolutePath)
    if (stat.isSymbolicLink()) throw new Error(`Candidate input ${relativePath} must not be a symlink`)
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolutePath).sort()) {
        visit(path.join(absolutePath, name), path.join(relativePath, name))
      }
      return
    }
    if (!stat.isFile()) throw new Error(`Candidate input ${relativePath} must be a regular file`)
    files.push({ path: relativePath, sha256: crypto.createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex') })
  }
  for (const relativePath of CANDIDATE_INPUTS) {
    const absolutePath = path.join(root, relativePath)
    if (!fs.existsSync(absolutePath)) {
      if (relativePath === 'public') continue
      throw new Error(`Required candidate input ${relativePath} is missing`)
    }
    visit(absolutePath, relativePath)
  }
  return files
}

function prepareCandidate() {
  assertGitHubActions()
  assertCandidateRoot()
  if (fs.existsSync(CANDIDATE_ROOT)) {
    throw new Error(`Refusing to reuse an existing CI candidate at ${CANDIDATE_ROOT}`)
  }
  fs.mkdirSync(CANDIDATE_ROOT, { recursive: false })
  for (const relativePath of CANDIDATE_INPUTS) {
    const sourcePath = path.join(APP_ROOT, relativePath)
    if (!fs.existsSync(sourcePath)) continue
    fs.cpSync(sourcePath, path.join(CANDIDATE_ROOT, relativePath), { recursive: true })
  }
  fs.symlinkSync(path.join(APP_ROOT, 'node_modules'), path.join(CANDIDATE_ROOT, 'node_modules'), 'dir')
  return verifyCandidate()
}

function verifyCandidate() {
  assertCandidateRoot()
  if (!fs.existsSync(CANDIDATE_ROOT) || !fs.lstatSync(CANDIDATE_ROOT).isDirectory()) {
    throw new Error('Isolated Phase 46 CI candidate is missing')
  }
  if (JSON.stringify(inputManifest(APP_ROOT)) !== JSON.stringify(inputManifest(CANDIDATE_ROOT))) {
    throw new Error('Isolated Phase 46 CI candidate inputs no longer match the checkout')
  }
  const audit = auditNextEnvSources(CANDIDATE_ROOT)
  if (audit.sourceNames.length !== 0 || audit.criticalSourceAssignmentCount !== 0) {
    throw new Error('Isolated Phase 46 CI candidate unexpectedly contains a Next env source')
  }
  return audit
}

// ── Disposable fixture ─────────────────────────────────────────────────────
const photoPath = userId => `${userId}/${FIXTURE_LIBRARY_CARD_ID}/${FIXTURE_PHOTO_VERSION}.jpg`

async function exactFixtureUsers(db) {
  const found = []
  for (let page = 1; ; page += 1) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 })
    if (error) throw error
    const users = data?.users || []
    found.push(...users.filter(user => user.email?.toLowerCase() === FIXTURE_EMAIL))
    if (users.length < 1000) break
  }
  return found
}

export async function cleanupFixture() {
  const db = serviceClient()
  for (const user of await exactFixtureUsers(db)) {
    for (const [table, column, value] of [
      ['listings', 'library_card_id', FIXTURE_LIBRARY_CARD_ID],
      ['claim_sales', 'user_id', user.id],
      ['card_photos', 'library_card_id', FIXTURE_LIBRARY_CARD_ID],
      ['library_cards', 'id', FIXTURE_LIBRARY_CARD_ID],
      ['binders', 'id', FIXTURE_BINDER_ID],
    ]) {
      const { error } = await db.from(table).delete().eq(column, value)
      if (error) throw new Error(`${table} fixture cleanup failed: ${error.message}`)
    }
    await db.storage.from('card-photos').remove([photoPath(user.id)])
    const { error } = await db.auth.admin.deleteUser(user.id)
    if (error) throw new Error(`Fixture user cleanup failed: ${error.message}`)
  }
  const { error: catalogError } = await db.from('card_index').delete().eq('scryfall_id', FIXTURE_SCRYFALL_ID)
  if (catalogError) throw new Error(`Fixture catalog cleanup failed: ${catalogError.message}`)

  // Cleanup is proven by re-read, never by the delete call's own success.
  const absence = {}
  for (const [table, column, value] of [
    ['listings', 'library_card_id', FIXTURE_LIBRARY_CARD_ID],
    ['card_photos', 'library_card_id', FIXTURE_LIBRARY_CARD_ID],
    ['library_cards', 'id', FIXTURE_LIBRARY_CARD_ID],
    ['binders', 'id', FIXTURE_BINDER_ID],
    ['card_index', 'scryfall_id', FIXTURE_SCRYFALL_ID],
  ]) {
    const { count, error } = await db.from(table).select('*', { count: 'exact', head: true }).eq(column, value)
    if (error) throw new Error(`${table} cleanup verification failed: ${error.message}`)
    if (count !== 0) throw new Error(`${table} cleanup verification found ${count} fixture row(s)`)
    absence[table] = count
  }
  const remaining = await exactFixtureUsers(db)
  if (remaining.length !== 0) throw new Error('Fixture auth user still exists after cleanup')
  console.log(`[phase46-uat-ci] cleanup PASS: ${JSON.stringify({ ...absence, authUser: 0 })}`)
}

async function createFixture() {
  await cleanupFixture()
  const db = serviceClient()
  try {
    const { data: authData, error: authError } = await db.auth.admin.createUser({
      email: FIXTURE_EMAIL,
      password: FIXTURE_PASSWORD,
      email_confirm: true,
      user_metadata: { username: FIXTURE_USERNAME, display_name: 'Phase 42 UAT' },
    })
    if (authError || !authData?.user) throw authError || new Error('Fixture auth user was not created')
    const user = authData.user

    const { error: profileError } = await db.from('profiles').update({
      merchant_bank_name: FIXTURE_PROFILE_MARKER,
      merchant_account_name: 'Phase 42 UAT Seller',
      merchant_account_number: '0000000042',
      merchant_duitnow_id: null,
      merchant_payment_instructions: 'Disposable CI-only rendered UAT fixture.',
      merchant_profile_completed_at: new Date().toISOString(),
    }).eq('id', user.id)
    if (profileError) throw profileError

    const { error: catalogError } = await db.from('card_index').insert({
      scryfall_id: FIXTURE_SCRYFALL_ID,
      name: FIXTURE_CARD_NAME,
      set_code: 'uat',
      set_name: 'Local UAT',
      collector_number: '42',
      rarity: 'rare',
      colors: ['U'],
      type_line: 'Artifact — UAT Fixture',
      cmc: 2,
      mana_cost: '{2}',
      finishes: ['normal'],
      image_uris: { normal: FIXTURE_CARD_IMAGE },
    })
    if (catalogError) throw catalogError

    const { error: binderError } = await db.from('binders').insert({
      id: FIXTURE_BINDER_ID, user_id: user.id,
      name: 'Phase 42 Rendered UAT', description: 'Disposable local-only fixture', is_default: false,
    })
    if (binderError) throw binderError

    const { error: cardError } = await db.from('library_cards').insert({
      id: FIXTURE_LIBRARY_CARD_ID, user_id: user.id, binder_id: FIXTURE_BINDER_ID,
      scryfall_id: FIXTURE_SCRYFALL_ID, quantity: 1, foil: 'normal', condition: 'NM',
      language: 'en', starred: false, purchase_price: 4.2, purchase_currency: 'MYR',
    })
    if (cardError) throw cardError

    const { error: uploadError } = await db.storage.from('card-photos')
      .upload(photoPath(user.id), Buffer.from(FIXTURE_JPEG_BASE64, 'base64'), { contentType: 'image/jpeg', upsert: false })
    if (uploadError) throw uploadError

    const { error: photoError } = await db.from('card_photos').insert({
      user_id: user.id, library_card_id: FIXTURE_LIBRARY_CARD_ID, storage_path: photoPath(user.id),
    })
    if (photoError) throw photoError

    const { data: listing, error: listingError } = await db.from('listings').insert({
      user_id: user.id, library_card_id: FIXTURE_LIBRARY_CARD_ID, multiplier: 2.5, quantity: 1,
      status: 'active', expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    }).select('id, multiplier, status').single()
    if (listingError) throw listingError

    const { data: admitted, error: readError } = await db.from('library_cards')
      .select('id, card_index!inner(name)').eq('id', FIXTURE_LIBRARY_CARD_ID).eq('user_id', user.id).single()
    if (readError || admitted?.card_index?.name !== FIXTURE_CARD_NAME) {
      throw readError || new Error('Fixture library admission failed')
    }
    console.log(`[phase46-uat-ci] fixture PASS: ${FIXTURE_EMAIL}, card ${FIXTURE_LIBRARY_CARD_ID}, listing ${listing.id}`)
  } catch (error) {
    await cleanupFixture().catch(cleanupError => {
      console.error(`[phase46-uat-ci] cleanup after setup failure also failed: ${cleanupError.message}`)
    })
    throw error
  }
}

export default async function globalSetup() {
  assertGitHubActions()
  await createFixture()
  return async () => { await cleanupFixture() }
}

async function runNext(mode) {
  assertGitHubActions()
  if (mode === 'build') prepareCandidate()
  const audit = verifyCandidate()
  const env = loadCiEnvironment(CANDIDATE_ROOT)
  const nextBin = path.join(APP_ROOT, 'node_modules', 'next', 'dist', 'bin', 'next')
  const args = mode === 'build'
    ? [nextBin, 'build']
    : [nextBin, 'start', '-p', String(APP_PORT), '-H', APP_LISTEN_HOST]
  console.log(JSON.stringify({
    phase46UatCi: mode,
    runner: os.hostname(),
    appOrigin: APP_ORIGIN,
    appListenHost: APP_LISTEN_HOST,
    supabaseOrigin: SUPABASE_ORIGIN,
    anonKeyFingerprint: fingerprint(env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    serviceKeyFingerprint: fingerprint(env.SUPABASE_SERVICE_ROLE_KEY),
    criticalAssignmentCount: CRITICAL_ENV_KEYS.length,
    checkoutEnvSources: NEXT_PRODUCTION_ENV_SOURCE_NAMES.filter(name => fs.existsSync(path.join(APP_ROOT, name))),
    candidateEnvSourceCount: audit.sourceNames.length,
    candidateInputCount: inputManifest(CANDIDATE_ROOT).length,
  }))
  const child = spawn(process.execPath, args, { cwd: CANDIDATE_ROOT, env, stdio: 'inherit' })
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', value => resolve(value ?? 1))
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2]
  if (!['build', 'serve'].includes(command)) {
    throw new Error('Usage: node scripts/phase46-uat-harness-ci.mjs <build|serve>')
  }
  await runNext(command)
}
