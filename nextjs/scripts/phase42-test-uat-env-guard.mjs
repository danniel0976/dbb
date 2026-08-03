import assert from 'node:assert/strict'
import {
  NEXT_PRODUCTION_ENV_SOURCE_NAMES,
  auditNextEnvSourceContents,
  auditNextEnvSources,
  stripEnvComments,
} from './phase42-uat-harness.mjs'

let checks = 0
function check(label, assertion) {
  assertion()
  checks += 1
  console.log(`  ok - ${label}`)
}

console.log('\n=== Phase 42: rendered-UAT environment admission guard ===\n')

check('candidate list matches every production env source Next 14 may load', () => {
  assert.deepEqual(NEXT_PRODUCTION_ENV_SOURCE_NAMES, [
    '.env.production.local',
    '.env.local',
    '.env.production',
    '.env',
  ])
})

check('comments are stripped while hashes inside quoted credentials survive', () => {
  const stripped = stripEnvComments([
    '# NEXT_PUBLIC_SITE_URL=http://attacker.invalid',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY="local#credential" # trailing comment',
  ].join('\n'))
  assert.doesNotMatch(stripped, /attacker/)
  assert.match(stripped, /"local#credential"/)
  assert.doesNotMatch(stripped, /trailing comment/)
})

check('the direct worktree is rejected because its real production env source has empty placeholders', () => {
  assert.throws(() => auditNextEnvSources(), /empty NEXT_PUBLIC_SUPABASE_ANON_KEY/)
})

check('an env-free isolated candidate has no ambiguous Next source assignment', () => {
  const receipt = auditNextEnvSourceContents([])
  assert.deepEqual(receipt.sourceNames, [])
  assert.equal(receipt.criticalSourceAssignmentCount, 0)
})

check('duplicate assignments across Next source files are rejected', () => {
  assert.throws(() => auditNextEnvSourceContents([
    { name: '.env.production.local', contents: 'NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321\n' },
    { name: '.env.production', contents: 'NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321\n' },
  ]), /2 assignments for NEXT_PUBLIC_SUPABASE_URL/)
})

check('a late same-file override is rejected even after a trusted first assignment', () => {
  assert.throws(() => auditNextEnvSourceContents([{
    name: '.env.production',
    contents: [
      'NEXT_PUBLIC_SITE_URL=http://localhost:34242',
      'UNRELATED=value',
      'NEXT_PUBLIC_SITE_URL=http://late-override.invalid',
    ].join('\n'),
  }]), /2 assignments for NEXT_PUBLIC_SITE_URL/)
})

check('empty and interpolated critical assignments fail closed', () => {
  assert.throws(() => auditNextEnvSourceContents([
    { name: '.env', contents: 'SUPABASE_SERVICE_ROLE_KEY= # empty\n' },
  ]), /empty SUPABASE_SERVICE_ROLE_KEY/)
  assert.throws(() => auditNextEnvSourceContents([
    { name: '.env', contents: 'NEXT_PUBLIC_SUPABASE_ANON_KEY=${LATE_KEY}\n' },
  ]), /ambiguous NEXT_PUBLIC_SUPABASE_ANON_KEY/)
})

console.log(`\n${checks} checks passed\n`)
