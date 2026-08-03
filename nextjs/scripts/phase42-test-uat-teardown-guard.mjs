import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ISOLATED_CANDIDATE_ROOT,
  buildCandidateTrashDestination,
  buildCandidateTrashDestinationForRoot,
  loggedInUserTrashRoot,
  validateCandidateSourcePath,
} from './phase42-uat-harness.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const harnessSource = fs.readFileSync(path.join(__dirname, 'phase42-uat-harness.mjs'), 'utf8')
const runtimeMode = process.argv[2] || 'ci-static'
if (!['ci-static', '--mac-local-runtime'].includes(runtimeMode)) {
  throw new Error('Usage: node scripts/phase42-test-uat-teardown-guard.mjs [--mac-local-runtime]')
}
let checks = 0

function check(label, assertion) {
  assertion()
  checks += 1
  console.log(`  ok - ${label}`)
}

console.log(`\n=== Phase 42: recoverable candidate teardown guard (${runtimeMode}) ===\n`)

check('recursive deletion APIs and shell recursive removal are absent', () => {
  assert.doesNotMatch(harnessSource, /\bfs\.(?:rmSync|rmdirSync)\s*\(/)
  assert.doesNotMatch(harnessSource, /\b(?:rm|unlink)\s+[^\n]*(?:-[A-Za-z]*r|--recursive)\b/)
})

check('the exact source validator executes before the recoverable rename', () => {
  const functionStart = harnessSource.indexOf('export function moveIsolatedCandidateToTrash()')
  const validation = harnessSource.indexOf(
    'validateCandidateSourcePath(ISOLATED_CANDIDATE_ROOT)',
    functionStart,
  )
  const move = harnessSource.indexOf('fs.renameSync(validated.sourcePath, destinationPath)', functionStart)
  const absenceProof = harnessSource.indexOf('fs.existsSync(validated.sourcePath)', move)
  assert.ok(functionStart >= 0)
  assert.ok(validation > functionStart)
  assert.ok(move > validation)
  assert.ok(absenceProof > move)
})

check('unsafe candidate source paths fail closed before filesystem mutation', () => {
  for (const unsafePath of [
    os.tmpdir(),
    path.join(os.tmpdir(), 'dbb-phase42-rendered-uat-34242-sibling'),
    path.resolve(ISOLATED_CANDIDATE_ROOT, '..'),
    path.join(path.parse(ISOLATED_CANDIDATE_ROOT).root, 'tmp', 'dbb-phase42-rendered-uat-34242'),
  ]) {
    if (unsafePath === ISOLATED_CANDIDATE_ROOT) continue
    assert.throws(
      () => validateCandidateSourcePath(unsafePath),
      /Refusing unvalidated Phase 42 candidate source path/,
    )
  }
})

check('pure Trash destinations are unique and portable without touching a real Trash directory', () => {
  const syntheticTrashRoot = path.join(path.parse(process.cwd()).root, 'phase42-ci-user', '.Trash')
  assert.equal(fs.existsSync(syntheticTrashRoot), false)
  const first = buildCandidateTrashDestinationForRoot(syntheticTrashRoot, {
    now: new Date('2026-08-03T12:00:00.000Z'),
    pid: 4242,
    uniqueId: '42000000-0000-4000-8000-000000000042',
  })
  const second = buildCandidateTrashDestinationForRoot(syntheticTrashRoot, {
    now: new Date('2026-08-03T12:00:00.000Z'),
    pid: 4242,
    uniqueId: '42000000-0000-4000-8000-000000000043',
  })
  assert.equal(path.dirname(first), syntheticTrashRoot)
  assert.equal(path.dirname(second), syntheticTrashRoot)
  assert.notEqual(first, second)
  assert.match(path.basename(first), /^dbb-phase42-rendered-uat-34242-/)
  assert.equal(fs.existsSync(syntheticTrashRoot), false, 'static proof must not create its injected root')
})

check('pure destination validation rejects unsafe or ambiguous roots and identities', () => {
  const validRoot = path.join(path.parse(process.cwd()).root, 'phase42-ci-user', '.Trash')
  for (const invalidRoot of ['relative/.Trash', path.dirname(validRoot), `${validRoot}${path.sep}nested`]) {
    assert.throws(
      () => buildCandidateTrashDestinationForRoot(invalidRoot),
      /Refusing invalid Phase 42 Trash destination identity/,
    )
  }
  assert.throws(
    () => buildCandidateTrashDestinationForRoot(validRoot, { pid: 0 }),
    /Refusing invalid Phase 42 Trash destination identity/,
  )
})

check('CI-static mode cannot invoke logged-in-user Trash validation', () => {
  const pureDefinition = harnessSource.slice(
    harnessSource.indexOf('export function buildCandidateTrashDestinationForRoot'),
    harnessSource.indexOf('export function buildCandidateTrashDestination('),
  )
  assert.doesNotMatch(pureDefinition, /loggedInUserTrashRoot|lstatSync|realpathSync|existsSync/)
  assert.equal(runtimeMode === 'ci-static', process.argv.length === 2)
})

check('all candidate teardown call sites use the recoverable move', () => {
  assert.equal((harnessSource.match(/moveIsolatedCandidateToTrash\(\)/g) || []).length, 5)
  assert.doesNotMatch(harnessSource, /removeIsolatedCandidate/)
})

check('fixture cleanup admits the full synthetic graph before its first delete', () => {
  const cleanupStart = harnessSource.indexOf('export async function cleanupFixture()')
  const admission = harnessSource.indexOf('await admitFixtureForCleanup(db, user)', cleanupStart)
  const firstDelete = harnessSource.indexOf(".delete().eq(column, value)", cleanupStart)
  assert.ok(cleanupStart >= 0)
  assert.ok(admission > cleanupStart)
  assert.ok(firstDelete > admission)
  for (const proof of [
    'profile marker does not match',
    'binder ownership does not match',
    'library card ownership does not match',
    'photo ownership does not match',
    'listing ownership does not match',
    'catalog stored image does not match',
    'does not match the synthetic fixture bytes',
  ]) {
    assert.ok(harnessSource.includes(proof), `missing fixture admission proof: ${proof}`)
  }
})

check('storage and database absence are independently proven after cleanup', () => {
  const cleanupStart = harnessSource.indexOf('export async function cleanupFixture()')
  const storageRemove = harnessSource.indexOf(".remove([exactStoragePath])", cleanupStart)
  const storageAbsence = harnessSource.indexOf('exactFixtureStorageObjects(db, user.id)', storageRemove)
  const authDelete = harnessSource.indexOf('deleteUser(user.id)', cleanupStart)
  const finalAbsence = harnessSource.indexOf('await assertFixtureAbsent(db, user?.id || null)', cleanupStart)
  assert.ok(storageRemove > cleanupStart)
  assert.ok(storageAbsence > storageRemove)
  assert.ok(authDelete > storageAbsence)
  assert.ok(finalAbsence > authDelete)
})

if (runtimeMode === '--mac-local-runtime') {
  check('explicit Mac-local mode validates the real user Trash without mutating it', () => {
    assert.equal(os.hostname(), 'Dans-MacBook-Air-9.local')
    const trashRoot = loggedInUserTrashRoot()
    const first = buildCandidateTrashDestination({
      now: new Date('2026-08-03T12:00:00.000Z'),
      pid: 4242,
      uniqueId: '42000000-0000-4000-8000-000000000042',
    })
    const second = buildCandidateTrashDestination({
      now: new Date('2026-08-03T12:00:00.000Z'),
      pid: 4242,
      uniqueId: '42000000-0000-4000-8000-000000000043',
    })
    assert.equal(path.dirname(first), trashRoot)
    assert.equal(path.dirname(second), trashRoot)
    assert.notEqual(first, second)
    assert.equal(fs.existsSync(first), false)
    assert.equal(fs.existsSync(second), false)
  })
}

console.log(`\n${checks} checks passed\n`)
