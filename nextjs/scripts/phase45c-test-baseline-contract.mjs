#!/usr/bin/env node

// CI-safe provenance gate for the immutable local-UAT baseline. The baseline
// deliberately squashes only the legacy schema; post-baseline migrations must
// remain timestamped so a hosted upgrade never replays local bootstrap SQL.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const ROOT = new URL('../..', import.meta.url)
const BASELINE_PATH = new URL('supabase/migrations/20260101000000_dbb_baseline.sql', ROOT)
const baseline = readFileSync(BASELINE_PATH, 'utf8')
const expectedSources = [
  'migration-002-multiuser.sql',
  'migration-003-move-rpc.sql',
  'migration-004-listings.sql',
  'migration-005-indexes.sql',
  'migration-006-cart.sql',
  'migration-007-catalog.sql',
  'migration-008-indexes.sql',
  'migration-009-listing-lifecycle.sql',
  'migration-010-card-photos.sql',
  'migration-011-rpc-binder-validation.sql',
  'migration-012-theme-preference.sql',
  'migration-013-claim-sales.sql',
  'migration-014-listing-quantity.sql',
  'migration-015-card-hashes.sql',
]
const actualSources = [...baseline.matchAll(/^-- SOURCE supabase\/(.+)$/gm)].map(match => match[1])
const executableSql = baseline.replace(/^--.*$/gm, '')

assert.deepEqual(actualSources, expectedSources, 'baseline must contain exactly legacy migration-002 through migration-015 in order')
assert.doesNotMatch(actualSources.join('\n'), /migration-add-foil-pricing|migration-016|migration-017|migration-018/i,
  'baseline must not source later or obsolete migrations')
assert.doesNotMatch(executableSql, /\bpublic\.cards\b|foil[-_ ]?pricing/i,
  'baseline must not execute obsolete foil-pricing SQL against public.cards')
assert.match(baseline, /BEGIN;[\s\S]*COMMIT;\s*$/,
  'baseline must remain one atomic local bootstrap migration')

console.log(JSON.stringify({ result: 'PHASE45C_BASELINE_CONTRACT_PASS', legacy_sources: actualSources.length }))
