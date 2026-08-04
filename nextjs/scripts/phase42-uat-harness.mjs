import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const APP_ROOT = path.resolve(__dirname, '..')
const WORKSPACE_ROOT = path.resolve(APP_ROOT, '..', '..')
const SUPABASE_PROJECT_ROOT = path.join(WORKSPACE_ROOT, 'dbb-auction-concurrency')
export const ISOLATED_CANDIDATE_ROOT = path.join(os.tmpdir(), 'dbb-phase42-rendered-uat-34242')
const CANDIDATE_MANIFEST = '.phase42-uat-input-manifest.json'
const CANDIDATE_INPUTS = Object.freeze([
  'src',
  'public',
  'jsconfig.json',
  'next.config.js',
  'package.json',
  'package-lock.json',
  'postcss.config.js',
  'tailwind.config.js',
])

export const CRITICAL_ENV_KEYS = Object.freeze([
  'NEXT_PUBLIC_SITE_URL',
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
])
// This is the exact production list and precedence used by Next 14's
// @next/env loadEnvConfig. Development/test-only and similarly named files
// such as .env.example and .env.vercel are not Next production env sources.
export const NEXT_PRODUCTION_ENV_SOURCE_NAMES = Object.freeze([
  '.env.production.local',
  '.env.local',
  '.env.production',
  '.env',
])

export const APP_PORT = 34242
export const APP_ORIGIN = `http://localhost:${APP_PORT}`
export const APP_LISTEN_HOST = '127.0.0.1'
export const SUPABASE_ORIGIN = 'http://127.0.0.1:54321'
export const FIXTURE_EMAIL = 'phase42-rendered-uat-20260803@dbb.local'
export const FIXTURE_PASSWORD = 'Phase42_Rendered_UAT_2026!'
export const FIXTURE_USERNAME = 'phase42_uat_0803'
export const FIXTURE_CARD_NAME = 'Phase 42 Rendered UAT Card'
export const FIXTURE_SCRYFALL_ID = '42000000-0000-4000-8000-000000000042'
export const FIXTURE_LIBRARY_CARD_ID = '42000000-0000-4000-8000-000000000043'
export const FIXTURE_BINDER_ID = '42000000-0000-4000-8000-000000000044'
export const FIXTURE_PHOTO_VERSION = '42000000-0000-4000-8000-000000000045'
export const FIXTURE_PROFILE_MARKER = 'DBB Phase 42 rendered UAT synthetic profile'
export const FIXTURE_CARD_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAAAAACw='
export const FIXTURE_CLAIM_SALE_TITLE = 'Phase 42 Rendered UAT Claim Sale'
const FIXTURE_JPEG_BASE64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EH//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EH//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EH//2Q=='

export function stripEnvComments(raw) {
  return raw.split(/\r?\n/).map(line => {
    let quote = null
    let escaped = false
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index]
      if (escaped) {
        escaped = false
        continue
      }
      if (character === '\\' && quote) {
        escaped = true
        continue
      }
      if ((character === '"' || character === "'") && (!quote || quote === character)) {
        quote = quote ? null : character
        continue
      }
      if (character === '#' && !quote) return line.slice(0, index)
    }
    return line
  }).join('\n')
}

function criticalValue(rawValue, key, sourceName, lineNumber) {
  const value = rawValue.trim()
  if (!value) throw new Error(`${sourceName}:${lineNumber} has an empty ${key} assignment`)
  const quote = value[0]
  if (quote === '"' || quote === "'") {
    if (value.length < 2 || value.at(-1) !== quote) {
      throw new Error(`${sourceName}:${lineNumber} has an ambiguous ${key} assignment`)
    }
    const unquoted = value.slice(1, -1)
    if (!unquoted.trim()) throw new Error(`${sourceName}:${lineNumber} has an empty ${key} assignment`)
    if (/\$\{?[A-Za-z_]/.test(unquoted)) {
      throw new Error(`${sourceName}:${lineNumber} has an interpolated ${key} assignment`)
    }
    return
  }
  if (/\s/.test(value) || /\$\{?[A-Za-z_]/.test(value)) {
    throw new Error(`${sourceName}:${lineNumber} has an ambiguous ${key} assignment`)
  }
}

export function auditNextEnvSourceContents(sources) {
  const sourceNames = new Set()
  const assignments = new Map(CRITICAL_ENV_KEYS.map(key => [key, []]))
  for (const source of sources) {
    if (!NEXT_PRODUCTION_ENV_SOURCE_NAMES.includes(source.name) || sourceNames.has(source.name)) {
      throw new Error(`Unexpected or duplicate Next environment source ${source.name}`)
    }
    sourceNames.add(source.name)
    const stripped = stripEnvComments(source.contents)
    for (const [offset, line] of stripped.split(/\r?\n/).entries()) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/)
      if (!match) {
        const criticalKey = CRITICAL_ENV_KEYS.find(key =>
          new RegExp(`^(?:export\\s+)?${key}(?:\\s|=|$)`).test(trimmed))
        if (criticalKey) {
          throw new Error(`${source.name}:${offset + 1} has an ambiguous ${criticalKey} assignment`)
        }
        continue
      }
      const key = match[1]
      if (!assignments.has(key)) continue
      criticalValue(match[2], key, source.name, offset + 1)
      assignments.get(key).push({ sourceName: source.name, lineNumber: offset + 1 })
    }
  }
  for (const [key, occurrences] of assignments) {
    if (occurrences.length > 1) {
      throw new Error(`Next environment sources contain ${occurrences.length} assignments for ${key}`)
    }
  }
  return {
    candidateNames: [...NEXT_PRODUCTION_ENV_SOURCE_NAMES],
    sourceNames: NEXT_PRODUCTION_ENV_SOURCE_NAMES.filter(name => sourceNames.has(name)),
    criticalSourceAssignmentCount: Array.from(assignments.values()).reduce((sum, values) => sum + values.length, 0),
  }
}

export function auditNextEnvSources(appRoot = APP_ROOT) {
  const sources = []
  for (const name of NEXT_PRODUCTION_ENV_SOURCE_NAMES) {
    const sourcePath = path.join(appRoot, name)
    if (!fs.existsSync(sourcePath)) continue
    const stat = fs.lstatSync(sourcePath)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Next environment source ${name} must be a regular non-symlink file`)
    }
    sources.push({ name, contents: fs.readFileSync(sourcePath, 'utf8') })
  }
  return auditNextEnvSourceContents(sources)
}

function assertCandidateRoot() {
  if (path.dirname(ISOLATED_CANDIDATE_ROOT) !== os.tmpdir()
      || path.basename(ISOLATED_CANDIDATE_ROOT) !== 'dbb-phase42-rendered-uat-34242') {
    throw new Error('Refusing unsafe Phase 42 candidate path')
  }
}

export function validateCandidateSourcePath(candidatePath = ISOLATED_CANDIDATE_ROOT) {
  assertCandidateRoot()
  if (typeof candidatePath !== 'string'
      || !path.isAbsolute(candidatePath)
      || candidatePath !== ISOLATED_CANDIDATE_ROOT
      || path.normalize(candidatePath) !== ISOLATED_CANDIDATE_ROOT
      || path.dirname(candidatePath) !== os.tmpdir()
      || path.basename(candidatePath) !== 'dbb-phase42-rendered-uat-34242') {
    throw new Error('Refusing unvalidated Phase 42 candidate source path')
  }
  const expectedParent = fs.realpathSync.native(os.tmpdir())
  const resolvedParent = fs.realpathSync.native(path.dirname(candidatePath))
  if (resolvedParent !== expectedParent) {
    throw new Error('Phase 42 candidate source parent did not resolve to the approved temp root')
  }
  if (!fs.existsSync(candidatePath)) return { sourcePath: candidatePath, exists: false }
  const stat = fs.lstatSync(candidatePath)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Phase 42 candidate source must be a real directory')
  }
  if (fs.realpathSync.native(candidatePath) !== candidatePath) {
    throw new Error('Phase 42 candidate source did not resolve to its exact approved path')
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('Phase 42 candidate source is not owned by the logged-in user')
  }
  return { sourcePath: candidatePath, exists: true }
}

export function loggedInUserTrashRoot() {
  const user = os.userInfo()
  const home = path.resolve(user.homedir)
  if (!path.isAbsolute(user.homedir)
      || home !== path.resolve(os.homedir())
      || user.username !== process.env.USER) {
    throw new Error('Could not validate the logged-in user home for Phase 42 teardown')
  }
  const trashRoot = path.join(home, '.Trash')
  if (path.dirname(trashRoot) !== home || path.basename(trashRoot) !== '.Trash') {
    throw new Error('Refusing unsafe Phase 42 Trash root')
  }
  const stat = fs.lstatSync(trashRoot)
  if (!stat.isDirectory() || stat.isSymbolicLink()
      || fs.realpathSync.native(trashRoot) !== trashRoot) {
    throw new Error('Logged-in user Trash must be a real directory')
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('Logged-in user Trash ownership did not match the current process')
  }
  return trashRoot
}

export function buildCandidateTrashDestinationForRoot(trashRoot, {
  now = new Date(),
  pid = process.pid,
  uniqueId = crypto.randomUUID(),
} = {}) {
  if (typeof trashRoot !== 'string' || !path.isAbsolute(trashRoot)
      || path.basename(trashRoot) !== '.Trash'
      || path.normalize(trashRoot) !== trashRoot
      || !(now instanceof Date) || Number.isNaN(now.getTime())
      || !Number.isSafeInteger(pid) || pid < 1
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uniqueId)) {
    throw new Error('Refusing invalid Phase 42 Trash destination identity')
  }
  const timestamp = now.toISOString().replace(/[:.]/g, '-')
  const destinationPath = path.join(
    trashRoot,
    `dbb-phase42-rendered-uat-34242-${timestamp}-pid${pid}-${uniqueId}`,
  )
  if (path.dirname(destinationPath) !== trashRoot) {
    throw new Error('Refusing ambiguous Phase 42 Trash destination')
  }
  return destinationPath
}

export function buildCandidateTrashDestination(options = {}) {
  const trashRoot = loggedInUserTrashRoot()
  const destinationPath = buildCandidateTrashDestinationForRoot(trashRoot, options)
  if (fs.existsSync(destinationPath)) {
    throw new Error('Refusing ambiguous Phase 42 Trash destination')
  }
  return destinationPath
}

export function moveIsolatedCandidateToTrash() {
  const validated = validateCandidateSourcePath(ISOLATED_CANDIDATE_ROOT)
  if (!validated.exists) return null
  const destinationPath = buildCandidateTrashDestination()
  fs.renameSync(validated.sourcePath, destinationPath)
  if (fs.existsSync(validated.sourcePath)) {
    throw new Error('Phase 42 candidate source still exists after recoverable move')
  }
  const destinationStat = fs.lstatSync(destinationPath)
  if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink()) {
    throw new Error('Phase 42 recoverable destination is not the moved candidate directory')
  }
  const receipt = {
    sourcePath: validated.sourcePath,
    destinationPath,
    sourceAbsent: true,
    destinationPresent: true,
  }
  console.log(`[phase42-uat] candidate teardown PASS: ${JSON.stringify(receipt)}`)
  return receipt
}

function inputManifest(root) {
  const files = []
  function visit(absolutePath, relativePath) {
    const stat = fs.lstatSync(absolutePath)
    if (stat.isSymbolicLink()) throw new Error(`Candidate input ${relativePath} must not be a symlink`)
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolutePath).sort()) {
        visit(path.join(absolutePath, name), path.join(relativePath, name))
      }
      return
    }
    if (!stat.isFile()) throw new Error(`Candidate input ${relativePath} must be a regular file`)
    files.push({
      path: relativePath,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex'),
    })
  }
  for (const relativePath of CANDIDATE_INPUTS) {
    const absolutePath = path.join(root, relativePath)
    if (!fs.existsSync(absolutePath)) {
      if (relativePath === 'public') continue
      throw new Error(`Required Phase 42 candidate input ${relativePath} is missing`)
    }
    visit(absolutePath, relativePath)
  }
  return files
}

function prepareIsolatedCandidate() {
  assertCandidateRoot()
  const priorCandidateTeardown = moveIsolatedCandidateToTrash()
  fs.mkdirSync(ISOLATED_CANDIDATE_ROOT, { recursive: false })
  for (const relativePath of CANDIDATE_INPUTS) {
    const sourcePath = path.join(APP_ROOT, relativePath)
    if (!fs.existsSync(sourcePath)) continue
    fs.cpSync(sourcePath, path.join(ISOLATED_CANDIDATE_ROOT, relativePath), { recursive: true })
  }
  fs.symlinkSync(path.join(APP_ROOT, 'node_modules'), path.join(ISOLATED_CANDIDATE_ROOT, 'node_modules'), 'dir')
  const manifest = inputManifest(APP_ROOT)
  fs.writeFileSync(path.join(ISOLATED_CANDIDATE_ROOT, CANDIDATE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  verifyIsolatedCandidate()
  return {
    copiedInputCount: manifest.length,
    excludedEnvSources: NEXT_PRODUCTION_ENV_SOURCE_NAMES.filter(name => fs.existsSync(path.join(APP_ROOT, name))),
    priorCandidateTeardown,
  }
}

function verifyIsolatedCandidate() {
  assertCandidateRoot()
  if (!fs.existsSync(ISOLATED_CANDIDATE_ROOT)
      || fs.lstatSync(ISOLATED_CANDIDATE_ROOT).isSymbolicLink()
      || !fs.lstatSync(ISOLATED_CANDIDATE_ROOT).isDirectory()) {
    throw new Error('Isolated Phase 42 candidate is missing or unsafe')
  }
  const manifestPath = path.join(ISOLATED_CANDIDATE_ROOT, CANDIDATE_MANIFEST)
  const expected = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const currentSource = inputManifest(APP_ROOT)
  const currentCandidate = inputManifest(ISOLATED_CANDIDATE_ROOT)
  if (JSON.stringify(expected) !== JSON.stringify(currentSource)
      || JSON.stringify(expected) !== JSON.stringify(currentCandidate)) {
    throw new Error('Isolated Phase 42 candidate inputs no longer match the worktree')
  }
  const envAudit = auditNextEnvSources(ISOLATED_CANDIDATE_ROOT)
  if (envAudit.sourceNames.length !== 0 || envAudit.criticalSourceAssignmentCount !== 0) {
    throw new Error('Isolated Phase 42 candidate unexpectedly contains a Next env source')
  }
  return envAudit
}

function parseStatusEnv(raw) {
  const values = new Map()
  const counts = new Map()
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/)
    if (!match) continue
    const key = match[1]
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    counts.set(key, (counts.get(key) || 0) + 1)
    values.set(key, value)
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
  const loopbackHost = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost'
  if (parsed.origin !== exactOrigin || parsed.protocol !== 'http:' || !loopbackHost) {
    throw new Error(`${label} must be exactly ${exactOrigin}; got ${parsed.origin}`)
  }
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 12)
}

export function loadUatEnvironment(nextAppRoot = null) {
  const host = execFileSync('/bin/hostname', [], { encoding: 'utf8' }).trim()
  if (host !== 'Dans-MacBook-Air-9.local') {
    throw new Error(`Phase 42 UAT is Mac-local only; resolved host ${host}`)
  }
  if (!fs.existsSync(path.join(SUPABASE_PROJECT_ROOT, 'supabase', 'config.toml'))) {
    throw new Error('Approved local Supabase project config is missing')
  }

  let raw
  try {
    raw = execFileSync('supabase', ['status', '-o', 'env'], {
      cwd: SUPABASE_PROJECT_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    throw new Error('Could not resolve the approved local Supabase status')
  }
  const local = parseStatusEnv(raw)
  assertLoopbackUrl('API_URL', local.API_URL, SUPABASE_ORIGIN)
  assertLoopbackUrl('NEXT_PUBLIC_SITE_URL', APP_ORIGIN, APP_ORIGIN)

  const envSourceAudit = nextAppRoot ? auditNextEnvSources(nextAppRoot) : {
    candidateNames: [...NEXT_PRODUCTION_ENV_SOURCE_NAMES],
    sourceNames: [],
    criticalSourceAssignmentCount: 0,
  }

  // The server receives one programmatically constructed resolved assignment
  // for each critical key. Process values override inert repo env placeholders.
  const criticalAssignments = [
    ['NEXT_PUBLIC_SITE_URL', APP_ORIGIN],
    ['NEXT_PUBLIC_SUPABASE_URL', local.API_URL],
    ['NEXT_PUBLIC_SUPABASE_ANON_KEY', local.ANON_KEY],
    ['SUPABASE_SERVICE_ROLE_KEY', local.SERVICE_ROLE_KEY],
  ]
  if (new Set(criticalAssignments.map(([key]) => key)).size !== criticalAssignments.length) {
    throw new Error('Critical UAT environment contains duplicate assignments')
  }
  const resolved = Object.fromEntries(criticalAssignments)
  const expectedResolved = {
    NEXT_PUBLIC_SITE_URL: APP_ORIGIN,
    NEXT_PUBLIC_SUPABASE_URL: local.API_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: local.ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: local.SERVICE_ROLE_KEY,
  }
  for (const key of CRITICAL_ENV_KEYS) {
    if (!resolved[key] || resolved[key] !== expectedResolved[key]) {
      throw new Error(`Critical UAT key ${key} does not match the approved local resolved value`)
    }
  }
  const environment = {
    ...process.env,
    ...resolved,
    NODE_ENV: 'production',
    PHASE42_UAT: '1',
  }
  for (const key of CRITICAL_ENV_KEYS) {
    if (environment[key] !== expectedResolved[key]) {
      throw new Error(`Child process environment did not resolve exact ${key}`)
    }
  }
  environment.PHASE42_UAT_ENV_CANDIDATES = envSourceAudit.candidateNames.join(',')
  environment.PHASE42_UAT_ENV_SOURCES = envSourceAudit.sourceNames.join(',')
  environment.PHASE42_UAT_ENV_SOURCE_ASSIGNMENT_COUNT = String(envSourceAudit.criticalSourceAssignmentCount)
  return environment
}

function serviceClient() {
  const env = loadUatEnvironment()
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

async function exactFixtureUsers(db) {
  const found = []
  for (let page = 1; ; page += 1) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 })
    if (error) throw error
    const users = data?.users || []
    found.push(...users.filter(user => user.email?.toLowerCase() === FIXTURE_EMAIL))
    if (users.length < 1000) break
  }
  if (found.length > 1) throw new Error(`Refusing ambiguous cleanup: ${found.length} exact fixture users`)
  return found
}

function photoPath(userId) {
  return `${userId}/${FIXTURE_LIBRARY_CARD_ID}/${FIXTURE_PHOTO_VERSION}.jpg`
}

function fixtureJpeg() {
  return Buffer.from(FIXTURE_JPEG_BASE64, 'base64')
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function requireFixture(condition, message) {
  if (!condition) throw new Error(`Refusing fixture cleanup: ${message}`)
}

async function fixtureRows(db, table, column, value, columns = '*') {
  const { data, error } = await db.from(table).select(columns).eq(column, value)
  if (error) throw new Error(`${table} fixture admission failed: ${error.message}`)
  return data || []
}

async function exactFixtureStorageObjects(db, userId) {
  const exactPath = photoPath(userId)
  const prefix = path.posix.dirname(exactPath)
  const objectName = path.posix.basename(exactPath)
  const { data, error } = await db.storage.from('card-photos').list(prefix, {
    limit: 100,
    search: objectName,
  })
  if (error) throw new Error(`Fixture storage admission failed: ${error.message}`)
  const exact = (data || []).filter(object => object.name === objectName)
  requireFixture(exact.length <= 1, `ambiguous exact storage object ${exactPath}`)
  return exact
}

async function assertExactFixtureStorage(db, userId, { required = false } = {}) {
  const exactPath = photoPath(userId)
  const objects = await exactFixtureStorageObjects(db, userId)
  if (required) requireFixture(objects.length === 1, `exact storage object ${exactPath} is missing`)
  if (objects.length === 0) return false

  const { data, error } = await db.storage.from('card-photos').download(exactPath)
  if (error || !data) {
    throw new Error(`Fixture storage download admission failed: ${error?.message || 'missing payload'}`)
  }
  const bytes = Buffer.from(await data.arrayBuffer())
  requireFixture(
    sha256(bytes) === sha256(fixtureJpeg()),
    `storage object ${exactPath} does not match the synthetic fixture bytes`,
  )
  return true
}

async function admitFixtureForCleanup(db, user) {
  const [profiles, binders, cards, photos, listings, claimSales, catalogRows] = await Promise.all([
    user ? fixtureRows(db, 'profiles', 'id', user.id, 'id, merchant_bank_name') : Promise.resolve([]),
    fixtureRows(db, 'binders', 'id', FIXTURE_BINDER_ID, 'id, user_id, name, description, is_default'),
    fixtureRows(db, 'library_cards', 'id', FIXTURE_LIBRARY_CARD_ID, 'id, user_id, binder_id, scryfall_id, quantity, foil, condition, language, purchase_price, purchase_currency'),
    fixtureRows(db, 'card_photos', 'library_card_id', FIXTURE_LIBRARY_CARD_ID, 'id, user_id, library_card_id, storage_path'),
    fixtureRows(db, 'listings', 'library_card_id', FIXTURE_LIBRARY_CARD_ID, 'id, user_id, library_card_id, multiplier, quantity, status'),
    user ? fixtureRows(db, 'claim_sales', 'user_id', user.id, 'id, user_id, title, status') : Promise.resolve([]),
    fixtureRows(db, 'card_index', 'scryfall_id', FIXTURE_SCRYFALL_ID, 'scryfall_id, name, set_code, set_name, collector_number, rarity, type_line, image_uris'),
  ])

  for (const [label, rows] of [
    ['profile', profiles],
    ['binder', binders],
    ['library card', cards],
    ['card photo', photos],
    ['listing', listings],
    ['claim sale', claimSales],
    ['catalog card', catalogRows],
  ]) {
    requireFixture(rows.length <= 1, `ambiguous ${label} rows`)
  }

  if (!user) {
    requireFixture(
      binders.length === 0 && cards.length === 0 && photos.length === 0 && listings.length === 0 && claimSales.length === 0,
      'fixed-ID rows exist without the exact synthetic auth user',
    )
  } else {
    requireFixture(user.email?.toLowerCase() === FIXTURE_EMAIL, 'auth email does not match')
    requireFixture(user.user_metadata?.username === FIXTURE_USERNAME, 'auth username marker does not match')
    requireFixture(user.user_metadata?.display_name === 'Phase 42 UAT', 'auth display marker does not match')
    requireFixture(profiles.length === 1, 'synthetic profile row is missing')
    requireFixture(profiles[0].merchant_bank_name === FIXTURE_PROFILE_MARKER, 'profile marker does not match')
  }

  if (binders[0]) {
    requireFixture(user && binders[0].user_id === user.id, 'binder ownership does not match')
    requireFixture(binders[0].name === 'Phase 42 Rendered UAT', 'binder name does not match')
    requireFixture(binders[0].description === 'Disposable local-only fixture', 'binder description does not match')
    requireFixture(binders[0].is_default === false, 'binder default flag does not match')
  }
  if (cards[0]) {
    requireFixture(user && cards[0].user_id === user.id, 'library card ownership does not match')
    requireFixture(cards[0].binder_id === FIXTURE_BINDER_ID, 'library card binder does not match')
    requireFixture(cards[0].scryfall_id === FIXTURE_SCRYFALL_ID, 'library card catalog identity does not match')
    requireFixture(Number(cards[0].quantity) === 1, 'library card quantity does not match')
    requireFixture(cards[0].foil === 'normal' && cards[0].condition === 'NM' && cards[0].language === 'en', 'library card attributes do not match')
    requireFixture(Number(cards[0].purchase_price) === 4.2 && cards[0].purchase_currency === 'MYR', 'library card purchase marker does not match')
  }
  if (photos[0]) {
    requireFixture(user && photos[0].user_id === user.id, 'photo ownership does not match')
    requireFixture(photos[0].library_card_id === FIXTURE_LIBRARY_CARD_ID, 'photo card identity does not match')
    requireFixture(photos[0].storage_path === photoPath(user.id), 'photo storage path does not match')
  }
  if (listings[0]) {
    requireFixture(user && listings[0].user_id === user.id, 'listing ownership does not match')
    requireFixture(listings[0].library_card_id === FIXTURE_LIBRARY_CARD_ID, 'listing card identity does not match')
    requireFixture(Number(listings[0].quantity) === 1, 'listing quantity does not match')
    requireFixture([2.5, 2.8, 3].includes(Number(listings[0].multiplier)), 'listing multiplier is not a Phase 42 tier')
    requireFixture(['active', 'expired'].includes(listings[0].status), 'listing status is not a Phase 42 UAT transition')
  }
  if (claimSales[0]) {
    requireFixture(user && claimSales[0].user_id === user.id, 'claim sale ownership does not match')
    requireFixture(claimSales[0].title === FIXTURE_CLAIM_SALE_TITLE, 'claim sale title marker does not match')
    requireFixture(claimSales[0].status === 'active', 'claim sale status does not match')
  }
  if (catalogRows[0]) {
    const catalog = catalogRows[0]
    requireFixture(catalog.name === FIXTURE_CARD_NAME, 'catalog name does not match')
    requireFixture(catalog.set_code === 'uat' && catalog.set_name === 'Local UAT', 'catalog set marker does not match')
    requireFixture(catalog.collector_number === '42' && catalog.rarity === 'rare', 'catalog printing marker does not match')
    requireFixture(catalog.type_line === 'Artifact — UAT Fixture', 'catalog type marker does not match')
    requireFixture(
      catalog.image_uris == null || catalog.image_uris?.normal === FIXTURE_CARD_IMAGE,
      'catalog stored image does not match the synthetic fixture',
    )
  }

  if (user) {
    const storagePresent = await assertExactFixtureStorage(db, user.id, { required: photos.length === 1 })
    requireFixture(!storagePresent || photos.length === 1, 'storage object exists without its exact synthetic photo row')
  }

  return {
    userId: user?.id || null,
    present: {
      profile: profiles.length,
      binder: binders.length,
      libraryCard: cards.length,
      photo: photos.length,
      listing: listings.length,
      claimSale: claimSales.length,
      catalog: catalogRows.length,
    },
  }
}

async function assertFixtureAbsent(db, userId = null) {
  const checks = [
    ['library_cards', 'id', FIXTURE_LIBRARY_CARD_ID],
    ['binders', 'id', FIXTURE_BINDER_ID],
    ['card_photos', 'library_card_id', FIXTURE_LIBRARY_CARD_ID],
    ['listings', 'library_card_id', FIXTURE_LIBRARY_CARD_ID],
    ['card_index', 'scryfall_id', FIXTURE_SCRYFALL_ID],
  ]
  if (userId) checks.push(['profiles', 'id', userId])
  if (userId) checks.push(['claim_sales', 'user_id', userId])
  for (const [table, column, value] of checks) {
    const { count, error } = await db.from(table).select('*', { count: 'exact', head: true }).eq(column, value)
    if (error) throw new Error(`${table} cleanup verification failed: ${error.message}`)
    if (count !== 0) throw new Error(`${table} cleanup verification found ${count} fixture row(s)`)
  }
  if (userId && (await exactFixtureStorageObjects(db, userId)).length !== 0) {
    throw new Error(`Fixture storage cleanup verification found ${photoPath(userId)}`)
  }
}

export async function cleanupFixture() {
  const db = serviceClient()
  const users = await exactFixtureUsers(db)
  const user = users[0] || null
  const admission = await admitFixtureForCleanup(db, user)

  if (user) {
    // Admission above proves the complete identity/ownership graph before the
    // first destructive query. Delete in dependency order and verify each row.
    for (const [table, column, value] of [
      ['listings', 'library_card_id', FIXTURE_LIBRARY_CARD_ID],
      ['claim_sales', 'user_id', user.id],
      ['card_photos', 'library_card_id', FIXTURE_LIBRARY_CARD_ID],
      ['library_cards', 'id', FIXTURE_LIBRARY_CARD_ID],
      ['binders', 'id', FIXTURE_BINDER_ID],
    ]) {
      const { error } = await db.from(table).delete().eq(column, value)
      if (error) throw new Error(`${table} fixture cleanup failed: ${error.message}`)
      const { count, error: verifyError } = await db.from(table).select('*', { count: 'exact', head: true }).eq(column, value)
      if (verifyError || count !== 0) throw new Error(`${table} fixture cleanup absence check failed`)
    }

    const exactStoragePath = photoPath(user.id)
    const { error: storageError } = await db.storage.from('card-photos').remove([exactStoragePath])
    if (storageError) throw new Error(`Fixture photo cleanup failed: ${storageError.message}`)
    if ((await exactFixtureStorageObjects(db, user.id)).length !== 0) {
      throw new Error(`Fixture storage object still exists after remove: ${exactStoragePath}`)
    }

    // Storage absence is independently proven while the synthetic auth owner
    // still exists; only then may auth/profile cascade cleanup run.
    const { error: userError } = await db.auth.admin.deleteUser(user.id)
    if (userError) throw new Error(`Fixture user cleanup failed: ${userError.message}`)
  }

  const { error: catalogError } = await db.from('card_index').delete().eq('scryfall_id', FIXTURE_SCRYFALL_ID)
  if (catalogError) throw new Error(`Fixture catalog cleanup failed: ${catalogError.message}`)
  const remainingUsers = await exactFixtureUsers(db)
  if (remainingUsers.length !== 0) throw new Error('Fixture auth user still exists after cleanup')

  // Independent post-cleanup proof covers every database target plus the
  // exact storage object path, rather than treating remove() success as proof.
  await assertFixtureAbsent(db, user?.id || null)
  console.log(`[phase42-uat] cleanup PASS: ${JSON.stringify({
    admittedBeforeDelete: admission.present,
    authUserAbsent: true,
    databaseRowsAbsent: true,
    storageObjectAbsent: true,
    storagePath: user ? photoPath(user.id) : null,
  })}`)
}

async function createFixture() {
  await cleanupFixture()
  const db = serviceClient()
  let createdUser = null
  try {
    const { data: authData, error: authError } = await db.auth.admin.createUser({
      email: FIXTURE_EMAIL,
      password: FIXTURE_PASSWORD,
      email_confirm: true,
      user_metadata: { username: FIXTURE_USERNAME, display_name: 'Phase 42 UAT' },
    })
    if (authError || !authData?.user) throw authError || new Error('Fixture auth user was not created')
    createdUser = authData.user

    const { error: profileError } = await db.from('profiles').update({
      merchant_bank_name: FIXTURE_PROFILE_MARKER,
      merchant_account_name: 'Phase 42 UAT Seller',
      merchant_account_number: '0000000042',
      merchant_duitnow_id: null,
      merchant_payment_instructions: 'Disposable local rendered UAT fixture.',
      merchant_profile_completed_at: new Date().toISOString(),
    }).eq('id', createdUser.id)
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
      id: FIXTURE_BINDER_ID,
      user_id: createdUser.id,
      name: 'Phase 42 Rendered UAT',
      description: 'Disposable local-only fixture',
      is_default: false,
    })
    if (binderError) throw binderError

    const { error: cardError } = await db.from('library_cards').insert({
      id: FIXTURE_LIBRARY_CARD_ID,
      user_id: createdUser.id,
      binder_id: FIXTURE_BINDER_ID,
      scryfall_id: FIXTURE_SCRYFALL_ID,
      quantity: 1,
      foil: 'normal',
      condition: 'NM',
      language: 'en',
      starred: false,
      purchase_price: 4.2,
      purchase_currency: 'MYR',
    })
    if (cardError) throw cardError

    const jpeg = fixtureJpeg()
    const { error: uploadError } = await db.storage.from('card-photos').upload(photoPath(createdUser.id), jpeg, {
      contentType: 'image/jpeg',
      upsert: false,
    })
    if (uploadError) throw uploadError

    const { error: photoError } = await db.from('card_photos').insert({
      user_id: createdUser.id,
      library_card_id: FIXTURE_LIBRARY_CARD_ID,
      storage_path: photoPath(createdUser.id),
    })
    if (photoError) throw photoError

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    const { data: listing, error: listingError } = await db.from('listings').insert({
      user_id: createdUser.id,
      library_card_id: FIXTURE_LIBRARY_CARD_ID,
      multiplier: 2.5,
      quantity: 1,
      status: 'active',
      expires_at: expiresAt,
    }).select('id, multiplier, status, expires_at').single()
    if (listingError) throw listingError

    const { data: admittedCard, error: cardReadError } = await db.from('library_cards')
      .select('id, card_index!inner(name)')
      .eq('id', FIXTURE_LIBRARY_CARD_ID)
      .eq('user_id', createdUser.id)
      .single()
    if (cardReadError || admittedCard?.card_index?.name !== FIXTURE_CARD_NAME) {
      throw cardReadError || new Error('Fixture library admission failed')
    }
    console.log(`[phase42-uat] fixture PASS: ${FIXTURE_EMAIL}, card ${FIXTURE_LIBRARY_CARD_ID}, listing ${listing.id}`)
  } catch (error) {
    await cleanupFixture().catch(cleanupError => {
      console.error(`[phase42-uat] cleanup after setup failure also failed: ${cleanupError.message}`)
    })
    throw error
  }
}

export async function setFixtureListing({ multiplier = 2.5, expired = false, expiresInMs = null } = {}) {
  const db = serviceClient()
  const users = await exactFixtureUsers(db)
  if (users.length !== 1) throw new Error('Exact Phase 42 fixture user is not admitted')
  if (expiresInMs != null && (!Number.isFinite(expiresInMs) || expiresInMs <= 0)) {
    throw new Error('expiresInMs must be a positive finite duration')
  }
  const expiresAt = new Date(Date.now() + (expired ? -60_000 : expiresInMs ?? 24 * 60 * 60 * 1000)).toISOString()
  const { data, error } = await db.from('listings').upsert({
    user_id: users[0].id,
    library_card_id: FIXTURE_LIBRARY_CARD_ID,
    multiplier,
    quantity: 1,
    status: expired ? 'expired' : 'active',
    expires_at: expiresAt,
  }, { onConflict: 'library_card_id' }).select('id, multiplier, status, expires_at').single()
  if (error) throw error
  return data
}

export default async function globalSetup() {
  await createFixture()
  return async () => {
    try {
      await cleanupFixture()
    } finally {
      const teardown = moveIsolatedCandidateToTrash()
      console.log(`[phase42-uat] isolated candidate cleanup PASS: ${JSON.stringify(teardown)}`)
    }
  }
}

async function runNext(mode) {
  const candidateReceipt = mode === 'build' ? prepareIsolatedCandidate() : null
  const envSourceAudit = verifyIsolatedCandidate()
  const env = loadUatEnvironment(ISOLATED_CANDIDATE_ROOT)
  const nextBin = path.join(APP_ROOT, 'node_modules', 'next', 'dist', 'bin', 'next')
  const args = mode === 'build'
    ? [nextBin, 'build']
    : [nextBin, 'start', '-p', String(APP_PORT), '-H', APP_LISTEN_HOST]
  console.log(JSON.stringify({
    phase42Uat: mode,
    host: os.hostname(),
    appOrigin: APP_ORIGIN,
    appListenHost: APP_LISTEN_HOST,
    supabaseOrigin: SUPABASE_ORIGIN,
    anonKeyFingerprint: fingerprint(env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    serviceKeyFingerprint: fingerprint(env.SUPABASE_SERVICE_ROLE_KEY),
    criticalAssignmentCount: 4,
    nextEnvCandidates: env.PHASE42_UAT_ENV_CANDIDATES.split(','),
    nextEnvSources: env.PHASE42_UAT_ENV_SOURCES ? env.PHASE42_UAT_ENV_SOURCES.split(',') : [],
    nextEnvCriticalSourceAssignmentCount: Number(env.PHASE42_UAT_ENV_SOURCE_ASSIGNMENT_COUNT),
    candidateInputCount: candidateReceipt?.copiedInputCount ?? inputManifest(ISOLATED_CANDIDATE_ROOT).length,
    excludedWorktreeEnvSources: candidateReceipt?.excludedEnvSources ?? NEXT_PRODUCTION_ENV_SOURCE_NAMES.filter(name => fs.existsSync(path.join(APP_ROOT, name))),
    candidateEnvSourceCount: envSourceAudit.sourceNames.length,
  }))
  const child = spawn(process.execPath, args, { cwd: ISOLATED_CANDIDATE_ROOT, env, stdio: 'inherit' })
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal))
  }
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', value => resolve(value ?? 1))
    })
    process.exitCode = code
  } finally {
    if (mode === 'serve') moveIsolatedCandidateToTrash()
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2]
  if (command === 'clean') {
    const teardown = moveIsolatedCandidateToTrash()
    console.log(`[phase42-uat] isolated candidate cleanup PASS: ${JSON.stringify(teardown)}`)
  } else {
    if (!['build', 'serve'].includes(command)) throw new Error('Usage: node scripts/phase42-uat-harness.mjs <build|serve|clean>')
    await runNext(command)
  }
}
